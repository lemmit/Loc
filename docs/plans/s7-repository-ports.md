# S7 — Repository ports (missing or leaking)

> Design note for the S7 remediation from
> [`docs/audits/generated-code-ddd-review-2026-07.md`](../audits/generated-code-ddd-review-2026-07.md).
> **Structural refactor of the GENERATED backend code — runtime behavior is
> UNCHANGED.** Goal: every backend practices ports-and-adapters — the domain
> layer depends on a domain-owned, ORM-neutral repository **port**, and the
> concrete infra adapter is supplied at the composition root.
>
> **STATUS — Slice A + B shipped (this PR).** Hono + Python domain services now
> depend on a domain-owned repository PORT (TS `interface` / Python `Protocol`,
> pooled per project); the concrete adapters are unchanged in name (TS
> `implements` the port; Python satisfies the `Protocol` structurally, proven by
> `mypy --strict`). .NET's `I<Agg>Repository` port no longer speaks EF —
> `ignoreAllFilters`/`ignoreFilters` are replaced by a domain `FilterBypass`
> (capability names) that the adapter translates to EF filter names. **Slice C**
> (.NET `AppDbContext` → `IWorkflowEventStore`/`IUnitOfWork` ports across the 7
> orchestration/read handler sites) is DEFERRED to a stacked follow-up PR.
> Gates: `npm test` (fast suite) green, `biome ci` clean, and the generated
> Hono (`tsc --noEmit`), Python (`uv` + `ruff` + `mypy --strict`), and .NET
> (`dotnet build /warnaserror`) projects all compile.

## The defect, per backend (verified on fresh `main` @ `1d87b293`)

| Backend | Domain service → repo | Handler → repo | Port emitted? | Verdict |
|---|---|---|---|---|
| **Hono/TS** | imports the **concrete** `db/repositories/<agg>-repository` (`emit/domain-service.ts:97-100`) | routes/workflow are composition-root, hold the concrete (OK) | **none** | backward edge |
| **Python** | imports the **concrete** `app.db.repositories.<agg>_repository` (`emit/domain-service.ts:159-162`) | routes/workflow/views/seed/dispatch are composition-root (OK) | **none** | backward edge |
| **.NET** | (no separate domain-service concrete import) | 7 workflow/saga/view/projection handler+controller sites inject concrete `AppDbContext` | `I<Agg>Repository` exists **but speaks EF** | leaking port |
| **Java** | injects the domain-package **interface** `<Agg>Repository` | handlers inject the interface | `<Agg>Repository` (domain) + `<Agg>RepositoryImpl` adapter + `<Agg>JpaRepository` (infra) | ✅ the model to copy |
| **Elixir** | context function on the facade, resolves against the **ambient `Repo`** | facade `defdelegate`s to the concrete `<Agg>Repository` module | n/a — no interface/behaviour idiom | ⚠️ out of scope (see below) |

### Concrete evidence

- **Hono** `src/generator/typescript/emit/domain-service.ts:97-100` — the ONLY
  domain-layer backward edge in the TS tree (a `db/repositories` grep confirms
  `emit/routes.ts` is the only other importer, and routes are the composition
  root):
  ```ts
  ...readPortRepos.map((p) =>
    `import type { ${p.aggregate}Repository } from "../db/repositories/${lowerFirst(p.aggregate)}-repository";`),
  ```
- **Python** `src/generator/python/emit/domain-service.ts:159-162` — the ONLY
  domain-layer backward edge (base-reader/views/routes/workflows/seed/dispatch
  are all composition-root importers):
  ```ts
  ...readPortRepos.map((p) =>
    `from app.db.repositories.${snake(p.aggregate)}_repository import ${p.aggregate}Repository`),
  ```
- **.NET port speaks EF** `src/generator/dotnet/emit/repository.ts:975-988`
  (`renderRetrievalParamsWithCt`, used by BOTH the `I<Agg>Repository` interface
  and the impl): the port's `Run<Name>Async` signature carries
  `bool ignoreAllFilters = false, string[]? ignoreFilters = null` — verbatim
  `IgnoreQueryFilters` vocabulary. The bypass set is **known at each call site
  at compile time** (from the DSL `ignoring *` / `ignoring <Cap>` clause,
  passed as literal named args in `workflow-emit.ts`), so it is domain data
  wearing an EF-shaped parameter.
- **.NET AppDbContext into handlers — 7 sites** (concrete EF unit-of-work /
  event-store handle injected into orchestration/read handlers):

  | # | Handler | File:line |
  |---|---|---|
  | 1 | workflow command handler (when `transactional`; *in addition to* its `I<Agg>Repository`) | `dotnet/workflow-emit.ts:1207-1209` |
  | 2 | event-triggered saga handler (`persisted`) | `dotnet/workflow-emit.ts:518-520` |
  | 3 | merged event-sourced saga handler | `dotnet/workflow-emit.ts:899-901` |
  | 4 | `<Ctx>WorkflowInstancesController` (saga-instance reads) | `dotnet/workflow-emit.ts:2198-2199` |
  | 5 | `<View>Handler` (saga-state / ES view query) | `dotnet/view-emit.ts:332-333` |
  | 6 | `<Proj>On<Event>Handler` (projection fold) | `dotnet/projection-emit.ts:132-133` |
  | 7 | `<Ctx>ProjectionsController` (projection reads) | `dotnet/projection-emit.ts:268-269` |

  (The aggregate write/read path already honours `I<Agg>Repository`:
  `workflow-emit.ts:1191`, `view-emit.ts:167`, `cqrs/commands.ts:405`.)
- **Java (clean, model to copy)** `src/generator/java/emit/repository.ts`:
  `:250-259` domain-package `public interface <Agg>Repository`
  (`@jmolecules …Repository`); `:610-611` `<Agg>RepositoryImpl implements
  <Agg>Repository` (infra `@Repository` adapter); `:411` `<Agg>JpaRepository
  extends JpaRepository` (infra). Domain services (`emit/domain-service.ts:253-258`)
  and workflow handlers (`emit/workflow.ts:747,764`) inject the **domain
  interface** (`pkgFor("repository-interface", …)`). No backward edge.
  *Correction to the audit*: the Spring Data repo is a `public interface`, not
  package-private — it is "behind" the adapter by package/role, not by access
  modifier.

## The port shape (domain-termed, ORM-neutral)

Mirror Java. A per-aggregate repository **port** = the aggregate's domain-facing
read/write surface, in domain terms only (aggregate class, typed ids, domain
value objects — **no** ORM types, which never appear in the concrete repo's
public method signatures anyway, so the port is ORM-neutral by construction):

- `getById(id) : Agg` (throws not-found) / `findById(id) : Agg | null`
- `getByIdForWrite(id)` — only when the aggregate has a narrower write scope
- `findManyByIds(ids) : Agg[]`
- `save(agg)` and `delete(agg)` — the latter only when a canonical `destroy` exists
- one method per DSL `find` (incl. the `currentUser`-scoped + paged variants)
- one `run<Retrieval>` per context retrieval targeting the aggregate

**Excluded from the port**: `toWire()` (presentation — the audit dings it
separately; a class may implement a port and still carry extra methods).

### Where the port lives

- **TS/Hono**: new `domain/<agg>-repository-port.ts` exporting
  `export interface <Agg>RepositoryPort`. Concrete `<Agg>Repository` (name
  unchanged, in `db/repositories/`) gains `implements <Agg>RepositoryPort`
  (infra→domain import — the correct direction). Domain service imports the
  **port** from `domain/`.
- **Python**: new `app/domain/repositories/<agg>_repository.py` exporting a
  `class <Agg>RepositoryPort(Protocol)`. Concrete keeps its name; Protocols are
  structural so no `implements` is needed — we type the domain-service param
  against the Protocol. Domain service imports the Protocol from `app.domain`.
- **.NET**: `I<Agg>Repository` already lives in the Domain layer — keep it;
  just remove the EF vocabulary from its signatures.

The port name `<Agg>RepositoryPort` (vs reusing `<Agg>Repository` like Java)
keeps the **concrete class name unchanged**, so every composition-root wiring
site (routes / workflow / seed) stays byte-identical → runtime unchanged, diff
minimal.

## DI approach — **the user-owned fork**

Recommendation: **the least-machinery option, already idiomatic on every
backend**, because the domain service already receives the repo as a
parameter/injected field — S7 only changes the **type** of that
parameter/field from the concrete to the port. No new wiring, no container
changes:

- **Hono**: manual param injection already. The workflow composition root does
  `new <Agg>Repository(db, events)` and passes it to the domain-service
  function. S7 changes only the function's param **type** to the port. Runtime
  identical.
- **Python/FastAPI**: same — the workflow supplies the repo handle to the
  domain-service function; S7 retypes the param to the Protocol. `Depends`
  wiring untouched.
- **.NET**: ASP.NET built-in DI **already** registers `I<Agg>Repository →
  <Agg>Repository` and handlers **already** inject the interface for the
  standard path. We re-point nothing for the standard case; we (a) clean the
  interface signatures and (b) — if in scope — replace `AppDbContext` injection
  in the 7 handler/controller sites with the port(s).
- **Java / Elixir**: no change (Java already correct; Elixir has no interface
  idiom).

### .NET specifics

1. **EF vocabulary off the port.** Replace `bool ignoreAllFilters, string[]?
   ignoreFilters` on the port method with a domain-termed filter-bypass value
   (a `ReadScope` / `FilterBypass` domain type carrying "bypass all" or the
   named capabilities to bypass — the capability names are already domain
   terms). The **adapter** translates it to `.IgnoreQueryFilters(...)`; call
   sites in `workflow-emit.ts` pass the domain value. (Because the bypass is
   compile-time-known per call site, an alternative is to bake it adapter-side
   and keep the port bypass-free — but a shared retrieval can be read with
   different bypasses at different call sites, so a parameter is still needed.)
2. **AppDbContext out of handlers.** Inject the relevant `I<Agg>Repository`
   port(s) instead. The saga/workflow/projection event-store use of
   `AppDbContext` needs an `IWorkflowEventStore` port (and transaction control an
   `IUnitOfWork` port) — this is the **largest, highest-risk** piece (7 sites,
   3 emitter files).

## Scope boundary (recommendation — user decides)

Staged, so the low-risk high-value core lands first and cleanly:

- **Slice A (this PR, recommended):** Hono + Python domain-service **port** —
  removes the one backward edge on both backends. Low risk, directly closes the
  headline S7 defect. Concrete keeps its name; port added to the domain layer.
- **Slice B (this PR if approved, else stacked):** .NET — EF vocabulary off the
  `I<Agg>Repository` port (domain-termed bypass).
- **Slice C (defer / separate PR):** .NET `AppDbContext` → `IWorkflowEventStore`
  / `IUnitOfWork` ports across the 7 workflow/saga/view/projection handler +
  controller sites. Largest blast radius; worth its own review + full .NET
  compile gate.
- **Java:** no change (already ports-and-adapters). **Elixir:** no interface
  idiom; the module-based context→repository call (facade `defdelegate` to the
  concrete `<Agg>Repository` module, domain service on the ambient `Repo`) is
  the Elixir-idiomatic seam — a `behaviour` would be ceremony no other Elixir
  code uses. Recommend **out of scope**; flag if the user wants a `behaviour`.

**Runtime-unchanged invariant** holds throughout: only types/interfaces are
added and parameter/field types change; no method body, wiring, or SQL changes.
The per-backend compile gates (tsc / mypy / dotnet `/warnaserror`) are the proof.

## Open decisions for sign-off

1. **Port granularity**: full per-aggregate repository port (recommended, matches
   Java, task-specified) vs a narrow read-port (only the methods the domain
   service reads — smaller, but less "the model to copy").
2. **Explicit `implements`** on the TS concrete (compile-proven fidelity,
   recommended) vs structural-only (lower risk if a signature proves fiddly).
3. **.NET scope**: Slice B only, or B+C in this PR?
4. **Elixir**: leave module-based (recommended) or introduce a `behaviour`?
