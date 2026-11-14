# Spatial Test Studio

A browser workbench for designing and testing
[core](https://github.com/bardic-inspiration/core) rulesets: watch a match,
rewind or fork it, change its config, and run batches to see what a change
does.

**Status:** early development. Expect breaking changes.

## Install and run

Requires Node 22 or later.

```bash
git clone https://github.com/bardic-inspiration/space
cd space
npm install
npm run dev
```

The studio opens on bundled examples from core. Opening a project folder on
disk requires desktop Chromium.

Core is a git dependency that the lockfile names over ssh. Without ssh access
to GitHub, rewrite it to https before installing:

```bash
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
```

## Documentation

- [`SPEC.md`](SPEC.md) — what the studio does.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup and how to contribute.
- [`AGENTS.md`](AGENTS.md) — the full working guide, for humans and AI agents.
- [`docs/`](docs) — workflow, testing, CI, and documentation conventions.

## License

[MIT](LICENSE). The bundled 5e examples come with core and include material
from the System Reference Document 5.2 by Wizards of the Coast LLC, licensed
under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
