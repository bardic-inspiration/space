# Spatial Test Studio: Conceptual Design

Nov 12, 2026 · @Reif

## Purpose and intent

The studio is a browser workbench for designing and testing core rulesets. You watch a match, rewind or fork it, change the config, and run batches to see what a change does. It is core's first real host, and the base a live-play mode can grow from later.

- **Audience:** the ruleset designer. Human seats come later, through the same seat interface.
- **Core loop:** pick a variant, run one match or a batch, read the board and the log, compare, then change the variant.
- **Stack:** TypeScript and three.js, with core's compiler and runtime used unchanged. Core is at format 2, and its groundwork for the studio is merged (core PR #4); `docs/host.md` in core is the reference for everything the studio calls.

## The divide

Core holds the rules and produces the facts. The studio derives, organizes, displays and compares them, and everything visual or spatial sits on the studio side.

| Concern | Core | Studio |
| --- | --- | --- |
| Rules | Ruleset: kinds, intents, flow, cell-layer declarations and what they block | Read-only, edited as YAML variants |
| Behaviors | Their own document, a behavior set, compiled against the ruleset's registry. Sets overlay each other in order | A variant is an overlay set. Seats are bound for each run with `bindSeats` |
| Map values | Scenario `space.cells`: per-cell layer values. Core evaluates `blocksMove` and `blocksSight` per cell at load and hands the host a plain map | Painted in Build, drawn from `scenario.map` |
| Geometry | Declares the six host functions and their contract, and ships a reference host and `compareHosts` | Implements them: one host for the view and for headless batches |
| Facts | Event log with a `cause` on every entry, match records worked out from the log by `summarize` | Organized, rendered, compared |
| Presentation | None | Per-ruleset file: colors, icons, log sentence templates, section signals |
| Metrics and analysis | `compileExpression`, to check and evaluate a free-standing expression | CEL metrics saved in the studio project |

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
- **Cell layers:** the ruleset declares them in `space.layers` (for example `terrain`, `cover`), each typed and with a default, and the scenario's `space.cells` holds their values. Layers are the only way to block a cell: `space.blocked` is gone. The studio builds the layer panel and paint tools from those declarations. Each layer can be shown or hidden, with colors taken from the presentation file.
- **The map is static:** `blocksMove` and `blocksSight` read one cell's layers and nothing else, and no rule or referee edit can write a cell. A door that opens is an entity standing in a cell. Layer values belong to the scenario and are not in the log, so painting the map makes a scenario variant.
- **Tokens:** round chips with an icon, colored by seat or side. The log uses the same colors.
- **Geometry host:** one implementation of core's host interface (`inBounds`, `distance`, `neighbors`, `cellsWithin`, `lineOfSight`, `cellAt`), built from the plain map core hands over at load, so the host never runs CEL. It runs in the viewer and in batch workers, so what you watch and what a batch measures always agree. Three points of the contract matter to it:
  - `neighbors` and `cellsWithin` answer in row order (ascending `y`, then `x`). The order decides the order of a seat's options, so another order plays different matches from the same seed.
  - `inBounds` means on the map and open to movement, so a wall inside the map is out of bounds.
  - `compareHosts` checks the studio's host against core's reference over a whole map. A host that answers `lineOfSight` with better geometry differs on purpose, and its batches are not comparable with the reference's.
- **Spatial debug overlay:** at the current decision, it draws what the host answered: range rings, line-of-sight rays, neighbor cells, and, for each candidate target, which gate passed or failed. All of it comes from `match.explain()`, which returns every candidate binding, legal or not, each gate's result, and each host call as `{ fn, args, result }`. It costs several times a plain enumeration, so only the viewer calls it, never a batch.

## Matches

A match can be played, rewound to any point, and forked at any decision, so each match is a tree of logs.

- **Play:** step by decision or by event, or play at a set speed.
- **Scrub:** the state at any point is `fold` of the log up to there, which is exact and cheap.
- **Fork:** only at a decision (an `intent` entry, a seat's or a referee's), where matches can actually diverge. `fork(registry, scenario, log, seq)` returns the match as it stood there, optionally starting from a snapshot. You can pick a different intent, swap a behavior, or make a referee edit, and the match continues as a new branch.
- **Compare:** a split board shows a fork beside its parent, synced by decision index.

Forks are deterministic: choosing the same option again plays out the same match. Each seat's random stream is in the state (`state.streams`), so it is in every snapshot and in the state folded from a log at any point, and `replay(registry, scenario, log)` re-applies referee changes and rulings where the log has them.

## The log

The log is read as a tree grouped by decision and nested the way the rules nest. Each level folds open into the next.

- **Match:** ruleset@version, scenario, variant, seed, outcome
  - **Setup:** the scenario's seed, globals, creates and links, folded by default. Cell layers are not in the log; they are read from `scenario.map`.
  - **Section:** opened by a signal the presentation file marks as structural (`round`, `turn.start`, `hand`, `tick`). Sections nest.
    - **Decision:** seat, intent, bound params, and how many options it had (`of`). The legal options and their behavior scores are folded under it, worked out by the studio at that point (`match.scores`), not read from the log.
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

Sections are presentation config because core has no rounds or turns, only `flow`. Below a section, nesting comes from `cause`: the `seq` of the intent or signal an entry ran under. Three kinds of entry have no cause, and the studio places them by position instead:

- Setup entries.
- The flow's own effects, such as a round counter or a turn's start. These are what sections are built from.
- A referee's own changes.

A prompt is not a log entry. A decision made during resolution records the intent or signal that asked for it, which is what nests a reaction under its trigger. An `end` takes the cause of the write that tripped it.

## Batches and analysis

The point of this mode is to show and arrange batch data so variants can be compared at a glance, with every number leading back to a match you can watch.

- **Batch:** a variant × a seed range, run across the worker pool.
- **Record:** core's fixed fields: outcome, decisions, forced decisions, options per decision, events by type, signals, entity counts, seats, `logHash`. `summarize` works it out from the log alone, so a worker, a fork or a regenerated log can each make one. The seed is a string, as the log holds it.
- **Custom metrics:** CEL expressions, the same language as the rules, saved in the studio project. Each is evaluated at the end of the match or at every signal or event you name (e.g. each `hp.lose`). Metrics run inside the worker during the batch, and their results are saved with the record. Each is checked with `compileExpression` like a rule and refused with the compiler's errors. A metric on a signal declares the signal's arguments as typed variables, and one can be evaluated through a seat's view, where reading a secret is an error.
- **Views:** the outcome split, metric distributions as small histograms, variants side by side, and outlier seeds. Clicking an outlier opens that match in Run.
- **Heatmaps:** batch data from every match drawn on the grid: where tokens spent time, where defeats happened, which cells were used as cover.

## Runtime and data

Everything runs in the browser, and everything is stored as plain files in a project folder you can commit.

- **Compute:** core runs unchanged in Web Workers, in a pool sized to the CPU cores. Core's validation plays matches in a worker in headless Chromium and gets the same logs as Node, no slower. The heaviest match today, the junkyard, takes about 230 ms in a worker, so 100 of them across 8 workers should finish in a few seconds; a pool has not been measured yet.
- **Crossing to a worker:** the page parses the YAML and passes plain data. A running match is not transferable, but a snapshot and a log are plain data and cross `postMessage` as they are.
- **Content security policy:** core's schema checker (Ajv) builds validators with `new Function`, so the worker needs `unsafe-eval` until they are precompiled.
- **Storage:** the project folder holds variants, presentation files, metric definitions, batch records as JSONL, and fork branches. The studio reads and writes it through the browser's File System Access API.
- **Records over logs:** a log is fully set by ruleset + variant + seed, so batches keep only records and logs are regenerated on demand, checked against `logHash`. Forks store their decisions and referee edits, since those aren't set by the seed. A scenario variant changes the map, which the log does not hold, so a log is only read against the scenario it was played on.
- **Live play later:** the workers already keep the UI apart from the runtime, so a human seat can plug into the same seat interface.

## Build phases

There are four phases, and each ends in something usable. Analyze comes before Build because behavior batches are the first use, and Build needs the most new core.

1. **Phase 0, core groundwork (done):** the behavior split, `cause` links, and a browser-worker check, validated by `npm run validate`. The core work for the later phases landed in the same pass.
2. **Phase 1, Run slice:** worg-vs-scout in the browser, with the grid, token chips, play and scrub, the log tree, the inspector, the debug overlay, and light/dark themes. There is no editing yet. This proves the core-to-studio pipe and the log hierarchy.
3. **Phase 2, Analyze:** batches across the worker pool, records, CEL metrics, comparison and heatmaps. Behavior variants only, since the split makes them the cheapest thing to vary: a variant is one more behavior set laid over the defaults, and the rules are not recompiled.
4. **Phase 3, Build and forks:** the paint tools for cell layers, entity placement, the YAML editors, scenario variants, and forking.

## Core groundwork

All ten prerequisites are in core (issue #3, merged as PR #4), and nothing in the studio waits on core now. `docs/host.md` in core is the contract, and D46 to D57 in its `DECISIONS.md` give the reasoning.

| Phase | Task | What core provides |
| --- | --- | --- |
| 0 | Split behaviors from rulesets | A behavior set is its own document (`rulesets/<id>/behaviors/default.yaml`), compiled by `compileBehaviors`. Sets overlay in order. `bindSeats` binds seats by the scenario's names, or by the run over them. |
| 0 | Causal links | Every entry carries `cause`. |
| 0 | Browser worker | Core's entry imports nothing from Node. A test runs matches in a Web Worker in headless Chromium and compares the logs with Node's. |
| 1 | Explain enumeration | `match.explain()` |
| 1 | Host contract | `docs/host.md`, and `compareHosts` |
| 2 | Expression API | `compileExpression(registry, source, { vars, expect })`, evaluated on any state or through a seat's view |
| 3 | Cell layers | `space.layers`, `blocksMove`, `blocksSight` in the ruleset; `space.cells` in the scenario; `cellAt(c)`, typed from the declarations |
| 3 | Seat RNG in snapshots | `state.streams` |
| 3 | Referee edits on replay | `replay(registry, scenario, log)` |
| 3 | Fork from a decision | `fork(registry, scenario, log, seq)` |

Where core departed from the plan, in ways the studio has to follow:

- **Format 2.** A format 1 file is refused, and a ruleset with a `behaviors` key is refused. Every ruleset's version went up.
- **No cause on flow-level entries**, as well as setup, and none on a referee's own changes.
- **Seat streams are in the state**, not only in snapshots, because a fork starts from a log. A decision that drew logs where its stream stood (`rng`).
- **`ReplaySeat` is gone**, replaced by `replay()`. A seat driver is only asked to choose, so it cannot author a referee's change.
- **`space.blocked` is gone**, replaced by layers.
- **Records moved into core** (`summarize`). For that, an `intent` logs `of` and the `seed` entry carries the seed.
- **The space rules cannot read the match.** Core evaluates them per cell at load and hands the host plain lists.
- **Seat drivers hold no state.** `UtilitySeat` takes a compiled behavior and no seed, and `Match.scores` takes a behavior, not a name.

Still open in core, and visible in the studio:

- The grid is square and two-dimensional, with no footprints or path distance.
- The event log is not filtered by seat, and `state.streams` is in every seat's view.
- `inBounds` carries two meanings.
