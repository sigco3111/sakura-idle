/**
 * GLSL for the post-processing chain (owned by the postfx agent, 90-postfx.js).
 *
 * Every shader here is a plain `{ name, defines, uniforms, vertexShader, fragmentShader }`
 * object, i.e. the same shape three's own `ShaderPass` accepts. All of them are
 * GLSL1 (texture2D / gl_FragColor) to match three's bundled passes.
 *
 * Conventions used throughout:
 *   - The scene is rendered into a HalfFloat linear-HDR target with a real depth
 *     texture attached, so every effect that needs geometry (AO, god rays, DOF)
 *     reads *the same* depth as the colour it is filtering. No extra geometry pass,
 *     which also means wind-displaced vertices (grass, petals, twigs) line up.
 *   - `uProjInv` is the *jittered* inverse projection matrix of the frame that
 *     produced the depth buffer — position reconstruction is therefore exact.
 *   - Everything is linear HDR up to and including GRADE_SHADER, which tonemaps,
 *     grades, dithers and encodes to sRGB. Passes after it (SMAA, FINAL) work in
 *     display space.
 *   - **Every stochastic pass that runs AFTER the TAA resolve uses white noise
 *     (`hash12`), never interleaved gradient noise.** IGN is a *structured* dither:
 *     it is the right choice when a temporal filter downstream will resolve it, and
 *     the wrong choice otherwise, because its spectrum has a strong diagonal peak
 *     that reads as a fixed cross-hatch weave over smooth subjects. Only the final
 *     8-bit quantisation dither (GRADE) keeps IGN, and there it is advanced per
 *     frame by the golden-ratio offsets so it never sits still.
 */

/* ------------------------------------------------------------------ *
 * shared chunks
 * ------------------------------------------------------------------ */

/** Full-screen triangle vertex shader (matches three's own passes). */
export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const CHUNK_COMMON = /* glsl */`
varying vec2 vUv;
float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
float sat( float x ) { return clamp( x, 0.0, 1.0 ); }
vec3  sat3( vec3 x ) { return clamp( x, 0.0, 1.0 ); }
/** interleaved gradient noise — structured; ONLY for the final quantisation dither */
float ign( vec2 p ) { return fract( 52.9829189 * fract( 0.06711056 * p.x + 0.00583715 * p.y ) ); }
/** white noise — flat spectrum, so it can never form a visible periodic weave */
float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}`;

/** Depth helpers. Requires uniforms: tDepth, uProjInv, uNear, uFar. */
const CHUNK_DEPTH = /* glsl */`
uniform sampler2D tDepth;
uniform mat4  uProjInv;
uniform float uNear;
uniform float uFar;

#define SKY_DEPTH 0.999995

float rawDepth( vec2 uv ) { return texture2D( tDepth, uv ).x; }

/** matches three's perspectiveDepthToViewZ(); returns a NEGATIVE view-space z */
float viewZ( float raw ) { return ( uNear * uFar ) / ( ( uFar - uNear ) * raw - uFar ); }

/** linear distance along the view axis (positive) */
float viewDist( vec2 uv ) {
  float d = rawDepth( uv );
  return ( d >= SKY_DEPTH ) ? uFar : -viewZ( d );
}

/** exact view-space position from the depth buffer */
vec3 viewPos( vec2 uv, float raw ) {
  vec4 c = uProjInv * vec4( uv * 2.0 - 1.0, raw * 2.0 - 1.0, 1.0 );
  return c.xyz / c.w;
}`;

/**
 * Circle-of-confusion curve, shared by the CoC pack and the full-res composite so
 * the two can never disagree.
 *
 * Shaped for a *hero composition*, not for a physical lens:
 *   - a flat in-focus plateau around the subject   (uCocBand.x .. uCocBand.z)
 *   - a fast near ramp so a foreground framing element goes properly soft
 *   - a much gentler far ramp, because separating the background is the job of
 *     aerial perspective; using DOF for it turns readable mid-ground into mush.
 *
 * uCocBand = ( nearFocusEdge, nearMaxEdge, farFocusEdge, farMaxEdge ) as ratios of
 * the focus distance.  uCocPx = ( nearMaxPixels, farMaxPixels ), full-res pixels.
 */
const CHUNK_COC = /* glsl */`
uniform vec4 uCocBand;
uniform vec2 uCocPx;

float cocPixels( float dist, float focus ) {
  float r = dist / max( focus, 0.05 );
  float nearT = 1.0 - smoothstep( uCocBand.y, uCocBand.x, r );
  float farT  = smoothstep( uCocBand.z, uCocBand.w, r );
  return farT * uCocPx.y - nearT * uCocPx.x;
}`;

/* ------------------------------------------------------------------ *
 * 1. ambient occlusion (depth-only, Alchemy estimator)
 * ------------------------------------------------------------------ */

/**
 * Half-resolution AO. Normals are reconstructed from depth with an
 * edge-preserving derivative pick, so the AO never leaks across silhouettes.
 * Output: r = visibility (1 = open), g = view distance (for the bilateral blur).
 */
export const AO_SHADER = {
  name: 'sakura.ao',
  defines: { AO_SAMPLES: 12 },
  uniforms: {
    tDepth: { value: null },
    uProjInv: { value: null },
    uNear: { value: 0.1 },
    uFar: { value: 900.0 },
    uProjScale: { value: null },   // vec2 = 0.5 * (m00, m11) — world radius -> uv radius
    uTexel: { value: null },       // vec2, full-res texel size (normal reconstruction)
    uRadius: { value: 0.6 },
    uIntensity: { value: 0.55 },
    uFade: { value: null },        // vec2 (start, end) distance fade
    uFrameMod: { value: 0.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
${CHUNK_DEPTH}
uniform vec2  uProjScale;
uniform vec2  uTexel;
uniform vec2  uFade;
uniform float uRadius;
uniform float uIntensity;
uniform float uFrameMod;

void main() {
  float d = rawDepth( vUv );
  if ( d >= SKY_DEPTH ) { gl_FragColor = vec4( 1.0, uFar, 0.0, 1.0 ); return; }

  vec3 P = viewPos( vUv, d );

  // --- normal from depth, picking the closer neighbour per axis (no edge bleed)
  vec2 ex = vec2( uTexel.x, 0.0 ), ey = vec2( 0.0, uTexel.y );
  vec3 Pl = viewPos( vUv - ex, rawDepth( vUv - ex ) );
  vec3 Pr = viewPos( vUv + ex, rawDepth( vUv + ex ) );
  vec3 Pd = viewPos( vUv - ey, rawDepth( vUv - ey ) );
  vec3 Pu = viewPos( vUv + ey, rawDepth( vUv + ey ) );
  vec3 ddx = ( abs( Pr.z - P.z ) < abs( P.z - Pl.z ) ) ? ( Pr - P ) : ( P - Pl );
  vec3 ddy = ( abs( Pu.z - P.z ) < abs( P.z - Pd.z ) ) ? ( Pu - P ) : ( P - Pd );
  vec3 N = normalize( cross( ddx, ddy ) );
  if ( N.z < 0.0 ) N = -N;

  // --- Alchemy AO over a spiral disc of world radius uRadius
  // white-noise rotation: this buffer is consumed AFTER the TAA resolve, so a
  // structured (IGN) rotation would bake a fixed diagonal weave into the frame.
  float ang = hash12( gl_FragCoord.xy + vec2( uFrameMod * 5.813, uFrameMod * 3.271 ) ) * 6.2831853;
  vec2 uvR = uRadius * uProjScale / max( -P.z, 0.05 );
  float occ = 0.0;
  float r2max = uRadius * uRadius * 2.2;

  for ( int i = 0; i < AO_SAMPLES; i ++ ) {
    float fi = ( float( i ) + 0.5 ) / float( AO_SAMPLES );
    float rr = pow( fi, 0.68 );
    float a  = ang + fi * 6.2831853 * 3.0;
    vec2  suv = vUv + vec2( cos( a ), sin( a ) ) * rr * uvR;
    if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;
    float sd = rawDepth( suv );
    if ( sd >= SKY_DEPTH ) continue;
    vec3 v = viewPos( suv, sd ) - P;
    float vv = dot( v, v );
    if ( vv > r2max ) continue;
    occ += max( 0.0, dot( v, N ) - 0.012 * sqrt( vv ) ) / ( vv + 0.02 );
  }

  occ *= ( 1.9 * uRadius ) / float( AO_SAMPLES );
  float vis = sat( 1.0 - occ * uIntensity );
  // no AO on the far field — it would read as dirt on the hills
  vis = mix( vis, 1.0, smoothstep( uFade.x, uFade.y, -P.z ) );
  gl_FragColor = vec4( vis, -P.z, 0.0, 1.0 );
}`,
};

/**
 * Separable bilateral blur for the AO buffer. Run twice (uDir = x then y).
 * Depth comes from the g channel written by AO_SHADER, so this is one fetch per tap.
 */
export const AO_BLUR_SHADER = {
  name: 'sakura.aoBlur',
  defines: { AO_BLUR_TAPS: 5 },
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: null },   // vec2 half-res texel
    uDir: { value: null },     // vec2 (1,0) or (0,1)
    uSharpness: { value: 0.09 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform vec2  uDir;
uniform float uSharpness;

void main() {
  vec2 c = texture2D( tDiffuse, vUv ).rg;
  float sum = c.r, wsum = 1.0;
  for ( int i = 1; i <= AO_BLUR_TAPS; i ++ ) {
    float fi = float( i );
    float g = exp( -0.5 * fi * fi / 7.5 );
    vec2 o = uDir * uTexel * fi;
    vec2 a = texture2D( tDiffuse, vUv + o ).rg;
    vec2 b = texture2D( tDiffuse, vUv - o ).rg;
    float wa = g / ( 1.0 + abs( a.g - c.g ) * uSharpness * 12.0 );
    float wb = g / ( 1.0 + abs( b.g - c.g ) * uSharpness * 12.0 );
    sum += a.r * wa + b.r * wb;
    wsum += wa + wb;
  }
  gl_FragColor = vec4( sum / wsum, c.g, 0.0, 1.0 );
}`,
};

/* ------------------------------------------------------------------ *
 * 2. god rays — occlusion mask + radial blur
 * ------------------------------------------------------------------ */

/**
 * Quarter-res occlusion/emission mask for the light shafts.
 * Sky (far depth) contributes its own luminance; very bright geometry (rim-lit
 * petal edges) contributes a little, which makes shafts appear to *start* in the
 * canopy instead of only in the gaps.
 */
export const RAY_MASK_SHADER = {
  name: 'sakura.rayMask',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uProjInv: { value: null },
    uNear: { value: 0.1 },
    uFar: { value: 900.0 },
    uTexelFull: { value: null },
    uThreshold: { value: 0.5 },
    uSunUV: { value: null },
    uSunReach: { value: null },  // vec2 (full-strength radius, zero radius)
    uAspect: { value: 1.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
${CHUNK_DEPTH}
uniform sampler2D tDiffuse;
uniform vec2  uTexelFull;
uniform vec2  uSunUV;
uniform vec2  uSunReach;
uniform float uThreshold;
uniform float uAspect;

void main() {
  // 2x2 box of the full-res buffers: thin canopy gaps become partial coverage
  // instead of shimmering single pixels.
  vec2 o = uTexelFull;
  float sky = 0.0;
  vec3 col = vec3( 0.0 );
  for ( int i = 0; i < 4; i ++ ) {
    vec2 d = vec2( i == 0 || i == 2 ? -0.5 : 0.5, i < 2 ? -0.5 : 0.5 ) * o * 2.0;
    sky += step( SKY_DEPTH, rawDepth( vUv + d ) );
    col += texture2D( tDiffuse, vUv + d ).rgb;
  }
  sky *= 0.25;
  col *= 0.25;

  // Any *visible sky* near the sun seeds a shaft — a hard luminance threshold
  // makes the effect vanish whenever the sky is not blindingly bright, which is
  // most of the day. Brightness modulates, it does not gate.
  // Brightness must DOMINATE, not merely modulate: a large flat floor over every
  // sky pixel radial-blurs into a uniform veil over the whole upper frame, which
  // is a fog bug wearing a god-ray costume. The floor is only there so a shaft
  // still has a visible root in dimmer sky right next to the sun.
  float l = luma( col );
  float m = sky * ( 0.10 + 0.90 * smoothstep( uThreshold, uThreshold * 2.0 + 0.35, l ) )
          + ( 1.0 - sky ) * 0.22 * smoothstep( 1.2, 3.4, l );

  // Only sky *near the sun* seeds a shaft. Without this a uniformly bright sky
  // radial-blurs into a flat global glow instead of readable light shafts.
  float dSun = length( ( vUv - uSunUV ) * vec2( uAspect, 1.0 ) );
  m *= 1.0 - smoothstep( uSunReach.x, uSunReach.y, dSun );

  gl_FragColor = vec4( m, m, m, 1.0 );
}`,
};

/** Quarter-res radial occlusion blur toward the sun's screen position. */
export const RAY_BLUR_SHADER = {
  name: 'sakura.rayBlur',
  defines: { RAY_TAPS: 48 },
  uniforms: {
    tDiffuse: { value: null },
    uSunUV: { value: null },
    uDensity: { value: 0.85 },
    uDecay: { value: 0.955 },
    uJitter: { value: 0.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform vec2  uSunUV;
uniform float uDensity;
uniform float uDecay;
uniform float uJitter;

void main() {
  vec2 delta = ( uSunUV - vUv ) * uDensity / float( RAY_TAPS );
  // dithered start offset removes the visible stepping of a marched blur.
  // white noise, not IGN — this buffer is added in after the TAA resolve.
  vec2 uv = vUv + delta * ( hash12( gl_FragCoord.xy + uJitter * 11.7 ) - 0.5 );
  float w = 1.0, acc = 0.0, wsum = 0.0, wtot = 0.0;
  for ( int i = 0; i < RAY_TAPS; i ++ ) {
    uv += delta;
    float inside = step( 0.0, uv.x ) * step( uv.x, 1.0 ) * step( 0.0, uv.y ) * step( uv.y, 1.0 );
    acc  += texture2D( tDiffuse, uv ).r * w * inside;
    wsum += w * inside;
    wtot += w;
    w *= uDecay;
  }
  // Off-frame sun: the march leaves the buffer part way, so normalising by the
  // full tap weight would fade every shaft out exactly where the light source
  // sits. Normalise by the weight that actually landed inside, floored at 30% of
  // the total so a single surviving tap can never spike.
  float r = acc / max( wsum, 0.30 * wtot );
  gl_FragColor = vec4( r, r, r, 1.0 );
}`,
};

/* ------------------------------------------------------------------ *
 * 3. atmospherics composite — AO multiply + god-ray add
 * ------------------------------------------------------------------ */

export const ATMOS_SHADER = {
  name: 'sakura.atmos',
  defines: {},
  uniforms: {
    tDiffuse: { value: null },
    tAO: { value: null },
    tRays: { value: null },
    uAOTint: { value: null },     // vec3 colour the occluded pixels are pushed toward
    uRayColor: { value: null },   // vec3 sun colour * strength
    uSunUV: { value: null },
    uAspect: { value: 1.0 },
    uRayFalloff: { value: null }, // vec2 (start, end) radial fade from the sun
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform sampler2D tAO;
uniform sampler2D tRays;
uniform vec3  uAOTint;
uniform vec3  uRayColor;
uniform vec2  uSunUV;
uniform vec2  uRayFalloff;
uniform float uAspect;

void main() {
  vec3 c = texture2D( tDiffuse, vUv ).rgb;

  #ifdef USE_AO
    float vis = texture2D( tAO, vUv ).r;
    c *= mix( uAOTint, vec3( 1.0 ), vis );
  #endif

  #ifdef USE_RAYS
    float r = texture2D( tRays, vUv ).r;
    float dist = length( ( vUv - uSunUV ) * vec2( uAspect, 1.0 ) );
    r *= 1.0 - smoothstep( uRayFalloff.x, uRayFalloff.y, dist );
    c += uRayColor * r;
  #endif

  gl_FragColor = vec4( c, 1.0 );
}`,
};

/* ------------------------------------------------------------------ *
 * 4. temporal AA (jittered accumulation + neighbourhood clamp)
 * ------------------------------------------------------------------ */

export const TAA_SHADER = {
  name: 'sakura.taa',
  uniforms: {
    tDiffuse: { value: null },   // current, jittered frame
    tHistory: { value: null },
    uTexel: { value: null },
    uBlend: { value: 0.125 },
    uWiden: { value: 0.035 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform sampler2D tHistory;
uniform vec2  uTexel;
uniform float uBlend;
uniform float uWiden;

void main() {
  vec3 c = texture2D( tDiffuse, vUv ).rgb;
  vec3 n0 = texture2D( tDiffuse, vUv + vec2( uTexel.x, 0.0 ) ).rgb;
  vec3 n1 = texture2D( tDiffuse, vUv - vec2( uTexel.x, 0.0 ) ).rgb;
  vec3 n2 = texture2D( tDiffuse, vUv + vec2( 0.0, uTexel.y ) ).rgb;
  vec3 n3 = texture2D( tDiffuse, vUv - vec2( 0.0, uTexel.y ) ).rgb;
  vec3 mn = min( c, min( min( n0, n1 ), min( n2, n3 ) ) );
  vec3 mx = max( c, max( max( n0, n1 ), max( n2, n3 ) ) );
  vec3 pad = ( mx - mn ) * uWiden + 0.002;
  vec3 h = clamp( texture2D( tHistory, vUv ).rgb, mn - pad, mx + pad );
  gl_FragColor = vec4( mix( h, c, uBlend ), 1.0 );
}`,
};

/** Straight copy (history write-back, fallbacks). */
export const COPY_SHADER = {
  name: 'sakura.copy',
  uniforms: { tDiffuse: { value: null } },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
void main() { gl_FragColor = texture2D( tDiffuse, vUv ); }`,
};

/* ------------------------------------------------------------------ *
 * 5. bloom — progressive-downsample / tent-upsample pyramid
 *
 * Not UnrealBloomPass. Three reasons:
 *   1. `nMips` is fixed at 5 there and the art bible wants a wider, hazier veil;
 *      this pyramid runs 7 levels, so the coarsest mip is 1/128 of the frame and
 *      its support after the upsample chain spans well over a third of frame
 *      height — "hazy and generous" instead of a tight halo.
 *   2. The high-pass must read a *different* texture from the one the result is
 *      composited over, so the sky around the sun can be pre-multiplied into the
 *      bloom source without turning into a white disc in the actual frame.
 *      UnrealBloomPass derives both from its `readBuffer` argument.
 *   3. The Jimenez (CoD:AW) downsample/tent-upsample pair is smoother per tap
 *      than a separable gaussian per mip, and cheaper.
 * ------------------------------------------------------------------ */

/**
 * Bloom pre-filter → mip 0. Soft-knee luminance threshold in *linear HDR*, a Karis
 * partial average to stop single bright pixels from popping, and a smooth sun-disc
 * pre-multiply so the sky itself hazes rather than only geometry edges.
 */
export const BLOOM_PREFILTER_SHADER = {
  name: 'sakura.bloomPrefilter',
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: null },       // vec2 source (full-res) texel
    uThreshold: { value: 0.8 },    // linear HDR knee centre
    uKnee: { value: 0.6 },         // knee width as a fraction of the threshold
    uSunUV: { value: null },
    uSunBoost: { value: null },    // vec2 ( multiplier at the sun, radius in frame heights )
    uAspect: { value: 1.0 },
    uClamp: { value: 24.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform vec2  uSunUV;
uniform vec2  uSunBoost;
uniform float uThreshold;
uniform float uKnee;
uniform float uAspect;
uniform float uClamp;

void main() {
  // Karis partial average of a 2x2 box: weight each tap by 1/(1+luma) so a single
  // fireflies-bright pixel cannot dominate the whole mip.
  vec3 acc = vec3( 0.0 );
  float wsum = 0.0;
  for ( int i = 0; i < 4; i ++ ) {
    vec2 d = vec2( i == 0 || i == 2 ? -0.5 : 0.5, i < 2 ? -0.5 : 0.5 ) * uTexel * 2.0;
    vec3 s = min( texture2D( tDiffuse, vUv + d ).rgb, uClamp );
    float w = 1.0 / ( 1.0 + luma( s ) );
    acc += s * w;
    wsum += w;
  }
  vec3 c = acc / max( wsum, 1e-4 );

  // sun glare: boost the *source* before the threshold, so sky that sits just
  // below the knee is pushed over it and blooms as haze.
  float dSun = length( ( vUv - uSunUV ) * vec2( uAspect, 1.0 ) );
  float disc = 1.0 - smoothstep( 0.0, max( uSunBoost.y, 1e-3 ), dSun );
  c *= 1.0 + ( uSunBoost.x - 1.0 ) * disc * disc;

  // soft-knee high pass (quadratic knee, the standard Unreal/Bloom curve)
  float l = max( max( c.r, c.g ), c.b );
  float knee = max( uThreshold * uKnee, 1e-4 );
  float soft = clamp( l - uThreshold + knee, 0.0, 2.0 * knee );
  soft = soft * soft / ( 4.0 * knee );
  float w = max( soft, l - uThreshold ) / max( l, 1e-4 );

  gl_FragColor = vec4( c * w, 1.0 );
}`,
};

/** 13-tap Jimenez downsample — one mip down, no aliasing, no blockiness. */
export const BLOOM_DOWN_SHADER = {
  name: 'sakura.bloomDown',
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: null },   // vec2 SOURCE mip texel size
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform vec2 uTexel;

vec3 T( vec2 o ) { return texture2D( tDiffuse, vUv + o * uTexel ).rgb; }

void main() {
  vec3 a = T( vec2( -1.0, -1.0 ) ), b = T( vec2( 0.0, -1.0 ) ), c = T( vec2( 1.0, -1.0 ) );
  vec3 f = T( vec2( -1.0,  0.0 ) ), g = T( vec2( 0.0,  0.0 ) ), h = T( vec2( 1.0,  0.0 ) );
  vec3 k = T( vec2( -1.0,  1.0 ) ), l = T( vec2( 0.0,  1.0 ) ), m = T( vec2( 1.0,  1.0 ) );
  vec3 d = T( vec2( -0.5, -0.5 ) ), e = T( vec2( 0.5, -0.5 ) );
  vec3 i = T( vec2( -0.5,  0.5 ) ), j = T( vec2( 0.5,  0.5 ) );

  vec3 o  = ( d + e + i + j ) * 0.125;
  o += ( a + b + g + f ) * 0.03125;
  o += ( b + c + h + g ) * 0.03125;
  o += ( f + g + l + k ) * 0.03125;
  o += ( g + h + m + l ) * 0.03125;
  gl_FragColor = vec4( o, 1.0 );
}`,
};

/**
 * 9-tap tent upsample. The material is created with AdditiveBlending, so this
 * accumulates the coarser mip into the finer one in place — the progressive
 * upsample that gives the veil its long, smooth tail.
 */
export const BLOOM_UP_SHADER = {
  name: 'sakura.bloomUp',
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: null },    // vec2 DESTINATION mip texel size
    uRadius: { value: 1.3 },    // tent radius in destination texels
    uScale: { value: 1.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform float uRadius;
uniform float uScale;

vec3 T( vec2 o ) { return texture2D( tDiffuse, vUv + o * uTexel * uRadius ).rgb; }

void main() {
  vec3 s = T( vec2( -1.0, -1.0 ) ) + T( vec2( 1.0, -1.0 ) )
         + T( vec2( -1.0,  1.0 ) ) + T( vec2( 1.0,  1.0 ) );
  s += ( T( vec2( 0.0, -1.0 ) ) + T( vec2( -1.0, 0.0 ) )
       + T( vec2( 1.0,  0.0 ) ) + T( vec2(  0.0, 1.0 ) ) ) * 2.0;
  s += T( vec2( 0.0, 0.0 ) ) * 4.0;
  gl_FragColor = vec4( s * ( uScale / 16.0 ), 1.0 );
}`,
};

/** Adds the finished pyramid over the frame. tDiffuse = frame, tBloom = mip 0. */
export const BLOOM_COMPOSITE_SHADER = {
  name: 'sakura.bloomComposite',
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
    uStrength: { value: 0.2 },
    uTint: { value: null },     // vec3
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uStrength;
uniform vec3  uTint;

void main() {
  vec3 c = texture2D( tDiffuse, vUv ).rgb;
  vec3 b = texture2D( tBloom, vUv ).rgb;
  gl_FragColor = vec4( c + b * uTint * uStrength, 1.0 );
}`,
};

/* ------------------------------------------------------------------ *
 * 6. depth of field — autofocus, CoC pack, CoC-weighted gather, composite
 * ------------------------------------------------------------------ */

/**
 * 1x1 autofocus probe. This *is* the "raycast through screen centre to the
 * nearest hit" the composition wants, done on the GPU against the same depth
 * buffer the CoC uses: a small cross at the frame centre, nearest hit wins, then
 * temporally smoothed so a petal crossing the centre cannot yank focus.
 * `uTarget > 0` overrides it with a distance published by another module
 * (ctx.assets.focusTarget), which is how the hero subject drives focus.
 */
export const FOCUS_SHADER = {
  name: 'sakura.focus',
  uniforms: {
    tDepth: { value: null },
    tPrev: { value: null },
    uProjInv: { value: null },
    uNear: { value: 0.1 },
    uFar: { value: 900.0 },
    uCenter: { value: null },
    uRate: { value: 0.07 },
    uFallback: { value: 24.0 },
    uTarget: { value: 0.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
${CHUNK_DEPTH}
uniform sampler2D tPrev;
uniform vec2  uCenter;
uniform float uRate;
uniform float uFallback;
uniform float uTarget;

void main() {
  // nearest hit in a small cross at the frame centre — the hero subject
  float near = 1e9;
  float acc = 0.0, n = 0.0;
  for ( int i = 0; i < 9; i ++ ) {
    vec2 o = vec2( 0.0 );
    if ( i == 1 ) o = vec2(  0.030,  0.000 );
    if ( i == 2 ) o = vec2( -0.030,  0.000 );
    if ( i == 3 ) o = vec2(  0.000,  0.040 );
    if ( i == 4 ) o = vec2(  0.000, -0.040 );
    if ( i == 5 ) o = vec2(  0.022,  0.030 );
    if ( i == 6 ) o = vec2( -0.022,  0.030 );
    if ( i == 7 ) o = vec2(  0.022, -0.030 );
    if ( i == 8 ) o = vec2( -0.022, -0.030 );
    float d = rawDepth( uCenter + o );
    if ( d < SKY_DEPTH ) { float z = -viewZ( d ); near = min( near, z ); acc += z; n += 1.0; }
  }
  // 70% toward the nearest hit, 30% the mean: locks onto the subject but does not
  // snap to a single stray twig pixel.
  float probe = n > 0.0 ? mix( acc / n, near, 0.7 ) : uFallback;
  float target = uTarget > 0.0 ? uTarget : probe;
  float prev = texture2D( tPrev, vec2( 0.5 ) ).r;
  float f = prev > 0.01 ? mix( prev, target, uRate ) : target;
  gl_FragColor = vec4( f, 0.0, 0.0, 1.0 );
}`,
};

/** Half-res pack: rgb = colour, a = signed CoC in FULL-res pixels. */
export const COC_SHADER = {
  name: 'sakura.coc',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tFocus: { value: null },
    uProjInv: { value: null },
    uNear: { value: 0.1 },
    uFar: { value: 900.0 },
    uTexelFull: { value: null },
    uCocBand: { value: null },
    uCocPx: { value: null },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
${CHUNK_DEPTH}
${CHUNK_COC}
uniform sampler2D tDiffuse;
uniform sampler2D tFocus;
uniform vec2  uTexelFull;

void main() {
  vec3 col = vec3( 0.0 );
  float dist = 1e9;
  for ( int i = 0; i < 4; i ++ ) {
    vec2 d = vec2( i == 0 || i == 2 ? -0.5 : 0.5, i < 2 ? -0.5 : 0.5 ) * uTexelFull * 2.0;
    col += texture2D( tDiffuse, vUv + d ).rgb;
    dist = min( dist, viewDist( vUv + d ) );   // nearest surface wins -> foreground dilates
  }
  col *= 0.25;

  float focus = max( texture2D( tFocus, vec2( 0.5 ) ).r, 0.05 );
  gl_FragColor = vec4( col, cocPixels( dist, focus ) );
}`,
};

/**
 * Half-res CoC-weighted gather. A tap only contributes if its own circle of
 * confusion actually reaches this pixel, and background taps are additionally
 * gated on the centre pixel being blurry — that is what stops bokeh bleeding
 * across a sharp silhouette.
 * Output: rgb = blurred colour, a = near-field coverage.
 */
export const DOF_GATHER_SHADER = {
  name: 'sakura.dofGather',
  defines: { DOF_TAPS: 25 },
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: null },     // vec2 half-res texel
    uMaxCoC: { value: 6.0 },     // full-res px
    uJitter: { value: 0.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform float uMaxCoC;
uniform float uJitter;

void main() {
  vec4 c = texture2D( tDiffuse, vUv );
  float ccoc = c.a;
  vec3 acc = c.rgb;
  float wsum = 1.0;
  float nearCov = sat( -ccoc * 0.6 );

  // White-noise Cranley-Patterson rotation + per-pixel radial offset. IGN was
  // used here before and its diagonal spectrum printed a fixed cross-hatch weave
  // over the whole canopy: the DOF gather runs *after* the TAA resolve, so there
  // is nothing downstream to average a structured dither away.
  float r0 = hash12( gl_FragCoord.xy + vec2( uJitter * 17.13, uJitter * 9.71 ) );
  float r1 = hash12( gl_FragCoord.yx * 1.371 + vec2( uJitter * 5.19, uJitter * 23.7 ) );
  float rot = r0 * 6.2831853;

  for ( int i = 0; i < DOF_TAPS; i ++ ) {
    // Vogel / golden-angle disc: the rotated Poisson-disc distribution, generated
    // rather than tabulated. sqrt() on the radius makes the taps area-uniform.
    float fi = ( float( i ) + 0.5 + ( r1 - 0.5 ) * 0.9 ) / float( DOF_TAPS );
    float rr = sqrt( sat( fi ) );
    float a = rot + float( i ) * 2.39996323;
    float dpx = rr * uMaxCoC;                       // distance in full-res px
    vec2 suv = vUv + vec2( cos( a ), sin( a ) ) * dpx * 0.5 * uTexel;
    vec4 s = texture2D( tDiffuse, suv );
    // a tap only contributes if its own circle of confusion actually reaches here
    float spread = sat( abs( s.a ) - dpx + 1.0 );
    // ...and a background tap additionally needs THIS pixel to be blurry, which is
    // what stops background bokeh bleeding over an in-focus silhouette.
    float behind = step( ccoc + 0.05, s.a );
    float allow = mix( 1.0, sat( abs( ccoc ) - dpx + 1.0 ), behind );
    float w = spread * allow;
    acc += s.rgb * w;
    wsum += w;
    if ( s.a < -0.75 ) nearCov = max( nearCov, spread );
  }

  gl_FragColor = vec4( acc / wsum, nearCov );
}`,
};

/** Full-res composite: keep sharp where CoC is small, feather in the gather. */
export const DOF_COMPOSITE_SHADER = {
  name: 'sakura.dofComposite',
  uniforms: {
    tDiffuse: { value: null },
    tBlur: { value: null },
    tDepth: { value: null },
    tFocus: { value: null },
    uProjInv: { value: null },
    uNear: { value: 0.1 },
    uFar: { value: 900.0 },
    uCocBand: { value: null },
    uCocPx: { value: null },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
${CHUNK_DEPTH}
${CHUNK_COC}
uniform sampler2D tDiffuse;
uniform sampler2D tBlur;
uniform sampler2D tFocus;

void main() {
  vec3 sharp = texture2D( tDiffuse, vUv ).rgb;
  vec4 blur = texture2D( tBlur, vUv );

  float dist = viewDist( vUv );
  float focus = max( texture2D( tFocus, vec2( 0.5 ) ).r, 0.05 );
  float coc = cocPixels( dist, focus );

  float f = max( smoothstep( 0.7, 2.4, abs( coc ) ), blur.a );
  gl_FragColor = vec4( mix( sharp, blur.rgb, sat( f ) ), 1.0 );
}`,
};

/* ------------------------------------------------------------------ *
 * 7. ACES filmic tonemap + colour grade (linear HDR in, sRGB-encoded out)
 * ------------------------------------------------------------------ */

export const GRADE_SHADER = {
  name: 'sakura.grade',
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    uGain: { value: null },        // vec3 white balance on the tonemapped image
    uGammaC: { value: null },      // vec3 per-channel gamma
    uBlack: { value: 0.004 },      // LINEAR scene black subtracted before ACES
    uFloor: { value: 0.030 },      // display-space floor — the only "never pure black" lift
    uPivot: { value: 0.18 },       // S-curve pivot (log-ish, so 0 stays 0)
    uContrast: { value: 1.12 },    // S-curve slope about the pivot
    uNightPivot: { value: 0.10 },  // the same two, for the night end of uNightMix
    uNightContrast: { value: 1.05 },
    uToe: { value: 0.10 },         // extra roll of the deep shadows only
    uSaturation: { value: 1.08 },  // >= 1 always — never desaturate (art bible §4.6)
    uSplitLo: { value: null },     // vec3 SIGNED shadow offset (cool / violet)
    uSplitHi: { value: null },     // vec3 SIGNED highlight offset (warm)
    uSplit: { value: null },       // vec2 (shadow amount, highlight amount)
    uLift: { value: null },        // vec3 luma-gated shadow lift toward #2A2438
    uNight: { value: 0.0 },        // uNightMix mirror — lets the night frame be dark
    uShoulder: { value: 0.94 },    // hue-preserving highlight roll-off knee
    uDither: { value: 1.0 },       // amplitude in 1/255 units
    uDitherOffset: { value: null }, // vec2, advanced per frame
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform vec3  uGain;
uniform vec3  uGammaC;
uniform vec3  uSplitLo;
uniform vec3  uSplitHi;
uniform vec3  uLift;
uniform vec2  uSplit;
uniform vec2  uDitherOffset;
uniform float uExposure;
uniform float uBlack;
uniform float uFloor;
uniform float uPivot;
uniform float uContrast;
uniform float uNightPivot;
uniform float uNightContrast;
uniform float uToe;
uniform float uSaturation;
uniform float uNight;
uniform float uShoulder;
uniform float uDither;

vec3 RRTAndODTFit( vec3 v ) {
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return a / b;
}

/** ACES filmic, same fit three uses (brightened by 1/0.6 like three does). */
vec3 acesFilmic( vec3 color ) {
  const mat3 ACESInputMat = mat3(
    vec3( 0.59719, 0.07600, 0.02840 ),
    vec3( 0.35458, 0.90834, 0.13383 ),
    vec3( 0.04823, 0.01566, 0.83777 ) );
  const mat3 ACESOutputMat = mat3(
    vec3(  1.60475, -0.10208, -0.00327 ),
    vec3( -0.53108,  1.10813, -0.07276 ),
    vec3( -0.07367, -0.00605,  1.07602 ) );
  color /= 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit( color );
  color = ACESOutputMat * color;
  return sat3( color );
}

vec3 encodeSRGB( vec3 v ) {
  return mix( pow( v, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), v * 12.92,
              vec3( lessThanEqual( v, vec3( 0.0031308 ) ) ) );
}

void main() {
  vec3 c = max( texture2D( tDiffuse, vUv ).rgb, 0.0 ) * uExposure;

  // --- (0) a REAL black point, set in linear scene space where it belongs.
  //     Subtracting here (Cineon's trick) is what gives the frame a low end.
  //     Scaled down at night, otherwise the navy sky would crush to nothing.
  c = max( c - uBlack * ( 1.0 - 0.8 * uNight ), 0.0 );

  // one tonemap, right here — the renderer is set to NoToneMapping by 90-postfx
  c = acesFilmic( c );

  // white balance / channel gamma on the tonemapped image (subtle golden cast)
  c = sat3( c * uGain );
  c = pow( c, 1.0 / uGammaC );

  // --- the grade proper, in this exact order -------------------------------
  // (1) S-curve contrast about a pivot below mid grey. A POWER law, not a line:
  //     the old affine form ( c - p ) * k + p clamped everything below
  //     p - p/k to zero, which flattened the whole night frame into one value
  //     and stripped every shadow of its chroma. This form fixes 0 -> 0 and
  //     the pivot -> the pivot, and only ever changes local slope.
  // At night every value in frame sits far BELOW a daylight pivot, where a power
  // law is a pure multiplicative crush — it takes range out of the one phase that
  // has the least to spare. The pivot and slope therefore travel with uNightMix.
  float pv = mix( uPivot, uNightPivot, uNight );
  float ct = mix( uContrast, uNightContrast, uNight );
  c = pv * pow( max( c, 1e-5 ) / pv, vec3( ct ) );

  // (2) toe: an extra, gentle roll of the DEEP shadows only, so the low end has
  //     somewhere to go. Relaxed at night for the same reason as the black point.
  float lo = smoothstep( pv, 0.0, luma( c ) );
  c *= 1.0 - uToe * ( 1.0 - 0.8 * uNight ) * lo * 0.42;

  // (3) saturation — art bible §4.6 is +8%; a value below 1 is never legal here,
  //     desaturating the grade is what produced neutral-grey shadows.
  float l = luma( c );
  c = mix( vec3( l ), c, max( uSaturation, 1.0 ) );

  // (4) split tone, weighted by luma rather than mixed flat: shadows travel
  //     toward #6E76A8 / #2A2438 (b - r strongly positive), highlights warm.
  //     Signed offsets, so this genuinely rotates hue instead of just adding light.
  l = luma( c );
  float loW = ( 1.0 - l ) * ( 1.0 - l );
  float hiW = l * l;
  c += uSplitLo * ( uSplit.x * loW ) + uSplitHi * ( uSplit.y * hiW );

  // (5) shadow lift toward #2A2438 — luma-gated so it can only touch the bottom
  //     quarter, and relaxed at night. Peak contribution stays <= 0.012.
  c += uLift * ( ( 1.0 - 0.75 * uNight ) * ( 1.0 - smoothstep( 0.0, 0.25, luma( c ) ) ) );
  c = max( c, 0.0 );

  // (6) hue-preserving highlight roll-off. A per-channel clamp turns every
  //     over-range pixel white, which is what makes a bright rim read as a hard
  //     white outline instead of a hot pink edge. Scaling the whole triplet by a
  //     soft shoulder on its max channel keeps the hue all the way to 1.0, and
  //     still reaches full white for genuinely blown values (m >= ~1.35).
  float m = max( max( c.r, c.g ), c.b );
  if ( m > uShoulder ) {
    float head = 1.0 - uShoulder;
    float rolled = uShoulder + head * ( 1.0 - exp( -( m - uShoulder ) / max( head, 1e-4 ) ) );
    c *= rolled / m;
  }

  vec3 srgb = encodeSRGB( sat3( c ) );

  // "never pure black" (art bible §3) — enforced HERE, in display space, and only
  // on the very bottom of the range. The old code lifted the whole image by 0.048
  // linear, which is 61/255 of flat grey added to every shadow in the frame.
  float k = max( uFloor * 4.0, 1e-4 );
  vec3 t = vec3( 1.0 ) - min( srgb / k, vec3( 1.0 ) );
  srgb += uFloor * t * t;

  // Quantisation dither, immediately before the 8-bit hand-off and nowhere else.
  // Triangular PDF from two IGN samples advanced by the golden-ratio pair each
  // frame, so it is never a static pattern. RMS = amplitude/sqrt(6) ~= 0.41/255
  // at amplitude 1/255, i.e. right at the 0.4/255 budget.
  vec2 p = gl_FragCoord.xy + uDitherOffset;
  float d = ign( p ) - ign( p + vec2( 37.0, 17.0 ) );
  srgb += d * ( uDither / 255.0 );

  gl_FragColor = vec4( srgb, 1.0 );
}`,
};

/* ------------------------------------------------------------------ *
 * 8. final: chromatic aberration, vignette, film grain (display space)
 * ------------------------------------------------------------------ */

export const FINAL_SHADER = {
  name: 'sakura.final',
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: null },
    uResolution: { value: null },
    uVignette: { value: 0.12 },
    uCA: { value: 1.2 },
    uGrain: { value: 0.02 },
    uTime: { value: 0.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform vec2  uResolution;
uniform float uVignette;
uniform float uCA;
uniform float uGrain;
uniform float uTime;

void main() {
  vec2 d = vUv - 0.5;
  float rc = length( d ) * 1.41421356;            // 1.0 at the corners

  // Chromatic aberration confined to the outer 8% of the frame radius: zero
  // until rc = 0.84, reaching ~1.2 px only in the corners. Anything wider than
  // this reads as a lens defect rather than as polish.
  vec2 dir = d * ( uCA * smoothstep( 0.84, 1.0, rc ) );
  vec3 c;
  c.r = texture2D( tDiffuse, vUv + dir * uTexel ).r;
  c.g = texture2D( tDiffuse, vUv ).g;
  c.b = texture2D( tDiffuse, vUv - dir * uTexel ).b;

  // vignette
  c *= 1.0 - uVignette * pow( rc, 2.4 );

  // Animated film grain — art bible §4.9, and the cheapest possible answer to a
  // flat sky. Two decorrelated white-noise fetches averaged (flat spectrum, so
  // it can never print a tiling pattern), signed on [-1,1], rolled off in the
  // highlights so specular cores and bloom stay clean.
  vec2 pn = vUv * uResolution;
  float t1 = fract( uTime * 3.317 ) * 137.0, t2 = fract( uTime * 1.913 ) * 211.0;
  float n = hash12( pn + vec2( t1, t2 ) ) * 2.0 - 1.0;   // uniform on [-1,1]
  c += n * uGrain * ( 1.0 - 0.22 * sat( luma( c ) ) );

  gl_FragColor = vec4( sat3( c ), 1.0 );
}`,
};
