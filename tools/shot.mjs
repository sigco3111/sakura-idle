#!/usr/bin/env node
/**
 * Deterministic screenshot harness.
 *
 *   node tools/shot.mjs --out shots/r1 --presets hero,canopy --w 1920 --h 1080 --warm 240
 *
 * Each invocation boots its own Vite dev server on an ephemeral port, so any
 * number of agents can run this concurrently without fighting over a port.
 *
 * Writes  <out>/<preset>.png  plus  <out>/report.json  (console errors, module
 * errors, draw calls, triangle counts, per-frame timing).
 * Exits non-zero if the page threw, so agents cannot mistake a black frame for art.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i === -1 ? d : (argv[i + 1] ?? true);
};
const has = (k) => argv.includes('--' + k);

const OUT = path.resolve(String(arg('out', 'shots/latest')));
const PRESETS = String(arg('presets', 'hero')).split(',').map((s) => s.trim()).filter(Boolean);
const W = Number(arg('w', 1920));
const H = Number(arg('h', 1080));
const WARM = Number(arg('warm', 240));
const DPR = Number(arg('dpr', 1));
const UI = String(arg('ui', '1')) !== '0';
const QUALITY = String(arg('q', 'ultra'));
const SCENARIO = arg('scenario', null);
const FRAMES = Math.max(1, Number(arg('frames', 1)));
const FRAME_GAP = Number(arg('frameGap', 18)); // sim steps (1/60s) between strip frames
const ROOT = path.resolve(import.meta.dirname, '..');
const TIMEOUT = Number(arg('timeout', 90000));

const log = (...a) => console.log('[shot]', ...a);

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
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--disable-dev-shm-usage',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${W},${H}`,
  ],
});

const report = { base, presets: {}, console: [], pageErrors: [], gl: null, ok: true };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR });
  page.on('console', (m) => {
    const t = m.type();
    if (t !== 'error' && t !== 'warning') return;
    const text = m.text();
    if (/favicon/i.test(text)) return;
    report.console.push({ type: t, text: text.slice(0, 800) });
  });
  page.on('pageerror', (e) => report.pageErrors.push(String(e?.stack ?? e).slice(0, 2000)));

  const url = `${base}?shot=1&q=${QUALITY}`;
  log('loading', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  report.gl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { webgl2: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl2: true,
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
      floatBlend: !!gl.getExtension('EXT_float_blend'),
      aniso: !!gl.getExtension('EXT_texture_filter_anisotropic'),
    };
  });

  await page.waitForFunction('window.__READY !== undefined', { timeout: TIMEOUT, polling: 100 });
  const ready = await page.evaluate(() => window.__READY);
  if (ready === 'error') report.ok = false;

  await mkdir(OUT, { recursive: true });

  if (SCENARIO) await page.evaluate((s) => window.__game.scenarios?.[s]?.(), SCENARIO);
  await page.evaluate((ui) => window.__game.setUI(ui), UI);

  // Warm the simulation deterministically once (wind, petal spawn, LOD settle),
  // then per preset re-frame and let motion settle a little more.
  await page.evaluate((n) => window.__game.warm(n), WARM);

  for (const preset of PRESETS) {
    await page.evaluate((p) => { window.__game.setCamera(p); window.__game.warm(24); }, preset);
    // measure frame cost with the camera in place
    const perf = await page.evaluate(() => {
      // Warm caches, then measure with an explicit GPU sync each frame so the
      // number reflects real GPU cost rather than command-queue submission.
      for (let i = 0; i < 5; i++) { window.__game.redraw(); }
      window.__game.syncGPU();
      const t0 = performance.now();
      const N = 20;
      for (let i = 0; i < N; i++) { window.__game.redraw(); window.__game.syncGPU(); }
      const ms = (performance.now() - t0) / N;
      return { msPerFrame: +ms.toFixed(2), fpsEst: +(1000 / ms).toFixed(1), ...window.__game.info() };
    });
    const files = [];
    // FRAMES > 1 captures a motion strip: same camera, sim advanced between shots.
    // Critics need this to judge wind coherence, petal tumble and idle life.
    for (let f = 0; f < FRAMES; f++) {
      if (f > 0) await page.evaluate((n) => window.__game.warm(n), FRAME_GAP);
      const name = FRAMES === 1 ? `${preset}.png` : `${preset}-f${f}.png`;
      const file = path.join(OUT, name);
      await page.screenshot({ path: file, type: 'png', optimizeForSpeed: false });
      files.push(file);
    }
    report.presets[preset] = { file: files[0], files, ...perf };
    log(preset, '→', files.length > 1 ? `${files.length} frames` : files[0],
      `${perf.msPerFrame}ms`, `${perf.drawCalls} calls`, `${perf.triangles} tris`);
  }

  const modErrors = await page.evaluate(() => window.__errors ?? []);
  report.moduleErrors = modErrors;
  if (modErrors.length || report.pageErrors.length) report.ok = false;
} catch (e) {
  report.ok = false;
  report.fatal = String(e?.stack ?? e);
  console.error('[shot] FATAL', e);
} finally {
  await browser.close();
  await server.close();
}

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

if (!report.ok) {
  console.error('[shot] FAILED — see', path.join(OUT, 'report.json'));
  console.error(JSON.stringify({ pageErrors: report.pageErrors, moduleErrors: report.moduleErrors, fatal: report.fatal }, null, 2));
  process.exit(1);
}
log('ok →', OUT);
