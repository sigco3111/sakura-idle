import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
export function readPng(file){
  const buf = readFileSync(file);
  let p = 8, w=0,h=0,bd=0,ct=0; const idat=[];
  while (p < buf.length){
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p+4, p+8);
    const data = buf.subarray(p+8, p+8+len);
    if (type==='IHDR'){ w=data.readUInt32BE(0); h=data.readUInt32BE(4); bd=data[8]; ct=data[9]; }
    else if (type==='IDAT') idat.push(data);
    else if (type==='IEND') break;
    p += 12+len;
  }
  if (bd!==8) throw new Error('bitdepth '+bd);
  const ch = ct===6?4:ct===2?3:ct===0?1:ct===4?2:0;
  if(!ch) throw new Error('colortype '+ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w*ch;
  const out = Buffer.alloc(h*stride);
  let ip=0;
  for (let y=0;y<h;y++){
    const f = raw[ip++]; const line = raw.subarray(ip, ip+stride); ip+=stride;
    const cur = out.subarray(y*stride, y*stride+stride);
    const prev = y>0 ? out.subarray((y-1)*stride, (y-1)*stride+stride) : null;
    for (let x=0;x<stride;x++){
      const a = x>=ch ? cur[x-ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x>=ch) ? prev[x-ch] : 0;
      let v = line[x];
      if (f===1) v += a; else if (f===2) v += b; else if (f===3) v += (a+b)>>1;
      else if (f===4){ const pa=Math.abs(b-c), pb=Math.abs(a-c), pc=Math.abs(a+b-2*c);
        v += (pa<=pb&&pa<=pc)?a:(pb<=pc?b:c); }
      cur[x]=v&255;
    }
  }
  return { w,h,ch,data:out };
}
export function px(img,x,y){ const k=(y*img.w+x)*img.ch; return [img.data[k],img.data[k+1],img.data[k+2]]; }
export function hsl(R,G,B){ R/=255;G/=255;B/=255;
  const mx=Math.max(R,G,B),mn=Math.min(R,G,B),d=mx-mn;
  let hue=0; if(d>1e-6){ if(mx===R)hue=60*(((G-B)/d)%6); else if(mx===G)hue=60*((B-R)/d+2); else hue=60*((R-G)/d+4); if(hue<0)hue+=360; }
  const l=(mx+mn)/2; const sat=d<=1e-6?0:d/(l>0.5?2-mx-mn:mx+mn);
  return { hue, sat, l, lum:0.2126*R+0.7152*G+0.0722*B, mx:mx===R?'R':mx===G?'G':'B' };
}
