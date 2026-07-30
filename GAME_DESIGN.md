# Game design — Sakura: Petals of the Everblossom

Incremental / idle clicker. The numbers below are **the spec** — implement them, don't invent
your own curves. Where a value is marked *(tune)* you may adjust to hit the stated pacing.

## Pacing targets (the thing balance must actually achieve)

| moment | wall-clock, active play |
|---|---|
| first Tender bought | ~20 s |
| Bloom stage 1 (蕾 Budding) | ~90 s |
| Bloom stage 2 (初咲 First Bloom) | ~8 min |
| Bloom stage 3 (満開 Full Bloom) | ~35 min |
| first prestige (Season turn) feels correct | 50–70 min |
| Bloom stage 4 (輝咲 Radiant) | second/third season |
| Bloom stage 5 (常桜 Everblossom) | long-term goal |

There must be a meaningful decision or a new unlock at least every ~40 seconds early on, and
never a dead stretch longer than ~3 minutes without something to click, buy, or read.

## Currencies

| id | name | source | spent on |
|---|---|---|---|
| `petals` | **Petals** 花びら | clicks + Tenders | Tenders, Upgrades |
| `blossoms` | **Blossoms** 桜花 | Bloom-stage ups, achievements, Codex | permanent tree upgrades (never reset) |
| `essence` | **Sakura Essence** 桜精 | prestige (Season turn) | Constellation nodes |

## Clicking

- `clickValue = (1 + clickFlat) * clickMult * seasonMult * (1 + 0.0002 * passiveRate)`
  — the last term means a big idle economy also makes clicking feel strong, so active play
  never becomes pointless.
- Crit: `critChance` (base 3%, cap 60%), `critMult` (base ×8). Crits spawn a bigger burst,
  a brighter number, a distinct chime, and a small camera kick.
- Every click emits `tree:clicked` and shakes real petals loose from the branch nearest the
  click point. The click must feel like it *physically hit the tree*.
- Click power is displayed as "per shake"; passive as "per second".

## Tenders (generators)

`cost(n) = baseCost * 1.15^n` (n = number already owned). Output is per-second, additive.

| # | id | name | baseCost | petals/s |
|---|---|---|---|---|
| 1 | `sprite` | Wind Sprite 風精 | 15 | 0.1 |
| 2 | `gatherer` | Petal Gatherer 花摘み | 100 | 1 |
| 3 | `miko` | Shrine Maiden 巫女 | 1.1e3 | 8 |
| 4 | `lantern` | Stone Lantern 石灯籠 | 1.2e4 | 47 |
| 5 | `koi` | Koi Spirit 鯉霊 | 1.3e5 | 260 |
| 6 | `rabbit` | Moon Rabbit 月兎 | 1.4e6 | 1.4e3 |
| 7 | `kitsune` | Kitsune Herald 狐使 | 2.0e7 | 7.8e3 |
| 8 | `envoy` | Wind God's Envoy 風神使 | 3.3e8 | 4.4e4 |
| 9 | `heart` | Everblossom Heart 常桜心 | 5.1e9 | 2.6e5 |
| 10 | `bough` | Celestial Bough 天樹枝 | 7.5e10 | 1.6e6 |

Each Tender has **milestone multipliers** at 10 / 25 / 50 / 100 / 150 / 200 owned, each ×2
(so 200 owned = ×64). Show the next milestone on the card — it's the main "just one more" hook.

> **`PROD_SCALE = 0.70` is intentional — do not "fix" it.** The table above is the BASE table;
> all passive output is multiplied by `ECONOMY.PROD_SCALE` (0.70) at runtime, so a lone Wind
> Sprite correctly displays `0.07 /s`, not `0.10 /s`.
>
> Reason, measured (see the rationale block in `src/lib/economy.js`): the live game runs Petal
> Storm, Golden Petal Frenzy, Spring Rain, Golden Hour and Full Moon continuously, together ≈ ×1.8
> on income. In a reinvestment economy time-to-milestone scales as income^-1.67, so at scale 1.0
> the whole first Season ran 2.2–2.4× fast (満開 Full Bloom in 14.6 min against the ~35 min
> target). Alternatives were tried and cannot fix it: upgrade prices alone saturate, COST_GROWTH
> 1.15→1.22 falls short, halving event cadence costs the game its juice, and CLICK_SCALE only
> moves the first three minutes.
>
> The Tenders column and the pacing table are **not simultaneously satisfiable** with the spec'd
> events. This document says the pacing table is "the thing balance must actually achieve", so
> pacing wins. No rate *math* changed — every baseCost, per-second output and bloom threshold is
> still the literal value above, scaled once by one documented dial.

A Tender is revealed in the UI once the player can afford 40% of its base cost, with a card
flip-in animation. Never show a wall of locked rows.

## Upgrades

Three families, all one-shot purchases with `petals`:

1. **Shake** (click): `+flat`, `xmult`, `+critChance`, `+critMult`. ~18 upgrades.
2. **Tender**: per-Tender ×2 output upgrades unlocked at owned counts 1/5/25/50; plus global
   "all Tenders ×1.5" upgrades gated on total Tenders owned. ~40 upgrades.
3. **Grove** (utility): offline cap extensions, Golden Petal frequency/duration, petal-magnet
   radius, Storm duration, auto-shake (a slow automatic click), UI conveniences. ~14 upgrades.

Upgrade cost is authored per-upgrade, roughly `10–25×` the current cost of the thing it improves.
Every upgrade must have a one-line flavour text in the game's voice — this is a big part of the
charm and is not optional.

## Bloom stages — the visual progression

Driven by **total petals earned this Season** (not current bank). Emits `bloom:stage`.

| stage | name | threshold | tree looks like |
|---|---|---|---|
| 0 | 冬芽 Winter Bud | 0 | bare dark branches, a few buds, cool light |
| 1 | 蕾 Budding | 1e3 | pink buds swelling, first scattered blossoms |
| 2 | 初咲 First Bloom | 1e5 | ~35% canopy coverage, light petal fall |
| 3 | 満開 Full Bloom | 1e7 | full canopy, constant petal fall, ground carpet |
| 4 | 輝咲 Radiant | 1e10 | luminous petals, faint emissive glow, drifting motes |
| 5 | 常桜 Everblossom | 1e13 | gold-veined bark, aurora petals, light shafts, floating islands of blossom |

Every stage-up is a **set piece**: time slows, the camera pushes in, a shockwave of petals
erupts, the music swells, a title card names the new stage, and the player is granted Blossoms
(stage index × 3). This is the game's reward moment — it must feel like a Genshin ascension.

## Seasons (prestige)

- Available once `totalPetalsThisSeason >= 1e6`.
- `essenceGain = floor( (totalPetalsThisSeason / 1e6) ** 0.55 )` *(tune)*
- Turning the Season resets: petals, Tenders, Upgrades, bloom stage.
  Keeps: Blossoms, Essence, Constellation, Codex, Achievements, statistics.
- Each Essence point: **+2% to all petal production**, and Essence spent on Constellation nodes
  still counts toward that bonus (spend freely, never a trap).
- Constellation: a radial node tree of ~30 nodes in 5 branches — *Wind, Water, Moon, Stone,
  Blossom* — costing 1–120 Essence. Node effects: starting Tenders, offline rate, crit, Storm
  power, Golden Petal luck, click scaling, a second click per shake, etc. Visually a
  constellation of connected stars over a night sky, unmistakably Genshin's talent-tree language.

## Live events

| event | trigger | effect | duration |
|---|---|---|---|
| **Petal Storm** 花嵐 | every 7 min ±2 *(tune)* | ×10 passive, heavy petal rain, wind strength ×2.5 | 20 s |
| **Full Moon** 満月 | during `night` phase | +25% crit chance, moonlit palette | phase length |
| **Golden Hour** 黄金時 | during `dusk` phase | +15% click value | phase length |
| **Spring Rain** 春雨 | random, 4% per minute | +10% passive, petals fall slower, ripples on the pond | 45 s |

**Golden Petal** 金花弁: a single shimmering petal drifts across the screen every 90–240 s
(a real 3D object, not a UI sprite, catching a specular glint). Clicking it grants one of:
- *Frenzy* — ×7 passive for 30 s
- *Lucky* — instantly +13% of current bank (capped at 20 min of passive)
- *Click Frenzy* — ×77 click for 13 s
- *Bloomfall* — a burst of `60 s` worth of passive as physical petals that must be collected
It must be genuinely satisfying to spot and catch.

## Offline / idle

- Accrue **55%** of passive rate while the tab is closed, capped by the *Dew Reservoir*
  (default 3 h, upgradeable to 24 h).
- On return: a parchment "welcome back" panel — time away, petals gathered, a small
  hand-written-feeling summary, and any stage-up that happened while away.
- While the tab is open but unfocused, run at full rate but drop rendering to 10 fps.

## Codex (collection)

12 sakura varieties — 染井吉野 Somei Yoshino, 枝垂桜 Shidarezakura, 八重桜 Yaezakura,
河津桜 Kawazu-zakura, 山桜 Yamazakura, 大島桜 Oshima-zakura, 鬱金桜 Ukon (green-tinged),
御衣黄 Gyoiko, 十月桜 Jugatsu-zakura, 冬桜 Fuyuzakura, 陽光桜 Yoko, 常桜 Everblossom (final).

Each unlocks at a milestone, grants a small permanent bonus (+1–5% something), and reveals as
a **rarity card** (3★/4★/5★ per ART_BIBLE §7) with a flip + shine animation and a short
botanical/poetic description. Unlocking a variety also tints petals in the world.

## Achievements

~44, each granting +1% global production. Categories: clicks, Tenders owned, petals earned,
Seasons turned, Golden Petals caught, Storms ridden, varieties found, plus a few secret/joke
ones. Toast in the top-right with a gold flourish, queued so they never overlap.

## Save / load

- `localStorage` key `sakura.save.v1`, JSON, **versioned with a migration function**.
- Autosave every 10 s and on `visibilitychange`/`beforeunload`.
- Export/import as base64 in a textarea. A hard-reset button behind a typed confirmation.
- Never trust the clock: clamp negative or absurd `Date.now()` deltas to 0 (anti-cheat and
  anti-DST-bug), and store `lastSeen` as UTC ms.

## Number formatting

`0` → `1,234` → `12.34K` → `1.234M` → `B T Qa Qi Sx Sp Oc No Dc Ud Dd` → then `1.23e45`.
Always 4 significant figures. Rates show 2 decimals below 100. Tabular figures everywhere.
Counters **tick up smoothly** (lerp toward the true value, ~180 ms) — a snapping counter feels
cheap.

## Feel rules (as important as the numbers)

- Every purchase: button press-in, gold particle puff, a soft wooden *tok*, the affected thing
  in the 3D scene visibly changes (a lantern lights, a sprite appears near the tree).
- Affordability is communicated by colour and a subtle pulse before the player reads any text.
- Keyboard: `Space` shakes, `1–9` buy Tender n, `Esc` closes panels, `Tab` cycles panels.
- Nothing modal ever blocks the 3D scene entirely — panels occupy at most the right 38% or a
  centred card with the tree still visible and blurred behind.
- The tree is always the star of the frame. UI serves it, never buries it.
