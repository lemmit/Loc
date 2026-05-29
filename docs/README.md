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
| [`capabilities.md`](capabilities.md) | `filter`, `stamp`, `implements` — cross-aggregate behaviours like soft-delete and audit. |
| [`scaffold-macros.md`](scaffold-macros.md) | The `scaffold`, `crudish`, `audit`, and `softDelete` macros — what they expand to. |
| [`provenance.md`](provenance.md) | `provenanced` field modifier, the `ddd snapshot` capture step, and the Hono runtime trace SDK. |
| [`observability.md`](observability.md) | The catalog envelope, per-backend log emission, the catalog extension surface. |
| [`traceability.md`](traceability.md) | `requirement` / `solution` / `testCase` artefacts and the generated coverage report. |
| [`conformance.md`](conformance.md) | The cross-generator OpenAPI parity harness — the nine dimensions, strict vs report-only mode. |

## Platforms, packs, stacks

| Doc | When to read |
| --- | --- |
| [`platforms.md`](platforms.md) | You want to know which `platform:` values exist, how `family@version` pins resolve, and what the `PlatformSurface` contract is. |
| [`design-packs.md`](design-packs.md) | You're authoring a design pack (Mantine / shadcn / MUI / Chakra / ashPhoenix). Covers manifest, stacks (v1/v2/v3 framework baselines), required emits, template language, validation, and the recipe for adding a new pack version. |

## Internals

| Doc | When to read |
| --- | --- |
| [`technical.md`](technical.md) | The canonical pipeline reference — the ten phases from `.ddd` to disk.  Read this before extending the language or adding a backend. |
| [`macro-api.md`](macro-api.md) | You're authoring a macro (stdlib or project-local).  Covers `defineMacro`, parameter types, the factory surface, composability rules. |
| [`loom-artifacts.md`](loom-artifacts.md) | The `.loom/` output directory — wire-spec, mermaid + C4 diagrams, traceability files, verification, snapshots.  What each artefact is and which CLI command produces it. |

## Operational / legal

| Doc | When to read |
| --- | --- |
| [`license-faq.md`](license-faq.md) | "Is it OK to use Loom in production?", what counts as Competing Use, generator vs. generated-code licensing. |

## Subdirectories

- [`architecture/`](architecture/) — cross-cutting design specs shared by several proposals (`RequestContext`, wire envelope, modifier propagation, diagnostic catalog, CLI surface, fixture re-baseline).  Pin shapes that multiple features consume; back the `D-*` decisions in [`decisions.md`](decisions.md).
- [`plans/`](plans/) — implementation plans, roadmaps, and design notes for in-flight or future work.  Not authoritative for what ships today; treat as historical context.
- [`audits/`](audits/) — empirical audits of shipped state (pack equivalence, stack version pins).  Snapshot-in-time documents.
- `proposals/` — formal proposals not yet adopted.  Aspirational; do not treat as describing the shipped system.  **Not deployed** to the published docs site; browse on [GitHub](https://github.com/lemmit/Loc/tree/main/docs/proposals).
- [`decisions.md`](decisions.md) — pinned cross-proposal decisions (the `D-*` tags).  The binding answer when a proposal cites a tag.

## See also

- [`../experience_gathered.md`](../experience_gathered.md) — running retrospective of design choices, language and IR gotchas, and lessons learned across iterations.  Worth a read before non-trivial changes.
- [`../CLAUDE.md`](../CLAUDE.md) — short orientation for automated agents; mirrors the structure above.
