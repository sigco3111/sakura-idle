# Resume notes — paused 2026-07-28 morning

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
