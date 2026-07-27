#!/usr/bin/env node
/**
 * Objective image statistics — a mechanical gate that complements the subjective
 * art critique. Several of the ART_BIBLE "instant-fail tells" are measurable, and
 * measuring them stops a reviewer from talking themselves into a pass.
 *
 *   node tools/stats.mjs shots/critic-r1/hero.png [more.png ...]
 *   node tools/stats.mjs --json shots/**\/hero.png
 *
 * Reported per image:
 *   lum p1/p50/p99      luminance percentiles (0..1)
 *   crushed             fraction of pixels with L < 0.02   -> pure-black shadows (fail > 0.005)
 *   blown               fraction with L > 0.985            -> clipped highlights (fail > 0.02)
 *   satMean             mean HSL saturation                -> muddy if < 0.20
 *   flatBlocks          fraction of 16x16 blocks with stddev < 0.012
 *                                                          -> empty/undetailed pixels (fail > 0.28)
 *   detail              mean Sobel gradient magnitude      -> overall micro-detail
 *   shadowHue/Chroma    hue(deg)/chroma of the darkest 25% of the WHOLE frame
 *   highlightHue/Chroma hue(deg)/chroma of the brightest 25% of the WHOLE frame
 *                       (outdoors these are dominated by the sky — informational only)
 *   groundSplitTone     the meaningful one: hue difference between the bright and dark
 *                       quartiles of the BOTTOM QUARTER of frame (lit surfaces, no sky),
 *                       with percentiles computed within that region. Near 0 means lit and
 *                       shadowed surfaces share a hue — the flat look ART_BIBLE 2 forbids.
 *                       Want shadows cool (~170-290) and highlights warm (~0-80).
 *                       Meaningless for the upward-looking 'canopy' preset.
 *   uniqueColors        distinct quantised colours (5-bit)  -> banding / flat art check
 *
 * Exits 1 if any HARD threshold is violated, so it can be used as a gate.
 */
import puppeteer from 'puppeteer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const files = argv.filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: node tools/stats.mjs <png> [...]'); process.exit(2); }

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'] });
const results = [];
try {
  const page = await browser.newPage();
  for (const f of files) {
    const b64 = 'data:image/png;base64,' + (await readFile(path.resolve(f))).toString('base64');
    const s = await page.evaluate(async (src) => {
      const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
      const W = Math.min(im.width, 960);
      const H = Math.round(im.height * (W / im.width));
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const N = W * H;

      const lum = new Float32Array(N);
      const sat = new Float32Array(N);
      let satSum = 0;
      const colorSet = new Set();
      for (let i = 0, p = 0; i < N; i++, p += 4) {
        const r = d[p] / 255, gg = d[p + 1] / 255, b = d[p + 2] / 255;
        const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        lum[i] = L;
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        const l2 = (mx + mn) / 2;
        const S = mx === mn ? 0 : (mx - mn) / (l2 > 0.5 ? 2 - mx - mn : mx + mn);
        sat[i] = S; satSum += S;
        colorSet.add(((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3));
      }

      const sorted = Float32Array.from(lum).sort();
      const pct = (q) => sorted[Math.min(N - 1, Math.max(0, Math.floor(q * N)))];
      let crushed = 0, blown = 0;
      for (let i = 0; i < N; i++) { if (lum[i] < 0.02) crushed++; if (lum[i] > 0.985) blown++; }

      // Hue/chroma of the darkest and brightest quartiles, in a perceptual-ish
      // space: mean the a*/b*-like opponent channels, then convert to hue.
      const loCut = pct(0.25), hiCut = pct(0.75);
      // yFrom lets us exclude the sky: outdoors the sky is both the brightest and
      // the coolest thing in frame, which inverts a naive split-tone reading. The
      // meaningful measurement is on lit surfaces, i.e. the lower part of the frame.
      const bucket = (test, yFrom = 0) => {
        let n = 0, A = 0, B = 0;
        const start = Math.floor(yFrom * H) * W;
        for (let i = start, p = start * 4; i < N; i++, p += 4) {
          if (!test(lum[i])) continue;
          const r = d[p] / 255, gg = d[p + 1] / 255, b = d[p + 2] / 255;
          A += r - gg;                    // red-green opponent
          B += (r + gg) / 2 - b;          // yellow-blue opponent
          n++;
        }
        if (!n) return { hue: 0, chroma: 0, n: 0 };
        A /= n; B /= n;
        let hue = Math.atan2(B, A) * 180 / Math.PI;
        if (hue < 0) hue += 360;
        return { hue: +hue.toFixed(1), chroma: +Math.hypot(A, B).toFixed(4), n };
      };
      const shadow = bucket((L) => L <= loCut);
      const highlight = bucket((L) => L >= hiCut);
      // Ground-only variants (lower 45% of frame) — this is the pair that actually
      // tests ART_BIBLE section 2's hue-shifted shadows.
      // Percentiles must be computed WITHIN the region, otherwise the global p75
      // cut only ever selects sky pixels and the reading stays inverted.
      const yFrom = 0.76;   // bottom quarter: ground/trunk/water in every ground-containing preset
      const regionLum = [];
      for (let i = Math.floor(yFrom * H) * W; i < N; i++) regionLum.push(lum[i]);
      regionLum.sort((a, b) => a - b);
      const rpct = (q) => regionLum[Math.min(regionLum.length - 1, Math.max(0, Math.floor(q * regionLum.length)))];
      const rLo = rpct(0.25), rHi = rpct(0.75);
      const gShadow = bucket((L) => L <= rLo, yFrom);
      const gHighlight = bucket((L) => L >= rHi, yFrom);
      let gSplit = gHighlight.hue - gShadow.hue;
      while (gSplit > 180) gSplit -= 360;
      while (gSplit < -180) gSplit += 360;

      // Flatness: 16x16 blocks whose luminance stddev is negligible.
      const BS = 16; let flat = 0, blocks = 0;
      for (let by = 0; by + BS <= H; by += BS) for (let bx = 0; bx + BS <= W; bx += BS) {
        let m = 0, m2 = 0;
        for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) {
          const L = lum[(by + y) * W + bx + x]; m += L; m2 += L * L;
        }
        const n = BS * BS; const mean = m / n;
        const sd = Math.sqrt(Math.max(0, m2 / n - mean * mean));
        if (sd < 0.012) flat++;
        blocks++;
      }

      // Sobel gradient magnitude = micro-detail proxy.
      let grad = 0, gn = 0;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const at = (xx, yy) => lum[yy * W + xx];
        const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
        const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
        grad += Math.hypot(gx, gy); gn++;
      }

      let split = highlight.hue - shadow.hue;
      while (split > 180) split -= 360;
      while (split < -180) split += 360;

      return {
        w: im.width, h: im.height,
        lumP1: +pct(0.01).toFixed(4), lumP50: +pct(0.5).toFixed(4), lumP99: +pct(0.99).toFixed(4),
        crushed: +(crushed / N).toFixed(5), blown: +(blown / N).toFixed(5),
        satMean: +(satSum / N).toFixed(4),
        flatBlocks: +(flat / blocks).toFixed(4),
        detail: +(grad / gn).toFixed(4),
        shadowHue: shadow.hue, shadowChroma: shadow.chroma,
        highlightHue: highlight.hue, highlightChroma: highlight.chroma,
        splitTone: +split.toFixed(1),
        groundShadowHue: gShadow.hue, groundShadowChroma: gShadow.chroma,
        groundHighlightHue: gHighlight.hue, groundHighlightChroma: gHighlight.chroma,
        groundSplitTone: +gSplit.toFixed(1),
        uniqueColors: colorSet.size,
      };
    }, b64);
    results.push({ file: f, ...s });
  }
} finally { await browser.close(); }

// Hard gates. Deliberately lenient — these catch gross failures, not taste.
const GATES = [
  ['crushed', (v) => v <= 0.005, 'pure-black shadows (ART_BIBLE: never below ~0.055 luminance)'],
  ['blown', (v) => v <= 0.02, 'clipped highlights beyond specular cores'],
  ['satMean', (v) => v >= 0.18, 'muddy / desaturated image'],
  ['flatBlocks', (v) => v <= 0.28, 'large flat undetailed regions ("no empty pixel" law)'],
  ['detail', (v) => v >= 0.035, 'insufficient micro-detail'],
];

let failed = 0;
if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`\n${r.file}  (${r.w}x${r.h})`);
    console.log(`  lum p1/p50/p99   ${r.lumP1} / ${r.lumP50} / ${r.lumP99}`);
    console.log(`  crushed / blown  ${r.crushed} / ${r.blown}`);
    console.log(`  satMean          ${r.satMean}`);
    console.log(`  flatBlocks       ${r.flatBlocks}`);
    console.log(`  detail (sobel)   ${r.detail}`);
    console.log(`  whole frame      shadowHue ${r.shadowHue}deg  highlightHue ${r.highlightHue}deg  split ${r.splitTone}deg`);
    console.log(`                   (sky dominates the bright quartile outdoors — read the next line instead)`);
    console.log(`                   NOTE: LIT SURFACES = bottom quarter of frame. Meaningless for the 'canopy' preset.`);
    console.log(`  LIT SURFACES     shadowHue ${r.groundShadowHue}deg (chr ${r.groundShadowChroma})  highlightHue ${r.groundHighlightHue}deg (chr ${r.groundHighlightChroma})`);
    console.log(`  groundSplitTone  ${r.groundSplitTone}deg`);
    console.log(`                   hue guide: ~0-80 warm (red/orange/yellow), ~90-160 green,`);
    console.log(`                   ~170-290 cool (cyan/blue/violet). ART_BIBLE wants lit-surface`);
    console.log(`                   shadows COOL and highlights WARM, i.e. groundSplitTone strongly`);
    console.log(`                   NEGATIVE (highlights at a lower/warmer hue than cool shadows).`);
    console.log(`  uniqueColors     ${r.uniqueColors}`);
  }
}
for (const r of results) {
  for (const [k, ok, why] of GATES) {
    if (!ok(r[k])) { console.error(`GATE FAIL ${path.basename(path.dirname(r.file))}/${path.basename(r.file)}  ${k}=${r[k]}  — ${why}`); failed++; }
  }
}
if (failed) { console.error(`\n${failed} gate failure(s).`); process.exit(1); }
if (!JSON_OUT) console.log('\nall gates pass');
