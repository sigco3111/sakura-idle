#!/usr/bin/env node
/**
 * tools/make-og.mjs — builds the Open Graph / social share cards.
 *
 *   node tools/make-og.mjs                  # composite from cached bases (renders if missing)
 *   node tools/make-og.mjs --render         # force a fresh scene render, then composite
 *   node tools/make-og.mjs --proofs         # also write the 600/350/200 px legibility proofs
 *   node tools/make-og.mjs --variants v1,v2 # render camera variants only, no cards
 *
 * Outputs
 *   public/og.png         1200 x 630   the 1.91:1 OG standard (X, Discord, Slack, iMessage, Google)
 *   public/og-square.png  1200 x 1200  square-preferring layouts
 *   .tmp-orch/og/base/*.png            cached 2x scene renders (the expensive half)
 *   .tmp-orch/og/proof/*.png           downscaled proofs, only with --proofs
 *
 * WHY IT IS BUILT THIS WAY
 * - Two stages, cached in the middle. Stage 1 boots its own Vite server + headless
 *   Chrome (same pattern as tools/shot.mjs) and renders the scene at 2x the card,
 *   writing .tmp-orch/og/base/<name>.png. Stage 2 composites type over it on a
 *   canvas and downscales to the final size, so text is laid out at 2x and
 *   resampled — crisp rather than upscaled. Re-running only stage 2 is seconds,
 *   which is what makes the type iterable.
 * - No image library. Everything is headless-Chrome canvas, exactly as
 *   tools/sheet.mjs does it; the repo has no image dependency and must not gain one.
 * - No runtime network requests: system fonts only, no remote assets.
 *
 * CAMERA / SCENE NOTES (each ruled in or out by rendering it)
 * - Scenario `rich` (mid-game, stage 3 満開 FULL BLOOM) not `lategame`: at
 *   lategame the stage-6 god rays blow the crown out to near-white and the
 *   silhouette stops reading as a cherry tree at thumbnail size.
 * - Camera sits at negative X — the grove's WEST side. storyboards/demo.mjs
 *   documents that a few major limbs on the tree's east side carry no blossom and
 *   read as dead wood; from the west those limbs point away from camera and sit
 *   behind the crown, so the silhouette is all blossom.
 * - ~24 units out at a 42 deg vertical fov (48 on the square, which needs the
 *   extra headroom or the crown clips the top edge), aimed ~1 unit BELOW the
 *   trunk's mid height. That floats the crown to the top of the frame (top edge
 *   ~3 % down, trunk base ~68 %) and leaves the lower third as grass, fallen
 *   petals and pond — quiet enough to carry type under a gradient scrim.
 *   Two alternatives were rendered and rejected: a smaller tree with the whole
 *   type block clear of it (the tree stopped being the subject and the bottom
 *   40 % went to empty grass — ART_BIBLE §8.11), and a 45 deg wide frame for
 *   more headroom (same problem, milder). A 1.91:1 card gets cropped at the
 *   SIDES, not the top, so 3 % of headroom is enough here.
 * - dayT 0.665, the game's own default mood anchor — i.e. what a player actually
 *   boots into. Sunset (0.755) and the lavender top-of-dusk (0.700) are prettier
 *   at full size, but both drop the tree/sky separation and at 200 px the crown
 *   turns into a soft mauve mass. The day anchor keeps pink blossom against blue
 *   sky, which is the only version that still reads as a cherry tree that small.
 *   Both alternatives survive as `v_w755` / `v_w700` if the call is ever revisited.
 *
 * TO RE-POINT AT A DIFFERENT RENDER: edit BASES below (or drop a PNG at the
 * base path and run without --render, which reuses whatever is on disk).
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : (argv[i + 1] ?? true); };
const has = (k) => argv.includes('--' + k);

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(ROOT, '.tmp-orch/og');
const BASEDIR = path.join(TMP, 'base');
const SCALE = 2;                       // render at 2x the card, downscale on composite

/* ------------------------------------------------------------------ *
 * Scene renders. `cam` is fed straight to ctx.camera with the idle
 * camera rig switched off, so any framing is reachable — not just the
 * named presets in src/core/cameras.js.
 * ------------------------------------------------------------------ */
const BASES = {
  wide: {
    w: 1200 * SCALE, h: 630 * SCALE,
    scenario: 'rich', dayT: 0.665, warm: 900,
    cam: { pos: [-7.0, 5.6, 22.0], target: [-1.0, 4.55, -1.0], fov: 42 },
  },
  square: {
    w: 1200 * SCALE, h: 1200 * SCALE,
    scenario: 'rich', dayT: 0.665, warm: 900,
    cam: { pos: [-5.9, 5.8, 19.5], target: [-1.0, 5.60, -1.0], fov: 48 },
  },
  /* Exploration only (--variants). Kept so the choices above stay auditable. */
  v_frontal: {
    w: 1200 * SCALE, h: 630 * SCALE, scenario: 'rich', dayT: 0.700, warm: 900,
    cam: { pos: [2.4, 7.0, 30.0], target: [-0.4, 5.4, -1.0], fov: 34 },
  },
  v_west: {
    w: 1200 * SCALE, h: 630 * SCALE, scenario: 'rich', dayT: 0.700, warm: 900,
    cam: { pos: [-9.0, 7.2, 28.0], target: [-1.0, 5.2, -1.0], fov: 34 },
  },
  v_westclose: {
    w: 1200 * SCALE, h: 630 * SCALE, scenario: 'rich', dayT: 0.700, warm: 900,
    cam: { pos: [-7.0, 5.6, 22.0], target: [-1.0, 5.6, -1.0], fov: 42 },
  },
  v_dusk: {
    w: 1200 * SCALE, h: 630 * SCALE, scenario: 'rich', dayT: 0.755, warm: 900,
    cam: { pos: [-9.0, 7.2, 28.0], target: [-1.0, 5.2, -1.0], fov: 34 },
  },
  // The wide framing above, at three times of day.
  v_w700: {
    w: 1200 * SCALE, h: 630 * SCALE, scenario: 'rich', dayT: 0.700, warm: 900,
    cam: { pos: [-7.6, 5.7, 24.1], target: [-1.0, 3.2, -1.0], fov: 42 },
  },
  v_w755: {
    w: 1200 * SCALE, h: 630 * SCALE, scenario: 'rich', dayT: 0.755, warm: 900,
    cam: { pos: [-7.6, 5.7, 24.1], target: [-1.0, 3.2, -1.0], fov: 42 },
  },
  v_w665: {
    w: 1200 * SCALE, h: 630 * SCALE, scenario: 'rich', dayT: 0.665, warm: 900,
    cam: { pos: [-7.6, 5.7, 24.1], target: [-1.0, 3.2, -1.0], fov: 42 },
  },
};

/* ------------------------------------------------------------------ *
 * Copy. Every claim here has to be true of the shipped build — see
 * README.md. No marks, no endorsements, no numbers we cannot stand behind.
 * ------------------------------------------------------------------ */
const TEXT = {
  mark: '桜',
  title: 'SAKURA',
  subtitle: 'PETALS OF THE EVERBLOSSOM',
  strap: 'An idle game about one ancient cherry tree · every petal, texture and note generated in code',
  url: 'sakura-idle.vercel.app',
};

/* ART_BIBLE §3 / §7 tokens. */
const C = {
  goldPale: '#E8C56A',
  goldDeep: '#A8792C',
  goldHi: '#FBEEC2',
  parchment: '#F3EBDC',
  ink: '#3A322A',
  scrim: '26, 19, 13',      // warm ink-brown, never neutral grey
};

const CARDS = [
  { name: 'og', base: 'wide', out: 'public/og.png', w: 1200, h: 630 },
  { name: 'og-square', base: 'square', out: 'public/og-square.png', w: 1200, h: 1200 },
];

const log = (...a) => console.log('[og]', ...a);
const exists = (p) => access(p).then(() => true, () => false);

/* ------------------------------------------------------------------ *
 * Minimal PNG encoder (colour type 2, no alpha) on node's own zlib.
 *
 * Canvas.toDataURL only ever emits RGBA at whatever effort Chrome feels like.
 * A social card has no transparency, so a quarter of that file is a constant
 * alpha channel, and Chrome's deflate is tuned for speed. Encoding here instead
 * — adaptive per-row filtering + deflate level 9 — took og.png from 1.63 MB to
 * comfortably under 1 MB with byte-identical pixels. No dependency: it is ~50
 * lines against node:zlib, and the repo must not gain an image library.
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** Apply one filter strategy. `fixed` null = adaptive (min sum of abs residuals). */
function filterRows(rgb, w, h, fixed) {
  const bpp = 3, stride = w * bpp;
  const out = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    let best = 0, bestScore = Infinity;
    for (let f = 0; f <= 4; f++) {
      if (fixed !== null && f !== fixed) continue;
      const c = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev[i];
        const cc = i >= bpp ? prev[i - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) {
          const p = a + b - cc;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
        }
        const v = (row[i] - pred) & 0xff;
        c[i] = v;
        score += v < 128 ? v : 256 - v;   // sum of absolute signed residuals
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
    prev = row;
  }
  return out;
}

/**
 * rgb: tightly packed 3-byte-per-pixel buffer.
 * Searches a handful of (row filter x zlib strategy) pairs and keeps the smallest
 * IDAT. The libpng heuristic (adaptive filtering) is not always the winner on
 * grain-heavy photographic content — on this card `none` + Z_FILTERED beats it —
 * and a few extra seconds is free in a tool that runs by hand.
 */
function encodePNG(rgb, w, h) {
  const Z = { DEFAULT: 0, FILTERED: 1, RLE: 3 };
  let best = null;
  for (const fixed of [null, 0, 2, 4]) {
    const raw = filterRows(rgb, w, h, fixed);
    for (const strategy of [Z.DEFAULT, Z.FILTERED]) {
      const idat = deflateSync(raw, { level: 9, memLevel: 9, windowBits: 15, strategy });
      if (!best || idat.length < best.length) best = idat;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', best),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ================================================================== *
 * STAGE 1 — scene render
 * ================================================================== */
async function renderBases(names) {
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const base = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.config.server.port}/`;

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=metal',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-dev-shm-usage',
      '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio',
    ],
  });

  await mkdir(BASEDIR, { recursive: true });
  try {
    for (const name of names) {
      const b = BASES[name];
      if (!b) throw new Error(`unknown base "${name}"`);
      // A fresh page per base: the post chain allocates its render targets at the
      // boot resolution, and resizing a live page is a needless risk for a tool
      // that runs in a minute.
      const page = await browser.newPage();
      await page.setViewport({ width: b.w, height: b.h, deviceScaleFactor: 1 });
      const errs = [];
      page.on('pageerror', (e) => errs.push(String(e?.stack ?? e).slice(0, 500)));
      page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errs.push(m.text().slice(0, 500)); });

      await page.goto(`${base}?shot=1&q=ultra`, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction('window.__READY !== undefined', { timeout: 120000, polling: 100 });

      await page.evaluate((cfg) => {
        const g = window.__game;
        g.scenarios?.[cfg.scenario]?.();
        g.setUI(false);
        if (cfg.dayT != null) g.ctx.assets.lighting?.setDayT(cfg.dayT);
        g.ctx.assets.lighting?.pause(true);
        // Idle drift would fight an explicit framing; switch the rig off and drive
        // the camera directly (storyboards/demo.mjs does the same).
        g.ctx.assets.cameraRig?.setEnabled?.(false);
      }, b);

      await page.evaluate((n) => window.__game.warm(n), b.warm);
      await page.evaluate((cam) => {
        const c = window.__game.ctx.camera;
        c.position.set(...cam.pos);
        c.lookAt(...cam.target);
        c.fov = cam.fov;
        c.updateProjectionMatrix();
        c.updateMatrixWorld();
      }, b.cam);
      // A few more steps with the camera in place: LOD, DOF and the TAA history
      // all key off view position.
      await page.evaluate(() => window.__game.warm(40));
      await page.evaluate(() => { for (let i = 0; i < 4; i++) window.__game.redraw(); });

      const file = path.join(BASEDIR, `${name}.png`);
      await page.screenshot({ path: file, type: 'png', optimizeForSpeed: false });
      await page.close();
      if (errs.length) { console.error('[og] page errors:', errs.slice(0, 4)); throw new Error('scene render reported errors'); }
      log('rendered', name, `${b.w}x${b.h}`, '→', path.relative(ROOT, file));
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

/* ================================================================== *
 * STAGE 2 — type + composite
 * ================================================================== */

/** Runs inside the page. Returns a base64 PNG of one finished card. */
const drawCard = ({ src, W, H, T, C, S }) => new Promise((resolve, reject) => {
  const im = new Image();
  im.onerror = reject;
  im.onload = () => {
    const c = document.createElement('canvas');
    c.width = W * S; c.height = H * S;      // lay out at 2x, downscale at the end
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const w = c.width, h = c.height;
    const u = (n) => n * S;                 // design units -> 2x device px

    /* ---- backdrop: cover-fit the render, no stretch ---- */
    const s = Math.max(w / im.width, h / im.height);
    const dw = im.width * s, dh = im.height * s;
    g.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh);

    const SERIF = '"Hiragino Mincho ProN", "Songti SC", Georgia, serif';
    const SANS = 'ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

    /* ---- vignette: warm, corners only, holds the eye centre ---- */
    const vg = g.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.30, w / 2, h * 0.5, Math.max(w, h) * 0.72);
    vg.addColorStop(0, `rgba(${C.scrim},0)`);
    vg.addColorStop(0.62, `rgba(${C.scrim},0.07)`);
    vg.addColorStop(1, `rgba(${C.scrim},0.30)`);
    g.fillStyle = vg; g.fillRect(0, 0, w, h);

    /* ---- type block, bottom-anchored and centred ---------------------
       Sizes are in 1200-wide design units. The stack is measured from the
       bottom up so the 60 px safe margin is guaranteed on every card ratio. */
    const isSquare = H > W * 1.2;
    const F = {
      mark: isSquare ? 92 : 80,
      title: isSquare ? 98 : 86,
      rule: isSquare ? 620 : 560,
      sub: isSquare ? 30 : 27,
      strap: isSquare ? 24 : 20,
      url: isSquare ? 20 : 17,
    };
    /* Vertical rhythm, measured bottom → top so the 60 px safe margin holds on
       every ratio. 桜 rides on the SAME line as the title rather than above it:
       stacking it cost ~95 design px, which pushed the scrim over the trunk. */
    const bottom = H - 68;   // baseline; leaves the URL's descenders ~64 px clear
    const yUrl = bottom;
    const yStrap = yUrl - F.url - (isSquare ? 28 : 24);
    const ySub = yStrap - F.strap - (isSquare ? 26 : 22);
    const yRule = ySub - F.sub - (isSquare ? 20 : 17);
    const yTitle = yRule - (isSquare ? 26 : 22);
    const blockTop = yTitle - F.title;

    /* Scrim: a single bottom-up gradient that starts ABOVE the type block and
       is fully clear by the horizon, plus a soft elliptical lift right behind
       the words. Nothing here is a rectangle, so the picture is never flattened. */
    const gTop = u(blockTop - (isSquare ? 120 : 100));
    const sc = g.createLinearGradient(0, gTop, 0, h);
    sc.addColorStop(0, `rgba(${C.scrim},0)`);
    sc.addColorStop(0.22, `rgba(${C.scrim},0.13)`);
    sc.addColorStop(0.55, `rgba(${C.scrim},0.43)`);
    sc.addColorStop(1, `rgba(${C.scrim},0.64)`);
    g.fillStyle = sc; g.fillRect(0, gTop, w, h - gTop);

    const cy = u((blockTop + bottom) / 2);
    const lift = g.createRadialGradient(w / 2, cy, u(40), w / 2, cy, u(W * 0.46));
    lift.addColorStop(0, `rgba(${C.scrim},0.26)`);
    lift.addColorStop(0.55, `rgba(${C.scrim},0.13)`);
    lift.addColorStop(1, `rgba(${C.scrim},0)`);
    // Full-canvas fill: clipping a radial gradient to a rect leaves a visible
    // straight edge wherever the rect boundary cuts it above zero alpha.
    g.fillStyle = lift; g.fillRect(0, 0, w, h);

    const cx = w / 2;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';

    /** Letter-spaced centred text — canvas letterSpacing lands the advance on the
     *  trailing glyph too, so the visual centre drifts right; correct for it. */
    const centred = (text, ls, y) => {
      g.letterSpacing = `${u(ls)}px`;
      g.fillText(text, cx - u(ls) / 2, u(y));
      g.letterSpacing = '0px';
    };

    const softShadow = (blur, alpha, dy = 0) => {
      g.shadowColor = `rgba(20,14,9,${alpha})`;
      g.shadowBlur = u(blur);
      g.shadowOffsetY = u(dy);
    };
    const noShadow = () => { g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0; };

    /* ---- title line: gold 桜 + parchment SAKURA, optically centred together.
       This line is the whole card at thumbnail size, so it gets the most weight,
       the widest tracking and the strongest shadow. ---- */
    (() => {
      const gap = u(F.title * 0.30);
      const tls = u(F.title * 0.15);          // tracking on the latin word
      g.letterSpacing = '0px';
      g.textAlign = 'left';
      const MARKF = `600 ${u(F.mark)}px ${SERIF}`;
      g.font = MARKF;
      const markW = g.measureText(T.mark).width;
      g.font = `${u(F.title)}px ${SERIF}`;
      g.letterSpacing = `${tls}px`;
      const titleW = g.measureText(T.title).width - tls;   // drop the trailing advance
      g.letterSpacing = '0px';

      const total = markW + gap + titleW;
      let x = cx - total / 2;
      const y = u(yTitle);

      // 桜 in the §7 gold gradient, with a breath of glow so it separates from
      // blossom without needing a hard outline.
      g.font = MARKF;
      const mg = g.createLinearGradient(0, y - u(F.mark) * 0.82, 0, y + u(F.mark) * 0.06);
      mg.addColorStop(0, C.goldHi);
      mg.addColorStop(0.32, C.goldPale);
      mg.addColorStop(1, C.goldDeep);
      // A dark halo, not a bright one: the glow was eating the thin Mincho
      // strokes at thumbnail size instead of separating them.
      g.globalAlpha = 0.5; g.fillStyle = 'rgba(30,20,10,0.9)';
      g.filter = `blur(${u(10)}px)`;
      g.fillText(T.mark, x, y);
      g.filter = 'none'; g.globalAlpha = 1;
      softShadow(26, 0.55, 2);
      g.fillStyle = mg;
      g.fillText(T.mark, x, y);
      noShadow();

      x += markW + gap;
      g.font = `${u(F.title)}px ${SERIF}`;
      g.letterSpacing = `${tls}px`;
      g.fillStyle = C.parchment;
      // Two shadow passes: a wide soft one to lift the word off the scene, then a
      // tight one hugging the strokes. The tight pass is what keeps Mincho's thin
      // serifs separable once the card is resampled to 200 px.
      softShadow(30, 0.58, 3);
      g.fillText(T.title, x, y);
      softShadow(9, 0.62, 1);
      g.fillText(T.title, x, y);
      noShadow();
      g.letterSpacing = '0px';
      g.textAlign = 'center';
    })();

    /* ---- tapered gold rule with a centre diamond (ART_BIBLE §7) ---- */
    (() => {
      const rw = u(F.rule), y = u(yRule), x0 = cx - rw / 2;
      const rg = g.createLinearGradient(x0, 0, x0 + rw, 0);
      rg.addColorStop(0, 'rgba(168,121,44,0)');
      rg.addColorStop(0.20, 'rgba(232,197,106,0.92)');
      rg.addColorStop(0.44, 'rgba(232,197,106,0.55)');
      rg.addColorStop(0.56, 'rgba(232,197,106,0.55)');
      rg.addColorStop(0.80, 'rgba(232,197,106,0.92)');
      rg.addColorStop(1, 'rgba(168,121,44,0)');
      softShadow(10, 0.5, 1);
      g.fillStyle = rg;
      g.fillRect(x0, y - u(0.6), rw, u(1.3));
      noShadow();
      const d = u(isSquare ? 10 : 9);
      g.beginPath();
      g.moveTo(cx, y - d); g.lineTo(cx + d, y); g.lineTo(cx, y + d); g.lineTo(cx - d, y);
      g.closePath();
      g.fillStyle = C.goldPale; g.fill();
      g.beginPath();
      const i2 = d * 0.42;
      g.moveTo(cx, y - i2); g.lineTo(cx + i2, y); g.lineTo(cx, y + i2); g.lineTo(cx - i2, y);
      g.closePath();
      g.fillStyle = 'rgba(251,238,194,0.72)'; g.fill();
      // the two small companion dots the panel flourish uses
      g.fillStyle = 'rgba(168,121,44,0.85)';
      for (const dx of [-d * 2.3, d * 2.3]) { g.beginPath(); g.arc(cx + dx, y, u(1.4), 0, 7); g.fill(); }
    })();

    /* ---- subtitle in gold ---- */
    g.font = `${u(F.sub)}px ${SERIF}`;
    softShadow(16, 0.55, 2);
    g.fillStyle = C.goldPale;
    centred(T.subtitle, F.sub * 0.26, ySub);
    noShadow();

    /* ---- strap-line: what it actually is, one line, sans ---- */
    g.font = `${u(F.strap)}px ${SANS}`;
    softShadow(11, 0.85, 1);
    g.fillStyle = 'rgba(243,235,220,0.94)';
    // Shrink-to-fit rather than wrap: two lines here would crowd the tree.
    let ls = F.strap * 0.012, size = F.strap;
    const maxW = u(W - 150);
    while (size > 13) {
      g.font = `${u(size)}px ${SANS}`;
      g.letterSpacing = `${u(ls)}px`;
      if (g.measureText(T.strap).width <= maxW) break;
      size -= 0.5;
    }
    g.fillText(T.strap, cx - u(ls) / 2, u(yStrap));
    g.letterSpacing = '0px';
    noShadow();

    /* ---- URL: small, gold, unobtrusive, still legible ---- */
    g.font = `${u(F.url)}px ${SANS}`;
    softShadow(12, 0.6, 1);
    g.fillStyle = 'rgba(232,197,106,0.92)';
    centred(T.url, F.url * 0.09, yUrl);
    noShadow();

    /* ---- downscale 2x -> 1x, then dither ---- */
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const og = out.getContext('2d');
    og.imageSmoothingEnabled = true;
    og.imageSmoothingQuality = 'high';
    og.drawImage(c, 0, 0, W, H);

    /* Anti-banding dither: deterministic value noise (no Math.random, so the card
       is byte-reproducible), amplitude <= ~1 LSB.
       MEASURED: the post chain's own film grain already dithers the sky, so the
       longest flat run down a sky column is 2-3 rows with ~137 distinct colours
       over 157 — i.e. there is no banding to fix even with this switched off.
       It is kept, at a light amplitude, as insurance for a future grade with less
       grain; it costs ~10 KB and cannot make the gradient worse. */
    const id = og.getImageData(0, 0, W, H);
    const p = id.data;
    let a = 0x9e3779b9;
    const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    /* Weighted by local flatness: full amplitude on the smooth sky where the
       banding actually is, none in the grass, where noise only costs file size. */
    const rgb = new Uint8Array(W * H * 3);
    for (let y = 0, k = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const j = (y * W + Math.min(W - 1, x + 3)) * 4;
        const i2 = (Math.min(H - 1, y + 3) * W + x) * 4;
        const d = Math.abs(p[i] - p[j]) + Math.abs(p[i + 1] - p[j + 1]) + Math.abs(p[i + 2] - p[j + 2])
                + Math.abs(p[i] - p[i2]) + Math.abs(p[i + 1] - p[i2 + 1]) + Math.abs(p[i + 2] - p[i2 + 2]);
        const n = d > 14 ? 0 : (rnd() - 0.5) * 1.4 * (1 - d / 14);
        rgb[k++] = Math.max(0, Math.min(255, p[i] + n));
        rgb[k++] = Math.max(0, Math.min(255, p[i + 1] + n));
        rgb[k++] = Math.max(0, Math.min(255, p[i + 2] + n));
      }
    }
    resolve(b64(rgb));
  };
  im.src = src;
});

/** Plain downscale, for the small-size legibility proofs. */
const drawScaled = ({ src, W }) => new Promise((resolve, reject) => {
  const im = new Image();
  im.onerror = reject;
  im.onload = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = Math.round(im.height * (W / im.width));
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(im, 0, 0, c.width, c.height);
    const p = g.getImageData(0, 0, c.width, c.height).data;
    const rgb = new Uint8Array(c.width * c.height * 3);
    for (let i = 0, k = 0; i < p.length; i += 4) { rgb[k++] = p[i]; rgb[k++] = p[i + 1]; rgb[k++] = p[i + 2]; }
    resolve({ b64: b64(rgb), w: c.width, h: c.height });
  };
  im.src = src;
});

/** Injected into the page: chunked base64 so a 2-3 MB pixel buffer can come back
 *  over the evaluate boundary without JSON-serialising it a byte at a time. */
const B64_HELPER = `window.b64 = (bytes) => {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
};`;

async function composite(cards, { proofs }) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 600, height: 400 });
    await page.evaluateOnNewDocument(B64_HELPER);
    await page.goto('about:blank');
    await page.evaluate(B64_HELPER);
    for (const card of cards) {
      const basePath = path.join(BASEDIR, `${card.base}.png`);
      const src = 'data:image/png;base64,' + (await readFile(basePath)).toString('base64');
      const raw = await page.evaluate(drawCard, { src, W: card.w, H: card.h, T: TEXT, C, S: SCALE });
      const png = encodePNG(Buffer.from(raw, 'base64'), card.w, card.h);
      const outPath = path.join(ROOT, card.out);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, png);
      log('card', card.out, `${card.w}x${card.h}`, `${Math.round(png.length / 1024)} KB`);

      if (proofs) {
        await mkdir(path.join(TMP, 'proof'), { recursive: true });
        const cardSrc = 'data:image/png;base64,' + png.toString('base64');
        for (const W of [600, 350, 200]) {
          const r = await page.evaluate(drawScaled, { src: cardSrc, W });
          const pf = path.join(TMP, 'proof', `${card.name}-${W}.png`);
          await writeFile(pf, encodePNG(Buffer.from(r.b64, 'base64'), r.w, r.h));
          log('proof', path.relative(ROOT, pf), `${r.w}x${r.h}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
}

/* ================================================================== *
 * main
 * ================================================================== */
const variants = arg('variants', null);
if (variants) {
  await renderBases(String(variants).split(',').map((s) => s.trim()).filter(Boolean));
  log('variants only — no cards written');
} else {
  const needed = [...new Set(CARDS.map((c) => c.base))];
  const missing = has('render')
    ? needed
    : (await Promise.all(needed.map(async (n) => ((await exists(path.join(BASEDIR, `${n}.png`))) ? null : n)))).filter(Boolean);
  if (missing.length) { log('rendering bases:', missing.join(', ')); await renderBases(missing); }
  else log('reusing cached bases in', path.relative(ROOT, BASEDIR));
  await composite(CARDS, { proofs: has('proofs') });
}
