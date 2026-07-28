#!/usr/bin/env node
/** node /tmp/pfx-region.mjs <png...>  -> bottom-quarter dark/bright quartile mean RGB + hue */
import puppeteer from 'puppeteer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const files = process.argv.slice(2);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'] });
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
      for (let i = 0, p = 0; i < N; i++, p += 4) {
        lum[i] = (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255;
      }
      const yFrom = 0.76;
      const start = Math.floor(yFrom * H) * W;
      const reg = [];
      for (let i = start; i < N; i++) reg.push(lum[i]);
      reg.sort((a, b) => a - b);
      const rp = (q) => reg[Math.floor(q * reg.length)];
      const lo = rp(0.25), hi = rp(0.75);
      const mean = (test) => {
        let n = 0, r = 0, gg = 0, b = 0, A = 0, B = 0, L = 0;
        for (let i = start, p = start * 4; i < N; i++, p += 4) {
          if (!test(lum[i])) continue;
          const rr = d[p] / 255, g2 = d[p + 1] / 255, bb = d[p + 2] / 255;
          r += rr; gg += g2; b += bb; L += lum[i];
          A += rr - g2; B += (rr + g2) / 2 - bb; n++;
        }
        let hue = Math.atan2(B / n, A / n) * 180 / Math.PI; if (hue < 0) hue += 360;
        return {
          n, rgb: [Math.round(r / n * 255), Math.round(gg / n * 255), Math.round(b / n * 255)],
          L: +(L / n).toFixed(3), hue: +hue.toFixed(1),
          chroma: +Math.hypot(A / n, B / n).toFixed(4),
        };
      };
      const D = mean((L) => L <= lo), Br = mean((L) => L >= hi);
      let split = Br.hue - D.hue; while (split > 180) split -= 360; while (split < -180) split += 360;
      return { dark: D, bright: Br, split: +split.toFixed(1), loCut: +lo.toFixed(3), hiCut: +hi.toFixed(3) };
    }, b64);
    console.log(`${f}`);
    console.log(`  dark   rgb ${String(s.dark.rgb).padEnd(15)} L ${s.dark.L}  hue ${s.dark.hue}  chr ${s.dark.chroma}  (cut<=${s.loCut})`);
    console.log(`  bright rgb ${String(s.bright.rgb).padEnd(15)} L ${s.bright.L}  hue ${s.bright.hue}  chr ${s.bright.chroma}  (cut>=${s.hiCut})`);
    console.log(`  split  ${s.split}deg`);
  }
} finally { await browser.close(); }
