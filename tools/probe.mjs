#!/usr/bin/env node
/**
 * Live-scene probe. Boots the game headlessly and evaluates an expression
 * against window.__game / window.__ctx, printing the JSON result.
 *
 *   node tools/probe.mjs "ctx.assets.lightRig.sun.position.toArray()"
 *   node tools/probe.mjs --file tools/probes/shadows.js
 *
 * Far cheaper than reading shader source when you need to know what the
 * renderer actually decided at runtime.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const FILE = arg('file', null);
const WARM = Number(arg('warm', 300));
const SCENARIO = arg('scenario', null);
const expr = FILE ? await readFile(path.resolve(FILE), 'utf8') : argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--file' && argv[argv.indexOf(a) - 1] !== '--warm' && argv[argv.indexOf(a) - 1] !== '--scenario').join(' ');
if (!expr) { console.error('need an expression or --file'); process.exit(2); }

const ROOT = path.resolve(import.meta.dirname, '..');
const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error', server: { port: 0, strictPort: false, host: '127.0.0.1' } });
await server.listen();
const base = server.resolvedUrls?.local?.[0];
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=metal', '--ignore-gpu-blocklist', '--force-color-profile=srgb'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`${base}?shot=1&q=ultra`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY !== undefined', { timeout: 90000, polling: 100 });
  if (SCENARIO) await page.evaluate((s) => window.__game.scenarios?.[s]?.(), SCENARIO);
  await page.evaluate((n) => window.__game.warm(n), WARM);
  const out = await page.evaluate(`(() => { const ctx = window.__ctx; const game = window.__game; const THREE = game.THREE;
    try { return JSON.stringify(${expr.includes('return') ? `(() => { ${expr} })()` : `(${expr})`}, (k,v) => typeof v === 'number' ? +v.toFixed(5) : v, 2); }
    catch (e) { return 'PROBE ERROR: ' + (e && e.stack || e); } })()`);
  console.log(out);
  if (errs.length) console.error('page errors:', errs.slice(0, 3));
} finally { await browser.close(); await server.close(); }
