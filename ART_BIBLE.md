# Art bible — the single source of visual truth

Every module obeys this. When your module's look disagrees with this file, this file wins.

**Target:** a player takes a screenshot of this game, puts it beside a Genshin Impact
screenshot, and cannot immediately tell which is the AAA product. That is the bar. Not
"nice for a web demo" — the bar is the actual shipped game.

---

## 1. The scene

A single ancient sakura tree on a small grassy rise, wrapped by a low stone wall and a
weathered vermilion torii, with a still pond to the west catching fallen petals and stone
lanterns along a mossy path. Distant blue-hazed hills. Petals always in the air. Time of
day cycles dawn → day → dusk → night, driven by `time:phase`.

Mood: *serene, warm, slightly melancholy, luminous.* Hanami at golden hour.

## 2. Lighting model — non-photoreal, ramp-shaded

This is the highest-leverage thing in the project. **Do not ship PBR-default lighting.**

- **Diffuse**: half-Lambert `d = NdotL*0.5+0.5`, then pushed through a **ramp** with a
  soft-but-defined terminator (roughly: shadow below 0.42, a narrow mid band 0.42–0.52,
  light above). Two to three readable tone bands, not a smooth gradient.
- **Shadow colour is hue-shifted, never just "darker"**. Multiply shadowed albedo toward
  cool violet-blue `#6E76A8`, ~0.55 luminance of the lit side. Pure-black shadow is an
  instant fail.
- **Specular**: one sharp, small, clipped highlight (step on Blinn-Phong), plus a broad
  low-intensity sheen. No rough metallic PBR response on organic surfaces.
- **Rim light on every silhouette**: Fresnel `pow(1-NdotV, 3.2)`, tinted to the *back*
  light colour, strongest where the surface faces away from camera and toward the sun.
  This is what separates the canopy from the sky and reads as "anime".
- **Translucency / wrapped light on all thin foliage**: light bleeds through backlit
  petals and leaves — `transmission = pow(saturate(dot(-L, V)), 4) * thickness`, tinted
  warm `#FFE3EC`. Backlit canopy edges must glow pink. Non-negotiable for sakura.
- **Ambient is directional, not flat**: sky colour from above, bounced ground colour from
  below (hemisphere), plus a weak ambient-occlusion-driven darkening in canopy interiors
  and under props.

## 3. Palette (author in sRGB)

| role | day | dusk | night |
|---|---|---|---|
| sun / key | `#FFEBCB` | `#FF9E5E` | `#9FB6E8` (moon) |
| sky zenith | `#4E86D4` | `#3A4E86` | `#101A34` |
| sky horizon | `#CFE0F2` | `#F5A86E` | `#2A3355` |
| shadow tint | `#6E76A8` | `#5A4A78` | `#1E2A4A` |
| fog / aerial | `#BCD3EA` | `#E8A57E` | `#1B2440` |

Sakura petals — the hero colour, five values, use all of them:
`#FFF2F6` (specular/edge) · `#FFD9E6` (light) · `#FFB6CE` (mid) · `#EE8CAF` (shadow) ·
`#C25F86` (deep interior). Backlit transmission: `#FFE7EE`.

Bark `#6A5344` → `#3F3029` in cracks, lichen `#9AA88C`, moss `#5C7A3E`.
Grass `#8FB463` (tips, sun-bleached, warmer) → `#3E6134` (base, cooler). **Grass must be
lighter and yellower at the tips** — uniform green grass is a dead giveaway.
Torii vermilion `#C4322B` weathered toward `#8E3A32`; stone `#9E9A92` with `#6E6A62` in
crevices. Gold (UI + accents) `#E8C56A` → `#A8792C`.

Rules: never pure black (min luminance ≈ 0.055), never pure white except specular cores
and bloom. Saturation high but coherent — every colour reads as if lit by the same sun.

## 4. Post-processing chain (owned by `90-postfx.js`, order fixed)

1. Render scene → HDR float target
2. **SSAO/GTAO** — subtle, radius ~0.6 world units, intensity ≤ 0.55, only for contact
   darkening. Must not look like dirty smudges.
3. **God rays / volumetric shafts** from the sun through the canopy — radial occlusion
   blur, additive, tinted to sun colour. Strong at dawn/dusk.
4. **Bloom** — wide, soft, multi-mip (UnrealBloom style). Threshold ~0.85, strength ~0.55,
   radius ~0.75. Genshin's bloom is *hazy and generous*; a tight bloom looks cheap.
5. **Depth of field** — gentle. Focus on the tree, foreground grass and far hills softly
   out. Bokeh must not bleed sharp edges (use a proper CoC-weighted gather).
6. **ACES filmic tonemap** → **colour grade**: lift shadows toward `#2A2438`, warm the
   highlights, gentle S-curve contrast, +8% saturation, slight split-tone (cool shadows /
   warm highs).
7. **Vignette** — very subtle, ~12% at corners, and a faint chromatic aberration at the
   extreme edge (≤ 1.2 px). Both must be invisible unless you look for them.
8. **SMAA** (or TAA when `ctx.quality.taa > 0`) — edges must be clean; aliased petal edges
   read as amateur instantly.
9. Optional: fine film grain ≤ 2%, animated.

## 5. Detail density — the "no empty pixel" law

Genshin has no flat, empty surfaces. Neither do we.

- Ground: multi-layer blended textures (grass / dirt path / moss / stone) driven by
  slope + noise, **plus** instanced grass blades, clover clumps, pebbles, fallen petal
  decals, small wildflowers. Density falls off with distance, never to zero.
- Trunk: bark normal + cavity detail, moss on the north/shadow side, lichen patches,
  visible root flare blending into the terrain with a vertex-colour transition.
- Canopy: individual petal clusters must be resolvable at `bark`/`canopy` distance.
  Blobby spheres are an instant fail. Layered cards, varied per-instance scale/rotation/hue.
- Every silhouette edge should have something breaking it up — stray branches, loose petals.
- **Foreground framing**: at least one out-of-focus element (grass tuft, branch, petals)
  in the near field of the `hero` composition.

## 6. Motion — static is an instant fail

Nothing in frame is allowed to be perfectly still.

- Wind: one coherent global wind field (`sin` gusts + curl noise) that *all* modules sample
  so grass, branches, petals and water agree on direction and gust timing.
- Branch hierarchy sway: amplitude scales with distance from trunk; trunk barely moves,
  twig tips move a lot, with lag/phase offset per branch.
- Petals: tumble on 3 axes, flutter (sinusoidal lateral drift), terminal velocity, and
  *settle* — they land, rest, then get picked up by gusts.
- Grass: per-blade phase, bend not slide, bend along the wind direction with recovery.
- Light dapples through the canopy onto the ground (animated shadow mask).
- Water: two-layer normal scroll + ripple rings where petals land.
- Camera: slow idle breathing drift (≤ 0.4° amplitude, ~14 s period) plus parallax on
  pointer. Never a locked-off camera.

## 7. UI style — Genshin's actual UI language

- **Panels**: warm parchment `#F3EBDC` at ~94% opacity over a backdrop blur, inset cream
  gradient, 1.5 px border `#4A4034`, then a thin `#C9A227` gold inner keyline offset 3 px.
- **Ornament**: gold filigree corner pieces (procedural SVG/canvas), a small diamond/rhombus
  motif at panel-title centre, and hairline dividers that taper at the ends.
- **Type**: display/headers in a serif stack (`"Hiragino Mincho ProN", "Songti SC",
  Georgia, serif`) with generous letter-spacing; body in a clean sans. Numbers **always**
  `font-variant-numeric: tabular-nums`.
- **Buttons**: gold vertical gradient `#F0D68A → #B98B32`, 1 px darker border, inner top
  highlight, drop shadow; hover lifts 1 px + gold outer glow; active presses in.
- **Rarity**: 3★ blue `#4C8BC9`, 4★ violet `#A277DD`, 5★ gold `#D5A54A` — as a gradient
  card background plus a star row, exactly like Genshin's item cards.
- **Motion**: entrances 220 ms `cubic-bezier(.2,.9,.25,1.15)` (slight overshoot), staggered
  ~35 ms per row. Numbers tick up with easing, never snap. Currency gains fly to the HUD
  counter. Every hover/press has feedback within 80 ms.
- No flat Material-Design rectangles. No default system-blue focus rings. No pure `#fff`
  panels, no pure `#000` text (use `#3A322A`).

## 8. Instant-fail tells (any one of these = not AAA, keep working)

1. Default grey `MeshStandardMaterial` anywhere visible.
2. Flat single-colour ground or sky.
3. No fog / no aerial perspective on distance.
4. Pure black shadows, or shadows that are only "darker albedo".
5. Visible low-poly faceting on organic shapes; blobby sphere canopy.
6. Petals rendered as circles, squares, or untextured quads.
7. Anything perfectly still, or perfectly regular/gridded placement.
8. Aliased/jaggy silhouette edges.
9. Washed-out or muddy midtones; whole image low contrast.
10. UI in default fonts and flat rectangles.
11. Empty, undetailed regions of frame.
12. Bloom that looks like a hard white halo instead of atmospheric glow.

---

## 9. Critic protocol (for review agents)

Score the render **0–10 on each axis**. Report per-axis score, the single most damaging
concrete defect for each axis below 8, and an exact prescription (file, technique, values).

1. **Silhouette & composition** — readability, leading lines, thirds, foreground framing.
2. **Lighting believability & style** — ramp shading, terminator quality, hue-shifted shadows.
3. **Rim / backlight / translucency** — does the canopy glow when backlit?
4. **Colour grade & palette coherence** — one sun, coherent temperature, no muddy midtones.
5. **Atmosphere** — fog, aerial perspective, god rays, depth separation.
6. **Material richness** — bark, stone, foliage read as distinct, detailed materials.
7. **Detail density** — no empty pixels, micro-detail at all depths.
8. **Foliage / petal quality** — resolvable petal shapes, varied, translucent.
9. **Post-processing craft** — bloom, DOF, AA, vignette all present and *tasteful*.
10. **Motion & life** (judge from the multi-frame strip) — wind coherence, no stiffness.
11. **UI craft** (when UI is in frame) — ornament, type, hierarchy, polish.
12. **"Would I believe this is a shipped AAA game?"** — holistic gut score.

**Gate:** PASS requires **every axis ≥ 8** *and* **axis 12 ≥ 9** *and* **zero instant-fail
tells from §8**. Anything else is FAIL with prescriptions.

You are a hostile critic with a bias toward FAIL. Genshin Impact cost hundreds of millions
of dollars; assume this render is worse until the pixels prove otherwise. Vague praise is
useless — every criticism must name a pixel region and a fix. Do **not** award points for
effort, for "good for WebGL", or for progress since the last round. Judge only the frame
in front of you against the shipped commercial product.
