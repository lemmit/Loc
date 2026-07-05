# Loom — documentation index

This directory holds the reference and technical docs for Loom.  The
files are organised by audience, not by alphabetical order; pick the
section that matches what you need.

## Start here

| Doc | When to read |
| --- | --- |
| [`language-reference/`](language-reference/README.md) | **The complete language reference** — every feature, one chapter at a time, each with the `.ddd` source *and* its real generated output in per-platform tabs. Start here when you want the exhaustive surface. |
| [`language.md`](language.md) | You're writing or reading `.ddd` source.  Declarations, types, expressions, statements, validation rules. |
| [`page-metamodel.md`](page-metamodel.md) | You're writing `ui` / `page` / `component` blocks. |
| [`architecture.md`](architecture.md) | You want to know how `module`, `deployable`, `api`, `storage`, and `ui` compose into a runnable system. |
| [`tools.md`](tools.md) | You're using the `ddd` CLI (`generate`, `verify`, `snapshot`, `patch`, `trace`), `.loomignore`, watch mode, the docker workflow, or the OpenAPI parity check. |
| [`generators.md`](generators.md) | You want to know exactly what each backend (Hono, .NET, Phoenix LiveView, Java, Python) or frontend (React, Vue, Svelte, Angular) emits for a given DSL construct. |
| [`kubernetes.md`](kubernetes.md) | You want to deploy the generated system to a cluster — the opt-in `generate system --k8s` Helm chart + raw manifests. |
| [`playground.md`](playground.md) | You want to know what the browser playground is — the typed editor, visual builders, live preview, and in-browser PGlite test runner at lemmit.github.io/Loc/playground. |

## Per-feature references

These cover a single language feature each.  Each one is self-contained.

| Doc | Feature |
| --- | --- |
| [`actions.md`](actions.md) | Page/component `action`s — named handlers, `match await` on a remote command, single- and multi-error-variant handling. |
| [`auth.md`](auth.md) | `user` block, `auth: required`, `currentUser`, `requires`, row-level permissions. |
| [`views.md`](views.md) | `view` declarations, joined ("snowflake") views via `X id` follows. |
| [`payloads.md`](payloads.md) | `payload` / `command` / `query` / `response` / `error` records, the generic carriers `paged` / `envelope`, and discriminated unions (`A or B`, `payload Foo = A \| B`, `T option`) with their tagged `type` wire. |
| [`inheritance.md`](inheritance.md) | `abstract aggregate`, `extends`, `inheritanceUsing(sharedTable \| ownTable)` — TPC (all backends) vs TPH (Hono only), and the polymorphic `find all <Base>` reader. |
| [`workflow.md`](workflow.md) | `workflow` blocks, transactional vs non-transactional, isolation levels, event drain semantics. |
| [`resources.md`](resources.md) | `storage` / `resource`, source types, the `objectStore` / `queue` / `api` kinds, the `config` map, and workflow-level resource consumption (`files.put`, `jobs.enqueue`, `rates.get`). |
| [`extern.md`](extern.md) | `extern` operations and their per-backend handler registries. |
| [`criterion.md`](criterion.md) | `criterion` — reusable named predicate specifications, shared across queries, validation, and permissions. |
| [`capabilities.md`](capabilities.md) | `filter`, `stamp`, `implements` — cross-aggregate behaviours like soft-delete, audit, tenant-ownership, and optimistic concurrency (`versioned`). |
| [`tenancy.md`](tenancy.md) | Multi-tenancy — `tenancy by user.<claim> of <Registry>`, the `tenantOwned` capability, `crossTenant`, and the explicit-stance rule. |
| [`domain-services.md`](domain-services.md) | `domainService` — stateless cross-aggregate pure calculators, the no-infra contract, and per-backend emission. |
| [`scaffold-macros.md`](scaffold-macros.md) | The `scaffold`, `crudish`, `audit`, and `softDelete` macros — what they expand to. |
| [`provenance.md`](provenance.md) | `provenanced` field modifier, the `ddd snapshot` capture step, and the Hono runtime trace SDK. |
| [`observability.md`](observability.md) | The catalog envelope, per-backend log emission, the catalog extension surface. |
| [`traceability.md`](traceability.md) | `requirement` / `solution` / `testCase` artefacts and the generated coverage report. |
| [`conformance.md`](conformance.md) | The cross-generator OpenAPI parity harness — the nine dimensions, strict vs report-only mode (the **structural** wire contract). |
| [`conformance-semantics.md`](conformance-semantics.md) | The **runtime-value** contract the spec-diff is blind to — named RS-rules (camelCase keys, enum casing, no leaked timestamps, association round-trip) seeded from the #1620–#1660 wire-parity sweep. |
| [`migrations.md`](migrations.md) | `MigrationsIR` — the phase-⑨ schema-delta IR derived once and shared by every DB backend: how IR maps to tables/columns/join-tables, `migrationsOwner`, the shared Postgres SQL renderer, and where each backend applies migrations. |
| [`verify.md`](verify.md) | The `ddd verify` gate — joins a test-results JSON onto the requirements graph for per-requirement Definition-of-Done verdicts (VERIFIED / FAILING / UNVERIFIED / UNTESTED); CLI flags, `results.json` contract, and the emitted `.loom/verification.*`. |

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
| [`loom-artifacts.md`](loom-artifacts.md) | The `.loom/` output directory — wire-spec, mermaid + C4 diagrams, traceability files, verification, snapshots, and the opt-in `sourcemap.json` (`ddd trace`).  What each artefact is and which CLI command produces it. |
| [`api-toolkit.md`](api-toolkit.md) | The transport-neutral `src/api/` toolkit (`validate` / `generate` / `outline` / `applyPatches` + nav/refactor) and the `src/diagnostics/contract.ts` wire shapes — one browser-safe core behind the CLI, MCP, LSP, and playground. |
| [`mcp.md`](mcp.md) | The MCP stdio server (`ddd-mcp`) + the transport-neutral `loom_*` agent-tool catalog — the three-layer tools/api/mcp stack and how to wire it into an MCP host. |

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
