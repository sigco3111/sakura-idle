import { readPng, hsl } from './png.mjs';
const [file, ...r] = process.argv.slice(2);
const img = readPng(file);
const B = r.length===4 ? r.map(Number) : [0,0,img.w,img.h];
const L=[], ys=[]; let sr=0,sg=0,sb=0,n=0;
const rows = new Map();
for(let y=B[1];y<B[3];y++) for(let x=B[0];x<B[2];x++){
  const k=(y*img.w+x)*img.ch; const R=img.data[k],G=img.data[k+1],Bl=img.data[k+2];
  const c=hsl(R,G,Bl);
  if(!(c.mx==='R' && (c.hue>=290||c.hue<=25) && c.sat>0.05)) continue;
  L.push(c.lum); ys.push(y); sr+=R;sg+=G;sb+=Bl;n++;
  if(!rows.has(y)) rows.set(y,[]); rows.get(y).push(c.lum);
}
L.sort((a,b)=>a-b);
const pct=p=>L.length?L[Math.min(L.length-1,Math.floor(p*L.length))]:0;
const yy=[...ys].sort((a,b)=>a-b);
const yA=yy[Math.floor(yy.length*0.03)], yB=yy[Math.floor(yy.length*0.97)];
const span=yB-yA;
const band=(f0,f1)=>{ let s=0,c=0; for(const [y,arr] of rows){ const t=(y-yA)/span; if(t>=f0&&t<f1){ for(const v of arr){s+=v;c++;} } } return c?s/c:0; };
const mean=(0.2126*sr+0.7152*sg+0.0722*sb)/n/255;
console.log(`canopy px=${n}  mean=${mean.toFixed(4)} rgb=${Math.round(sr/n)},${Math.round(sg/n)},${Math.round(sb/n)}`);
console.log(`  p02=${pct(0.02).toFixed(3)} p10=${pct(0.10).toFixed(3)} p25=${pct(0.25).toFixed(3)} p50=${pct(0.50).toFixed(3)} p90=${pct(0.90).toFixed(3)} p99=${pct(0.99).toFixed(3)}`);
console.log(`  yspan=${yA}..${yB}  topBand(0-0.18)=${band(0,0.18).toFixed(4)}  botBand(0.82-1)=${band(0.82,1.001).toFixed(4)}  ratio=${(band(0.82,1.001)/band(0,0.18)).toFixed(3)}`);
