# Realization-axes implementation alignment — closing the gap to D-REALIZATION-AXES

> Status: **plan** (implementation-gap audit + phased convergence). This doc
> introduces **no new design**: the target is the already-**PINNED**
> **D-REALIZATION-AXES** (`docs/decisions.md`) and its spec
> `proposals/platform-realization-axes.md`. Where a naming or scope question
> arises, this plan defers to that decision rather than re-litigating it.
>
> Motivation: a review of the three backend targets (dotnet, node/hono, elixir)
> found the axis *model* is pinned and partly implemented, but the
> implementations diverge — most sharply, `foundation: vanilla` on elixir
> **bypasses the adapter machinery entirely**, so Ecto is hardwired while the Ash
> data layer is a first-class `PersistenceAdapter`. This plan catalogs every gap
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
| **application** | `cqrs` R, `layered` S | `layered` R, `cqrs` S | `ash` R · **`vanilla` ⊘** | elixir vanilla style hardwired; value names drift (`layered` vs spec `flat`/`serviceLayer`) |
| **directoryLayout** | `byLayer` R, `byFeature` R | `byLayer` R, `byFeature` R | `byFeature` R | elixir `byLayer` absent (idiom — see §4) |
| **transport** | `minimalApi` **1** | `hono` **1** | `phoenix` **1** | **all** greenfield size-1; spec wants `minimalApi`·`controllers` etc. |
| **foundation** | `vanilla` 1 (`abp` future) | `vanilla` 1 (`nestjs` future) | `ash`*(def)* · `vanilla` | elixir vanilla realized via a **bypass branch**, not the axis |
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

1. **Why `ashPostgres`, not `ash`?** Because `persistence:` names the
   data-access *library*, and Ash's data layer is the per-DB package
   `ash_postgres`. The vanilla analogue is `ecto` (DB via its adapter, off the
   `storage` block). Fix = **add `ecto`**, keep `ashPostgres`.
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

**Phase 1 — elixir-vanilla joins the adapter machinery (the headline).**
- Add `src/generator/elixir/adapters/ecto-persistence.ts` — a `PersistenceAdapter`
  named **`ecto`**, sibling of `ashPostgresPersistenceAdapter`; `supports`
  `state` now (`eventLog` later, D-VANILLA-ES-HOME); DB from `storageType`.
- Add a **`vanilla` `StyleAdapter`** (plain contexts/changesets/controllers) as
  sibling of `ashStyleAdapter`.
- Register both in `src/platform/elixir.ts`: `persistence: { ashPostgres, ecto }`,
  `styles: { ash, vanilla }`.
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

**Phase 2 — promote `transport:` to an adapter axis.**
- Introduce a `TransportAdapter` contract (sibling of the others) and convert the
  greenfield `transport` menu to adapter-backed.
- Wire the real second entry where it exists: dotnet **`controllers`** alongside
  `minimalApi` (the canonical ASP.NET split); elixir `phoenix` (controllers);
  node `hono` (+ `express`/`fastify` as future stubs).
- Independent of Phase 1 / 5c (different files) — can land in parallel.

**Phase 3 — `runtime:` axis (defer-leaning).**
- Today every backend is `transactional` size-1. Realizing `genserver` (elixir),
  `orleans`/`akka` (dotnet) is a large, separate effort. **Document as a known
  greenfield axis; defer** unless prioritized.

**Phase 4 — layout / application value-name parity (polish).**
- elixir `byLayer`: **defer** (idiom, §3.2).
- Reconcile `application:` value names (impl `layered`/`cqrs` vs spec
  `flat`/`serviceLayer`/`cqrs`) — a naming-only pass; low risk, do last.

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
