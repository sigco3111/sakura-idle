# 桜 Sakura — Petals of the Everblossom

An incremental idle game about growing one ancient cherry tree, rendered in Three.js with
anime-styled non-photorealistic shading. Click the tree to shake petals loose, hire spirits to
gather them, and carry the tree from a bare winter bud to the Everblossom.

**▶ Play it in your browser: [sakura-idle.vercel.app](https://sakura-idle.vercel.app)**

**Everything you see is generated in code.** No textures, no models, no HDRIs, no audio files, no
fonts, no network requests at runtime. The bark, the blossom atlas, the grass, the stone, the
water, the clouds, the UI filigree and the music are all procedural.

![Sakura hero shot](docs/hero.png)

## Play

```bash
npm install
npm run dev
```

Then open the printed URL. `Space` shakes the tree, `1`–`9` buy Tenders, `Esc` closes panels,
`Tab` cycles them.

## What's in it

**Rendering**
- Custom NPR / cel-shading library: half-Lambert pushed through a banded ramp with a defined
  terminator, hue-shifted (never black) shadows, clipped specular, Fresnel rim, and wrapped
  transmission so backlit petals glow
- Procedural sakura tree — recursive branch hierarchy, procedural bark with cracks/moss/lichen,
  instanced blossom-cluster cards with resolvable five-petal flowers, six bloom stages
- One shared global wind field that grass, branches, petals, clouds and water all sample, so gusts
  sweep the whole scene coherently
- GPU petal system with divergence-free curl-noise advection, three-axis tumble, settling and
  gust pickup
- Terrain with multi-layer blended ground, up to 260k instanced grass blades, Poisson-disc scatter
- Pond with planar reflections, wind-driven ripples and petals that drift on the surface
- Torii, stone lanterns with real emissive glow at night, mossy wall, tsukubai
- Sky with painted volumetric clouds, Mie forward-scatter, stars, moon, milky way, layered
  aerial-perspective hills
- Post chain: GTAO → god rays → bloom → CoC-weighted DOF → ACES + split-tone grade → vignette →
  SMAA/TAA
- Full dawn/day/dusk/night cycle driving every material

**Game**
- Ten Tenders with milestone multipliers, three upgrade families, six bloom stages
- Seasons (prestige) with a 30-node radial Constellation
- Live events: Petal Storm, Full Moon, Golden Hour, Spring Rain, and a catchable Golden Petal
- 12-variety Codex, ~44 achievements, offline accrual, versioned save with migrations
- Procedural WebAudio: generative pentatonic koto, ambient wind tied to the real wind field,
  crickets at night

**Runs at** ~60 fps at 1920×1080 on an M1 Pro, ~61 draw calls, with quality tiers down to `low`.

## How it was built

It all started with one single [prompt](prompt.md), Claude Code + Opus 5 did the rest.

This was built by a fleet of Claude subagents under an orchestrator, and the repo keeps the
scaffolding that made that work:

- **`CONTRACT.md`** — a module contract giving each agent exactly one file to own, so a dozen
  agents can work in parallel with zero merge collisions. Modules self-register via
  `import.meta.glob`.
- **`ART_BIBLE.md`** — the single source of visual truth: palette, lighting model, a 12-axis
  scoring rubric and a list of instant-fail tells. Art review was run by adversarial critic agents
  scoring against it with a strong bias toward failure.
- **`GAME_DESIGN.md`** — the economy tables and pacing targets as spec.
- **`tools/shot.mjs`** — deterministic screenshot harness. Boots its own Vite server on a free
  port so N agents can shoot concurrently, fixed-timestep sim for reproducible frames, motion
  strips, and a non-zero exit on any page or shader error.
- **`tools/stats.mjs`** — objective image gates (crushed blacks, flat regions, saturation,
  micro-detail, whether shadows are genuinely hue-shifted).
- **`tools/probe.mjs`** — evaluates expressions against the live scene, which turned out to be far
  cheaper than reading shader source when debugging.
- **`tools/sheet.mjs`** — contact sheets and seeded blind A/B comparisons.

`RESUME.md` is the running engineering log, including the debugging dead ends, because carrying
*negative* results forward ("it is not the post-processing, not the ambient, not the albedo")
turned out to be the single highest-leverage thing in the whole process.

## Honest status

The stated goal was "indistinguishable from Genshin Impact in a blind comparison." It is not that,
and a browser scene with no artist-authored assets and a ~6 ms post budget realistically won't be.
The adversarial critics — scoring against a shipped-AAA bar with a deliberate bias toward FAIL —
have it in the 3–4 out of 10 range, and the gate (all twelve axes ≥ 8) has never been met. Known
weak points are canopy density, the crown's palette coherence, and mid-ground atmosphere.

What it is: a genuinely striking, coherently art-directed, fully procedural real-time scene with a
complete idle game attached, and a set of tools that make automated visual iteration possible.

## Licence

MIT. Sakura variety names and the Japanese text are ordinary botanical/common terms.
