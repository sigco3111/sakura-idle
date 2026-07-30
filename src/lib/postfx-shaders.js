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
    uFloor: { value: 0.3 },
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
uniform float uFloor;
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

  // Any *visible sky* seeds a shaft, weighted by how bright it is. Brightness
  // must DOMINATE, not merely modulate: a large flat floor over every sky pixel
  // radial-blurs into a uniform veil over the whole upper frame, which is a fog
  // bug wearing a god-ray costume. The floor is only there so a shaft still has
  // a visible root in dimmer sky right next to the sun.
  float l = luma( col );
  float m = sky * ( uFloor + ( 1.0 - uFloor ) * smoothstep( uThreshold, uThreshold * 2.6, l ) )
          + ( 1.0 - sky ) * 0.16 * smoothstep( 1.2, 3.4, l );

  // A GENTLE, WIDE taper only. This line is where three rounds of this pass died:
  // it used to be a tight blob (reach 0.62..1.85) SQUARED, and the march that
  // consumes it is an average along the line of sight to the sun, so the seed has
  // to be alive over the WHOLE path or the average is just "how close to the sun
  // am I". MEASURED with the old values, dusk/hero, pipeline.sample('mask',u,v):
  //   (0.20,0.70) sky, well clear of the canopy   mask 0.0105
  //   (0.50,0.75) sky                             mask 0.283
  //   (0.90,0.90) sky beside the sun              mask 1.000
  // i.e. the entire left half of the visible sky seeded NOTHING, so every pixel
  // on that side marched through zeros and the ray buffer read 0.007-0.03 there
  // against 1.0 at the source: a radial lobe centred on the sun, which is glow,
  // not shafts. Where the shafts are DRAWN is the composite's job (uRayFalloff);
  // the seed's only job is "is there bright sky here", and the cross-ray high pass
  // in ATMOS removes whatever smooth radial component survives.
  float dSun = length( ( vUv - uSunUV ) * vec2( uAspect, 1.0 ) );
  float reach = 1.0 - smoothstep( uSunReach.x, uSunReach.y, dSun );
  m *= reach;

  gl_FragColor = vec4( m, m, m, 1.0 );
}`,
};

/** Quarter-res radial occlusion blur toward the sun's screen position. */
export const RAY_BLUR_SHADER = {
  name: 'sakura.rayBlur',
  defines: { RAY_TAPS: 64 },
  uniforms: {
    tDiffuse: { value: null },
    uSunUV: { value: null },
    uDensity: { value: 0.85 },
    uDecay: { value: 0.955 },
    uJitter: { value: 0.0 },
    uShape: { value: 1.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform vec2  uSunUV;
uniform float uDensity;
uniform float uDecay;
uniform float uJitter;
uniform float uShape;

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
  // Shaft contrast. The march is an AVERAGE along the ray, so a ray that is half
  // blocked reads at half strength and the gaps never go properly dark. A gamma
  // above 1 pushes the partially-occluded rays down and leaves the clear ones
  // alone, which is what separates a shaft from its neighbour.
  //
  // But it must stay MILD. uShape was 3.0, which — on top of the squared seed
  // taper this shader's twin used to apply — was the second of two crushes both
  // centred on the sun: the raw march at dusk/hero read 0.20 / 0.31 / 0.44 / 0.75
  // at four points marching left-to-right across the frame, and pow(.,3) turned
  // those into 0.007 / 0.029 / 0.085 / 0.42. Two thirds of the frame therefore
  // carried 1-3% of the source's value and the pass could only ever read as a lobe
  // at the sun. 1.5 keeps the gap/shaft separation and leaves the mid-frame alive.
  r = pow( max( r, 0.0 ), uShape );
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
    uRayFalloff: { value: null }, // vec4 (innerStart, innerEnd, outerStart, outerEnd)
    uRayDamp: { value: null },    // vec2 (linear-HDR luma where damping starts, amount)
    uRayShaft: { value: null },   // vec3 (high-pass gain, absolute-level gain, noise deadband)
    uRayContrast: { value: null },// vec2 (gated multiplicative contrast gain, perp width)
    uRaySolo: { value: 0.0 },     // debug: 1 = output the ray contribution alone
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
uniform vec4  uRayFalloff;
uniform vec2  uRayDamp;
uniform vec3  uRayShaft;
uniform vec2  uRayContrast;
uniform float uRaySolo;
uniform float uAspect;

/**
 * The shaft field measured ACROSS the ray: .x = signed deviation of this pixel from
 * the local cross-ray baseline (positive = inside a shaft, negative = inside a gap),
 * .y = |deviation|, i.e. how much STRUCTURE there is here at all.
 *
 * The magnitude is the difference between god rays and fog. Where the sky near the
 * source is unoccluded there is nothing to make shafts out of, so the march returns
 * r ~ 1 over a large area and a plain composite paints a solid lobe of maximum add:
 * measured at dawn (sun on the left border, clear sky above it) that lobe was
 * responsible for 14 of the frame's 18 flat 200x200 blocks above L 0.90 — the pass
 * was manufacturing instant-fail tell 8.2.
 *
 * The SIGN is what makes the shafts survive a bright sky (see main()). Eight taps at
 * four baselines, so a shaft roughly 2-8% of frame width across is resolved without
 * the widest baseline swallowing it.
 */
vec2 rayStructure( vec2 uv, float r0 ) {
  vec2 d = uv - uSunUV;
  float len = max( length( d * vec2( uAspect, 1.0 ) ), 1e-4 );
  vec2 perp = normalize( vec2( -d.y * uAspect, d.x ) ) * vec2( 1.0 / uAspect, 1.0 );
  float shaft = 0.0;   // how much brighter than BOTH neighbours, best baseline wins
  float gap = 0.0;     // how much darker  than BOTH neighbours
  for ( int i = 0; i < 4; i ++ ) {
    // Baselines in UV. A crepuscular shaft in a 16:9 frame is 2-8% of frame width
    // across, so the widest baseline has to sit just OUTSIDE that and the narrowest
    // just inside it, or the "local baseline" is itself part of the shaft and the
    // high pass returns ~0. uRayContrast.y scales all four together.
    float s = ( i == 0 ? 0.008 : i == 1 ? 0.018 : i == 2 ? 0.038 : 0.072 )
            * uRayContrast.y * min( len * 3.0, 1.0 );
    float a = texture2D( tRays, uv + perp * s ).r;
    float b = texture2D( tRays, uv - perp * s ).r;
    // A LOCAL EXTREMUM test, not a difference from the mean of the two sides. This
    // matters and it is measurable: the previous mean-based high pass fires on any
    // MONOTONE gradient across the ray, and the biggest such gradient in the frame
    // is the horizon — the ray field steps from ~0.05 (every ray through the ground
    // is blocked) to ~0.35 (sky) over a few pixels. Measured on the mean-based
    // version, dusk/hero: a +45 to +62/255 horizontal band across the whole frame
    // at y 0.33-0.44, i.e. the pass was painting a bright line along the horizon
    // and adding to exactly the milky mid-ground band it is asked not to touch.
    // min(r0-a, r0-b) is positive only where this ray is clearer than the rays on
    // BOTH sides of it, which is what a shaft is; a step edge scores <= 0.
    shaft = max( shaft, min( r0 - a, r0 - b ) );
    gap   = max( gap,   min( a - r0, b - r0 ) );
  }
  // max() over baselines, so whichever baseline matches this shaft's width wins and
  // a shaft is not swallowed by a baseline wider than itself.
  return vec2( shaft - gap, max( shaft, gap ) );
}

void main() {
  vec3 c = texture2D( tDiffuse, vUv ).rgb;

  #ifdef USE_AO
    float vis = texture2D( tAO, vUv ).r;
    c *= mix( uAOTint, vec3( 1.0 ), vis );
  #endif

  #ifdef USE_RAYS
    float r = texture2D( tRays, vUv ).r;
    float dist = length( ( vUv - uSunUV ) * vec2( uAspect, 1.0 ) );
    // INNER fade as well as outer. Sky right at the source is unoccluded by
    // definition, so r = 1 over a disc there and the pass paints a solid lobe of
    // maximum add — measured at dawn (sun on the left border) that lobe alone was
    // responsible for 14 of the frame's 18 flat 200x200 blocks above L 0.90, i.e.
    // the pass was manufacturing instant-fail tell 8.2 next to the light it was
    // meant to dramatise. Glare AT the source is the bloom's job (it has a sun-disc
    // pre-multiply for exactly that); the shafts start a little way out, where there
    // is finally something for them to be shafts BETWEEN.
    float win = smoothstep( uRayFalloff.x, uRayFalloff.y, dist )
              * ( 1.0 - smoothstep( uRayFalloff.z, uRayFalloff.w, dist ) );
    vec2 st = rayStructure( vUv, r );

    // A shaft is only VISIBLE where the frame has display range left for it. The
    // bright sky beside the sun is already past ACES's shoulder, so ADDING there
    // buys clipping instead of contrast (instant-fail tell 8.12), while the same
    // add across the canopy, trunk and grass — the midtones the shafts rake over —
    // is worth 4-6x as much display luminance.
    float dampT = smoothstep( uRayDamp.x, uRayDamp.x + 0.9, luma( c ) );

    // ...and this is where three rounds of this pass went wrong: the two gates were
    // ANTI-CORRELATED. The ray buffer only has values where the march can see bright
    // sky — which is the bright half of the frame — and that is exactly where the
    // headroom damp threw the add away, so the net delta was a 2-8/255 wash with no
    // shaft in it anywhere. So the pass now spends its signal two different ways and
    // the split follows the destination:
    //   * ADD, weighted by the headroom that is left (1 - damp*dampT), which owns
    //     the midtones: canopy, trunk, grass, hills.
    //   * MULTIPLICATIVE CONTRAST about the local cross-ray baseline, weighted by
    //     dampT, which owns the near-clipped sky. A relative modulation cannot
    //     clip: the shaft is brighter than its neighbour and the gap between two
    //     shafts is darker, the local mean barely moves, and THAT is what reads as
    //     a crepuscular ray over a blown dusk sky.
    //
    // ROUND 4. The add is now driven by the cross-ray HIGH PASS (st.x), not by the
    // absolute level r. That distinction is the whole defect: a marched occlusion
    // average is a smooth radial ramp BY CONSTRUCTION (r -> 1 wherever the path to
    // the source happens to be clear sky), so 'uRayColor * r' can only ever paint a
    // lobe centred on the sun no matter what gates are hung off it. Measured on the
    // shipped r3 build, dusk/hero, delta against 'postfx-dusk-no-rays': peak cell
    // +55.7/255 in one 120x120 cell beside the sun, +2..+7 smeared across the whole
    // aerial-haze band, and 0-1 arc peak at >= 2.5/255 prominence at R = 0.25H and
    // 0.40H — i.e. exactly one soft glow, which is what the critic saw and also part
    // of the milky mid-ground band (§4 of the brief).
    // max(st.x, 0) is nonzero only where this pixel's ray is CLEARER than the rays
    // beside it, which is the definition of a shaft; the flat lobe high-passes to 0
    // and costs nothing. uRayShaft.y keeps a small r^2 absolute term so a shaft has
    // a faint root in the air around it instead of floating.
    // DEADBAND. max(x,0) RECTIFIES noise: the quarter-res march carries a dithered
    // start offset, so st.x has a random component, and the positive half of it
    // survives as a DC lift over the whole sky. Measured without the deadband,
    // dusk/hero at gain 4: +6.0/255 mean over the upper-left sky and +6.3 over the
    // aerial-haze band, with no shaft in either — a wash, and precisely the milky
    // band §4 of the brief asks this pass not to feed. Subtracting the noise floor
    // before the rectifier costs the shafts nothing (they are 5-10x it) and takes
    // the wash to zero.
    float shaft = max( st.x - uRayShaft.z, 0.0 );
    // Soft knee on the core. A shaft is allowed to be bright; it is not allowed to
    // reach a flat white plateau (instant-fail tell 8.12) at the one or two places
    // where the ray field happens to be perfectly clear. This costs a typical
    // 0.03-0.06 shaft under 10% and halves the outliers above 0.3.
    shaft = shaft / ( 1.0 + 2.2 * shaft );
    vec3 add = uRayColor * ( uRayShaft.x * shaft + uRayShaft.y * r * r )
             * win * ( 1.0 - uRayDamp.y * dampT );

    // Signed, so gaps darken as much as shafts brighten. Tinted toward the key so a
    // shaft over the sky is warmer than the sky it crosses, never a grey band.
    //
    // MEASURED (pipeline.histogram('scene')): the ATMOS input is scene-linear
    // PRE-exposure and its p50 is only 0.33 at dusk / 0.36 at day, so a dampT that
    // starts at 0.42 is exactly 0 over more than half of every frame. Gating the
    // contrast term on dampT alone therefore switched it off everywhere it was
    // needed — sweeping the gain 0.62 -> 1.1 moved the frame's cross-ray gradient
    // by 0.0004. So dampT only AMPLIFIES it (a relative modulation is worth most
    // where the absolute add is worth least); the floor keeps it live everywhere.
    vec3 tint = mix( vec3( 1.0 ), normalize( max( uRayColor, vec3( 1e-3 ) ) ) * 1.732, 0.55 );
    float sgn = clamp( sign( st.x ) * max( abs( st.x ) - uRayShaft.z, 0.0 ), -0.5, 0.5 );
    float cw = mix( 0.55, 1.0, dampT );
    vec3 mul = vec3( 1.0 ) + uRayContrast.x * sgn * win * cw * tint;

    c = max( c * mul + add, vec3( 0.0 ) );
    // debug: show only what this pass contributed (the add plus the signed
    // modulation, re-based so gaps are visible against black)
    c = mix( c, add + max( mul - 1.0, vec3( 0.0 ) ) * 2.0, uRaySolo );
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
    uGamma: { value: 1.6 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform sampler2D tHistory;
uniform vec2  uTexel;
uniform float uBlend;
uniform float uWiden;
uniform float uGamma;

/**
 * 3x3 VARIANCE CLIPPING (Salvi), not a 5-tap min/max box.
 *
 * The old rule was clamp(history, min5 - pad, max5 + pad) with pad = 3.5% of the
 * local range. On an alpha-tested blossom edge the 5-tap box is exactly two values
 * — petal and sky — and the history's true sub-pixel value is a MIX of them at a
 * different jitter phase, i.e. legitimately outside that box only when the edge is
 * moving. Measured on the canopy preset, that clamp rejected the history on 34% of
 * canopy-edge pixels, so the jittered accumulation (the entire point of TAA) was
 * being thrown away on precisely the edges it exists to resolve.
 *
 * Clipping to mean +/- gamma*sigma of a 3x3 neighbourhood instead keeps the
 * sub-pixel mixes (they sit inside one sigma of the local mean) while still
 * rejecting genuine disocclusion, which is what stops wind-moved petals ghosting.
 */
vec3 T( vec2 o ) { return texture2D( tDiffuse, vUv + o * uTexel ).rgb; }

void main() {
  vec3 c = T( vec2( 0.0, 0.0 ) );
  vec3 m1 = c, m2 = c * c, mn = c, mx = c;
  for ( int i = 0; i < 8; i ++ ) {
    vec2 o = vec2( i == 0 || i == 3 || i == 5 ? -1.0 : ( i == 2 || i == 4 || i == 7 ? 1.0 : 0.0 ),
                   i < 3 ? -1.0 : ( i > 4 ? 1.0 : 0.0 ) );
    vec3 s = T( o );
    m1 += s; m2 += s * s;
    mn = min( mn, s ); mx = max( mx, s );
  }
  m1 /= 9.0; m2 /= 9.0;
  vec3 sigma = sqrt( max( m2 - m1 * m1, 0.0 ) );
  // UNION of the variance box and the min/max box, never the intersection: a value
  // that literally appears in the 3x3 must always be accepted, and on a hard edge
  // (sigma large) the variance box is the wider of the two, which is the case this
  // pass exists for.
  vec3 pad = ( mx - mn ) * uWiden + 0.002;
  vec3 lo = min( m1 - uGamma * sigma, mn ) - pad;
  vec3 hi = max( m1 + uGamma * sigma, mx ) + pad;
  vec3 h = clamp( texture2D( tHistory, vUv ).rgb, lo, hi );
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
    uHeadroom: { value: 1.0 },  // 0 = plain add, 1 = full headroom weighting
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uStrength;
uniform float uHeadroom;
uniform vec3  uTint;

void main() {
  vec3 c = texture2D( tDiffuse, vUv ).rgb;
  vec3 b = texture2D( tBloom, vUv ).rgb;
  // HEADROOM WEIGHTING — the difference between "atmospheric glow" and
  // instant-fail tell 8.12, "a hard white halo".
  //
  // A plain additive veil is uniform in LINEAR space but not in DISPLAY space:
  // measured at dusk, the veil adds a flat 3-10/255 everywhere, yet the count of
  // 200x200 blocks above L 0.90 with sd < 0.05 went 6 -> 31 when it was switched
  // on, because the dusk sky already sits at L 0.88-0.91 and a flat lift tips a
  // third of the frame over the line into a structureless plateau. Dividing by
  // (1 + luma) spends the veil where the frame still has range for it — the
  // backlit canopy edge keeps ~0.83 of the glow, the near-clipped sky ~0.45.
  vec3 add = b * uTint * uStrength / ( 1.0 + uHeadroom * max( luma( c ), 0.0 ) );
  gl_FragColor = vec4( c + add, 1.0 );
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
    uClamp: { value: null },   // vec2 (min, max) legal focus distance for the probe
    // vec2 (geometric aim distance, how far to pull the probe toward it, 0..1).
    // The probe reads whatever the frame centre happens to hit — in the hero
    // composition that is a gap between branches. The anchor is the distance along
    // the view ray to the tree's own axis, so blending toward it keeps the plane on
    // the subject when the probe sees through it.
    uAnchor: { value: null },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
${CHUNK_COMMON}
${CHUNK_DEPTH}
uniform sampler2D tPrev;
uniform vec2  uCenter;
uniform vec2  uClamp;
uniform vec2  uAnchor;
uniform float uRate;
uniform float uFallback;
uniform float uTarget;

vec2 focusOffset( int i ) {
  if ( i == 1 ) return vec2(  0.030,  0.000 );
  if ( i == 2 ) return vec2( -0.030,  0.000 );
  if ( i == 3 ) return vec2(  0.000,  0.040 );
  if ( i == 4 ) return vec2(  0.000, -0.040 );
  if ( i == 5 ) return vec2(  0.022,  0.030 );
  if ( i == 6 ) return vec2( -0.022,  0.030 );
  if ( i == 7 ) return vec2(  0.022, -0.030 );
  if ( i == 8 ) return vec2( -0.022, -0.030 );
  return vec2( 0.0 );
}

void main() {
  // Pass 1: mean and nearest hit over a small cross at the frame centre.
  float near = 1e9;
  float acc = 0.0, n = 0.0;
  for ( int i = 0; i < 9; i ++ ) {
    float d = rawDepth( uCenter + focusOffset( i ) );
    if ( d < SKY_DEPTH ) { float z = -viewZ( d ); near = min( near, z ); acc += z; n += 1.0; }
  }
  float mean = n > 0.0 ? acc / n : uFallback;

  // Pass 2: reject FOREGROUND CLUTTER. A "nearest hit wins" probe is the wrong
  // rule for this composition — measured in the canopy preset, a blade of
  // instanced grass 2 m from the lens sat on the frame centre and dragged focus
  // from the tree (8-15 m) down to 2.1 m, which put the entire subject outside
  // the far edge of the band. Anything closer than 40% of the mean hit distance
  // is treated as something the camera is looking THROUGH, not AT.
  float cut = 0.40 * mean;
  float acc2 = 0.0, n2 = 0.0, near2 = 1e9;
  for ( int i = 0; i < 9; i ++ ) {
    float d = rawDepth( uCenter + focusOffset( i ) );
    if ( d < SKY_DEPTH ) {
      float z = -viewZ( d );
      if ( z > cut ) { acc2 += z; n2 += 1.0; near2 = min( near2, z ); }
    }
  }
  float mean2 = n2 > 0.0 ? acc2 / n2 : mean;
  float near3 = n2 > 0.0 ? near2 : near;

  // 45% toward the nearest surviving hit, 55% their mean: locks onto the subject
  // without snapping to one stray twig pixel.
  float probe = n > 0.0 ? mix( mean2, near3, 0.45 ) : uFallback;
  // Bound the probe to the composition. A depth probe is only as good as the depth
  // buffer it reads, and it cannot tell "there is nothing at the frame centre"
  // from "the thing at the frame centre did not write depth". Measured at the
  // MEDIUM tier, where the canopy stops writing depth: the probe resolved to
  // 158.9 m (the distant hills) instead of 25.2 m, which put the whole frame in
  // the near field and blurred the entire image. uClamp is derived on the CPU
  // from the camera and CONTRACT's world convention (trunk base at the origin),
  // so a bad depth read can now only shift focus, never lose the subject.
  probe = clamp( probe, uClamp.x, uClamp.y );
  // Pull toward the geometric aim distance. Measured before this existed: the bark
  // preset's probe resolved to 5.05 m — the exact floor of its legal band — while
  // the trunk that fills 60% of that frame stands 3.1 m from the lens, so the
  // "material close-up" was focused two metres behind its own subject.
  if ( uAnchor.x > 0.0 ) probe = mix( probe, uAnchor.x, sat( uAnchor.y ) );
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
  float nearCov = sat( ( -ccoc - 0.8 ) * 0.6 );

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
    // Foreground DILATION: a near-field tap spreads its blur over whatever sits
    // behind it. The threshold has to be well past 1 px or every petal with a
    // sub-pixel CoC dilates a half-res blur across the subject behind it — at
    // -0.75 px the canopy box lost 21% of its edge energy to petals that were not
    // themselves visibly soft.
    // ...and it is weighted by HOW soft that tap is, not applied as a hard max.
    // nearCov forces the destination pixel to the half-res gather, so one small
    // petal with a 2 px CoC used to be enough to make the canopy behind it half
    // res. Ramping over 1.8-6.5 px keeps that for genuinely soft foreground (which
    // §5 wants) and stops it happening for anything merely off-plane.
    nearCov = max( nearCov, spread * sat( ( -s.a - 1.8 ) * 0.21 ) );
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

  // Keep the FULL-RES pixel until the CoC is genuinely wider than a pixel. The
  // gather is half-res, so the instant this blend is non-zero the pixel loses its
  // top octave — which is why a "gentle" far ramp still cost the in-focus subject
  // real detail. MEASURED, hero at 1920x1080, no grain, mean Sobel per box against
  // 'postfx-no-dof-no-grain' (run-to-run noise on these boxes is +/-3%):
  //                    trunk   trunkEdge  canopy   farHills
  //   smoothstep(0.7,2.4)  -8.7%   -9.7%    -21.2%   -43.3%
  //   smoothstep(1.3,3.4)  see the ROUND 4 log at the bottom of 90-postfx.js
  // The far band is untouched by this (the hills' CoC is the full 5 px, well past
  // either knee); all it protects is the plane the composition is focused on.
  float f = max( smoothstep( 1.3, 3.4, abs( coc ) ), blur.a );
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
    // (contrast, pivot) of the SCENE-LINEAR log contrast that runs before ACES.
    // This is the curve that actually owns the frame's dynamic range; the display
    // S-curve below only shapes what ACES hands back.
    uSceneCurve: { value: null },      // vec2 day
    uSceneCurveNight: { value: null }, // vec2 night
    // (knee, log-log slope below the knee, knee softness in log units) of the
    // scene curve's TOE. Guarantees the curve can never be steeper than `slope`
    // at the bottom of the range, i.e. it can never crush a dark value to zero.
    uSceneToe: { value: null },        // vec3
    // 0 = drive the tone curve off Rec.709 luma (what shipped), 1 = off the max
    // channel. See the comment at the call site: luma weights blue at 0.0722, so
    // a saturated sky is read as a SHADOW and crushed by the power law.
    uCurveNorm: { value: 0.0 },
    uFloor: { value: 0.030 },      // display-space floor — the only "never pure black" lift
    uPivot: { value: 0.18 },       // S-curve pivot (log-ish, so 0 stays 0)
    uContrast: { value: 1.12 },    // S-curve slope about the pivot
    uNightPivot: { value: 0.10 },  // the same two, for the night end of uNightMix
    uNightContrast: { value: 1.05 },
    uToe: { value: 0.10 },         // extra roll of the deep shadows only
    uSaturation: { value: 1.08 },  // >= 1 always — never desaturate (art bible §4.6)
    uVibrance: { value: null },    // vec2 (amount, falloff power) — see (3) below
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
uniform vec2  uSceneCurve;
uniform vec2  uSceneCurveNight;
uniform vec3  uSceneToe;
uniform float uCurveNorm;
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
uniform vec2  uVibrance;
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

/**
 * The scene-linear tone curve: in log-exposure space a straight line of slope
 * sc through the pivot (classic film gamma), with its TOE slope clamped to
 * uSceneToe.y below the knee uSceneToe.x.
 *
 * The clamp is the fix for the r2 defect. A pure power law has slope sc
 * EVERYWHERE, so at sc = 2.1 a value one stop under the pivot loses 2.1 stops
 * and a value four stops under loses 8.4 — the mapping keeps accelerating
 * downward with nothing to stop it, which is what took the canopy frame's
 * zenith to literal zero. Blending to a sub-unity slope below the knee makes
 * the curve monotonic with a bounded, gentle toe: at slope 0.90 a value four
 * stops below the knee comes out 3.6 stops down, never crushed.
 *
 * softplus() gives the C-infinity blend: it is ~0 far below the knee (slope
 * -> uSceneToe.y) and ~d far above (slope -> sc), and exact at both limits, so
 * the midtones and highlights are bit-identical to the pure power law.
 */
float sceneTone( float n, float sc, float sp ) {
  float k = max( uSceneToe.x, 1e-5 );
  float s0 = uSceneToe.y;
  float w  = max( uSceneToe.z, 1e-3 );
  float d  = log( max( n, 1e-8 ) / k );
  float spl = max( d, 0.0 ) + w * log( 1.0 + exp( -abs( d ) / w ) );
  float atKnee = log( sp ) + sc * log( k / sp );
  return exp( atKnee + s0 * d + ( sc - s0 ) * spl );
}

void main() {
  vec3 c = max( texture2D( tDiffuse, vUv ).rgb, 0.0 ) * uExposure;

  // --- (0) a REAL black point, set in linear scene space where it belongs.
  //     Subtracting here (Cineon's trick) is what gives the frame a low end.
  //     Scaled down at night, otherwise the navy sky would crush to nothing.
  //
  //     Two changes from r2, both of which that build's zenith failure needed.
  //     (a) On LUMA, scaling the triplet — not per channel. A per-channel
  //     subtract removes a FIXED amount from a channel that may be 20x smaller
  //     than its neighbour, so it does not darken a saturated colour, it
  //     desaturates it through zero: measured on the canopy frame, the zenith
  //     sky arrives as (0.030, 0.184, 0.606) and the per-channel subtract took
  //     its red from 0.0264 to 0.0084, i.e. -68% on one channel and -3% on
  //     another. Same rule as the curve below — the grade owns tone, the
  //     lighting rig owns hue.
  //     (b) A smoothstep-weighted subtract, so the term fades out below 2x the
  //     black point instead of clipping there. The full amount is still removed
  //     from everything above it, which is all a black point is for, but no
  //     input value can be mapped to exactly 0 any more.
  float bk = uBlack * ( 1.0 - 0.8 * uNight );
  float b0 = max( luma( c ), 1e-6 );
  float b1 = max( b0 - bk * smoothstep( 0.0, 2.0 * bk, b0 ), 0.0 );
  c *= b1 / b0;

  // --- (0b) THE contrast, in scene-linear space where a tone curve belongs.
  //     A power law about a scene pivot is a straight line of slope 'contrast'
  //     in log-exposure — the classic film gamma — and ACES's own shoulder then
  //     rolls the top back down, which is why this can add a lot of separation
  //     without clipping. The old build did all of its contrast AFTER ACES,
  //     where the shoulder has already compressed everything into 0..1: measured
  //     on the hero frame, the grade input had p1 0.108 / p50 0.400 linear, i.e.
  //     1.9 stops between the darkest 1% and the median, and no post-ACES curve
  //     can open that up without clipping the sky. Doing it here instead takes
  //     the hero p1 from 0.238 to 0.075 display while p99 RISES (0.867 -> 0.90).
  //     Applied to LUMA and scaled back onto the triplet, so it is tone only and
  //     the lighting rig keeps ownership of every hue (same rule as (1) below).
  //     The DRIVER of the curve is mix(luma, max channel, uCurveNorm), not luma.
  //     Rec.709 luma weights blue at 0.0722, so a saturated sky — the canopy
  //     frame's zenith measures (0.030, 0.184, 0.606), luma 0.18 but max 0.606 —
  //     is handed to the power law as if it were a deep shadow and comes back
  //     0.38x. That is the whole reason a #4E86D4 zenith rendered at display
  //     L 0.199 instead of the ~0.50 ART_BIBLE §3 asks for, and it hit every
  //     saturated colour in the frame the same way (the torii vermilion arrives
  //     as (0.335, 0.092, 0.122), luma 0.146, and came out a dull maroon).
  //     Driving the curve off a norm that respects chroma is the standard fix
  //     and it is SELECTIVE: for a neutral colour max == luma, so ground, bark,
  //     cloud and haze are untouched and the frame's hard-won mid-ground
  //     separation is preserved — only the saturated pixels stop being crushed.
  float sc = mix( uSceneCurve.x, uSceneCurveNight.x, uNight );
  float sp = max( mix( uSceneCurve.y, uSceneCurveNight.y, uNight ), 1e-4 );
  float lc = luma( c );
  float sl0 = max( mix( lc, max( max( c.r, c.g ), c.b ), uCurveNorm ), 1e-6 );
  c *= sceneTone( sl0, sc, sp ) / sl0;

  // one tonemap, right here — the renderer is set to NoToneMapping by 90-postfx
  c = acesFilmic( c );

  // white balance / channel gamma on the tonemapped image (subtle golden cast)
  c = sat3( c * uGain );
  c = pow( c, 1.0 / uGammaC );

  // --- the grade proper, in this exact order -------------------------------
  // (1) S-curve contrast about a pivot below mid grey, applied to LUMINANCE and
  //     then scaled back onto the triplet. A POWER law, not a line: it fixes
  //     0 -> 0 and pivot -> pivot and only ever changes local slope.
  //
  //     Why on luma and not per channel: a per-channel power law with an exponent
  //     above 1 does not only add contrast, it multiplies CHROMA in the shadows —
  //     the small channel is crushed far harder than the large one. Measured on
  //     the hero frame, a shadowed patch of grass the rig delivered as
  //     (40,47,72) came out of the old per-channel curve as (14,30,72): the red
  //     channel had lost 65% of its value, i.e. the grade had turned a cool green
  //     shadow into electric navy. Scaling the triplet by luma_out/luma_in leaves
  //     every hue and every chroma ratio exactly as the lighting rig authored it
  //     (ART_BIBLE §2 owns shadow colour; the grade only owns tone), and leaves
  //     saturation to the one dial that is supposed to control it, uSaturation.
  //
  // At night every value in frame sits far BELOW a daylight pivot, where a power
  // law is a pure multiplicative crush — it takes range out of the one phase that
  // has the least to spare. The pivot and slope therefore travel with uNightMix.
  float pv = mix( uPivot, uNightPivot, uNight );
  float ct = mix( uContrast, uNightContrast, uNight );
  float l0 = max( luma( c ), 1e-5 );
  float l1 = pv * pow( l0 / pv, ct );

  // (2) toe: an extra, gentle roll of the DEEP shadows only, so the low end has
  //     somewhere to go. Relaxed at night for the same reason as the black point.
  float lo = smoothstep( pv, 0.0, l1 );
  l1 *= 1.0 - uToe * ( 1.0 - 0.8 * uNight ) * lo * 0.42;

  c *= l1 / l0;

  // (3) saturation — art bible §4.6 is +8%; a value below 1 is never legal here,
  //     desaturating the grade is what produced neutral-grey shadows. On top of
  //     the flat +8% sits a VIBRANCE term that is inversely weighted by the
  //     pixel's existing chroma: the aerial-perspective haze on the hill bands
  //     and the flat sky are the near-neutral things in frame and the ones that
  //     read as milky, while the canopy and the vermilion are already saturated
  //     and would go garish under the same multiplier.
  float l = luma( c );
  float mxc = max( max( c.r, c.g ), c.b );
  float mnc = min( min( c.r, c.g ), c.b );
  float chroma = ( mxc - mnc ) / max( mxc, 1e-4 );
  // Damped at night: the moonlit grass is a near-neutral teal, i.e. exactly what
  // the vibrance term is built to grab, and at full strength it came out emerald
  // (measured satMean 0.677 on the night hero frame against 0.31 by day).
  float satAmt = max( uSaturation, 1.0 )
    + uVibrance.x * ( 1.0 - 0.45 * uNight ) * pow( 1.0 - chroma, uVibrance.y );
  c = mix( vec3( l ), c, satAmt );

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
    uSharpen: { value: 0.0 },
    // ART_BIBLE §3's "never pure black", enforced HERE as well as in GRADE —
    // this is the last stage before the framebuffer, so it is the only place a
    // floor cannot be undone by the vignette multiply or the grain add.
    uFloor: { value: 0.056 },
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
uniform float uSharpen;
uniform float uFloor;

/**
 * AMD FidelityFX CAS (the cheap 5-tap variant), in display space, after SMAA.
 *
 * A jittered temporal resolve is a low-pass filter: measured on hero, TAA at 1.35 px
 * jitter takes the 300x300 trunk Sobel from 0.521 to 0.389 while removing 68% of the
 * isolated 1-px spikes. Every shipped TAA renderer pays that back with a sharpen
 * pass; doing it with CAS rather than an unsharp mask matters because CAS's
 * amplitude is derived from the LOCAL RANGE (sqrt(min(mn, 1-mx)/mx)) and therefore
 * falls to zero on the near-clipped high-contrast edges — it restores acuity on
 * midtone detail (bark, grass, petal interiors) without re-printing the aliasing.
 */
vec3 casSharpen( vec2 uv ) {
  vec3 e = texture2D( tDiffuse, uv ).rgb;
  if ( uSharpen <= 0.0 ) return e;
  vec3 b = texture2D( tDiffuse, uv + vec2( 0.0, -uTexel.y ) ).rgb;
  vec3 h = texture2D( tDiffuse, uv + vec2( 0.0,  uTexel.y ) ).rgb;
  vec3 dd = texture2D( tDiffuse, uv + vec2( -uTexel.x, 0.0 ) ).rgb;
  vec3 f = texture2D( tDiffuse, uv + vec2(  uTexel.x, 0.0 ) ).rgb;
  vec3 mn = min( min( min( dd, e ), min( f, b ) ), h );
  vec3 mx = max( max( max( dd, e ), max( f, b ) ), h );
  vec3 amp = sqrt( sat3( min( mn, 1.0 - mx ) / max( mx, vec3( 1e-4 ) ) ) );
  // peak weight runs from -1/8 (soft) to -1/5 (sharp), exactly as CAS specifies
  vec3 w = -amp * mix( 0.125, 0.2, sat( uSharpen ) );
  vec3 o = ( b * w + dd * w + f * w + h * w + e ) / ( 1.0 + 4.0 * w );
  // Clamp to the 5-tap RANGE, which is what FidelityFX CAS itself does and what
  // r2 was missing. A sharpen kernel's negative lobe undershoots on the dark side
  // of a high-contrast edge; sat3() then parks that undershoot at 0 and the frame
  // gets literal black pixels wherever a 1-2 px bright feature sits on a dark
  // field. Measured on the r2 canopy frame that is exactly what the zenith was:
  // the sky/cloud boundary there resolves at pixel scale (a scene scanline reads
  // 0.60, 0.96, 0.97, 0.98, 0.98, 0.94, 0.163, 0.163, ...), so a dark sky pixel
  // ringed by cloud undershot straight through zero and printed as one grain of
  // salt-and-pepper. Clamping to [mn, mx] keeps every bit of the acuity CAS buys
  // and makes overshoot in either direction impossible.
  return clamp( o, mn, mx );
}

void main() {
  vec2 d = vUv - 0.5;
  float rc = length( d ) * 1.41421356;            // 1.0 at the corners

  // Chromatic aberration confined to the outer 8% of the frame radius: zero
  // until rc = 0.84, reaching ~1.2 px only in the corners. Anything wider than
  // this reads as a lens defect rather than as polish.
  vec2 dir = d * ( uCA * smoothstep( 0.84, 1.0, rc ) );
  vec3 c = casSharpen( vUv );
  if ( dot( abs( dir ), vec2( 1.0 ) ) > 1e-5 ) {
    c.r = casSharpen( vUv + dir * uTexel ).r;
    c.b = casSharpen( vUv - dir * uTexel ).b;
  }

  // vignette
  c *= 1.0 - uVignette * pow( rc, 2.4 );

  // Animated film grain — art bible §4.9, and the cheapest possible answer to a
  // flat sky. Two decorrelated white-noise fetches averaged (flat spectrum, so
  // it can never print a tiling pattern), signed on [-1,1], rolled off in the
  // highlights so specular cores and bloom stay clean.
  vec2 pn = vUv * uResolution;
  float t1 = fract( uTime * 3.317 ) * 137.0, t2 = fract( uTime * 1.913 ) * 211.0;
  float n = hash12( pn + vec2( t1, t2 ) ) * 2.0 - 1.0;   // uniform on [-1,1]
  float gl = luma( c );
  // ...and rolled off in the DEEP shadows too. A flat +/-2.6% is 6.6/255, which is
  // a 100% relative modulation on a pixel sitting near the floor: that is where
  // the r2 zenith's visible salt-and-pepper came from once the sharpen undershoot
  // had put the base near zero. 0.30 + 0.70 * smoothstep keeps the grain at full
  // amplitude everywhere it is meant to read and takes it to 30% below L 0.09.
  c += n * uGrain * ( 1.0 - 0.22 * sat( gl ) )
     * ( 0.30 + 0.70 * smoothstep( 0.0, 0.09, gl ) );

  c = sat3( c );

  // "never pure black" (ART_BIBLE §3), applied LAST. GRADE has its own floor, but
  // the vignette multiply and the grain add both run after it, so the guarantee
  // has to be re-made here or the corners and the noise punch straight through it.
  // t^2 shape over a 1.7x window: exact at 0, ~11% of the floor at half the
  // window, zero above it — invisible except where something was about to clip.
  float fk = max( uFloor * 1.7, 1e-4 );
  vec3 ft = vec3( 1.0 ) - min( c / fk, vec3( 1.0 ) );
  c += uFloor * ft * ft;

  gl_FragColor = vec4( sat3( c ), 1.0 );
}`,
};
