# Spatial Test Studio: v1 Spec

Nov 13, 2026 · @Reif

This is the build spec for the first version of the studio. The design it builds is in [Spatial Test Studio: Conceptual Design](v1-conceptual-design.md); where the two differ, this document is wrong and should be fixed. Core is as of commit `63ab4e2` (core #5), and its contract for a host is `docs/host.md` there.

Decisions this spec makes that the design left open are numbered S1 to S20 and listed in [Decisions](#decisions), so each can be overturned by number. What is knowingly left unsettled is in [Open questions](#open-questions).

## 1. Scope

**v1 is the whole design:** Run, Analyze and Build around one board, for one designer in one browser. It is built in four milestones, each usable by itself ([Milestones](#12-milestones)).

In v1:

- Any ruleset core compiles can be opened, played, scrubbed and batched, with or without a presentation file.
- Four forms of instrument of play: the map, which the others stand on, and tokens, chips and cards (section 7).
- Square grids, and planes without a grid.
- Variants of behaviors, maps, scenarios and rulesets. Batches, CEL metrics, comparison, heatmaps.
- A map editor, entity placement, YAML editors, forks.

Not in v1:

- Instrument forms beyond those four: dice, tiles, pieces with facing.
- Human seats and live play. A seat is filled by a behavior or plays at random.
- Anything core lacks: hexes, height, footprints larger than a cell, path distance, play on a plane without a grid.
- A view filtered to what one seat may know. The studio shows the whole state, as a referee sees it.
- A server, accounts, or sharing. A project is a folder; sharing is committing it.
- Phones and tablets.
- Changes to core. v1 needs none.

## 2. Stack

| Part | Choice |
| --- | --- |
| Language, build | TypeScript, Vite. Tests in Vitest, browser tests in Playwright. |
| Board | three.js. |
| Panels | React. One store module; no state library (S1). |
| Editors | CodeMirror 6 with its YAML mode. |
| Charts | Drawn by the studio as SVG. No chart library (S2). |
| YAML | The `yaml` package, as core uses. Its document model keeps comments on a round trip. |
| Core | An npm git dependency pinned to a commit (S3). Its `rulesets/`, `kit/` and `data/matches.jsonl` come with it and are the studio's examples and its parity data. |

The studio is a static site. It targets desktop Chromium, because the project folder needs the File System Access API (S4). In another browser it opens the bundled examples in memory and cannot save.

The page's content security policy allows `unsafe-eval` for workers and for the page, because core's schema checker builds validators with `new Function`.

## 3. Architecture

```
main thread                              workers
───────────                              ───────
project files ─► resolve variant ─► RunInput ──────────► session worker   one; plays, explains, forks
                                       │        └──────► batch workers    a pool; play and measure
ui panels ◄── store ◄── log, records ◄─┴─────────────────┘
board (three.js) ◄── fold(log to cursor), scenario.mapAt(state)
```

- **Core runs in three places:** the page, the session worker, and each batch worker. Each compiles the same `RunInput` for itself, because a registry and a match do not cross `postMessage` and a log does.
- **The page never plays a match.** It compiles (5 to 40 ms) so it can draw a map, fold a log, show errors, and check a metric. Playing, explaining and forking happen in the session worker.
- **A match is played to its end, then watched (S5).** Run mode moves a cursor along a finished log. Play, pause and step are cursor moves, not runtime steps. This is what makes scrubbing exact and the UI simple, and the heaviest match takes a quarter of a second.
- **One geometry host,** the same module in all three places.

Source layout:

| Path | Holds |
| --- | --- |
| `src/project/` | The folder: reading, writing, the layout in section 4. |
| `src/engine/` | `RunInput` and its hash, the worker protocol, the session worker, the pool. |
| `src/host/` | The geometry host. |
| `src/present/` | Presentation files, their defaults, sentence templates. |
| `src/forms/` | The instrument forms: one module per form, each drawing on the board and inline in the log. |
| `src/log/` | The log tree and the cursor's state cache. |
| `src/board/` | The three.js scene: laying out the instruments, the overlay, heatmaps, picking. |
| `src/analyze/` | Metrics, statistics, charts. |
| `src/build/` | The map editor and entity placement. |
| `src/ui/` | Panels, the store, themes. |

## 4. The project folder

A project is a folder laid out as core lays out its own, with one folder added for the studio. A checkout of core is therefore a valid project.

```
kit/patterns.yaml
rulesets/<ruleset>/ruleset.yaml
rulesets/<ruleset>/{extensions,behaviors,maps,scenarios}/<id>.yaml
studio/project.yaml
studio/presentation/<ruleset>/<id>.yaml
studio/metrics/<ruleset>.yaml
studio/variants/<ruleset>/<variant>/variant.yaml
studio/variants/<ruleset>/<variant>/files/...        shadows of rulesets/<ruleset>/...
studio/batches/<ruleset>/<variant>/<hash>/batch.yaml
studio/batches/<ruleset>/<variant>/<hash>/records.jsonl
studio/forks/<ruleset>/<variant>/<fork>.yaml
```

- **Base files** are everything outside `studio/`. The studio never writes them (S6).
- **`studio/project.yaml`** holds `format: 1`, a title, and the core commit the project was last used with. A project opened with a different core says so, and marks its batches stale.
- **Appearance is not part of a run (S20).** A ruleset may have several presentation files; `default.yaml` is used unless another is picked in the view. None of them reaches a `RunInput`, so changing how a ruleset looks cannot change a match, a hash or a batch.
- Every studio document carries `format: 1` and is schema-checked. An unknown key is refused, as in core.

### 4.1 Variants

A variant is a run configuration and a set of files laid over the base.

```yaml
format: 1
variant: { id: bold-wolves, title: Bolder wolves, notes: "Wolves ignore the stand-and-fight goal." }
ruleset: dnd-5e-2024-slice
scenario: pack-ambush
extensions: []                       # extension ids, in order
behaviors: [default, bold]           # behavior set ids, merged in order
bind: { wild: packHunter }           # seat → behavior name, or `random`
map: narrow-pass                     # played on this map instead of the scenario's
limits: { maxDecisions: 6000 }
```

Only `variant`, `ruleset` and `scenario` are required. `behaviors` defaults to `[default]`.

- **Shadowing (S7).** A file under the variant's `files/` stands in for the base file at the same path under `rulesets/<ruleset>/`, and a file with no base counterpart is added. So `files/behaviors/bold.yaml` adds a set, `files/maps/narrow-pass.yaml` adds a map, and `files/ruleset.yaml` replaces the rules. A shadow is a whole file.
- **Small changes stay small.** A behavior change is an overlay set, since core merges sets in order. A map swap is the `map` line. A whole-file shadow is for what those cannot say.
- **`map`** replaces the scenario's `map`, or its inline `space`, before the scenario is loaded. Core refuses it when the ruleset allows only its standard map.
- **The base variant** of a scenario is implicit: the scenario as written, with the default behaviors.

### 4.2 From a variant to a run

Resolving a variant gives the plain data core takes:

```ts
interface RunInput {
  kit: unknown;
  ruleset: unknown;
  extensions: unknown[];
  behaviors: unknown[];                 // in merge order
  scenario: unknown;                    // with the variant's map and limits applied
  maps: Record<string, unknown>;        // every map document of the ruleset, by id
  bind: Record<string, string>;
}
```

The **variant hash** is the first 16 hex digits of SHA-256 over the canonical JSON of the `RunInput` (keys sorted) and the core commit (S8). It names a batch, and a record carries it. Because a log does not hold its map, the hash is the only thing that says which map a recorded match was played on. Two variants that resolve to the same input have the same hash and share a batch.

Compiling a `RunInput`, in every thread:

```ts
const registry = compile({ kit, base: ruleset, extensions });
const behaviors = compileBehaviors(registry, input.behaviors);
const scenario = loadScenario(registry, input.scenario, { maps: input.maps, host: createStudioHost });
const seats = bindSeats(scenario, behaviors, bind);   // input.bind, with each `random` replaced by a RandomSeat
```

### 4.3 Errors

Core refuses invalid data with a `CompileError` listing every reason and its path. The studio maps each path to a file and a YAML node (`scenario.entities[3].fields.pos` to the scenario's file, `behaviors.eager.scores.bump` to the set that wrote it) and shows the reason there in the editor, and in an errors list that jumps to it. A variant with errors cannot be run; the last good compile stays on the board.

## 5. The geometry host

`createStudioHost(map: SpaceMap): SpaceHost` in `src/host/`. It implements the six functions of `docs/host.md` exactly: units, row order, totality off the map, and closed corners in `neighbors`.

- **Pure, and built per ground.** It is a function of the one map it is given and keeps nothing between calls. Core calls the factory again with a patched map each time a match writes the ground, so building one must be cheap: it indexes `blocksMove`, `blocksSight` and `cells` into typed arrays sized to the map and does nothing else.
- **It agrees with core's reference host in v1 (S9).** Its line of sight is the same line walk. The studio owns a host so that better geometry has somewhere to go later; a host that answered differently now would play different matches from the recorded ones, with nothing to check them against.
- **A plane without a grid has no host.** Core builds none and asks nothing.

Held to the contract by two checks in `npm run validate`:

1. `compareHosts(createStudioHost(map), createGridHost(map), map)` returns nothing, for every map and inline space under core's `rulesets/`, and for those maps with random ground writes laid over them.
2. Parity: every match in core's `data/matches.jsonl` (240) is played through the studio's engine with the studio's host, and its `logHash` matches.

## 6. The engine

### 6.1 Session worker

One worker serves the interactive match. It keeps the compiled input for the current variant hash, and the live match it last played.

| Request | Does | Answers |
| --- | --- | --- |
| `play { input, seed }` | Plays to the end with `step`, keeping a snapshot every 32 decisions. | `{ log, record }`, or `{ errors }`. |
| `decision { seed, seq }` | `fork` to the decision at `seq` from the nearest snapshot, `advance`, `explain`, and score the options with the seat's bound behavior. | `{ seat, options, scores, explanation }`. |
| `branch { seed, seq, steps }` | `fork` to `seq`, applies the steps (section 9), plays to the end. | `{ log, record }`. |
| `replay { input, log }` | `replay` a stored log through the rules. | `{ ok }`, or the first entry that differs. |

Every request carries an id and can be cancelled; a newer `play` supersedes an older one. A `RuleError` or any other throw comes back as `{ error }` with core's message and is shown in Run, not swallowed.

### 6.2 Batch pool

- **Size:** `hardwareConcurrency - 1`, at least 1, at most 8.
- **Jobs:** one seed each, taken from a shared queue. A worker compiles an input once per variant hash and keeps the last four.
- **A job** plays the match with `playMatch`, evaluates the metrics (section 10.2), and answers one record.
- **Progress** is the count of records in. A batch can be cancelled, and resumed: seeds already in `records.jsonl` are not played again.
- **A match that throws** yields a record with `error` and no outcome (section 10.1). The batch goes on.

### 6.3 The cursor

The page holds the log and a cursor: the number of entries applied, from 0 to `log.length`. The state at the cursor is `fold(log.slice(0, cursor))`, kept cheap by a keyframe state every 256 entries and `apply` from the nearest one. The map at the cursor is `scenario.mapAt(state)`; the board redraws the ground only when that object's identity changes.

## 7. Presentation and instruments

A presentation file, `studio/presentation/<ruleset>/<id>.yaml`, says how a ruleset looks and reads. Every part is optional, and a ruleset with no file at all is fully usable: the studio fills each gap with the default given below (S10).

### 7.1 Instruments of play

An instrument of play is a thing the game is played with: a map, a token, a stack of chips, a hand of cards. Its rules are core's and its appearance is the studio's (S17). The presentation file joins the two: each entry under `instruments` binds something the ruleset declares to a **form** the studio draws, and gives it a look.

Instruments come in two roles, as Ludii's equipment does (S19):

- **A container** holds other instruments and says where they can be. The map is one: it is an instrument, with rules in core's `space` and a look of its own, and it is also the stage the others stand on. It is the only container in v1.
- **A component** is held. Tokens, chips and cards are components, and each lies somewhere on the map: in a cell, or at a place.

So a ruleset with no space has components and nowhere to put them, and the studio lists them in a tray.

```yaml
format: 1
presentation: { ruleset: holdem }

instruments:
  table:
    form: map
    places: { board: { label: Board }, pot: { label: Pot } }
  stack:
    form: chips
    of: player
    count: "self.chips"
    at: { place: "chair{chair}" }
    color: { by: seat }
    dim: "self.folded"
  hole:
    form: cards
    of: player
    cards: "self.hole"
    at: { place: "chair{chair}", offset: [0, 0.8] }
    face: { rank: "card / 4 + 2", suit: "card % 4" }
  community:
    form: cards
    cards: "game.board"
    at: { place: board }
    face: { rank: "card / 4 + 2", suit: "card % 4" }
  pot:
    form: chips
    count: "all.player.map(p, p.committed).sum()"
    at: { place: pot }
```

```yaml
format: 1
presentation: { ruleset: dnd-5e-2024-slice }

instruments:
  ground:
    form: map
    layers:
      terrain:
        values:
          difficult: { color: "#b9a46a", pattern: hatch }
          rock: { color: "#5c5c5c", raise: 0.6 }
  creature:
    form: token
    of: creature
    at: "self.pos"
    label: "{name}"
    icon: paw
    color: { by: side }
    dim: "self.defeated"

colors:
  side: { monsters: "#b5483a", adventurers: "#3a6fb5" }
```

Common to every component:

- **`of`** names a kind: there is one component per live entity of it, and its expressions see that entity as `self`. Without `of` there is one for the match, and its expressions see the global scope only.
- **What it shows** (`count`, `cards`, a token's `at`) and **`dim`** are CEL, checked with `compileExpression` against the ruleset like any rule and evaluated on the state at the cursor. They read facts; the presentation file gives an instrument no rules.
- **`at`** says where on the map it lies: a `cell` expression, or `{ place, offset }`, where the place's name is a template over the entity's stored fields and the offset is in the map's units. A component with no `at`, or whose place the map lacks, is listed in a tray beside the board.
- **`color`** is a fixed color, or `{ by: field }` with the field's values colored under `colors`.

The four forms of v1:

| Form | Role | Binds | Draws | Look |
| --- | --- | --- | --- | --- |
| `map` | Container | The ruleset's `space` and the map at the cursor. One per ruleset, with no `of` or `at`. | The plane, the grid when there is one, the cell layers, the places. | Per layer: a color, pattern and height per value of an enum, bool or string, or a `ramp` and `domain` for a number. Per place: a label and a color. |
| `token` | Component | An entity with a cell (`at`). | A round chip with an icon and a ring in its color. Several in one cell fan out inside it. | `label`, `icon`, `color`. |
| `chips` | Component | An `int` (`count`). | A stack whose height follows the count, with the number beside it. Zero draws an empty outline. | `color`, and `unit`, the chips one disc stands for. |
| `cards` | Component | A `list<int>` or `list<string>` (`cards`). | A row of card faces, in list order. | `face`: a `rank` and a `suit` expression over `card`, or `text`, an expression giving the words on the face. `back: true` draws them face down. |

Defaults, when a ruleset has no presentation file or lists no instruments:

- A `map` instrument for any ruleset with a space. A layer's default value draws nothing; other values take colors from a fixed categorical palette in declaration order; a number takes a ramp over the values present. A cell that blocks movement is raised.
- A `token` for every kind with exactly one `cell` field, labelled with its `name` field or its id, colored by its `seat` field when it has one.
- No chips and no cards: nothing in a ruleset says that a number is a stack or a list is a hand. Kinds with no instrument appear only in the inspector.

**A form is a module** in `src/forms/` with one interface: check a binding against the registry, draw on the board from a state, draw inline in a log row, and answer a pick. A container's form also answers where a cell or a place is, which is all a component's form needs to know of it. The board and the log know forms only through it, so a fifth form is one new module and no change elsewhere. The four forms are the fixtures that prove the interface.

**Hidden values are shown.** A field hidden from some seats, such as hole cards, is drawn as the referee sees it, with a mark that it is hidden (S14).

**Icons** are a name from the studio's built-in set, or one or two characters of text.

### 7.2 Sections and sentences

```yaml
outcome: winner

sections:
  - { on: { global: round }, title: "Round {value}" }
  - { on: { signal: turn.start }, title: "{args.actor.name}'s turn" }

sentences:
  intent:
    attack: { text: "{params.actor} → {params.weapon} → {params.target}", then: [attack.hit, attack.miss] }
  signal:
    attack.hit: "hit{args.critical ? ', critical'}"
  set:
    creature.hp: "{id} hp {was} → {value}"
  ground:
    terrain: "{at} becomes {value}"
```

| Part | Says | Default |
| --- | --- | --- |
| `colors` | Colors for the values of a field that instruments color by. | The categorical palette, by first appearance in the scenario. |
| `outcome` | The key of a match's outcome that batches are split by. | `winner` when outcomes have one, otherwise `result`. |
| `sections` | What opens a section of the log, outermost first: a signal, or a write to a global. | None: decisions sit directly under the match. |
| `sentences` | A template per intent, signal, `kind.field` set, created or destroyed kind, relation, and ground layer. | A generic sentence from the entry's own fields, e.g. *set worg.hp 12*. |

**Templates.** `{path}` is replaced by a value read from the log entry: `seat`, `intent`, `params.*`, `args.*`, `id`, `field`, `key`, `value`, `values`, `at`, `layer`. `was` is the value a write replaced. A path may step from an entity into its stored fields (`{params.target.name}`), read from the state at that entry. An entity renders inline as its instrument does (a token as a chip in its color), a value written to a `cards` binding as its faces, and a cell as `(x, y)`. `{flag ? 'text'}` writes the text when the value is true. A template is not CEL and computes nothing (S11); what a sentence needs and the log lacks belongs in the rules as a signal argument.

**`then`** on an intent's sentence appends the sentence of the first descendant signal of each listed name, so a decision reads as its result: *worg → bite → scout: hit, 7 piercing*.

The presentation file is checked against the compiled ruleset: an unknown form, layer, kind, field, signal, intent or place, or an instrument expression core refuses, is an error shown in its editor, and the studio falls back to the default for that part.

## 8. The board

One three.js scene, shared by the three modes. It draws the map and lays the ruleset's other instruments out on it; each is drawn by its form.

**Space.** Cell `(x, y)` occupies the square from `(x, y)` to `(x + 1, y + 1)` on the ground plane, with `y` running down the screen, so the board reads as a map document's picture does. On a plane without a grid, the same coordinates are game units.

**Camera.** Orthographic and top-down by default, with pan, zoom, and a tilt toggle to a perspective view. Fit-to-map on load and on a key.

**Drawn, bottom to top:**

1. The map: the plane, the grid lines when there is a grid, the cell layers (one instanced mesh per visible layer, from `mapAt(state)`), and the places as outlines with labels.
2. Heatmap, when one is on.
3. The components (tokens, chips and cards), each where its `at` puts it on the map. A dimmed one is flat and gray.
4. The debug overlay and the selection.

**Motion.** While playing, a token whose `at` changes slides to its new cell, a stack grows or shrinks, a card is dealt in, and a ground cell that changes flashes. Scrubbing and stepping draw the state with no animation.

**Picking.** Click selects an instrument or a cell and opens it in the inspector; hover names it. An instrument opens the entity it is `of`. The inspector shows a cell's layer values at the cursor, and whether each differs from the map document.

**Layer panel.** One row per declared layer: show or hide, its legend, and a mark when it is `mutable`.

**Themes.** Light and dark, from one set of CSS variables that the scene's materials also read.

**Size.** 60 frames a second on a 40 by 40 map with 100 tokens, on integrated graphics.

### 8.1 Debug overlay

Available when the cursor stands at a decision on a grid. The data is `match.explain()`, asked of the session worker.

- A list of the decision's intents and, under each, its candidates: legal ones first, each gate marked pass, fail or error with its source text.
- Selecting a candidate or a gate draws its host calls on the board: `cellsWithin` as a filled range, `neighbors` as marked cells, `lineOfSight` as a ray, green when clear and red when broken, `distance` as a labelled line, `cellAt` and `inBounds` as a marked cell.
- Selecting a param's domain draws the calls that produced it.

## 9. Run

**Transport.** Play and pause; step by event; step by decision; speed from 1 to 64 events a second, with a pause at each decision. Keys: space, the arrows for an event, shift with the arrows for a decision.

**Decision points.** An `intent` entry with `of` is a decision a seat made. Stepping by decision places the cursor just before one: the board shows what the seat saw, and the inspector shows the decision.

**Timeline.** A bar over the whole log with a tick per decision, a band per outermost section, the cursor, and a marker where each fork leaves. Drag to scrub.

**Log tree.** Built from the log alone:

- The first `1 + scenario.setup.length` entries are **Setup**.
- An entry with `cause` is a child of the entry with that `seq`.
- An entry without one sits at the top. If it matches a section opener it starts a section at that opener's level, closing any open section at that level or deeper; otherwise it joins the innermost open section.
- An entry with `by` is marked as the referee's.
- The `end` entry is **End**.

Rows are virtualized, and a log of 5,000 entries scrolls and scrubs without a dropped frame. The row at the cursor is highlighted and kept in view; clicking a row moves the cursor to just after it. Selecting a `ground` row marks its cell, and selecting a row that names an entity selects its token.

**Inspector.**

- *Entity:* its stored fields, its derived values (each read with `compileExpression`), and its links, at the cursor. A field that changed at the last entry is marked.
- *Decision:* the seat, its behavior, the options with their scores, and the one chosen. Opens the debug overlay.
- *Match:* ruleset and version, scenario, map, variant and hash, seed, outcome, and the record.

**Opening a match.** Run takes a variant and a seed. It regenerates the log; when it came from a batch record and the `logHash` differs, Run says so and names what changed since (the variant hash or the core commit).

### 9.1 Forks

A fork leaves a match at a decision and is stored as what was done there, not as a log.

```yaml
format: 1
fork: { id: scout-flees, title: The scout runs instead }
variant: { id: base, hash: 3f9c0e12a4b877d1 }
seed: 7
parent: null                 # or another fork's id
at: 412                      # the seq of the decision
steps:
  - author: { seat: referee, changes: [{ ground: { at: [9, 6], layer: terrain, value: difficult } }] }
  - bind: { scouts: skirmisher }
  - choose: { intent: move, params: { actor: scout, to: { x: 14, y: 6 } } }
logHash: 81c2aa07
```

- **Steps**, applied in this order when present: referee changes, then new seat bindings for the rest of the match, then the option to choose. With no `choose`, the seat's behavior chooses.
- **A referee change** is anything `match.author` takes, a write to a mutable layer included. It needs a referee seat in the scenario; without one the step is unavailable and the studio says why.
- **A fork's log** is regenerated: the parent's log, `fork` at `at`, the steps, then play to the end. It is checked against `logHash`.
- **In the UI:** at a decision, pick another option from the list, change a binding, or enter referee mode and edit the board. The branch opens beside its parent.
- **Compare.** A split board, parent and fork, with cursors synced by decision index from the fork point, and one timeline showing where they part.

## 10. Analyze

### 10.1 Batches

A batch is a variant hash and a seed range. `batch.yaml` holds the variant id and hash, the core commit, the seeds, a hash of the metric definitions, and when it ran. `records.jsonl` holds one line per seed:

```ts
type BatchRecord = MatchRecord & {
  variant: string;                              // the variant hash
  metrics: Record<string, number | boolean | string | null>;
  cells: Record<string, Record<string, number>>;   // per cell metric: "x,y" → count
  errors?: Record<string, string>;              // a metric that could not be evaluated
};
// A match that threw has `ruleset`, `version`, `scenario`, `seed`, `variant`, and `error`, core's message.
```

A record holds no clock and no machine, as core's does, so a batch re-run on the same core gives the same file (S12).

A batch is **stale** when its variant no longer resolves to its hash, when the core commit differs, or when the metric definitions changed. Stale batches stay readable and are marked; re-running replaces them.

### 10.2 Metrics

`studio/metrics/<ruleset>.yaml`:

```yaml
format: 1
metrics:
  rounds: { value: "game.round" }
  bloodied: { value: "all.creature.filter(c, c.hp * 2 <= c.hpMax).size()" }
  bigHits: { at: { signal: hp.lose }, value: "amount >= target.hpMax / 2", fold: count }
  damage: { at: { signal: hp.lose }, value: "amount", fold: sum }
  deaths: { at: { signal: hp.lose }, when: "amount >= target.hp", value: "target.pos", fold: cells }
```

- **`value`** is CEL, compiled with `compileExpression` against the variant's registry and refused with the same errors a rule gets.
- **`at`** says when: absent, once on the final state; `{ signal: name }`, at every emission of that signal, on the state at that entry, before any reaction to it has run, with the signal's arguments as variables; `{ entry: type }`, after every log entry of that type (`set`, `ground`, `intent`, ...), with no variables.
- **`when`** is an optional bool in the same scope; the sample is skipped when it is false.
- **`fold`** turns a match's samples into one value: `sum`, `count` (of true samples, or of all when not bool), `mean`, `min`, `max`, `last`, or `cells`. A metric with no `at` needs none.
- **A cell metric** has a `cell` value and `fold: cells`. It yields a count per cell and feeds a heatmap.
- **Built in,** for any ruleset with tokens on a grid: `occupancy`, a count per cell of tokens standing there at each decision, and `ground`, a count per cell of ground writes.

Metrics are evaluated in the batch worker, by walking the finished log once with `apply`. A metric that throws on one match records `null` and its message in `errors`.

The metrics editor checks each expression as it is typed and shows its type, and its value on the match open in Run.

### 10.3 Views

- **Batch table.** One row per record: seed, outcome, decisions, events, every metric. Sort and filter by any column. A row opens that match in Run.
- **Outcome split.** The share of each value of the outcome key, with a 95% Wilson interval, as a stacked bar.
- **Distributions.** A histogram of 20 bins for each numeric metric and each numeric record field, with mean, median, and 10th and 90th percentiles.
- **Compare.** Two or more batches side by side: outcome bars on one scale, histograms on shared axes, and a table of each metric's mean and median per batch with the difference from the first.
- **Outliers.** Per metric, the records beyond 1.5 times the interquartile range, and every record that ended at the decision limit or with an error. Each opens in Run.
- **Heatmaps.** A cell metric summed over a batch, drawn on the board over the variant's map. In Compare, a split board shows two batches' heatmaps on one color scale, when their maps are the same size.

Comparison is between distributions. The same seed under two variants is not a matched pair, because the matches diverge at the first different decision.

## 11. Build

Everything Build changes is written to the variant in hand. Editing while on the base variant first asks for a new variant's name.

**Variants.** New, duplicate, rename, delete, and a diff of each shadowed file against its base.

**Run settings.** The scenario, the map (from the ruleset's maps and the variant's own), extensions, behavior sets and their order, a binding per seat, the decision limit, and the default seed range.

**Map editor.** Works on a map document in the variant; editing a base map shadows it first.

- Tools: brush, rectangle, fill, and eyedropper, each writing one layer's value. The value picker is built from the layer's type: an enum's values, a bool, or a number.
- Places: add a point or drag out an area, name it, move it, delete it. Places the ruleset requires are listed and cannot be deleted.
- Size: resize within `space.size`, from any edge.
- Every edit is checked with `loadMap`. A cell that fails a `space.checks` rule is marked on the board with the rule's message, and the map is saved either way so work in progress is not lost; a variant whose map fails cannot be run.
- The map is written as a picture, `rows` and `legend`, keeping the file's existing symbols and adding new ones as needed. A map with more distinct cell values than symbols is written with `cells` (S13).
- A ruleset that allows only its standard map has the editor read-only, and says why. A plane without a grid has places and a size and no paint tools.
- Undo and redo, per document.

**Entities.** Editing a scenario in the variant.

- Drag a token to move it: its `cell` field is rewritten, or set to a place's name when dropped on a point place with the modifier held.
- Add an entity of any kind from a form generated from the registry's fields, with their types, defaults and checks. Delete one.
- Links: select an entity to see its relations, and add or remove a link to another.
- Core's refusals (a failed check, a cell off the map or blocked) show on the token and in the form.

**YAML editors.** Any document of the ruleset or the variant, and the presentation and metrics files. A presentation file is a studio file and is edited in place, not shadowed. Saving a base document writes a shadow. A change is compiled 300 ms after typing stops, with errors inline (section 4.3). The board and the open match follow the last good compile.

**Painting the ground in play** is not Build: it is a referee change in a fork (section 9.1), and only on a mutable layer.

## 12. Milestones

Each milestone ends with `npm run validate` green and its acceptance list demonstrated.

### M0: the pipe

The repo, the build, core pinned, the worker protocol, the geometry host, and a page that plays a bundled scenario in a worker and prints its record.

- [ ] `npm run validate` type-checks, runs the unit tests, the host conformance check and the parity check of section 5, and one Playwright test that plays a match in a worker in the built site.
- [ ] All 240 of core's recorded matches reproduce their `logHash` through the studio's engine and host.
- [ ] A GitHub workflow runs `npm run validate` on every pull request.

### M1: Run

Bundled examples only, read-only: the board, the cursor, the log tree, the inspector, the debug overlay, presentation files with defaults, themes.

- [ ] Every one of core's six scenarios opens and plays with no presentation file.
- [ ] 5e, hold 'em and checkers ship with presentation files, and between them use all four forms.
- [ ] Hold 'em under a second presentation file looks different, and its logs, hashes and batches are untouched.
- [ ] Pack ambush: rock and Difficult Terrain are drawn, and the overlay shows a diagonal that a closed corner removes from `neighbors`.
- [ ] Mage duel, a seed where Grease is cast: the ground changes at the `ground` entries and changes back when scrubbed before them.
- [ ] Mage duel: a Counterspell at a Shield at an attack is nested three decisions deep in the log tree.
- [ ] Hold 'em: the table is drawn as a plane with its places, each chair has a stack and two hole cards, the board and the pot fill as the hand is played, and the overlay is unavailable.
- [ ] Junkyard (about 2,600 entries): scrubbing the whole timeline holds 60 frames a second.
- [ ] At every decision of a match, the inspector lists as many options as the entry's `of`, with the one the log chose among them.

### M2: Analyze

The project folder, variants limited to run settings and behavior and map files written by hand, the pool, records, metrics, the five views, heatmaps.

- [ ] Opening a checkout of core as a project works, and nothing outside `studio/` is written.
- [ ] 100 junkyard matches finish in under 10 seconds on 8 workers.
- [ ] A batch of the base variant over seeds 1 to 40 reproduces every `logHash` in core's `data/matches.jsonl`, for each scenario.
- [ ] A batch cancelled halfway and resumed gives the same `records.jsonl` as one run through.
- [ ] Two variants of the pack ambush, one with another behavior bound and one on another map, compare side by side, and an outlier opens in Run with a matching `logHash`.
- [ ] A `deaths` heatmap draws on the rocky pass.
- [ ] Editing a metric marks the batch stale.

### M3: Build and forks

The map editor, entity placement, the YAML editors, ruleset and scenario variants, forks and the split board.

- [ ] A map painted in the editor loads with `loadMap`, round-trips through its file unchanged, and plays.
- [ ] A cell that breaks a `space.checks` rule is marked with the rule's message, and a missing required place is reported.
- [ ] Checkers' map editor is read-only.
- [ ] A compile error introduced in each kind of document is shown on the right line of the right file.
- [ ] A fork that chooses the option the match chose reproduces the parent's log.
- [ ] A fork with a referee's ground change, a new binding and another choice is saved, reloaded, and regenerates to its `logHash`.
- [ ] A fork of a fork does the same.

## 13. Risks

- **Core as source.** Core ships TypeScript with no build, and its imports carry `.ts` extensions. Vite takes that as it is; if a tool in the chain does not, the fallback is a git submodule aliased to the same import name.
- **A private core repo** needs a token for the dependency in CI.
- **Core moves.** Each bump of the pinned commit re-runs parity. A bump that changes logs marks batches stale by design.
- **Large maps written often.** Core rebuilds the host on every ground write. The host's build is linear in the map, so a 200 by 200 map written every decision would be felt. Nothing shipped does this; if a ruleset does, the fix is core's (patching the host), not the studio's.
- **Log volume.** A 5e hit is about ten entries. The tree and the keyframes are sized for 5,000 entries; matches near the 20,000-decision limit are not measured.
- **File System Access.** Chromium only, and permission is asked again each session.

## Open questions

Left open on purpose, to settle after the four forms have been built and used. Each is a question about where the seam between an instrument's rules and its appearance runs.

- **What makes a number a stack?** In v1 a binding in the presentation file does: nothing in a ruleset says that `player.chips` is chips, so a ruleset with no presentation file shows none. The other answer is that core declares what a thing is (a count of chips, a hand of cards) and the studio only chooses its look.
- **Is face up or face down a rule or a look?** Core already says who may see a field (`visible`). v1 draws every card as the referee sees it and marks the hidden ones, and `back` is a fixed look. Whether a card lies face up could instead follow from `visible` and a viewer, which waits on a seat's view (S14).
- **What holds what?** In v1 only the map is a container, and a component's place on it is written in the presentation file. A hand holds cards and a pot holds chips, and that containment may belong in the rules, with the studio showing where a container lies and the rules saying what is in it.

## Decisions

| | Decision | Why |
| --- | --- | --- |
| S1 | React for panels, one store, no state library. | The panels are lists, trees and forms. The store is a log, a cursor and a selection. |
| S2 | Charts drawn by the studio. | Stacked bars and histograms on shared axes are small, and a click on a bar must reach a record. |
| S3 | Core as a git dependency pinned to a commit. | A batch is only reproducible against a known core, and the hash needs a name for it. |
| S4 | Desktop Chromium, with a read-only fallback elsewhere. | The project is a folder you can commit, and only this API writes one. |
| S5 | A match is played to its end and then watched. | Scrubbing, stepping and playing become one thing, a cursor on a log. |
| S6 | The studio never writes outside `studio/`. | A project can be a checkout of core, and base files stay what was reviewed. |
| S7 | A variant shadows whole files. | One rule for every kind of document, readable in a diff, with no patch format to design. |
| S8 | A variant is named by a hash of its resolved input and the core commit. | A log does not hold its map or its rules, so the record must. |
| S9 | The studio's host agrees with core's reference in v1. | The 240 recorded matches are the only ground truth there is. |
| S10 | A presentation file is optional in every part. | A new ruleset should be watchable before anyone styles it. |
| S11 | Sentence templates read and do not compute. | A second expression language in the view would drift from the rules. |
| S12 | Batch records hold no timings. | The file is then a regression check, as core's is. |
| S13 | The map editor writes a picture. | Core's own maps are pictures, and a painted map should diff like one. |
| S14 | No seat-filtered view. | Core does not filter the log, so a seat's view of a match would be half true. |
| S15 | Metrics are CEL through `compileExpression`, with fixed folds. | The language of the rules, and no loops to write. |
| S16 | Seeds across variants are not paired. | Matches diverge at the first different decision, so pairing would claim more than it shows. |
| S17 | An instrument of play has its rules in core and its appearance in the studio, joined by a binding to a form. | The split Ludii makes between ludemes and equipment. Core stays free of presentation, and one ruleset can be shown many ways. |
| S18 | An instrument's bindings are CEL; its labels, a place's name, and the log's sentences are templates. | A binding reads the state and must be type-checked against the ruleset. A template only arranges what an entry or an entity already holds. |
| S19 | The map is both an instrument and the stage: a container, where tokens, chips and cards are components. | Ludii's two roles for equipment. The map gets a look like any instrument, and the others are placed by reference to it. |
| S20 | Presentation files are picked in the view and never enter a run. | How a ruleset looks must not be able to change a match, or a batch would depend on its colors. |
