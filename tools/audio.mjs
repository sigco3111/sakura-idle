#!/usr/bin/env node
/**
 * Audio harness — the ear the agents don't have.
 *
 *   node tools/audio.mjs --out .tmp-orch/audio/day.wav --seconds 30 --phase day --stage 3
 *
 * Renders the game's own audio graph offline (faster than realtime) via
 * ctx.assets.audio.renderOffline(), writes a 16-bit WAV a human can listen to,
 * and prints objective metrics. Several of "it sounds horrible" failure modes are
 * measurable, which is what lets an agent that cannot hear iterate honestly:
 *
 *   clipping      samples at |x| >= 0.999           -> distortion. MUST be 0.
 *   peak / rms    level and headroom                -> peak <= 0.9, rms 0.02-0.20
 *   crest         peak/rms                          -> very low = squashed/buzzy
 *   dc            mean sample value                 -> should be ~0
 *   centroid      mean spectral centroid, Hz        -> "brightness". Calm ambient
 *                                                      wants <= ~1800 Hz.
 *   hfRatio       energy above 5 kHz / total        -> the screech metric. <= 0.06
 *   harshRatio    energy 2-5 kHz / total            -> the ear-fatigue band. <= 0.22
 *   flatness      spectral flatness (geo/arith mean)-> ~0 pure tone, ~1 white noise.
 *                                                      A loud narrow tone reads as
 *                                                      a screech; want 0.05-0.55.
 *   flux          mean spectral flux                -> how abruptly timbre changes.
 *                                                      Calm ambient wants it low.
 *   silence       fraction of frames below -60 dBFS -> long gaps = broken graph
 *
 * Exit code is non-zero if a hard gate fails, so it can be used like shot.mjs.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };

const OUT = path.resolve(String(arg('out', '.tmp-orch/audio/out.wav')));
const SECONDS = Number(arg('seconds', 30));
const PHASE = String(arg('phase', 'day'));
const STAGE = Number(arg('stage', 3));
const RATE = Number(arg('rate', 44100));
const JSON_OUT = argv.includes('--json');
const ROOT = path.resolve(import.meta.dirname, '..');

/* ------------------------------ render ------------------------------ */
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const base = server.resolvedUrls?.local?.[0];
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=metal',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

let pcm = null, meta = null;
try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  await page.goto(`${base}?shot=1&q=high`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY !== undefined', { timeout: 90000, polling: 100 });

  const res = await page.evaluate(async (seconds, phase, stage, rate) => {
    const a = window.__ctx?.assets?.audio;
    if (!a) return { error: 'ctx.assets.audio is not published' };
    if (typeof a.renderOffline !== 'function') {
      return { error: 'ctx.assets.audio.renderOffline(seconds, opts) is not implemented — see tools/audio.mjs header' };
    }
    const buf = await a.renderOffline(seconds, { phase, stage, sampleRate: rate });
    if (!buf) return { error: 'renderOffline returned nothing' };
    const chans = buf.numberOfChannels ?? 1;
    const L = Array.from(buf.getChannelData ? buf.getChannelData(0) : buf[0]);
    const R = chans > 1 ? Array.from(buf.getChannelData(1)) : null;
    return { L, R, sampleRate: buf.sampleRate ?? rate, chans };
  }, SECONDS, PHASE, STAGE, RATE);

  if (res?.error) { console.error('[audio] FAILED:', res.error); process.exitCode = 2; }
  else { pcm = res; meta = { sampleRate: res.sampleRate, chans: res.chans, pageErrors: errs }; }
  if (errs.length) console.error('[audio] page errors:', errs.slice(0, 3));
} finally { await browser.close(); await server.close(); }

if (!pcm) process.exit(process.exitCode || 1);

/* ------------------------------ analyse ----------------------------- */
const L = Float32Array.from(pcm.L);
const R = pcm.R ? Float32Array.from(pcm.R) : null;
const sr = pcm.sampleRate;
const mono = new Float32Array(L.length);
for (let i = 0; i < L.length; i++) mono[i] = R ? (L[i] + R[i]) / 2 : L[i];

let peak = 0, sum = 0, sumSq = 0, clip = 0;
for (let i = 0; i < mono.length; i++) {
  const v = mono[i], a = Math.abs(v);
  if (a > peak) peak = a;
  if (a >= 0.999) clip++;
  sum += v; sumSq += v * v;
}
const rms = Math.sqrt(sumSq / mono.length);
const dc = sum / mono.length;

// radix-2 FFT (no dependencies)
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const N = 2048, HOP = 1024;
const win = new Float32Array(N);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

let frames = 0, centroidAcc = 0, hfAcc = 0, harshAcc = 0, totAcc = 0;
let flatAcc = 0, fluxAcc = 0, silent = 0;
let prevMag = null;
for (let off = 0; off + N <= mono.length; off += HOP) {
  const re = new Float64Array(N), im = new Float64Array(N);
  let frameE = 0;
  for (let i = 0; i < N; i++) { re[i] = mono[off + i] * win[i]; frameE += mono[off + i] ** 2; }
  if (Math.sqrt(frameE / N) < 0.001) silent++;      // < -60 dBFS
  fft(re, im);
  const bins = N / 2;
  const mag = new Float64Array(bins);
  let mSum = 0, wSum = 0, logSum = 0, hf = 0, harsh = 0, tot = 0;
  for (let k = 1; k < bins; k++) {
    const m = Math.hypot(re[k], im[k]);
    mag[k] = m;
    const f = (k * sr) / N;
    mSum += m; wSum += m * f;
    logSum += Math.log(m + 1e-12);
    tot += m * m;
    if (f > 5000) hf += m * m;
    if (f >= 2000 && f <= 5000) harsh += m * m;
  }
  if (mSum > 1e-9) {
    centroidAcc += wSum / mSum;
    const geo = Math.exp(logSum / (bins - 1));
    const arith = mSum / (bins - 1);
    flatAcc += geo / (arith + 1e-12);
    hfAcc += hf; harshAcc += harsh; totAcc += tot;
    if (prevMag) {
      let fl = 0;
      for (let k = 1; k < bins; k++) { const d = mag[k] - prevMag[k]; if (d > 0) fl += d; }
      fluxAcc += fl / (mSum + 1e-9);
    }
    prevMag = mag;
    frames++;
  }
}

const m = {
  seconds: +(mono.length / sr).toFixed(2),
  sampleRate: sr, channels: pcm.chans,
  peak: +peak.toFixed(4), rms: +rms.toFixed(5), crest: +(peak / (rms || 1e-9)).toFixed(2),
  dc: +dc.toFixed(6), clipping: clip,
  centroidHz: Math.round(centroidAcc / Math.max(frames, 1)),
  hfRatio: +(hfAcc / Math.max(totAcc, 1e-12)).toFixed(4),
  harshRatio: +(harshAcc / Math.max(totAcc, 1e-12)).toFixed(4),
  flatness: +(flatAcc / Math.max(frames, 1)).toFixed(4),
  flux: +(fluxAcc / Math.max(frames - 1, 1)).toFixed(4),
  silenceFrac: +(silent / Math.max(frames, 1)).toFixed(3),
};

/* ------------------------------- WAV -------------------------------- */
const ch = R ? 2 : 1;
const n = L.length;
const buf = Buffer.alloc(44 + n * ch * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(sr, 24);
buf.writeUInt32LE(sr * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
let p = 44;
for (let i = 0; i < n; i++) {
  const w = (v) => { const s = Math.max(-1, Math.min(1, v)); buf.writeInt16LE(Math.round(s * 32767), p); p += 2; };
  w(L[i]); if (R) w(R[i]);
}
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, buf);

/* ------------------------------ gates ------------------------------- */
const GATES = [
  ['clipping', m.clipping === 0, `${m.clipping} clipped samples — audible distortion`],
  ['peak', m.peak <= 0.92, `peak ${m.peak} — leave headroom, target <= 0.92`],
  ['rms', m.rms >= 0.008 && m.rms <= 0.22, `rms ${m.rms} — target 0.008-0.22 (too quiet or too hot)`],
  ['dc', Math.abs(m.dc) <= 0.02, `dc offset ${m.dc} — should be ~0`],
  ['hfRatio', m.hfRatio <= 0.06, `hfRatio ${m.hfRatio} — energy above 5 kHz; THE screech metric, target <= 0.06`],
  ['harshRatio', m.harshRatio <= 0.22, `harshRatio ${m.harshRatio} — 2-5 kHz ear-fatigue band, target <= 0.22`],
  ['centroidHz', m.centroidHz <= 1800, `centroid ${m.centroidHz} Hz — too bright for calm ambient, target <= 1800`],
  ['flatness', m.flatness >= 0.02 && m.flatness <= 0.60, `flatness ${m.flatness} — <0.02 is a bare screeching tone, >0.60 is hiss`],
  ['flux', m.flux <= 0.42, `flux ${m.flux} — timbre changing too abruptly for zen ambient`],
  ['silenceFrac', m.silenceFrac <= 0.25, `${(m.silenceFrac * 100).toFixed(0)}% of frames near-silent — graph may be broken`],
];

if (JSON_OUT) console.log(JSON.stringify({ ...m, wav: OUT }, null, 2));
else {
  console.log(`\n[audio] ${OUT}  (${m.seconds}s, ${m.sampleRate} Hz, ${m.channels}ch, phase=${PHASE} stage=${STAGE})`);
  for (const [k, v] of Object.entries(m)) console.log(`  ${k.padEnd(12)} ${v}`);
}
let bad = 0;
for (const [k, ok, why] of GATES) if (!ok) { console.error(`GATE FAIL  ${k}: ${why}`); bad++; }
if (bad) { console.error(`\n${bad} audio gate failure(s). Listen to ${OUT}.`); process.exit(1); }
console.log('\nall audio gates pass');
