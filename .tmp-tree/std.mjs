import { readPng, hsl } from './png.mjs';
const [file, x0,y0,w,h] = process.argv.slice(2);
const img = readPng(file);
const X=+x0,Y=+y0,W=+w,H=+h;
const v=[]; let sr=0,sg=0,sb=0;
for(let y=Y;y<Y+H;y++)for(let x=X;x<X+W;x++){const k=(y*img.w+x)*img.ch;
  const c=hsl(img.data[k],img.data[k+1],img.data[k+2]); v.push(c.lum); sr+=img.data[k];sg+=img.data[k+1];sb+=img.data[k+2];}
const n=v.length, m=v.reduce((a,b)=>a+b,0)/n;
const sd=Math.sqrt(v.reduce((a,b)=>a+(b-m)*(b-m),0)/n);
// macro component: box-blur to 24px blocks, stddev of block means
const bs=24, bw=Math.floor(W/bs), bh=Math.floor(H/bs), bm=[];
for(let j=0;j<bh;j++)for(let i=0;i<bw;i++){let s=0,c=0;
  for(let y=0;y<bs;y++)for(let x=0;x<bs;x++){s+=v[(j*bs+y)*W+(i*bs+x)];c++;} bm.push(s/c);}
const bmu=bm.reduce((a,b)=>a+b,0)/bm.length;
const bsd=Math.sqrt(bm.reduce((a,b)=>a+(b-bmu)*(b-bmu),0)/bm.length);
console.log(`crop ${X},${Y} ${W}x${H}  mean=${m.toFixed(4)} rgb=${Math.round(sr/n)},${Math.round(sg/n)},${Math.round(sb/n)}  stddev=${sd.toFixed(4)}  macroStd(24px blocks)=${bsd.toFixed(4)}`);
