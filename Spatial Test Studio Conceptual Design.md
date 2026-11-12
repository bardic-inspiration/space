# Spatial Test Studio: Conceptual Design

Nov 12, 2026 · @Reif · revised for core #5 (maps)

## Purpose and intent

The studio is a browser workbench for designing and testing core rulesets. You watch a match, rewind or fork it, change the config, and run batches to see what a change does. It is core's first real host, and the base a live-play mode can grow from later.

- **Audience:** the ruleset designer. Human seats come later, through the same seat interface.
- **Core loop:** pick a variant, run one match or a batch, read the board and the log, compare, then change the variant.
- **Stack:** TypeScript and three.js, with core's compiler and runtime used unchanged.

The build is specified in [Spatial Test Studio v1 Spec](Spatial%20Test%20Studio%20v1%20Spec.md).

## The divide

Core holds the rules and produces the facts. The studio derives, organizes, displays and compares them, and everything visual or spatial sits on the studio side.

| Concern | Core | Studio |
| --- | --- | --- |
| Rules | Ruleset: kinds, intents, flow | Read-only, edited as YAML variants |
| Behaviors | Their own layer, split from the ruleset | Bound to seats for each run |
| What a map can be | The ruleset's `space`: a grid or a bare plane, the cell layers and what they block, which layers play may change, and the criteria a map must meet (size, cell checks, required places, a standard map) | Builds its tools from these declarations and shows a refusal where it applies |
| Maps | A map is its own document, checked by `loadMap`. A scenario imports one, writes one inline, or takes the ruleset's standard map | Drawn before any match exists. Painted in Build and saved as map documents in a variant |
| The ground in play | A write to a mutable layer is a `ground` log entry. State holds the changes as an overlay, never the map | Draws the map as it stands at any point of a log (`scenario.mapAt(state)`) |
| Geometry | Declares six host functions and their contract | Implements them: one host for the view and for headless batches |
| Facts | Event log, match records | Organized, rendered, compared |
| Presentation | None | Per-ruleset file: colors, icons, log sentence templates, section openers |
| Metrics and analysis | None | CEL metrics saved in the studio project |

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

## The board

The board is a plain 3D environment built from data. The studio draws it, and core's rules decide what it means.

- **Plane and grid:** a map is a bounded plane, and a grid is a rule a ruleset may lay over it. The board draws the plane first and the grid on top when there is one. The square grid is the only one core has. Hexes, height, larger footprints and path distance are added as core adds them, and each one shows in the overlay.
- **A plane without a grid:** a ruleset with `grid: none` has a size and named places and no cells. The board draws the plane and its places, as a poker table, and tokens stand at places. Core asks no spatial question of it, so there is no host and no debug overlay.
- **Cell layers:** the ruleset declares them (for example `terrain`, `cover`) and the map holds their values. The studio builds the layer panel and paint tools from those declarations. Each layer can be shown or hidden, with colors taken from the presentation file. The panel marks which layers play may change.
- **Places:** named points and areas, drawn as outlines with labels. Places a ruleset requires are marked as such.
- **The ground as it stands:** play can write a mutable layer, so the board draws the map of the current state, not the map document. Scrubbing past a Grease shows the ground before it.
- **Tokens:** round chips with an icon, colored by seat or side. The log uses the same colors.
- **Geometry host:** one implementation of core's host contract (`inBounds`, `distance`, `neighbors`, `cellsWithin`, `lineOfSight`, `cellAt`), including closed corners. It is a pure function of one map. Core never tells it of a change; it calls the host factory again with the patched map. The same host runs in the viewer and in batch workers, so what you watch and what a batch measures always agree, and `compareHosts` holds it to core's reference.
- **Spatial debug overlay:** at the current decision, it draws what the host answered: range rings, line-of-sight rays, neighbor cells, and, for each candidate target, which gate passed or failed.

## Matches

A match can be played, rewound to any point, and forked at any decision, so each match is a tree of logs.

- **Play:** step by decision or by event, or play at a set speed.
- **Scrub:** the state at any point is `fold` of the log up to there, which is exact and cheap. The ground at that point comes with it.
- **Fork:** only at a decision, where matches can actually diverge. You can pick a different intent, swap a behavior, or make a referee edit, and the match continues as a new branch. A referee edit can also repaint a mutable layer.
- **Compare:** a split board shows a fork beside its parent, synced by decision index.

Forks are deterministic: core keeps each seat's random stream in the state and re-applies referee edits on replay.

## The log

The log is read as a tree grouped by decision and nested the way the rules nest. Each level folds open into the next.

- **Match:** ruleset@version, scenario, map, variant, seed, outcome
  - **Setup:** the scenario's seed, globals, creates and links, folded by default. The map is named here but is not in the log
  - **Section:** opened by a signal or a write the presentation file marks as structural (`round`, `turn.start`, `hand`, `tick`). Sections nest.
    - **Decision:** seat, intent, bound params. The legal options and their behavior scores are folded under it.
      - **Write / roll:** `set`, `create`, `destroy`, `link`, `unlink`, `ground`, `roll`, each a one-line leaf
      - **Signal:** name and `with`
        - **Reaction:** its writes, as leaves
          - **Decision (prompted):** the same shape again, so Counterspell inside Shield inside an attack nests as the rules do
    - **Fork marker:** a branch leaving at this decision
  - **End:** the condition that held, and its outcome

Three rules govern how it reads:

- **Sentences:** each row is a short sentence built from a template in the presentation file, e.g. *worg → bite → scout: 14 vs AC 13, hit, 7 piercing*.
- **Color:** follows the entry type. Seats and entities appear as chips that match their tokens.
- **Sync:** the log, the timeline and the board stay in step, so clicking a row moves the board to that moment. Clicking a `ground` row also marks its cell.

Sections are presentation config because core has no rounds or turns, only `flow`. Nesting comes from the `cause` link on every log entry.

## Batches and analysis

The point of this mode is to show and arrange batch data so variants can be compared at a glance, with every number leading back to a match you can watch.

- **Batch:** a variant × a seed range, run across the worker pool.
- **Record:** core's fixed fields: outcome, decisions, forced decisions, options per decision, events by type, signals, entity counts, seats, `logHash`.
- **Custom metrics:** CEL expressions, the same language as the rules, saved in the studio project. Each is evaluated at the end of the match or at every signal or event you name (e.g. each `hp.lose`). Metrics run inside the worker during the batch, and their results are saved with the record.
- **Views:** the outcome split, metric distributions as small histograms, variants side by side, and outlier seeds. Clicking an outlier opens that match in Run.
- **Heatmaps:** batch data from every match drawn on the grid: where tokens spent time, where defeats happened, which cells play rewrote.

## Runtime and data

Everything runs in the browser, and everything is stored as plain files in a project folder you can commit.

- **Compute:** core runs unchanged in Web Workers, in a pool sized to the CPU cores. The heaviest match today, the junkyard, takes about 230 ms in a worker, so 100 of them across 8 workers finish in a few seconds.
- **Storage:** the project folder holds the base files as core lays them out, variants, presentation files, metric definitions, batch records as JSONL, and fork branches. The studio reads and writes it through the browser's File System Access API.
- **Records over logs:** a log is fully set by variant + seed, where the variant includes the map. So batches keep only records and logs are regenerated on demand, checked against `logHash`. A log does not hold its map, so a record names the variant by a hash of everything that went into it. Forks store their decisions and referee edits, since those aren't set by the seed.
- **Live play later:** the workers already keep the UI apart from the runtime, so a human seat can plug into the same seat interface.

## Build phases

Core's groundwork is done, so three phases remain, and each ends in something usable. Analyze comes before Build because behavior batches are the first use.

1. **Phase 1, Run slice:** the 5e scenarios in the browser, with the grid, terrain, token chips, play and scrub, the log tree, the inspector, the debug overlay, and light/dark themes. The pack ambush on its rocky pass proves terrain and closed corners, the mage duel proves a ground that changes, and the hold 'em table proves a plane without a grid. There is no editing yet. This proves the core-to-studio pipe and the log hierarchy.
2. **Phase 2, Analyze:** batches across the worker pool, records, CEL metrics, comparison and heatmaps. Behavior variants and map swaps, the two cheapest things to vary.
3. **Phase 3, Build and forks:** the map editor, entity placement, the YAML editors, scenario and ruleset variants, and forking.

## Core status

Everything the studio asked of core is in. The ten tasks of the groundwork issue (core #3) landed in core #4: the behavior split, `cause` links, the browser-worker check, explained enumeration, the host contract, free-standing expressions, cell layers, seat streams in snapshots, referee edits on replay, and forks. Core #5 then made the map its own thing: map documents, map criteria, standard maps, a plane without a grid, named places, and mutable layers.

What core does not have, and the studio therefore leaves out or works around:

- **Geometry:** no hexes, height, footprints larger than a cell, or path distance. No play on a plane without a grid.
- **The ground:** a change does not end by itself, and no cell is hidden from a seat. A map does not change size in play. The host is rebuilt on every ground write, which is fine at today's sizes.
- **Places:** an expression cannot read one, so a place is a scenario's and a view's convenience, not a rule's.
- **The log:** it is not filtered by seat, and it does not hold its map.
- **Embedding:** core's schema checker needs `unsafe-eval` under a strict content security policy.

None of these blocks v1.
