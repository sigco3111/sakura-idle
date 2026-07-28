#!/usr/bin/env node
/**
 * Pixel probe: node /tmp/sak-px.mjs <png> <x,y,w,h> [more rects...]
 * Also supports:  --col x        (dump a vertical column of luminance)
 *                 --row y        (dump a horizontal row)
 *                 --edge y0,y1   (find, per column, the y in [y0,y1] of max vertical gradient; report longest run of equal y)
 *                 --flat y0,y1   (16x16 block stddev census in a band)
 */
import puppeteer from 'puppeteer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const file = argv[0];
const rest = argv.slice(1);
const b64 = 'data:image/png;base64,' + (await readFile(path.resolve(file))).toString('base64');
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'] });
const page = await browser.newPage();
const out = await page.evaluate(async (src, args) => {
  const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const W = im.width, H = im.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = (i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
  const lines = [`size ${W}x${H}`];
  const hueOf = (r, gg, b) => {
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), dd = mx - mn;
    if (dd < 1e-6) return 0;
    let h;
    if (mx === r) h = ((gg - b) / dd) % 6; else if (mx === gg) h = (b - r) / dd + 2; else h = (r - gg) / dd + 4;
    h *= 60; return (h + 360) % 360;
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--col' || a === '--row') {
      const v = parseInt(args[i + 1], 10); i += 2;
      const n = a === '--col' ? H : W;
      const vals = [];
      for (let k = 0; k < n; k += 8) {
        const idx = a === '--col' ? (k * W + v) * 4 : (v * W + k) * 4;
        vals.push(k + ':' + L(idx).toFixed(3));
      }
      lines.push(`${a} ${v} ` + vals.join(' '));
    } else if (a === '--edge') {
      const [y0, y1] = args[i + 1].split(',').map(Number); i += 2;
      const ys = new Int32Array(W);
      for (let x = 0; x < W; x++) {
        let best = -1, by = -1;
        for (let y = y0 + 1; y < y1; y++) {
          const gv = Math.abs(L(((y + 2) * W + x) * 4) - L(((y - 2) * W + x) * 4));
          if (gv > best) { best = gv; by = y; }
        }
        ys[x] = by;
      }
      // longest run where the edge y stays within +-1 of the run's start
      let bestRun = 0, cur = 1, runStart = 0, bestStart = 0;
      for (let x = 1; x < W; x++) {
        if (Math.abs(ys[x] - ys[runStart]) <= 1) { cur++; } else { if (cur > bestRun) { bestRun = cur; bestStart = runStart; } runStart = x; cur = 1; }
      }
      if (cur > bestRun) { bestRun = cur; bestStart = runStart; }
      // also: longest run of strictly identical y
      let br2 = 0, c2 = 1;
      for (let x = 1; x < W; x++) { if (ys[x] === ys[x - 1]) c2++; else { if (c2 > br2) br2 = c2; c2 = 1; } }
      if (c2 > br2) br2 = c2;
      lines.push(`edge y${y0}-${y1}: longestRun(+-1px)=${bestRun}@x${bestStart} y=${ys[bestStart]} longestIdentical=${br2} sample=${[0, 240, 480, 720, 960, 1200, 1440, 1680, 1900].map((x) => `${x}:${ys[x]}`).join(' ')}`);
    } else if (a === '--flat') {
      const [y0, y1] = args[i + 1].split(',').map(Number); i += 2;
      let tot = 0, flat = 0, minsd = 9, minat = '';
      for (let by = y0; by + 16 <= y1; by += 16) {
        for (let bx = 0; bx + 16 <= W; bx += 16) {
          let s = 0, s2 = 0;
          for (let y = by; y < by + 16; y++) for (let x = bx; x < bx + 16; x++) { const l = L((y * W + x) * 4); s += l; s2 += l * l; }
          const m = s / 256, sd = Math.sqrt(Math.max(0, s2 / 256 - m * m));
          tot++; if (sd < 0.012) flat++;
          if (sd < minsd) { minsd = sd; minat = `${bx},${by}`; }
        }
      }
      lines.push(`flat y${y0}-${y1}: ${flat}/${tot} blocks sd<0.012  minSd=${minsd.toFixed(4)}@${minat}`);
    } else if (a === '--prof') {
      // per-pixel luminance profile along a row: --prof y,x0,x1
      const [y, x0, x1] = args[i + 1].split(',').map(Number); i += 2;
      const vals = [];
      for (let x = x0; x <= x1; x++) vals.push(L((y * W + x) * 4).toFixed(3));
      lines.push(`prof y=${y} x${x0}-${x1}: ${vals.join(',')}`);
    } else if (a === '--pct') {
      // percentiles inside a rect: --pct x,y,w,h
      const [x, y, w, h] = args[i + 1].split(',').map(Number); i += 2;
      const arr = [];
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) arr.push(L((yy * W + xx) * 4));
      arr.sort((p, q) => p - q);
      const P = (f) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))].toFixed(3);
      lines.push(`pct ${x},${y},${w},${h}: p5=${P(0.05)} p10=${P(0.10)} p25=${P(0.25)} p50=${P(0.5)} p75=${P(0.75)} p90=${P(0.90)} p95=${P(0.95)}`);
    } else if (a === '--crop') {
      const [x, y, w, h, sc, outName] = args[i + 1].split(','); i += 2;
      const S = Number(sc) || 2;
      const c2 = document.createElement('canvas');
      c2.width = Number(w) * S; c2.height = Number(h) * S;
      const g2 = c2.getContext('2d');
      g2.imageSmoothingEnabled = false;
      g2.drawImage(c, Number(x), Number(y), Number(w), Number(h), 0, 0, c2.width, c2.height);
      lines.push(`CROPDATA ${outName} ${c2.toDataURL('image/png')}`);
    } else {
      const [x, y, w, h] = a.split(',').map(Number); i += 1;
      let r = 0, gg = 0, b = 0, l = 0, n = 0;
      for (let yy = y; yy < y + (h || 1); yy++) for (let xx = x; xx < x + (w || 1); xx++) {
        const idx = (yy * W + xx) * 4; r += d[idx]; gg += d[idx + 1]; b += d[idx + 2]; l += L(idx); n++;
      }
      r /= n; gg /= n; b /= n; l /= n;
      const hex = '#' + [r, gg, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
      lines.push(`${a} ${hex} L=${l.toFixed(3)} hue=${hueOf(r / 255, gg / 255, b / 255).toFixed(1)}`);
    }
  }
  return lines.join('\n');
}, b64, rest);
const { writeFile } = await import('node:fs/promises');
for (const line of out.split('\n')) {
  if (line.startsWith('CROPDATA ')) {
    const [, name, url] = line.split(' ');
    await writeFile(name, Buffer.from(url.split(',')[1], 'base64'));
    console.log('wrote ' + name);
  } else console.log(line);
}
await browser.close();
