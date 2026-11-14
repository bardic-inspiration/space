# Spatial Test Studio — Specification

`status: draft`

<!-- TEMPLATE: status is one of
- draft    — being written; nothing is built from it yet.
- building — the initial build plan is open; the spec isn't yet true of main.
- current  — true of main, except sections marked `Planned (#N):`, where #N
             is the plan issue building them.

Right-size this spec: keep the parts the project needs and delete the rest. A
small tool's spec can fit on a page. How to write and use it:
docs/spec-driven-development.md. -->

The source of truth for **what to build**. Written in the present tense: it
describes the system as it is on `main`, except where marked `Planned`. Its
history is in git (`git log -- SPEC.md`), not in this file.

## Purpose & non-goals

<!-- TEMPLATE: what the project is and who it's for, in a paragraph. Then the
non-goals — what it deliberately isn't, and the tempting work that's out of
scope. -->

{{PROJECT_PURPOSE}}

**Non-goals:**

- …

## Invariants

These hold for every change. A change that breaks one is wrong even if CI is
green.

<!-- TEMPLATE: 3–7 timeless, testable rules. The test or lint rule that
enforces each one names its ID. -->

- **`INV-1` — {{INVARIANT_NAME}}.** {{INVARIANT}}

## Concepts

<!-- TEMPLATE: the core nouns, each defined once. -->

| Term | Meaning |
|---|---|
| | |

## Architecture

<!-- TEMPLATE: the components, what each owns, and the boundaries between them.
A diagram or tree beats prose. -->

## Interfaces

<!-- TEMPLATE: every surface other code or people depend on — types, APIs,
file formats, CLI — precise enough to test against. Mark each surface that is
versioned (docs/workflow.md "Versioned surfaces"). -->

## Behavior

<!-- TEMPLATE: rules, state transitions, and error cases, at the precision a
test can be written from. When a rule needs a `Why:` line, see
docs/spec-driven-development.md "Writing it". -->

## Quality bars

<!-- TEMPLATE: budgets as numbers — latency, size, supported platforms,
security posture. -->

## Open questions

Undecided, and **not contract** — don't build against these; resolve one by
editing the spec, then delete it here.

- None yet.
