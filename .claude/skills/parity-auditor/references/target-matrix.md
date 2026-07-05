# Target matrix — the registry→matrix map and per-axis gate index

The roster every parity audit is built on, derived from the live registry, plus a
per-feature-axis index pointing at the authoritative validator gate set for each
row. **Always re-read the cited files on fresh `main` — this doc is a map, not the
source of truth. The gate sets move; the line numbers especially drift.**

## Contents
- [1. The target roster (from the registry)](#1-the-target-roster-from-the-registry)
- [2. The corpus backend keys (the test matrix)](#2-the-corpus-backend-keys-the-test-matrix)
- [3. Where the gates live](#3-where-the-gates-live)
- [4. Per-axis gate index — backends](#4-per-axis-gate-index--backends)
- [5. Per-axis gate index — frontends](#5-per-axis-gate-index--frontends)
- [6. The reserved-but-unwired hooks](#6-the-reserved-but-unwired-hooks)

---

## 1. The target roster (from the registry)

The single source of truth is `src/platform/registry.ts` — the `platforms`
`Record<Platform, PlatformSurface>` map and the `inTreeBackends`
`DiscoveredBackend[]` array (backends resolve by `family@version`, so the set can
grow via packages under `packages/backend-*`). `src/platform/surface.ts` defines
the `PlatformDescriptor` fields each carries (`needsDb` / `mountsUi` / `isFrontend`
/ `hostableFrameworks` / `reservedRepositoryFindNames`).

**Backends (domain-logic, 5 families):**

| Family | `platform:` id | Versions registered | Stack |
|---|---|---|---|
| Hono / TS | `node` | `node@v5` (default, zod4/TS6) + `node@v4` (zod3/TS5, pinnable) | Hono + Drizzle |
| .NET | `dotnet` | `dotnet@v10` | ASP.NET + EF Core + Mediator |
| Java | `java` | `java@v1` | Spring Boot + Spring Data JPA |
| Python | `python` | `python@v1` | FastAPI + SQLAlchemy 2 |
| Phoenix | `elixir` | `elixir@v1` | LiveView + **vanilla** Ecto (the only foundation) |

`node` is the only **versioned-package** backend (`src/platform/hono/vN/`); the
other four are thin `src/platform/<name>.ts` surfaces over
`src/generator/<name>/`. The legacy `phoenix`/`phoenixLiveView` and `fastapi`
aliases were retired — `elixir` and `python` are the only spellings.

**The elixir backend is single-foundation.** `elixir` generates on plain Ecto/
Phoenix — the **vanilla** foundation, the only one (the Ash foundation was removed,
#1568; `foundation: ash` is now a hard validation error). So the `elixir` column is
a single cell, not a foundation split — features like event-sourcing,
`shape(document)`, and provenance ship on the vanilla backend.

**Frontends (4 + the HEEx path):**

| Frontend | `platform:` | Generator | Walker target | Default pack |
|---|---|---|---|---|
| React | `react` (+ `static` alias) | `src/generator/react/` | `tsxTarget` | `mantine` |
| Vue | `vue` | `src/generator/vue/` | `vueTarget` | `vuetify` |
| Svelte | `svelte` | `src/generator/svelte/` | `svelteTarget` | `shadcnSvelte` |
| Angular | `angular` | `src/generator/angular/` | `angularTarget` | `angularMaterial` |
| Phoenix HEEx | `elixir` (LiveView render path) | `src/generator/elixir/` | `heexTarget` (parallel core) | `ashPhoenix` |

The four JSX/markup frontends share one walker core
(`src/generator/_walker/walker-core.ts`, `walkBody`). **Phoenix HEEx does NOT use
`walkBody`** — it runs a parallel engine (`heex-walker-core.ts`) because LiveView's
output topology diverges; it dispatches off the *same* `WALKER_PRIMITIVES` table,
so there's no second primitive list to drift.

`static` shares the React surface (it's React's UI-only deployable alias).

## 2. The corpus backend keys (the test matrix)

`test/fixtures/corpus/backends.ts` is the canonical machine-readable key set the
compile/generation tiers iterate — reuse it instead of hand-listing:

```ts
BACKENDS = ["node", "dotnet", "java", "python", "vanilla"]
PLATFORM_CLAUSE = {
  node: "node", dotnet: "dotnet", java: "java", python: "python",
  vanilla: "elixir { foundation: vanilla }",   // <- the sole elixir foundation
}
```

So the corpus encodes the elixir backend as a single `vanilla` column. A
platform-agnostic corpus `.ddd` writes `platform: __PLATFORM__`; the harness swaps
the token (see `references/silent-vs-honest-gap.md` §run-it for the harness API).

## 3. Where the gates live

The validator is the contract. The two files that hold the cross-backend gate sets:

- **`src/ir/validate/checks/system-checks.ts`** — the bulk: persistence,
  inheritance, capability filters, provenance, audit, event-sourcing.
- **`src/ir/validate/checks/structural-checks.ts`** — payload/query surface:
  unions, generic carriers, the `when` gate, exception-less returns.
- **`src/util/platform-axes.ts`** — `PLATFORM_SAVING_SHAPES` (the `shape(…)`
  capability map), read by both the validator and the generator persistence
  adapters.

Each gate is a `const FOO_BACKENDS = new Set([...])` (or `Partial<Record<Platform,
…>>`) literal, consulted by a `validate…Support` / `validate…Backend` fn that's
wired into `validateLoomModel` in **`src/ir/validate/validate.ts`**. To re-derive
the whole index on fresh main:

```
rg -n "_BACKENDS|_CAPABLE|_FAMILIES|new Set\(\[" \
   src/ir/validate/checks/system-checks.ts src/ir/validate/checks/structural-checks.ts
rg -n "validate\w+Support|validate\w+Backend" src/ir/validate/validate.ts
```

## 4. Per-axis gate index — backends

Each row: the feature axis → the named gate set + the file it lives in. **Read the
current set membership; do not trust the example membership below — it is a
fresh-main snapshot that will drift.** (Snapshot taken against the lines cited; the
backend audit doc `docs/audits/backend-feature-parity-2026-06.md` is the fuller
prose version of this table.)

| Feature axis | Gate set / fn | File | Diagnostic code |
|---|---|---|---|
| Event-sourced storage `persistedAs(eventLog)` | `EVENT_SOURCING_BACKENDS` (+ elixir branch) | `system-checks.ts` | `loom.event-sourcing-backend-unsupported` |
| Event-sourced **workflow** (saga appliers) | `EVENT_SOURCING_WORKFLOW_BACKENDS` | `system-checks.ts` | `loom.*-unsupported` |
| TPH inheritance `inheritanceUsing(sharedTable)` | `TPH_CAPABLE` | `system-checks.ts` | TPH gate |
| TPC inheritance `inheritanceUsing(ownTable)` | (universal — no gate) | — | — |
| `shape(document)` / `shape(embedded)` | `PLATFORM_SAVING_SHAPES` → `validateSavingShapeSupport` | `platform-axes.ts` / `system-checks.ts` | saving-shape gate |
| Discriminated unions (`A or B` / `T option`) | `SUPPORTED_UNION_BACKENDS` | `structural-checks.ts` | union gate |
| Generic carriers (`paged<T>`, `envelope<T>`) | `SUPPORTED_PAGED_BACKENDS` | `structural-checks.ts` | carrier gate |
| `when` canCommand gate + `can_<op>` query | `SUPPORTED_WHEN_BACKENDS` | `structural-checks.ts` | `when` gate |
| Exception-less returns (`op(): X or NotFound`) | `SUPPORTED_RETURN_BACKENDS` | `structural-checks.ts` | return gate |
| Capability `filter` (relational / principal / non-relational) | `LIMITED_FAMILIES` → `validateContextFilterSupport` | `system-checks.ts` | `loom.context-filter-unsupported` |
| Provenanced fields | `PROVENANCE_BACKENDS` (+ elixir branch) | `system-checks.ts` | provenance gate |
| Per-operation `audited` | `AUDIT_OP_BACKENDS` | `system-checks.ts` | `loom.audited-backend-unsupported` |
| Audited **lifecycle** (`audited create`/`destroy`) | `AUDIT_LIFECYCLE_BACKENDS` | `system-checks.ts` | audit-lifecycle gate |

**Watch for the elixir capability branch.** Several gates read
`FOO_BACKENDS.has(p) || (p === "elixir" && elixirFooCapable)` — a separate elixir
branch. With a single foundation this resolves to one `✓ elixir` / `✗ elixir` cell
(no `ash`/`vanilla` split). Read the actual `||` clause, don't assume.

**Watch for the silent-gap pattern.** A target *absent* from a `LIMITED_FAMILIES`
/ `FOO_BACKENDS` set is only honest if the emitter also errors. The historical 🔴
(backend audit Finding F1) was Python absent from `LIMITED_FAMILIES` *and* the
Python generator never consuming `contextFilters` → silent correctness hole. On
fresh main that one is fixed (`python` is now in the set), which is itself the
proof that you must re-read, not trust the doc.

## 5. Per-axis gate index — frontends

Frontend parity is enforced (or not) at four layers — audit them in this order
(per `docs/audits/frontend-parity-audit-2026-06.md` §Method):

1. **Validator surface** — `src/language/walker-stdlib.ts` (the closed set of page
   primitives the validator accepts; a page that type-checks here is legal against
   *any* target). Pinned by `walker-stdlib-completeness.test.ts`.
2. **Walker-target contract** — `src/generator/_walker/target.ts` (`WalkerTarget`:
   the required + optional framework-shaped seams). A frontend reaches parity by
   implementing the required seams; optional seams are *intended* idiom divergence
   (e.g. Angular forks all forms into Reactive Forms), not gaps.
3. **Primitive dispatch table** — `src/generator/_walker/registry.ts`
   (`WALKER_PRIMITIVES`): each primitive carries a `tsx` renderer and *optionally*
   a `heex` one. `heex-parity.test.ts` freezes the TSX-only set.
4. **Pack required-set gate** — `src/generator/_packs/required-primitives.ts`
   (`RequiredSet` per format + `TSX_ONLY_PRIMITIVES`): the load-time check that a
   pack ships every template its format needs.

The classic frontend **silent gap** is a *seam between layers 1 and 4*: a primitive
the validator accepts (layer 1) that's absent from a pack's `RequiredSet` (layer 4)
and whose `tsx` emitter calls `pack.render(...)` with no `templates.has` guard —
so it passes validation but **crashes codegen** on the pack that lacks the
template. The `Section`/`Sticky` finding (frontend audit Finding 1) is the
canonical example; the fix is to ship the `.hbs` + add the name to the
`RequiredSet`/`TSX_ONLY_PRIMITIVES` so the load-time gate names the pack instead of
crashing mid-generation.

The design-pack roster (for "which pack on which frontend" rows):
`designs/<pack>/` — React: `mantine`/`shadcn`/`mui`/`chakra`; Vue:
`vuetify`/`shadcnVue`; Svelte: `shadcnSvelte`/`flowbite`; Angular:
`angularMaterial`; Phoenix HEEx: `ashPhoenix`. (`primeng`/`spartanNg` are grammar-
reserved but unshipped — a maturity gap, not a correctness bug.)

## 6. The reserved-but-unwired hooks

`PlatformSurface` (`src/platform/surface.ts`) declares five **optional** lifecycle
hooks that are **undefined on every backend today** — designed boundaries with no
implementation. They are not parity gaps in the silent/honest sense (nothing reads
them, so nothing mis-emits); they're future cross-cutting concerns. Note them as
N/A-pending, with the owning proposal:

- `emitAuthGate` → `docs/proposals/authorization.md`
- `emitAuditInit` → `docs/proposals/audit-and-logging.md`
- `emitCompliancePolicy` → `docs/proposals/sensitivity-and-compliance.md`
- `emitTenancyFilter` → `docs/proposals/multi-tenancy-design-note.md`
- `emitI18nAdapter` → `docs/proposals/i18n.md`
