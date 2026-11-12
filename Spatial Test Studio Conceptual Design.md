# Spatial Test Studio: Conceptual Design

Nov 12, 2026 · @Reif

## Purpose and intent

The studio is a browser workbench for designing and testing rpg-core rulesets. You watch a match, rewind or fork it, change the config, and run batches to see what a change does. It is core's first real host, and the base a live-play mode can grow from later.

- **Audience:** the ruleset designer. Human seats come later, through the same seat interface.
- **Core loop:** pick a variant, run one match or a batch, read the board and the log, compare, then change the variant.
- **Stack:** TypeScript and three.js, with rpg-core's compiler and runtime used unchanged.

## The divide

Core holds the rules and produces the facts. The studio derives, organizes, displays and compares them, and everything visual or spatial sits on the studio side.

| Concern | Core (rpg-core) | Studio |
| --- | --- | --- |
| Rules | Ruleset: kinds, intents, flow, cell-layer declarations and what they block | Read-only, edited as YAML variants |
| Behaviors | Their own layer, split from the ruleset | Bound to seats for each run |
| Map values | Scenario `space`: per-cell instances | Painted in Build |
| Geometry | Declares the host functions | Implements them: one host for the view and for headless batches |
| Facts | Event log, match records | Organized, rendered, compared |
| Presentation | None | Per-ruleset file: colors, icons, log sentence templates, section signals |
| Metrics and analysis | None | CEL metrics saved in the studio project |

## Workspace

Three modes, Build, Run and Analyze, sit around one persistent board, so functionality divides where the work divides. Themes are light and dark: a gray grid on white or on dark gray.

- **Build**
  - Paint tools and the layer panel for cell layers
  - Entity placement and links, done directly on the board
  - Run settings: seed range, decision limit, seat-to-behavior bindings
  - Behavior and ruleset editors as YAML, with the compiler's errors shown inline by path
- **Run**
  - Play, pause, and step by decision or by event
  - Timeline scrubber with fork markers
  - Log tree, and an inspector for the selected entity or decision
  - Spatial debug overlay
- **Analyze**
  - Batch table and metric charts
  - Variant-vs-variant comparison and an outlier list
  - Split board and heatmaps on the grid

Every edit is saved as a **variant**, a named overlay on the base files that never overwrites them. A batch is a variant × a seed range, so comparing two batches means comparing two variants.

## The board

The board is a plain 3D environment with a grid, built from data. The studio draws it, and core's rules decide what it means.

- **Grid:** square at first, the only grid core has today. Hexes, height, larger footprints and path distance are added as core adds them, and each one shows in the overlay.
- **Cell layers:** the ruleset declares them (for example `terrain`, `cover`) and the scenario holds their values. The studio builds the layer panel and paint tools from those declarations. Each layer can be shown or hidden, with colors taken from the presentation file.
- **Tokens:** round chips with an icon, colored by seat or side. The log uses the same colors.
- **Geometry host:** one implementation of core's host interface (`inBounds`, `distance`, `neighbors`, `cellsWithin`, `lineOfSight`, plus a new `cellAt`). It runs in the viewer and in batch workers, so what you watch and what a batch measures always agree.
- **Spatial debug overlay:** at the current decision, it draws what the host answered: range rings, line-of-sight rays, neighbor cells, and, for each candidate target, which gate passed or failed.

## Matches

A match can be played, rewound to any point, and forked at any decision, so each match is a tree of logs.

- **Play:** step by decision or by event, or play at a set speed.
- **Scrub:** the state at any point is `fold` of the log up to there, which is exact and cheap.
- **Fork:** only at a decision, where matches can actually diverge. You can pick a different intent, swap a behavior, or make a referee edit, and the match continues as a new branch.
- **Compare:** a split board shows a fork beside its parent, synced by decision index.

Forks stay deterministic only once core saves the seat RNG positions in snapshots and re-applies referee edits on replay.

## The log

The log is read as a tree grouped by decision and nested the way the rules nest. Each level folds open into the next.

- **Match:** ruleset@version, scenario, variant, seed, outcome
  - **Setup:** the scenario's seed, globals, creates, links and cell layers, folded by default
  - **Section:** opened by a signal the presentation file marks as structural (`round`, `turn.start`, `hand`, `tick`). Sections nest.
    - **Decision:** seat, intent, bound params. The legal options and their behavior scores are folded under it.
      - **Write / roll:** `set`, `create`, `destroy`, `link`, `unlink`, `roll`, each a one-line leaf
      - **Signal:** name and `with`
        - **Reaction:** its writes, as leaves
          - **Decision (prompted):** the same shape again, so Counterspell inside Shield inside an attack nests as the rules do
    - **Fork marker:** a branch leaving at this decision
  - **End:** the condition that held, and its outcome

Three rules govern how it reads:

- **Sentences:** each row is a short sentence built from a template in the presentation file, e.g. *worg → bite → scout: 14 vs AC 13, hit, 7 piercing*.
- **Color:** follows the entry type. Seats and entities appear as chips that match their tokens.
- **Sync:** the log, the timeline and the board stay in step, so clicking a row moves the board to that moment.

Sections are presentation config because core has no rounds or turns, only `flow`. Nesting comes from a `cause` link on every log entry, which core needs to add.

## Batches and analysis

The point of this mode is to show and arrange batch data so variants can be compared at a glance, with every number leading back to a match you can watch.

- **Batch:** a variant × a seed range, run across the worker pool.
- **Record:** core's fixed fields: outcome, decisions, forced decisions, options per decision, events by type, signals, entity counts, seats, `logHash`.
- **Custom metrics:** CEL expressions, the same language as the rules, saved in the studio project. Each is evaluated at the end of the match or at every signal or event you name (e.g. each `hp.lose`). Metrics run inside the worker during the batch, and their results are saved with the record.
- **Views:** the outcome split, metric distributions as small histograms, variants side by side, and outlier seeds. Clicking an outlier opens that match in Run.
- **Heatmaps:** batch data from every match drawn on the grid: where tokens spent time, where defeats happened, which cells were used as cover.

## Runtime and data

Everything runs in the browser, and everything is stored as plain files in a project folder you can commit.

- **Compute:** core runs unchanged in Web Workers, in a pool sized to the CPU cores. The heaviest match today, the junkyard, takes about 350 ms, so 100 of them across 8 workers finish in a few seconds.
- **Storage:** the project folder holds variants, presentation files, metric definitions, batch records as JSONL, and fork branches. The studio reads and writes it through the browser's File System Access API.
- **Records over logs:** a log is fully set by ruleset + variant + seed, so batches keep only records and logs are regenerated on demand, checked against `logHash`. Forks store their decisions and referee edits, since those aren't set by the seed.
- **Live play later:** the workers already keep the UI apart from the runtime, so a human seat can plug into the same seat interface.

## Build phases

There are four phases, and each ends in something usable. Analyze comes before Build because behavior batches are the first use, and Build needs the most new core.

1. **Phase 0, core groundwork:** the behavior split, `cause` links, and a browser-worker check. All are validated by `npm run validate`.
2. **Phase 1, Run slice:** worg-vs-scout in the browser, with the grid, token chips, play and scrub, the log tree, the inspector, the debug overlay, and light/dark themes. There is no editing yet. This proves the core-to-studio pipe and the log hierarchy.
3. **Phase 2, Analyze:** batches across the worker pool, records, CEL metrics, comparison and heatmaps. Behavior variants only, since the split makes them the cheapest thing to vary.
4. **Phase 3, Build and forks:** cell layers (core first, then the paint tools), entity placement, the YAML editors, scenario variants, and forking.

## Core prerequisites

The issue body below is ready to paste into core (formerly rpg-core). Tasks are ordered by the studio phase that needs them. Two of them (explaining enumeration and an expression API) didn't come up in our questions: they are what the debug overlay and the batch metrics need from core.

```markdown
# Core groundwork for the spatial test studio

The studio (a three.js workbench) runs core unchanged in the browser. These additions lay its groundwork, ordered by the studio phase that needs them. Each should pass `npm run validate`.

## Phase 0: before the first studio slice

- [ ] **Split behaviors from rulesets.** Behaviors become their own layer, compiled against a ruleset's registry and bound to seats by the scenario or run config. Every shipped scenario plays with behaviors loaded separately; recorded matches stay identical, or are regenerated on purpose.
- [ ] **Causal links in the log.** Every event records `cause`: the `seq` of the entry it ran under (the intent, signal or prompt on the runtime stack). Setup entries have none. This lets a log be shown as a tree without re-running the match.
- [ ] **Run in a browser worker.** Confirm that compile and `Match` run in a Web Worker with no Node APIs (`load.ts` stays outside core). Add a smoke test and record timings against Node.

## Phase 1: Run slice

- [ ] **Explain enumeration.** An optional mode that returns every candidate binding at a prompt, legal or not, with each gate's result and the host calls it made. This feeds the spatial debug overlay.
- [ ] **Host interface as a documented contract.** Signatures, units and return values for every host function, so the studio's geometry host implements it exactly.

## Phase 2: Analyze

- [ ] **Expression API.** Compile a free-standing CEL expression against a registry, then evaluate it on a state or a seat's view. This is what batch metrics are written in.

## Phase 3: Build and forks

- [ ] **Cell layers in `space`.** The ruleset declares typed per-cell attributes and the rules the host respects (e.g. `blocksSight`, `blocksMove` as expressions over `cell`). The scenario's `space` holds the values. Add a `cellAt(c)` host function, with compile-time checks.
- [ ] **Seat RNG in snapshots.** A snapshot holds each AI seat's random-stream position, so a resumed or forked match stays deterministic.
- [ ] **Referee edits on replay.** `ReplaySeat` re-applies authored changes, so a branch with edits replays exactly.
- [ ] **Fork from a decision.** Given a log and a decision `seq`, return a match resumed at that point, built on snapshots and replay.
```
