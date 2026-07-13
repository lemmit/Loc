# Realization-axes implementation alignment — closing the gap to D-REALIZATION-AXES

> Status: **plan** (implementation-gap audit + phased convergence). This doc
> introduces **no new design**: the target is the already-**PINNED**
> **D-REALIZATION-AXES** (`docs/decisions.md`) and its spec
> `proposals/platform-realization-axes.md`. Where a naming or scope question
> arises, this plan defers to that decision rather than re-litigating it.
>
> **[2026-07-12 status refresh — SUPERSEDED to two axes.]** Code-verified against
> `main`: the realization block converged to the **two** user-selectable axes that
> carry real per-backend choice — **`persistence:`** and **`directoryLayout:`** —
> exactly as recorded in the D-REALIZATION-AXES supersession note in
> [`docs/decisions.md`](../../decisions.md) (canonical). **The six-axis model detailed
> below (§1 onward) is historical.** What changed:
> - **`foundation:` removed** — the grammar clause, `DeployableIR.foundation`, and the
>   R4/R6 rules are gone. `platform: elixir` (`src/generator/elixir/index.ts`) now
>   *unconditionally* delegates to `generateVanillaElixirProject`; there is **no
>   `foundation: vanilla` bypass branch** — so the "bypassed the adapter machinery"
>   framing below is history, not a live gap.
> - **`application:`/style removed as a user knob** — each backend has one fixed
>   emission style (`cqrs` on dotnet, `layered` elsewhere), kept only as an internal
>   `StyleAdapter` (`src/generator/_adapters/index.ts`: *"style is the single
>   per-backend emission style — no longer user-selectable"*). The **`R`/`S` stub
>   matrix below is void — every stub adapter was removed**; menus carry real adapters
>   only.
> - **`transport:` / `runtime:` removed whole** — name-only registries no emitter read.
>   `PlatformAdapters` now defines only `persistence`/`styles`/`layouts`;
>   `resolveTransport` / `resolveRuntime` no longer exist.
> - **`persistence:` is real but key-branched, not adapter-dispatched** — the
>   orchestrators branch on the `deployable.persistence` string (14 sites in
>   `dotnet/index.ts`); `resolvePersistence()` has **zero call sites** (currently-unused
>   API). **`directoryLayout:` is the one fully adapter-consumed axis** (`layout.pathFor`
>   via `resolveLayout`). Current menus: dotnet `persistence {efcore, dapper}`, node
>   `{drizzle, mikroorm}`, java `{jpa}`, elixir `{ecto}`; `directoryLayout {byLayer,
>   byFeature}` (elixir `byFeature` only). (python's `adapters()` menu is not yet
>   wired — it parses the axes but exposes no adapter menu.)
>
> **Update (2026):** the **Ash foundation has been removed.** `platform: elixir`
> now generates Phoenix LiveView on **plain Ecto/Phoenix**; on the `foundation:`
> axis, `vanilla` is the default and only valid value and `foundation: ash` is a
> validation error (the knob stays). Consequently the elixir `foundation:` axis is
> now greenfield size-1 (`vanilla`), the `ash`/`ashPostgres`/`ashSqlite` data
> layers are gone, and `ecto` is the only elixir persistence value. The
> ash-vs-vanilla menu/ruling detail below is retained as the record of how the
> elixir axes were structured **before** Ash was removed.
>
> Motivation (historical): a review of the three backend targets (dotnet,
> node/hono, elixir) found the axis *model* is pinned and partly implemented, but
> the implementations diverged — most sharply, `foundation: vanilla` on elixir
> **bypassed the adapter machinery entirely**, so Ecto was hardwired while the Ash
> data layer was a first-class `PersistenceAdapter`. This plan catalogs every gap
> and sequences the convergence.

## 1. The pinned target (recap, not a proposal)

D-REALIZATION-AXES decomposes a backend deployable's realization into **six
orthogonal, optional, validator-gated axes**, each a menu+default off the
backend's `PlatformSurface`. A bare `platform: <name>` equals the full default
block.

| Axis | Realizes | Backed by |
|---|---|---|
| `foundation:` | opinionated domain/app framework, or none | greenfield menu; **owns** other axes |
| `application:` | app-layer orchestration topology | `StyleAdapter` |
| `persistence:` | **data-access library only** | `PersistenceAdapter` |
| `directoryLayout:` | source-tree organization | layout adapter |
| `transport:` | HTTP surface (router/controllers) | greenfield menu *(spec: should be adapter-backed)* |
| `runtime:` | aggregate execution / concurrency model | greenfield menu |

Key rulings this plan leans on:

- **`persistence:` is the data-access *library*, never the domain framework.**
  Under `foundation: ash` the library is `ash_postgres` / `ash_sqlite` (Ash ships
  a *separate per-DB data-layer package*); under `foundation: vanilla` it is
  `ecto` (one library, DB chosen by its adapter — Postgrex / ecto_sqlite3).
  → So `ashPostgres` is **correctly named**; the gap is the **missing `ecto`
  adapter**, not a rename.
- **`foundation` owns layers.** Each value declares which of
  `{application, transport, persistence-flavor}` it supplies; `vanilla` owns
  **nothing**. (`FOUNDATION_OWNED_AXES`: `ash → [application, transport]`.)
- **`transport:` exists as an axis** (it rehomed the retired backend
  `framework:` knob) with values like `minimalApi · controllers`.

## 2. Implemented vs. spec — the cross-target matrix

`R` real · `S` stub · `1` greenfield single-value (axis exists, no alternatives) ·
`—` missing · `⊘` realized but **off the adapter axis** (hardwired).

| Axis | dotnet | node (hono) | elixir | Spec gap |
|---|---|---|---|---|
| **persistence** | `efcore` R, `dapper` R, `marten` S | `drizzle` R, `mikroorm` R | `ashPostgres` R · **`ecto` ⊘** | elixir `ecto` missing / hardwired |
| **application** | `cqrs` R, `layered` S | `layered` R, `cqrs` S | `ash` R · `layered` R | ✅ resolved (#1421): the plain-Phoenix style is now the real `layered` adapter (DSL `serviceLayer`), on-axis and spec-aligned — `vanilla` is foundation-only |
| **directoryLayout** | `byLayer` R, `byFeature` R | `byLayer` R, `byFeature` R | `byFeature` R | elixir `byLayer` absent (idiom — see §4) |
| **transport** | `minimalApi` **1** | `hono` **1** | `phoenix` **1** | **all** greenfield size-1; spec wants `minimalApi`·`controllers` etc. |
| **foundation** | `vanilla` 1 (`abp` future) | `vanilla` 1 (`nestjs` future) | `vanilla` 1 (Ash removed; `ash` now rejected) | elixir vanilla realized via a **bypass branch**, not the axis |
| **runtime** | `transactional` 1 | `transactional` 1 | `transactional` 1 | `orleans`/`akka`/`genserver` unrealized |

### The headline divergence
`src/generator/elixir/index.ts:92`:

```ts
if (deployable.foundation === "vanilla") {
  return generateVanillaElixirProject(args);   // bespoke parallel orchestrator
}
```

`foundation: vanilla` short-circuits **before** adapter resolution
(`resolve-adapters.ts`). The vanilla subtree emits Ecto schemas / changesets /
repositories / controllers directly — so on elixir-vanilla **persistence and
application are hardwired**, not the `PersistenceAdapter` / `StyleAdapter` the
spec (and dotnet/node, which are themselves `foundation: vanilla`) use. Every
other backend composes through the axes; elixir-vanilla is the sole `if
(foundation === …) return customTree()` escape hatch.

### A doc contradiction to fix
`src/platform/elixir.ts:83` comment says *"Ash owns persistence + style."*
`FOUNDATION_OWNED_AXES` says `ash → [application, transport]` (**not**
persistence — `ashPostgres`/`ashSqlite` stay selectable). The rules table is
authoritative per D-REALIZATION-AXES; the comment is wrong.

## 3. Answers to the three review questions (folded in)

1. **Why `ashPostgres`, not `ash`?** Because a `persistence:` value names the
   **unit of data-layer substitution**, and Ash's data layers are **not
   drop-in** — confirmed in the emit: `data_layer: AshPostgres.DataLayer` +
   a `postgres do … end` block (`domain-emit.ts:229,231`), `use AshPostgres.Repo`
   + a Postgres-only `min_pg_version/0` (`shell/runtime.ts:14,24`), embedded VOs
   as `jsonb` (`domain-emit.ts:152`). Swapping to SQLite changes the
   `data_layer:` module, the DSL block (`postgres do` → `sqlite do`), the repo
   macro, and the types — a *different* adapter, not a config flip. So
   `ashPostgres` / `ashSqlite` are correctly per-DB. The vanilla analogue is
   **`ecto`** (singular) because Ecto *is* substantially drop-in (same
   schema/query/changeset; DB is an `Ecto.Adapters.*` config + migration-type
   swap), exactly like `efcore`/`drizzle`. Fix = **add `ecto`**, keep
   `ashPostgres`. See §3.1 for the principle.

### 3.1 The naming principle (what the name *means*)

> A `persistence:` value names the **unit you swap to change data layer.**
> - **DB-agnostic library** (same code across DBs; DB is a provider/adapter
>   config) → value = the **library**, DB rides the orthogonal `storage` axis.
>   `ecto`, `efcore`, `drizzle`, `mikroorm`.
> - **DB-specific, non-drop-in data layer** (different code per DB) → value =
>   **per-DB**. `ashPostgres`, `ashSqlite`.

This is not cosmetic — it's load-bearing and testable:

- **Menu shape.** `foundation: ash` → `persistence: { ashPostgres, ashSqlite, … }`
  (one per supported DB); `foundation: vanilla` → `persistence: { ecto }` (one,
  multi-DB).
- **`supports(storageType)`.** Each `ash*` adapter is single-DB
  (`ashPostgres` ⇒ postgres only); `ecto` answers `true` for postgres *and*
  sqlite.
- **Validation.** `foundation: ash` + `storage: sqlite` *requires* `ashSqlite`
  (`ashPostgres` is a mismatch error); `foundation: vanilla` + any DB → `ecto`.

The axis is therefore *deliberately heterogeneous* — some values are
DB-agnostic libraries, some are DB-specific layers — because that heterogeneity
is the honest encoding of whether a given data layer is drop-in across
databases. (Alternative considered: a single `ash` adapter that internally
branches `postgres do`/`sqlite do` like `efcore` branches providers. Rejected
for now: Ash's per-DB packages diverge structurally at the resource-DSL level,
not just at a provider call, so modelling them as one adapter would hide a real
substitution boundary. Revisit only if the `postgres do`/`sqlite do` blocks
converge upstream.)
2. **Is elixir `byLayer` possible?** Technically yes (Elixir binds by module
   name, not path), but byLayer is **unidiomatic for Phoenix** (whose convention
   *is* byFeature/by-context). `by-layer-layout.ts` exists for dotnet/node, not
   elixir. Treat layout as a legitimately per-platform-idiom axis; **defer**
   elixir `byLayer` rather than forcing parity.
3. **Is there an API-layer axis?** Yes — `transport:`. It exists but is
   **greenfield size-1** today (`minimalApi` / `hono` / `phoenix`). The work is
   to **promote it to an adapter axis** with real alternatives (the canonical
   case: ASP.NET `minimalApi` vs `controllers`).

## 4. Phased convergence plan

Each phase is an independently green, mergeable unit. Phases 1 is the user-
visible alignment; later phases are parity/idiom polish.

> **Status (shipped, slice by slice):**
> - **Slice 1 ✅ (#1061)** — `ecto` persistence + `vanilla` style adapters
>   registered on elixir; foundation-aware defaults (`vanilla ⇒ ecto/vanilla`).
>   *Implementation note:* the planned "re-home + delete the foundation branch"
>   was **not** needed — the elixir persistence/style adapters are **decorative**
>   (only the style adapter is threaded; the actual emit is the `foundation`
>   branch in `index.ts`). `ecto` mirrors `ashPostgres`'s decorative role
>   exactly, so the foundation branch stays and Ash output is byte-identical.
> - **Slice 2 ✅ (#1063)** — validator **R6** (`loom.platform-knob-foundation-
>   mismatch`): `FOUNDATION_FAMILY_ADAPTERS` + `foundationCompatibleMenu`;
>   rejects `ash`+`ecto`, `vanilla`+`ashPostgres`, `vanilla`+`application: ash`,
>   and `persistence: ecto` with the default (ash) foundation.
> - **Slice 3 ✅** — `transport:` promoted to an adapter axis (this PR); see
>   Phase 2 below.
> - Deferred: `runtime:` (Phase 3), elixir `byLayer` + `application:`
>   value-name parity (Phase 4).

**Phase 1 — elixir `ecto`/`vanilla` first-class on the axes (the headline). ✅**
- Add `src/generator/elixir/adapters/ecto-persistence.ts` — a `PersistenceAdapter`
  named **`ecto`**, sibling of `ashPostgresPersistenceAdapter`; `supports`
  `state` now (`eventLog` later, D-VANILLA-ES-HOME); DB from `storageType`.
- Add a plain-Phoenix `StyleAdapter` (plain contexts/changesets/controllers) as
  sibling of `ashStyleAdapter`. *(Originally landed as `vanilla`; renamed to the
  real pipeline name `layered` / DSL `serviceLayer` in #1421 — see §2.)*
- Register both in `src/platform/elixir.ts`: `persistence: { ashPostgres, ecto }`,
  `styles: { ash, layered }`.
- Encode the foundation→axis coupling once (already supported by
  `FOUNDATION_OWNED_AXES` + greenfield narrowing): `ash ⇒ {ashPostgres, ash}`,
  `vanilla ⇒ {ecto, vanilla}`, each foundation supplying its default + narrowing
  its menu (Ash.Resource needs AshPostgres; plain contexts need Ecto).
- Re-home the existing `vanilla/` emit subtree **behind those adapter contracts**
  and **delete the `index.ts:92` branch**, so vanilla composes via
  `resolve-adapters` like every other backend. End state: no platform has a
  bespoke foundation branch.
- Fix the `elixir.ts:83` comment.
- ⚠ **Collision risk:** this edits the same `vanilla/` emit files as the
  in-flight **slice 5c (workflow execution)**. Sequence after 5c (or coordinate)
  — Phase 1 is a structural re-home, not new emit, so it rebases cleanly only if
  5c has settled.

**Phase 2 — promote `transport:` to an adapter axis. ✅ (slice 3)**
- Added a thin `TransportAdapter` contract (sibling of the others; just the
  registry `name` — no backend branches its emit on transport yet) and a
  `transports` slot on `PlatformAdapters` + a `transport` default on
  `PlatformAdapterDefaults`. `transport` left the greenfield set
  (`realizationAxisMenu` routes it to `availableAdapterNames(family,
  "transport")`; `greenfieldMenu` is now `foundation`/`runtime` only).
- Registered the real transports (`minimalApi` dotnet, `hono` node, `phoenix`
  elixir) + reserved stubs: **`controllers`** (dotnet) and **`express` /
  `fastify`** (node — the most widely-used Node web frameworks). The
  per-transport *emit* is future work — the stubs make those values recognized-
  reserved, not runnable.
- Behavior-preserving: the menu values match the old greenfield defaults, so
  lowering/resolution are unchanged.
- *Caveat:* the canonical node/elixir transports (`hono` / `phoenix`) are hard
  platform keywords, so they aren't user-writable axis values (set by the
  lowering default). dotnet's `minimalApi` / `controllers` are plain IDs and
  are writable.

**Phase 3 — `runtime:` axis. ✅ (slice 5 — promoted to adapter-backed with stubs)**
- Added a thin `RuntimeAdapter` contract + a `runtimes` slot / `runtime` default,
  mirroring transport. `runtime` left the greenfield set (`greenfieldMenu` is now
  `foundation`-only; `greenfieldAxisDefaults` returns just `foundation`).
- `transactional` real on every backend (the default); the non-transactional
  runtimes are registered as reserved stubs so they're recognized, not unknown
  — **`orleans`** (dotnet, virtual actors), **`genserver`** (elixir, BEAM
  process per aggregate), **`worker`** (node — `worker_threads`; Node has no
  mainstream actor runtime, so its built-in concurrency primitive stands in).
  The per-runtime *emit* is future work (no `akka` for now).
- Behavior-preserving (menu/defaults match the prior greenfield values).

**Phase 4 — value-name parity (polish).**
- `application: flat` ✅ (slice 4) — registered as a reserved stub on dotnet/node
  so the vocabulary matches the spec spectrum `flat`→`serviceLayer`→`cqrs`.
- elixir `byLayer`: **defer** (idiom, §3.2).

**Cross-knob validation (the "nonsensical combination errors" surface).** The
validator enforces: **R1** out-of-menu (incl. reserved stubs), **R4** foundation
owns axes, **R6** foundation ↔ persistence/application, and **R3** ✅ application
style ↔ `directoryLayout` (`StyleAdapter.supportedLayouts`). Note R3 is a
*forward guard*: style and layout are **orthogonal by design** — the
`LayoutAdapter` only remaps file paths (`layout-surface.ts`), so every real
style supports every real layout on its platform, and R3 has no reachable
rejection today. (Wiring it surfaced and fixed one stale capability: node
`layered` declared `byLayer`-only despite generating `byFeature` end-to-end.)
Still unwired: the `runtime` ↔ `application` advisory (`flat` × actor = warning)
and the persistence-adapter `supports()` storage check (handled on a separate
ES path), both deferred.

## 5. Definition of done
- elixir exposes `persistence: { ashPostgres, ecto }` and `application: { ash,
  vanilla }`; the `index.ts` foundation branch is gone; vanilla emits via the
  adapter path. (Phase 1)
- `transport:` is an adapter axis with ≥2 real entries on at least dotnet. (Phase 2)
- The implemented menus match `platform-realization-axes.md` per axis, or each
  divergence is recorded here as a deliberate idiom/defer. (ongoing)

## 6. Non-goals
- No grammar/keyword changes (the axes already parse).
- No change to Ash output (Phase 1 re-homes vanilla; ash stays on its path,
  byte-identical — guarded by the cross-backend parity gate).
- Not deciding `runtime:` realization here (Phase 3 is a placeholder).
