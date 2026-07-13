# M-T9.2 design brief — the persistence-emit seam (`PersistenceTarget`)

*Kickoff brief for the implementing agent. This mission is **design-first**: the first deliverable is a divergence audit + seam design for maintainer sign-off, not code. Read this whole brief, then follow [`../RUNBOOK.md`](../RUNBOOK.md).*

## Problem — the last un-abstracted N

Every language feature that touches storage re-lands by hand on five backends. The per-backend `emit/` sets are the largest duplicated surface in the repo (files: elixir ~70, dotnet ~61, java ~51, python ~37, typescript ~32; ~100k LOC combined), and the recurring fragment families are visibly parallel — `ids`, `enums-vos`, `events`, `dto`, `entity`/`schema`, `repository`, `migrations` glue, `seed`, `api`/`routes`, `domain-service`, `audit`, `provenance`, `request-context` appear in almost every backend's inventory. Benchmark cost: part-in-part containment (#1835) touched **36 files across 4 backends** for one storage feature. Gating is weakest exactly here (compile-only per-PR). Until this seam exists, **T10 (new targets) is frozen** — a sixth backend would re-buy the whole surface.

## Prior art in this repo — imitate, don't invent

The repo has already solved this problem three times on other axes; the seam must follow the same shape:

| Seam | What's shared | What stays per-backend | Lesson |
|---|---|---|---|
| `ExprTarget` (`src/generator/_expr/target.ts`) | the 17-arm `ExprIR` dispatch + all recursion | a leaf table of formatters per backend | exhaustive-switch + interface makes a new backend/kind a compile error until filled |
| `WalkerTarget` (`src/generator/_walker/`) | `walkBody` core, primitive registry | framework seams (state syntax, imports, navigation) | **HEEx declined the shared core** — LiveView's output topology diverges; a conformance shim was the honest outcome |
| `WorkflowStmtTarget` (workflow-choreographer-seam) | statement-sequence dispatch | envelope hooks (transaction/dispatch/saves) | **Elixir declined by design** — its `with`-chain reorders statements; the pre-registered "compose-mode leakage" criterion fired and the extraction stopped there |
| `MigrationsIR` + `sql-pg.ts` | the entire schema-DDL decision tree | per-backend migration file framing | proof that the *persistence* domain itself already shares one decision tree |
| `_stmt/leaves.ts`, `_payload/`, `_obs/`, `_frontend/` | smaller shared decision trees | rendering | the `_`-dir convention for cross-backend homes |

The two *declines* above are as important as the successes: this mission's success criterion is NOT "everything shared" — it's "every regular-shaped fragment shared, every divergent one *deliberately* per-backend with the reason recorded."

## Hard constraints

1. **No target-backend IR.** The pipeline principle (CLAUDE.md §Architecture) stands: backends consume `LoomModel` directly; `MigrationsIR` stays the only secondary IR. The seam is a *dispatch + leaf-table* pattern over the existing IR, not a new intermediate representation.
2. **Byte-identical extraction.** Every slice must produce byte-identical generated output, gated by the fixture suite — the exact protocol the walker extraction used (PRs #607–#627) and the `render-expr` unification used (#843). No behavior change rides along with an extraction slice, ever.
3. **Pinned decisions:** [D-ADAPTER-HOME](../../decisions.md) (persistence/layout adapters live on the backend surface), [D-BACKEND-PKG](../../decisions.md) (per-version backend packages are canonical — the seam must work for `packages/backend-hono-v5/` too, so it lives where both in-tree and packaged backends can import it: `src/generator/_persistence/` or a sibling), D-REALIZATION-AXES (only `persistence:` and `directoryLayout:` are live axes — do not resurrect removed ones). While here, wire the orphaned `resolvePersistence()` (`src/platform/resolve-adapters.ts:102`, currently uninvoked — M-T6.10) or fold its removal into the design.
4. **Layering:** the shared home obeys `test/platform/pipeline-layering.test.ts` and `backend-packages-layering.test.ts` — a shared helper lives at the layer its consumers live at.

## Phase 1 (the deliverable to sign off): divergence audit

Build the fragment × backend matrix before proposing any contract. For each fragment family — id types, VO/enum classes, event types, wire DTOs, entity/schema definitions, repository CRUD verbs, custom finds/criteria application, capability filter/stamp injection, association/join handling, document/embedded shape handling, seed, routes/controllers, DI/bootstrap — record per backend:

- **already-shared** (e.g. schema DDL via `MigrationsIR`; wire shape via `wireShape`; expression rendering via `ExprTarget`),
- **regular-shaped** (same decision tree, different surface syntax → seam candidate; cite the parallel file pairs, e.g. `dotnet/emit/repository.ts` vs `java/emit/repository.ts` vs `typescript/repository-*-builder.ts`),
- **shape-divergent** (different topology, e.g. EF fluent configs vs Ecto schemas + changesets vs Drizzle tables + Zod; Elixir's `with`-chain contexts) → stays per-backend, reason recorded.

Pre-register the decline criterion (the workflow-seam discipline): if sharing a fragment requires the shared core to know per-backend *composition order or grouping*, the fragment is divergent — don't force it.

## Phase 2: seam design (contract sketch + slicing plan)

Expected shape (to be validated by Phase 1, not assumed): a shared decision tree in `src/generator/_persistence/` dispatching per fragment kind, with one leaf table per backend (`TS_PERSISTENCE` / `CS_PERSISTENCE` / …) supplying naming, type mapping (reuse `lower-types`/`sql-pg` mappings where they exist), and syntax framing. Candidate extraction order, easiest-first with the highest feature-traffic:

1. **Repository CRUD verbs** (save/getById/findAll/delete + filter/stamp injection points) — the highest feature-traffic fragment (versioned, tenancy, softDelete, part-in-part all landed here N times).
2. **Entity/schema field mapping** — adjacent to `MigrationsIR`'s existing shared tree; likely the cheapest win.
3. **Wire DTO emission** — already semantically shared via `wireShape`; only syntax framing differs.
4. **Routes/controllers** — verify regularity; the api-derivation work (`commandHandler`/`route`) may already be reshaping this surface — coordinate with M-T5.10.

Each slice: one fragment × one backend at a time, byte-identical gate, then the next backend. Elixir last, with the decline option explicitly open.

## Non-goals

No new features during extraction; no forcing HEEx/Elixir topology; no touching the design-pack (`.hbs`) axis (that's a different seam); no output-tree changes (that's per-package-output-tree, deferred).

## Acceptance (for the epic, measured on the retro benchmark)

Re-run the part-in-part scenario mentally after the seam: a comparable storage feature should land as **shared-tree edits + ≤1 leaf-file edit per backend + tests**, instead of 36 files across 4 backends. Interim acceptance per slice: byte-identical fixtures, all per-backend compile gates green, layering tests green. Update this brief + the M-T9.2 status line as slices land.
