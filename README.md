# Spatial Test Studio

A browser workbench for designing and testing [core](https://github.com/bardic-inspiration/core)
rulesets. You watch a match, rewind or fork it, change the config, and run
batches to see what a change does.

- [Conceptual Design](Spatial%20Test%20Studio%20Conceptual%20Design.md): what the studio is for.
- [v1 Spec](Spatial%20Test%20Studio%20v1%20Spec.md): what this build implements. Section numbers below are the spec's.

## Run it

```bash
npm install
```

```bash
npm run dev
```

The studio opens on the bundled examples: core's four rulesets and six
scenarios, with the presentation files, metrics and variants under
[`examples/studio/`](examples/studio). They are held in memory. **Open
folder…** opens a project on disk, which needs desktop Chromium (S4). A
checkout of core is a valid project; the studio writes only under its
`studio/` folder (S6).

Node 22 or later. Core is a git dependency pinned to a commit in
`package.json` (S3), and that commit is part of every variant hash.

## Check a change

```bash
npm run validate
```

This is the check a pull request must pass, and
[the workflow](.github/workflows/validate.yml) runs it. It type-checks, runs
the unit tests, builds the site, and drives the built site in headless
Chromium. The browser tests need Chromium once: `npx playwright install chromium`.

| Tests | Hold |
|---|---|
| [`tests/m0.test.ts`](tests/m0.test.ts) | The studio's host against core's reference with `compareHosts`, over every shipped map and with random ground writes laid over them. All 240 of core's recorded matches reproduce their `logHash` through the studio's engine and host. |
| [`tests/m1.test.ts`](tests/m1.test.ts) | Presentation files and their defaults, the four forms, the log tree, the cursor, a decision's options. |
| [`tests/m2.test.ts`](tests/m2.test.ts) | The project folder, batches and their records, metrics, statistics. |
| [`tests/m3.test.ts`](tests/m3.test.ts) | The map editor's model, entity edits, errors on the right line of the right file, forks. |
| [`tests/browser/studio.test.ts`](tests/browser/studio.test.ts) | The built site: matches in workers, the board in WebGL, the three modes driven by mouse and keyboard. It leaves screenshots in `tests/browser/shots/`. |

## Layout

| Path | Holds |
|---|---|
| [`src/project/`](src/project) | The folder: reading, writing, variants and shadows, a variant resolved to a `RunInput`, core's errors mapped to a file and a line, forks, edits to YAML as text. |
| [`src/engine/`](src/engine) | `RunInput` and the variant hash, the worker protocol, the session worker, the batch pool. |
| [`src/host/`](src/host) | The geometry host: the six functions of core's `docs/host.md`. |
| [`src/present/`](src/present) | Presentation files, their defaults, templates and sentences. |
| [`src/forms/`](src/forms) | The instrument forms, one module each: `map`, `token`, `chips`, `cards`. |
| [`src/log/`](src/log) | The log tree and the cursor's state cache. |
| [`src/board/`](src/board) | The three.js scene, the debug overlay, heatmaps, picking. |
| [`src/analyze/`](src/analyze) | Metrics, batch records, statistics, charts. |
| [`src/build/`](src/build) | The map editor's model and entity placement. |
| [`src/ui/`](src/ui) | The store, the panels, the themes. |
| [`examples/studio/`](examples/studio) | Presentation files for the 5e slice, hold 'em (two) and checkers; metrics; three variants of the 5e slice. |

## What the spec left to the build

Small calls made while building, each open to being overturned:

- **A base variant's id is `@<scenario>`.** The spec calls it implicit; a
  batch and a fork need a folder name for it, and one ruleset has several.
- **`dagger-duel`, an example variant.** None of core's shipped behaviors
  counters a Shield, so no recorded match nests a Counterspell at a Shield at
  an attack. This variant binds an overlay behavior that does, which is also
  the worked example of an overlay set.
- **`checker` on the map form.** A look for the plane: the color of every
  other square. Checkers' board has no layer to color.
- **`sentences.global`.** A template for a write to a global, beside the
  groups the spec lists.
- **`seeds` in `variant.yaml`.** The variant's default seed range (section 11
  names it as a run setting; section 4.1 gives it no key).
- **A cell metric may be a `list<cell>`**, each cell counted once per sample.
- **Requests to the session worker carry the log.** The worker keeps
  snapshots by variant hash and log hash, and rebuilds them when it has none.
- **A fork that chooses what its parent chose** is given the parent's stream
  position, so it reproduces the parent's log entry for entry.

## Not done, or not measured

- **60 frames a second** is measured only as script: a cursor move on the
  junkyard's log costs about 2.5 ms, drawn or not. Frames themselves were
  drawn with software WebGL in headless Chromium, which is no measure of a GPU.
- **100 junkyard matches** took about 9 seconds on 3 workers (a 4-core
  machine). 8 workers were not available to measure.
- **A refusal on an entity** is shown in the Entities form and the errors
  list, not on the token itself.
- **Matches near the 20,000-decision limit** are not measured (spec, section 13).
- The File System Access path is tested through the browser's private file
  system, which gives the same handles as a folder picked from disk; the
  picker itself is not driven.

## License

MIT; see [`LICENSE`](LICENSE). The bundled 5e examples come with core and
include material from the System Reference Document 5.2 by Wizards of the
Coast LLC, licensed under CC-BY-4.0.
