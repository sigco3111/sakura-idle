# Resume notes

## 2026-07-29 ~09:15 — Phase 5 fix stage landed, PAUSED for Dan's work day

All 7 agents wrote their files; the critic loop was stopped before it ran, so **this work is
unreviewed**. Build verified running (exit 0, 61 draw calls, 11.6 ms/frame at ultra).
Latest frame: `shots/pause2/hero.png`.

### Fixed and measured
- **Violet canopy solved.** Interior mean went (185,144,174) → (192,142,160); blue/red ratio
  **0.94 → 0.83** (target 0.69 = `#C25F86`). Visually the crown now reads pink, not mauve.
  Still short of target — worth one more pass, but no longer the dominant defect.
- Purchase buttons exist (a `TEND ×1` control on each Tender row) — the blocking "clicker with no
  clickable button" is gone.
- Torii kasagi blotches cleared; weathering now follows form.
- Lanterns no longer blow out in daylight.
- Blossoms distributed across more limbs (the dead-wood read is much reduced, not fully gone —
  the mid-limbs are still sparser than the crown).

### Not yet verified (agents claimed, critic never checked)
God rays, night moon + stars, stage 5 Everblossom, the fog reduction, and the re-tuned pacing.
Note `clickValue` is now 0.7 (was 1.0), so the pacing curve was retuned — re-measure the 60-minute
sim against `GAME_DESIGN.md` before trusting it.

### Pick up here
1. Run the Phase 5 critic loop — nothing has scored this state. Prior scores: 2.9 → 3.2 → 2.9 → 4.2.
2. Canopy B/R still 0.83 vs 0.69 target; and the crown is somewhat wispy/sparse rather than lush.
3. Distance still reads a little hazy in the hero frame — check whether the fog reduction fully landed.
4. Still unbuilt from the original plan: nothing major, but stage 5's set-piece features and the
   Constellation/Codex screens have never been visually reviewed.

Resume the workflow in the SAME session only via:
```
Workflow({ scriptPath: "/Users/dan/.claude/projects/-Users-dan-Projects-claude-experiments-sakura-idle/0e6c86cd-66a5-4dfe-b844-22b3c3337013/workflows/scripts/sakura-phase5-canopy-and-blockers-wf_04406f07-cbc.js",
           resumeFromRunId: "wf_04406f07-cbc" })
```
In a fresh session, author a new workflow with just the critique + refine stages (the builder
prompts in that script file are reusable as reference).

## 2026-07-29 ~01:45 — Phase 4 done, subagent window exhausted (resets 03:30 Europe/Bucharest)

Critic went **2.9 → 4.2** across two rounds. Round-2 refiners and the round-3 critic died on the
session limit; the code on disk is the state that measured **4.2**, committed.

Landed this phase: the pond (real sky reflection — currently the best-looking element in the
build), torii + stone lanterns + mossy wall + basin, first-run bloom stage 1, and the round-1
fixes. Verified working by probe: `shake()` double-fire is FIXED (one gain event, netPetals ==
displayed value), fresh save is `{stage:1, stageFloor:1}`, save/load round-trips at version 3,
economy tables match `GAME_DESIGN.md` exactly. Favicon 404 fixed (inline data: URI in index.html).

### The top remaining defect: violet/magenta canopy

The crown shows saturated violet patches instead of sakura pink. This is the single most damaging
visual defect. **Already ruled out by measurement — do not re-test these:**
- NOT post-processing: `--scenario postfx-off` still shows the violet (`shots/dbg-nopost/hero.png`).
- NOT the blue sky ambient: zeroing `uSkyColor` at runtime changed the canopy region mean by
  literally 0 (185,144,174 both before and after).
- NOT the albedo constants: `30-tree.js` authors the correct ART_BIBLE five (`#FFF2F6 #FFD9E6
  #FFB6CE #EE8CAF #C25F86`).

So it is inside the tree's own fragment shader. Canopy interior mean measures **(185,144,174)** —
blue almost equal to red with green ~40 lower, i.e. mauve. ART_BIBLE's deep interior `#C25F86` is
(194,95,134), where blue sits well BELOW red. Prime suspects in `src/lib/tree-shaders.js` around
lines 1310-1400: `uDeepTint` = (0.90, 0.69, 0.77) crushes green fastest and is applied
multiplicatively via `occ`, then compounded by `uDeepClamp` and the luminance-preserving re-hue at
~1394. Something in that chain lifts blue relative to red. Fix so the deep interior lands on rose,
not lavender, and verify by sampling the region mean: want R clearly > B.

### Other visible defects (from `shots/state-p4/` and `shots/dbg-nopost/`)

- **Bare grey limbs.** Several major branches carry no blossoms at all and read as dead wood. At
  stage 1 low coverage should thin blossoms EVENLY across the whole crown, not leave whole limbs
  naked. Clearly visible on the right-hand limbs in the hero shot.  [30-tree.js]
- **Lanterns blow out.** With postfx off their emission is a flat yellow blob. Strong halo is right
  at night; in day/dusk it needs to be far subtler.  [35-props.js]
- **Aerial fog still too strong** in the mid-ground — the field-to-hills transition washes to a
  milky band and the hills lose value separation.  [08-lighting.js]
- **Torii kasagi has dark blotches** that read as damage rather than weathering.  [35-props.js]
- Round-1 blockers not yet re-verified after refine: god rays not rendering at ultra, stage 5
  Everblossom being the worst-looking stage, night sky missing moon + stars while the FULL MOON
  banner claims the moon is up.

### Pacing note

A live 12-minute sim reached the first Tender at 3 s vs the ~20 s target and stage 2 at 692 s vs
the ~8 min target. The double-fire fix will have shifted both; re-measure before retuning, and
retune the CURVE rather than the click value.

---

# Original resume notes — paused 2026-07-28 morning

Paused mid-Phase-3 at Dan's request to free up subscription tokens. Everything below is
committed; nothing is lost. Continuing tonight.

## How to see where we are

```bash
cd ~/Projects/claude-experiments/sakura-idle
npm run dev            # or: node tools/shot.mjs --out shots/now --presets gameplay --ui 1
```

Latest frame: `shots/pause-check/gameplay.png`

## What's done

- **Phase 0** — scaffold, module auto-registry (one file per agent, no collisions), `CONTRACT.md`,
  `ART_BIBLE.md` (12-axis rubric + instant-fail tells), `GAME_DESIGN.md` (full economy spec).
  Tools: `shot.mjs` (deterministic screenshots, own Vite server per run, non-zero exit on page
  error, `--frames` motion strips), `sheet.mjs` (contact sheets + seeded blind A/B),
  `stats.mjs` (objective image gates), `probe.mjs` (live-scene expression evaluator).
- **Phase 1** — lighting rig + shared NPR shading library, sky/clouds/stars/hills, post chain.
  Critic FAIL 2.9/10 after 3 rounds.
- **Phase 2** — real tree (procedural branches, bark, instanced blossom clusters, bloom stages),
  terrain (blended ground, instanced grass, scatter, stone path), GPU petals. Critic 3.2/10.
  `flatBlocks` 0.86 → 0.10, `detail` 0.015 → 0.219.
- **Shadow fix (solo)** — see the commit message on `5aa1e95`. The shadow map was always correct;
  the canopy's shadow landed at world (18.8,0,-9.6) = screen (2090,905) of a 1600x900 frame,
  outside both the view and the ±16 shadow frustum. Fixed by raising the sun arc and fitting the
  frustum to the shadow's landing footprint. Also `NPR_SHADOW_LEVEL` 0.99 → 0.55.
- **Phase 3 (build stage only)** — all six builders completed and their files are on disk:
  economy + save/prestige/events (`60-game.js`, `lib/economy.js`), Genshin-style DOM UI
  (`65-ui.js`, `lib/ui-style.js`, `lib/ui-widgets.js`), click VFX + set pieces (`45-vfx.js`,
  `lib/vfx-shaders.js`), procedural WebAudio (`70-audio.js`), camera rig (`10-camera.js`),
  plus contrast/postfx/tree/terrain revisions. Harness exits 0; UI renders.

## What was cut off

The Phase 3 **critic + refine loop never ran** — I stopped the workflow right after the build
stage. So the Phase 3 work is unreviewed. Nothing has scored it yet.

Workflow resume (SAME SESSION ONLY — will not work tonight in a fresh session):
```
Workflow({ scriptPath: "/Users/dan/.claude/projects/-Users-dan-Projects-claude-experiments-sakura-idle/0e6c86cd-66a5-4dfe-b844-22b3c3337013/workflows/scripts/sakura-phase3-game-and-contrast-wf_1493b115-238.js",
           resumeFromRunId: "wf_1493b115-238" })
```
In a fresh session, just author a new workflow with the critic + refine stages only (the builder
prompts are already in that script file and can be reused verbatim as reference).

## Pick up here tonight

1. **Default view shows a bare tree.** A fresh save is bloom stage 0 (冬芽 Winter Bud), which is
   correct per `GAME_DESIGN.md` but means the default hero/gameplay shot has no blossoms. Decide:
   either start new players at stage 2-3, or make the critics/marketing shots use
   `--scenario rich` / `--scenario lategame`. This matters — it's the first thing a player sees.
2. **Run the Phase 3 critique.** Nothing has reviewed the game, UI, VFX, audio or camera yet.
   Verify gameplay actually works via `tools/probe.mjs` (click → petals, buy Tender → rate up,
   save round-trips) and check the 60-minute pacing against the `GAME_DESIGN.md` table.
3. **Known outstanding from the Phase 2 critic** (not yet confirmed fixed):
   - `canopy` preset: near-camera grass blades occlude ~60% of frame (grass not distance-faded).
   - Near-black twig slivers in the crown (twig cards edge-on, unlit backfaces).
   - `--q low` is a different *look*, not lower fidelity (~95% bare branch over flat lime ground).
   - Dawn/dusk/night: ground lighting didn't match sky time-of-day.
   - Day clouds regressed from cumulus form to thin filaments.
4. **Unbuilt from the original plan:** pond/water (`25-water.js`) and props — torii, stone
   lanterns, wall (`35-props.js`). Both have reserved `order` slots in `CONTRACT.md`.
5. **The composition tradeoff I deliberately left open.** The hero camera's bottom edge hits the
   ground at world (1.4, 0, 2.1) — right at the tree base — so visible ground lies *beyond* the
   tree. With this framing you can have a backlit canopy (which the critic praised) or a long
   visible cast shadow, but not both. Worth deciding with Dan rather than guessing.

## Hard-won facts worth not rediscovering

- Judge NPR lighting only on surfaces that actually call `nprShade`. Reviewing it on a
  `MeshStandardMaterial` placeholder is what caused agents to hack the standard-material shadow
  path and produce the navy paint-fill shadow in Phase 1.
- Colour-coded shader debug output is **unreliable here** — it passes through the full tonemap +
  grade + bloom chain. Use A/B renders (toggle a feature, diff pixels) instead.
- `directionalShadowMap` is absent from `material.uniforms` even on working materials; three binds
  it at program level (`WebGLRenderer.js` ~2623). Not a bug.
- Two rounds regressed by *overshooting* fixes in opposite directions. Give refiners target
  numbers and the full review (including a "must not regress" list), not just their own slice.
- Token budget: Phase 1 ≈ 3.1M subagent tokens / 2.6 h; Phase 2 ≈ 2.9M. Phase 2's refine stage
  died on the session limit. Budget roughly 3M per big fan-out and don't start one on a tight window.
