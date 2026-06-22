# 19. Requirements & traceability

> **Grammar:** `Requirement`, `Solution`, `TestCase`, `verifies`/`covers` · **Validators:** traceability graph checks · **Docs:** [`../traceability.md`](../traceability.md)

The traceability artefacts: `requirement` work items with a parent hierarchy, `solution` design rationale that `entitles` symbols, `testCase` that `covers` symbols and is `verifies`-linked from tests, and the `ddd verify` rollup.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`requirement`** — UserStory/UseCase/AcceptanceCriteria/BusinessReq; `parent`; ticket-style IDs.
- **`solution`** — design rationale `for` a requirement; `entitles [symbols]`.
- **`testCase`** — verification `verifies` a requirement; `covers [symbols]`.
- **`verifies` from tests** — `test "…" verifies TC-001` execution link.
- **`ddd verify`** — join results onto the graph → per-requirement DoD verdict; the emitted report.
