#!/usr/bin/env node
/**
 * Deterministic video capture.
 *
 *   node tools/capture.mjs --storyboard storyboards/demo.mjs --out .tmp-orch/video/demo \
 *        --w 1920 --h 1080 --fps 30
 *
 * Renders the game frame-by-frame with a FIXED timestep (never realtime), so the
 * result is reproducible and never drops frames or stutters regardless of how slow
 * the machine is. Optionally renders the game's own audio offline for exactly the
 * same duration and muxes it in. Produces an H.264 mp4 suitable for social media.
 *
 * ── Writing a storyboard ────────────────────────────────────────────────────
 * A storyboard is an ES module exporting:
 *
 *   export const duration = 28;          // seconds
 *   export const fps = 30;               // optional, --fps wins
 *   export const audio = { phase: 'day', stage: 3 };   // or false for silent
 *   export const ui = true;              // show the DOM UI
 *   export const quality = 'ultra';
 *   export const pageScript = `          // JS evaluated IN THE PAGE
 *     window.__STORY = {
 *       setup(g, ctx) { ... },           // once, after __READY
 *       frame(t, g, ctx) { ... },        // every frame, BEFORE the sim steps
 *     };
 *   `;
 *
 * Inside pageScript you have the full runtime:
 *   g.setCamera('hero')                  snap to a named preset
 *   g.ctx.camera.position.set(...)       or drive the camera yourself
 *   g.scenarios.night()                  any registered debug scenario
 *   g.clickWorld(nx, ny)                 synthetic world click (NDC coords)
 *   ctx.assets.game                      the economy (buy, shake, prestige, state)
 *   ctx.assets.tree / .petals / .props   world modules
 *   ctx.bus.emit(...)                    fire game events
 *   g.THREE                              the three namespace
 *
 * `t` is the storyboard time in seconds. Camera moves should be written as
 * functions of `t` (lerp/ease between keyframes) rather than as one-shot
 * mutations, so the motion is smooth and reproducible.
 *
 * Because the camera rig applies idle drift, call g.setCamera() every frame if you
 * want an exactly locked-off shot, or set ctx.assets.cameraRig?.setEnabled(false)
 * if that module exposes it.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const has = (k) => argv.includes('--' + k);

const SB_PATH = path.resolve(String(arg('storyboard', '')));
if (!SB_PATH) { console.error('need --storyboard <file.mjs>'); process.exit(2); }
const OUT = path.resolve(String(arg('out', '.tmp-orch/video/out')));
const W = Number(arg('w', 1920));
const H = Number(arg('h', 1080));
const ROOT = path.resolve(import.meta.dirname, '..');
const KEEP = has('keep-frames');
const CRF = String(arg('crf', 18));
/** --master produces a high-quality DELIVERY MASTER, not a social-ready file:
 *  near-transparent video and 320k audio, intended to be compressed later by hand.
 *  Squeezing at capture time is what made the first demo look soft. */
const MASTER = has('master');
/** --lossless is mathematically lossless video + PCM audio in an MKV. Huge. Use
 *  when the master will be re-graded or re-encoded several times. */
const LOSSLESS = has('lossless');
const ABR = String(arg('audio-bitrate', MASTER ? '320k' : '192k'));

const sb = await import(pathToFileURL(SB_PATH).href);
const FPS = Number(arg('fps', sb.fps ?? 30));
const DURATION = Number(arg('seconds', sb.duration ?? 20));
const TOTAL = Math.round(FPS * DURATION);
const UI = sb.ui !== false;
const QUALITY = String(arg('q', sb.quality ?? 'ultra'));
const AUDIO = sb.audio === false ? null : (sb.audio ?? { phase: 'day', stage: 3 });

const FRAMES = OUT + '-frames';
await rm(FRAMES, { recursive: true, force: true });
await mkdir(FRAMES, { recursive: true });
await mkdir(path.dirname(OUT), { recursive: true });

const log = (...a) => console.log('[capture]', ...a);
log(`${DURATION}s @ ${FPS}fps = ${TOTAL} frames, ${W}x${H}, q=${QUALITY}, ui=${UI}, audio=${AUDIO ? 'yes' : 'no'}`);

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const base = server.resolvedUrls?.local?.[0];

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=metal',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--force-color-profile=srgb',
    '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`],
});

let wavPath = null;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errs.push('console: ' + m.text().slice(0, 300)); });

  await page.goto(`${base}?shot=1&q=${QUALITY}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__READY !== undefined', { timeout: 120000, polling: 100 });
  await page.evaluate((ui) => window.__game.setUI(ui), UI);

  // Capture mode: we ARE in shot mode (fixed timestep, deterministic) but we want
  // the transient DOM feedback that shot mode normally suppresses — the floating
  // petal-gain numbers that fly to the HUD counter. Modules should treat
  // `window.__CAPTURE` as "shot mode, but render live UI feedback normally":
  //   const suppress = ctx.shotMode && !window.__CAPTURE;
  // Without this the gameplay shot has no visible click reward, which is the whole
  // point of showing the game being played.
  await page.evaluate(() => { window.__CAPTURE = true; });

  // install the storyboard
  if (sb.pageScript) await page.evaluate(sb.pageScript);
  await page.evaluate(() => { window.__STORY?.setup?.(window.__game, window.__ctx); });

  // let shaders compile and the world settle before frame 0
  await page.evaluate(() => window.__game.warm(240));

  const dt = 1 / FPS;
  const t0 = Date.now();
  for (let f = 0; f < TOTAL; f++) {
    const t = f * dt;
    await page.evaluate((t, dt) => {
      window.__STORY?.frame?.(t, window.__game, window.__ctx);
      window.__game.warm(1, dt);      // exactly one fixed step, then draw
    }, t, dt);
    await page.screenshot({ path: path.join(FRAMES, String(f).padStart(5, '0') + '.png'), optimizeForSpeed: true });
    if (f % Math.max(1, Math.round(TOTAL / 10)) === 0) {
      const pct = Math.round((f / TOTAL) * 100);
      const eta = f ? Math.round(((Date.now() - t0) / f) * (TOTAL - f) / 1000) : '?';
      log(`  ${pct}%  frame ${f}/${TOTAL}  eta ${eta}s`);
    }
  }
  log('frames done');

  if (AUDIO) {
    const res = await page.evaluate(async (secs, opts) => {
      const a = window.__ctx?.assets?.audio;
      if (!a?.renderOffline) return { error: 'no renderOffline' };
      const buf = await a.renderOffline(secs, opts);
      if (!buf) return { error: 'renderOffline returned nothing' };
      const ch = buf.numberOfChannels ?? 1;
      return { L: Array.from(buf.getChannelData(0)), R: ch > 1 ? Array.from(buf.getChannelData(1)) : null, sr: buf.sampleRate };
    }, DURATION + 0.5, AUDIO);

    if (res?.error) log('audio skipped:', res.error);
    else {
      const L = res.L, R = res.R, sr = res.sr, n = L.length, chn = R ? 2 : 1;
      const buf = Buffer.alloc(44 + n * chn * 2);
      buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * chn * 2, 4); buf.write('WAVE', 8);
      buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
      buf.writeUInt16LE(chn, 22); buf.writeUInt32LE(sr, 24);
      buf.writeUInt32LE(sr * chn * 2, 28); buf.writeUInt16LE(chn * 2, 32); buf.writeUInt16LE(16, 34);
      buf.write('data', 36); buf.writeUInt32LE(n * chn * 2, 40);
      let p = 44;
      for (let i = 0; i < n; i++) {
        const w = (v) => { const s = Math.max(-1, Math.min(1, v)); buf.writeInt16LE(Math.round(s * 32767), p); p += 2; };
        w(L[i]); if (R) w(R[i]);
      }
      wavPath = OUT + '.wav';
      await writeFile(wavPath, buf);
      log('audio rendered ->', wavPath);
    }
  }

  if (errs.length) console.error('[capture] page errors (first 3):', errs.slice(0, 3));
} finally { await browser.close(); await server.close(); }

/* ------------------------------- encode ------------------------------ */
function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))));
    p.on('error', rej);
  });
}

const ext = LOSSLESS ? '.mkv' : '.mp4';
const outFile = OUT + ext;
const vf = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
const common = ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, '%05d.png')];

let venc;
if (LOSSLESS) {
  // qp 0 = mathematically lossless. yuv444p so chroma is not subsampled either.
  venc = ['-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0',
    '-pix_fmt', 'yuv444p', '-r', String(FPS)];
} else if (MASTER) {
  // Near-transparent master. crf 12 + veryslow + a high bitrate ceiling so the
  // petal-heavy shots keep their detail instead of being the first thing crushed.
  venc = ['-vf', vf, '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '12',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.2',
    '-movflags', '+faststart', '-r', String(FPS)];
} else {
  venc = ['-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF,
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', String(FPS)];
}

// IMPORTANT: never apply loudness gain here. The first demo was boosted +2.5 dB on
// top of an already-hot render and read as harsh. The mix should leave this tool at
// exactly the level the game plays at; normalise later, deliberately, if a platform
// needs it.
const aenc = LOSSLESS ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', ABR];

if (wavPath) await run('ffmpeg', [...common, '-i', wavPath, ...venc, ...aenc, '-shortest', outFile]);
else await run('ffmpeg', [...common, ...venc, outFile]);

if (!KEEP) await rm(FRAMES, { recursive: true, force: true });
const size = (await readFile(outFile)).length;
log(`ok -> ${outFile}  (${(size / 1e6).toFixed(2)} MB, ${DURATION}s, ${FPS}fps, ` +
  `${LOSSLESS ? 'LOSSLESS' : MASTER ? 'MASTER crf12' : 'crf' + CRF}` +
  `${wavPath ? `, audio ${LOSSLESS ? 'pcm' : ABR}` : ', silent'})`);
if (wavPath) log(`     wav kept alongside -> ${wavPath} (remux from this, do not re-gain)`);
if (KEEP) log(`     frames kept -> ${FRAMES}`);
