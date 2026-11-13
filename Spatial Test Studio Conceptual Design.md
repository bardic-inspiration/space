# Spatial Test Studio: Conceptual Design

Nov 13, 2026 · @Reif · revised for core #5 (maps)

## Purpose and intent

The studio is a browser workbench for designing and testing core rulesets. You watch a match, rewind or fork it, change the config, and run batches to see what a change does. It is core's first real host, and the base a live-play mode can grow from later.

- **Audience:** the ruleset designer. Human seats come later, through the same seat interface.
- **Core loop:** pick a variant, run one match or a batch, read the board and the log, compare, then change the variant.
- **Stack:** TypeScript and three.js, with core's compiler and runtime used unchanged. Core is at format 2. Its groundwork for the studio (core #4) and its maps (core #5) are merged; `docs/host.md` in core is the reference for everything the studio calls.

The build is specified in [Spatial Test Studio v1 Spec](Spatial%20Test%20Studio%20v1%20Spec.md).

## The divide

Core holds the rules and produces the facts. The studio derives, organizes, displays and compares them, and everything visual or spatial sits on the studio side.

The line between them is the one Ludii draws between ludemes and equipment. A game is its **rules** and its **instruments of play**: the things play is carried out with, such as a board, tokens, chips and cards. Core says what each instrument is and what may be done with it. The studio says what it looks like ([Instruments of play](#instruments-of-play)).

| Concern | Core | Studio |
| --- | --- | --- |
| Rules | Ruleset: kinds, intents, flow | Read-only, edited as YAML variants |
| Behaviors | Their own document, a behavior set, compiled against the ruleset's registry. Sets overlay each other in order | A variant is an overlay set. Seats are bound for each run with `bindSeats` |
| Instruments of play | Their rules: the kinds, fields and globals that are a token, a stack of chips or a hand of cards, and the `space` that is a map | Their appearance: a form and a look for each, in the presentation file |
| What a map can be | The ruleset's `space`: a grid or a bare plane, the cell layers and what they block, which layers play may change, and the criteria a map must meet (size, cell checks, required places, a standard map) | Builds its tools from these declarations and shows a refusal where it applies |
| Maps | A map is its own document, checked by `loadMap`. A scenario imports one, writes one inline, or takes the ruleset's standard map. Core evaluates `blocksMove` and `blocksSight` per cell and hands the host a plain map | Drawn before any match exists. Painted in Build and saved as map documents in a variant |
| The ground in play | A write to a mutable layer is a `ground` log entry. State holds the changes as an overlay, never the map | Draws the map as it stands at any point of a log (`scenario.mapAt(state)`) |
| Geometry | Declares the six host functions and their contract, and ships a reference host and `compareHosts` | Implements them: one host for the view and for headless batches |
| Facts | Event log with a `cause` on every entry, match records worked out from the log by `summarize` | Organized, rendered, compared |
| Presentation | None | Per-ruleset file: the instruments' appearance, log sentence templates, section openers |
| Metrics and analysis | `compileExpression`, to check and evaluate a free-standing expression | CEL metrics saved in the studio project |

## Workspace

Three modes, Build, Run and Analyze, sit around one persistent board, so functionality divides where the work divides. Themes are light and dark: a gray grid on white or on dark gray.

- **Build**
  - A map editor: paint tools and the layer panel for cell layers, named places, and the map's size
  - Entity placement and links, done directly on the board. An entity can stand at a place by name
  - Run settings: the map, seed range, decision limit, seat-to-behavior bindings
  - Behavior, map, scenario and ruleset editors as YAML, with the compiler's errors shown inline by path
- **Run**
  - Play, pause, and step by decision or by event
  - Timeline scrubber with fork markers
  - Log tree, and an inspector for the selected entity, cell or decision
  - Spatial debug overlay
- **Analyze**
  - Batch table and metric charts
  - Variant-vs-variant comparison and an outlier list
  - Split board and heatmaps on the grid

Every edit is saved as a **variant**, a named overlay on the base files that never overwrites them. A variant can change behaviors, the map, the scenario, or the ruleset. A batch is a variant × a seed range, so comparing two batches means comparing two variants.

Because a map is its own document, playing the same scenario on another map is a one-line variant. That makes maps the second-cheapest thing to vary, after behaviors.

## Instruments of play

An instrument of play is a thing the game is played with. Each has two halves that never mix:

- **Its rules are core's.** A token is an entity of some kind with a cell. A stack of chips is a number. A hand of cards is a list. A map is a `space` and a map document. What can be done with any of them is the ruleset's intents and effects. Core knows nothing of how they look.
- **Its appearance is the studio's.** The presentation file binds a fact the ruleset declares to a **form** the studio can draw, and gives it a look: colors, icons, faces.

The studio is a set of forms, and a ruleset picks from them. v1 has four, and they are the first test fixtures for the idea, chosen because the shipped rulesets need them:

| Form | Role | Stands for | Shown as | First used by |
| --- | --- | --- | --- | --- |
| Map | Container | A ruleset's `space` and a map document | A plane, its grid, its cell layers and its places | Every ruleset with a space |
| Token | Component | An entity with a place to stand | A round chip with an icon, colored by seat or side | 5e creatures, checkers pieces, junkyard bots |
| Chips | Component | A count | A stack whose height follows the number | Hold 'em stacks and the pot |
| Cards | Component | A list of cards | A row of faces | Hold 'em hole cards and the board |

Instruments come in two roles, as Ludii's equipment does. A **container** holds other instruments and says where they can be; a **component** is held. The map is a container, so it is both things at once: an instrument, with rules in core's `space` and a look in the presentation file, and the stage the tokens, chips and cards stand on. It is the only container in v1.

Where the seam runs is not settled everywhere. Whether a number is a stack, whether a card lies face up, and whether a hand holds its cards could each be a rule or a look; v1 makes each a look, and the spec lists them as open questions.

A form is the studio's only knowledge of a kind of object. A new form (dice, a hex tile, a meeple with facing) is new studio code and no change to core; a new look for an existing form is a line in a presentation file. The log uses the same looks, so a token and its chip in a sentence match.

## The board

The board is a plain 3D environment built from data: the open ruleset's map, with its other instruments laid out on it. The studio draws it, and core's rules decide what it means.

- **Plane and grid:** a map is a bounded plane, and a grid is a rule a ruleset may lay over it. The board draws the plane first and the grid on top when there is one. The square grid is the only one core has. Hexes, height, larger footprints and path distance are added as core adds them, and each one shows in the overlay.
- **A plane without a grid:** a ruleset with `grid: none` has a size and named places and no cells. The board draws the plane and its places, as a poker table, and instruments lie at places. Core asks no spatial question of it, so there is no host and no debug overlay.
- **Cell layers:** the ruleset declares them in `space.layers` (for example `terrain`, `cover`), each typed and with a default, and the map holds their values. Layers are the only way to block a cell. The studio builds the layer panel and paint tools from those declarations. Each layer can be shown or hidden, with colors taken from the presentation file. The panel marks which layers play may change.
- **Places:** named points and areas, drawn as outlines with labels. Places a ruleset requires are marked as such.
- **The ground as it stands:** `blocksMove` and `blocksSight` read one cell's layers and nothing else, so a door that opens is a value of a mutable layer. Play can write such a layer, so the board draws the map of the current state, not the map document. Scrubbing past a Grease shows the ground before it.
- **Geometry host:** one implementation of core's host contract (`inBounds`, `distance`, `neighbors`, `cellsWithin`, `lineOfSight`, `cellAt`), built from the plain map core hands over, so the host never runs CEL. It runs in the viewer and in batch workers, so what you watch and what a batch measures always agree. Five points of the contract matter to it:
  - `neighbors` and `cellsWithin` answer in row order (ascending `y`, then `x`). The order decides the order of a seat's options, so another order plays different matches from the same seed.
  - `inBounds` means on the map and open to movement, so a wall inside the map is out of bounds.
  - With `corners: closed`, `neighbors` leaves out a diagonal step past a cell that blocks movement.
  - It is a pure function of one map. Core never tells it of a change; it calls the host factory again with the patched map, once per ground a match passes through.
  - `compareHosts` checks the studio's host against core's reference over a whole map. A host that answers `lineOfSight` with better geometry differs on purpose, and its batches are not comparable with the reference's.
- **Spatial debug overlay:** at the current decision, it draws what the host answered: range rings, line-of-sight rays, neighbor cells, and, for each candidate target, which gate passed or failed. All of it comes from `match.explain()`, which returns every candidate binding, legal or not, each gate's result, and each host call as `{ fn, args, result }`. It costs several times a plain enumeration, so only the viewer calls it, never a batch.

## Matches

A match can be played, rewound to any point, and forked at any decision, so each match is a tree of logs.

- **Play:** step by decision or by event, or play at a set speed.
- **Scrub:** the state at any point is `fold` of the log up to there, which is exact and cheap. The ground at that point comes with it.
- **Fork:** only at a decision (an `intent` entry, a seat's or a referee's), where matches can actually diverge. `fork(registry, scenario, log, seq)` returns the match as it stood there, optionally starting from a snapshot. You can pick a different intent, swap a behavior, or make a referee edit, and the match continues as a new branch. A referee edit can also repaint a mutable layer.
- **Compare:** a split board shows a fork beside its parent, synced by decision index.

Forks are deterministic: choosing the same option again plays out the same match. Each seat's random stream is in the state (`state.streams`), so it is in every snapshot and in the state folded from a log at any point, and `replay(registry, scenario, log)` re-applies referee changes and rulings where the log has them.

## The log

The log is read as a tree grouped by decision and nested the way the rules nest. Each level folds open into the next.

- **Match:** ruleset@version, scenario, map, variant, seed, outcome
  - **Setup:** the scenario's seed, globals, creates and links, folded by default. The map is named here but is not in the log; it is read from `scenario.map`.
  - **Section:** opened by a signal or a write the presentation file marks as structural (`round`, `turn.start`, `hand`, `tick`). Sections nest.
    - **Decision:** seat, intent, bound params, and how many options it had (`of`). The legal options and their behavior scores are folded under it, worked out by the studio at that point (`match.scores`), not read from the log.
      - **Write / roll:** `set`, `create`, `destroy`, `link`, `unlink`, `ground`, `roll`, each a one-line leaf
      - **Signal:** name and `with`
        - **Reaction:** its writes, as leaves
          - **Decision (prompted):** the same shape again, so Counterspell inside Shield inside an attack nests as the rules do
    - **Fork marker:** a branch leaving at this decision
  - **End:** the condition that held, and its outcome

Three rules govern how it reads:

- **Sentences:** each row is a short sentence built from a template in the presentation file, e.g. *worg → bite → scout: 14 vs AC 13, hit, 7 piercing*.
- **Color:** follows the entry type. Seats and instruments appear inline in the look the board gives them: a token as its chip, a card as its face.
- **Sync:** the log, the timeline and the board stay in step, so clicking a row moves the board to that moment. Clicking a `ground` row also marks its cell.

Sections are presentation config because core has no rounds or turns, only `flow`. Below a section, nesting comes from `cause`: the `seq` of the intent or signal an entry ran under. Three kinds of entry have no cause, and the studio places them by position instead:

- Setup entries.
- The flow's own effects, such as a round counter or a turn's start. These are what sections are built from.
- A referee's own changes.

A prompt is not a log entry. A decision made during resolution records the intent or signal that asked for it, which is what nests a reaction under its trigger. An `end` takes the cause of the write that tripped it.

## Batches and analysis

The point of this mode is to show and arrange batch data so variants can be compared at a glance, with every number leading back to a match you can watch.

- **Batch:** a variant × a seed range, run across the worker pool.
- **Record:** core's fixed fields: outcome, decisions, forced decisions, options per decision, events by type, signals, entity counts, seats, `logHash`. `summarize` works it out from the log alone, so a worker, a fork or a regenerated log can each make one. The seed is a string, as the log holds it.
- **Custom metrics:** CEL expressions, the same language as the rules, saved in the studio project. Each is evaluated at the end of the match or at every signal or event you name (e.g. each `hp.lose`). Metrics run inside the worker during the batch, and their results are saved with the record. Each is checked with `compileExpression` like a rule and refused with the compiler's errors. A metric on a signal declares the signal's arguments as typed variables.
- **Views:** the outcome split, metric distributions as small histograms, variants side by side, and outlier seeds. Clicking an outlier opens that match in Run.
- **Heatmaps:** batch data from every match drawn on the grid: where tokens spent time, where defeats happened, which cells play rewrote.

## Runtime and data

Everything runs in the browser, and everything is stored as plain files in a project folder you can commit.

- **Compute:** core runs unchanged in Web Workers, in a pool sized to the CPU cores. Core's validation plays matches in a worker in headless Chromium and gets the same logs as Node, no slower. The heaviest match today, the junkyard, takes about 230 ms in a worker, so 100 of them across 8 workers should finish in a few seconds; a pool has not been measured yet.
- **Crossing to a worker:** the page parses the YAML and passes plain data. A running match is not transferable, but a snapshot and a log are plain data and cross `postMessage` as they are.
- **Content security policy:** core's schema checker (Ajv) builds validators with `new Function`, so the worker needs `unsafe-eval` until they are precompiled.
- **Storage:** the project folder holds the base files as core lays them out, variants, presentation files, metric definitions, batch records as JSONL, and fork branches. The studio reads and writes it through the browser's File System Access API.
- **Records over logs:** a log is fully set by variant + seed, where the variant includes the map. So batches keep only records and logs are regenerated on demand, checked against `logHash`. A log does not hold its map, so a record names the variant by a hash of everything that went into it. Forks store their decisions and referee edits, since those aren't set by the seed.
- **Live play later:** the workers already keep the UI apart from the runtime, so a human seat can plug into the same seat interface.

## Build phases

Core's groundwork is done, so three phases remain, and each ends in something usable. Analyze comes before Build because behavior batches are the first use.

1. **Phase 1, Run slice:** the shipped scenarios in the browser, with the four instrument forms, play and scrub, the log tree, the inspector, the debug overlay, and light/dark themes. The pack ambush on its rocky pass proves terrain and closed corners, the mage duel proves a ground that changes, and the hold 'em table proves a plane without a grid, chips and cards. There is no editing yet. This proves the core-to-studio pipe, the split between an instrument's rules and its appearance, and the log hierarchy.
2. **Phase 2, Analyze:** batches across the worker pool, records, CEL metrics, comparison and heatmaps. Behavior variants and map swaps, the two cheapest things to vary: a behavior variant is one more set laid over the defaults, and the rules are not recompiled.
3. **Phase 3, Build and forks:** the map editor, entity placement, the YAML editors, scenario and ruleset variants, and forking.

## Core status

Nothing in the studio waits on core. `docs/host.md` in core is the contract, and its `DECISIONS.md` gives the reasoning: D46 to D57 for the groundwork, D58 to D76 for maps.

| From | What core provides |
| --- | --- |
| Groundwork (core #3, merged as #4) | A behavior set is its own document (`rulesets/<id>/behaviors/default.yaml`), compiled by `compileBehaviors`. Sets overlay in order. `bindSeats` binds seats by the scenario's names, or by the run over them. |
| | Every log entry carries `cause`. |
| | Core's entry imports nothing from Node. A test runs matches in a Web Worker in headless Chromium and compares the logs with Node's. |
| | `match.explain()` |
| | `docs/host.md`, and `compareHosts` |
| | `compileExpression(registry, source, { vars, expect })`, evaluated on any state or through a seat's view |
| | `space.layers`, `blocksMove`, `blocksSight` in the ruleset; `cellAt(c)`, typed from the declarations |
| | `state.streams`, `replay(registry, scenario, log)`, `fork(registry, scenario, log, seq)` |
| Maps (core #5) | Map documents (`rulesets/<id>/maps/<id>.yaml`) and `loadMap`. A scenario's `map: <id>`, with the documents passed to `loadScenario`. |
| | Map criteria in `space`: `size`, `checks`, `places`, and a standard map that may be the only one allowed. |
| | `grid: none`: a plane with a size and named places. Named places on any map, and an entity placed at one by name. |
| | Mutable layers: the `at` effect, a referee's `ground` change, `ground` log entries, `state.ground`, and `scenario.mapAt(state)`. |
| | Closed corners in the host contract, and a host rebuilt per ground. |

Where core departed from the first plan, in ways the studio has to follow:

- **Format 2.** A format 1 file is refused, and a ruleset with a `behaviors` key is refused.
- **No cause on flow-level entries**, as well as setup, and none on a referee's own changes.
- **Seat streams are in the state**, not only in snapshots, because a fork starts from a log. A decision that drew logs where its stream stood (`rng`).
- **`ReplaySeat` is gone**, replaced by `replay()`. A seat driver is only asked to choose, so it cannot author a referee's change.
- **`space.blocked` is gone**, replaced by layers.
- **Records moved into core** (`summarize`). For that, an `intent` logs `of` and the `seed` entry carries the seed.
- **The space rules cannot read the match.** Core evaluates them per cell and hands the host plain lists.
- **Seat drivers hold no state.** `UtilitySeat` takes a compiled behavior and no seed, and `Match.scores` takes a behavior, not a name.

Still open in core, and visible in the studio:

- **Geometry:** the grid is square and two-dimensional, with no footprints or path distance. No play on a plane without a grid.
- **The ground:** a change does not end by itself, and no cell is hidden from a seat. A map does not change size in play. The host is rebuilt on every ground write, which is fine at today's sizes.
- **Places:** an expression cannot read one, so a place is a scenario's and a view's convenience, not a rule's.
- **The log:** it is not filtered by seat, it does not hold its map, and `state.streams` is in every seat's view.
- **`inBounds`** carries two meanings.

None of these blocks v1.
