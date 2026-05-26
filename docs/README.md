# Loom — documentation index

This directory holds the reference and technical docs for Loom.  The
files are organised by audience, not by alphabetical order; pick the
section that matches what you need.

## Start here

| Doc | When to read |
| --- | --- |
| [`language.md`](language.md) | You're writing or reading `.ddd` source.  Declarations, types, expressions, statements, validation rules. |
| [`page-metamodel.md`](page-metamodel.md) | You're writing `ui` / `page` / `component` blocks. |
| [`architecture.md`](architecture.md) | You want to know how `module`, `deployable`, `api`, `storage`, and `ui` compose into a runnable system. |
| [`tools.md`](tools.md) | You're using the `ddd` CLI, `.loomignore`, watch mode, the docker workflow, or the OpenAPI parity check. |
| [`generators.md`](generators.md) | You want to know exactly what each backend (Hono, .NET, React, Phoenix LiveView) emits for a given DSL construct. |

## Per-feature references

These cover a single language feature each.  Each one is self-contained.

| Doc | Feature |
| --- | --- |
| [`auth.md`](auth.md) | `user` block, `auth: required`, `currentUser`, `requires`, row-level permissions. |
| [`views.md`](views.md) | `view` declarations, joined ("snowflake") views via `X id` follows. |
| [`workflow.md`](workflow.md) | `workflow` blocks, transactional vs non-transactional, isolation levels, event drain semantics. |
| [`extern.md`](extern.md) | `extern` operations and their per-backend handler registries. |
| [`observability.md`](observability.md) | The catalog envelope, per-backend log emission, the catalog extension surface. |
| [`traceability.md`](traceability.md) | `requirement` / `solution` / `testCase` artefacts and the generated coverage report. |
| [`conformance.md`](conformance.md) | The cross-generator OpenAPI parity harness — the nine dimensions, strict vs report-only mode. |
| [`migrations-design.md`](migrations-design.md) | The migrations IR, snapshot diffing, per-backend emission. |

## Platforms, packs, stacks

| Doc | When to read |
| --- | --- |
| [`design-system-packs.md`](design-system-packs.md) | You're authoring a design pack (Mantine / shadcn / MUI / Chakra / ashPhoenix). Covers manifest, required emits, template language, stacks, adding a version. |
| [`stack-versioning.md`](stack-versioning.md) | You want to know what a "stack" is and how packs declare one. *(Note: most of this is being absorbed into `design-system-packs.md`.)* |
| [`adding-a-pack-version.md`](adding-a-pack-version.md) | Step-by-step recipe to fork a pack and add a new version. |

## Internals

| Doc | When to read |
| --- | --- |
| [`technical.md`](technical.md) | The canonical pipeline reference — the ten phases from `.ddd` to disk.  Read this before extending the language or adding a backend. |

## Operational / legal

| Doc | When to read |
| --- | --- |
| [`license-faq.md`](license-faq.md) | "Is it OK to use Loom in production?", what counts as Competing Use, generator vs. generated-code licensing. |

## Subdirectories

- [`plans/`](plans/) — implementation plans, roadmaps, and design notes for in-flight or future work.  Not authoritative for what ships today; treat as historical context.
- [`audits/`](audits/) — empirical audits of shipped state (pack equivalence, stack version pins).  Snapshot-in-time documents.
- [`proposals/`](proposals/) — formal proposals not yet adopted.  Aspirational; do not treat as describing the shipped system.

## See also

- [`../experience_gathered.md`](../experience_gathered.md) — running retrospective of design choices, language and IR gotchas, and lessons learned across iterations.  Worth a read before non-trivial changes.
- [`../CLAUDE.md`](../CLAUDE.md) — short orientation for automated agents; mirrors the structure above.
