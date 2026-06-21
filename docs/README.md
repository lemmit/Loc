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
| [`generators.md`](generators.md) | You want to know exactly what each backend (Hono, .NET, Phoenix LiveView, Java, Python) or frontend (React, Vue, Svelte, Angular) emits for a given DSL construct. |
| [`kubernetes.md`](kubernetes.md) | You want to deploy the generated system to a cluster — the opt-in `generate system --k8s` Helm chart + raw manifests. |

## Per-feature references

These cover a single language feature each.  Each one is self-contained.

| Doc | Feature |
| --- | --- |
| [`auth.md`](auth.md) | `user` block, `auth: required`, `currentUser`, `requires`, row-level permissions. |
| [`views.md`](views.md) | `view` declarations, joined ("snowflake") views via `X id` follows. |
| [`payloads.md`](payloads.md) | `payload` / `command` / `query` / `response` / `error` records, the generic carriers `paged` / `envelope`, and discriminated unions (`A or B`, `payload Foo = A \| B`, `T option`) with their tagged `type` wire. |
| [`inheritance.md`](inheritance.md) | `abstract aggregate`, `extends`, `inheritanceUsing(sharedTable \| ownTable)` — TPC (all backends) vs TPH (Hono only), and the polymorphic `find all <Base>` reader. |
| [`workflow.md`](workflow.md) | `workflow` blocks, transactional vs non-transactional, isolation levels, event drain semantics. |
| [`resources.md`](resources.md) | `storage` / `resource`, source types, the `objectStore` / `queue` / `api` kinds, the `config` map, and workflow-level resource consumption (`files.put`, `jobs.enqueue`, `rates.get`). |
| [`extern.md`](extern.md) | `extern` operations and their per-backend handler registries. |
| [`capabilities.md`](capabilities.md) | `filter`, `stamp`, `implements` — cross-aggregate behaviours like soft-delete and audit. |
| [`domain-services.md`](domain-services.md) | `domainService` — stateless cross-aggregate pure calculators, the no-infra contract, and per-backend emission. |
| [`scaffold-macros.md`](scaffold-macros.md) | The `scaffold`, `crudish`, `audit`, and `softDelete` macros — what they expand to. |
| [`provenance.md`](provenance.md) | `provenanced` field modifier, the `ddd snapshot` capture step, and the Hono runtime trace SDK. |
| [`observability.md`](observability.md) | The catalog envelope, per-backend log emission, the catalog extension surface. |
| [`traceability.md`](traceability.md) | `requirement` / `solution` / `testCase` artefacts and the generated coverage report. |
| [`conformance.md`](conformance.md) | The cross-generator OpenAPI parity harness — the nine dimensions, strict vs report-only mode. |

## Platforms, packs, stacks

| Doc | When to read |
| --- | --- |
| [`platforms.md`](platforms.md) | You want to know which `platform:` values exist, how `family@version` pins resolve, and what the `PlatformSurface` contract is. |
| [`design-packs.md`](design-packs.md) | You're authoring a design pack (Mantine / shadcn / MUI / Chakra / Vuetify / shadcnVue / shadcnSvelte / flowbite / angularMaterial / ashPhoenix). Covers manifest, stacks (v1/v2/v3 framework baselines), required emits, template language, validation, and the recipe for adding a new pack version. |

## Internals

| Doc | When to read |
| --- | --- |
| [`technical.md`](technical.md) | The canonical pipeline reference — the ten phases from `.ddd` to disk.  Read this before extending the language or adding a backend. |
| [`testing.md`](testing.md) | The test-tier placement guide — given a change, which tier proves it and where a new test belongs (fast vitest vs behavioral api/unit/ui vs per-backend build vs conformance vs playground e2e). |
| [`macro-api.md`](macro-api.md) | You're authoring a macro (stdlib or project-local).  Covers `defineMacro`, parameter types, the factory surface, composability rules. |
| [`loom-artifacts.md`](loom-artifacts.md) | The `.loom/` output directory — wire-spec, mermaid + C4 diagrams, traceability files, verification, snapshots.  What each artefact is and which CLI command produces it. |

## Operational / legal

| Doc | When to read |
| --- | --- |
| [`license-faq.md`](license-faq.md) | "Is it OK to use Loom in production?", what counts as Competing Use, generator vs. generated-code licensing. |

## Subdirectories

- [`architecture/`](architecture/) — cross-cutting design specs shared by several proposals (`RequestContext`, wire envelope, modifier propagation, diagnostic catalog, CLI surface, fixture re-baseline).  Pin shapes that multiple features consume; back the `D-*` decisions in [`decisions.md`](decisions.md).
- [`plans/`](plans/) — implementation plans, roadmaps, and design notes for in-flight or future work.  Not authoritative for what ships today; treat as historical context.  Start with [`plans/debt-prioritized-backlog.md`](plans/debt-prioritized-backlog.md) — the ranked list of every reserved stub, parity gap, and TODO, worked through top-down.
- [`audits/`](audits/) — empirical audits of shipped state (pack equivalence, stack version pins).  Snapshot-in-time documents.
- `proposals/` — formal proposals not yet adopted.  Aspirational; do not treat as describing the shipped system.  **Not deployed** to the published docs site; browse on [GitHub](https://github.com/lemmit/Loc/tree/main/docs/proposals).
- [`decisions.md`](decisions.md) — pinned cross-proposal decisions (the `D-*` tags).  The binding answer when a proposal cites a tag.

## See also

- [`../experience_gathered.md`](../experience_gathered.md) — running retrospective of design choices, language and IR gotchas, and lessons learned across iterations.  Worth a read before non-trivial changes.
- [`../CLAUDE.md`](../CLAUDE.md) — short orientation for automated agents; mirrors the structure above.
