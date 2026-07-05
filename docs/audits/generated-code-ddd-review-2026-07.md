# Generated-code DDD review — 2026-07 (all platforms)

> Snapshot-in-time audit. The question asked: **is the generated code what a
> senior architect specialized in DDD would write — and what should change to
> make it deliberately DDD-shaped?** Companion to the correctness-focused
> [`generated-code-review-2026-06.md`](generated-code-review-2026-06.md) and
> [`generated-code-review-2026-06-30.md`](generated-code-review-2026-06-30.md);
> items dispositioned there (two-tier 400/422 error model, SYS-1 update-path
> wire validation, decimal→float, regex `.find()`, dev-stub permissions,
> `headline` else-arm and other faithful-source oddities) are **not**
> re-reported here.

**Method.** `node bin/cli.js generate system examples/showcase.ddd` on `main`
(`bb043de`), then six independent reviews: one senior-DDD-practitioner pass per
backend (Hono/TS, .NET, Phoenix, Python, Java) over the generated project
*standalone*, plus one strategic-DDD pass over the system composition
(compose, db-init, `.loom/` artifacts, cross-context shape). Every headline
claim was re-verified against the tree (the two compile failures were confirmed
by building in the matching toolchains and re-confirmed statically:
referenced-but-never-emitted types, undefined locals). Findings that merely
mirror the `.ddd` source are dispositioned as faithful translations, not
generator defects.

> **P0 status (2026-07-03, this PR + #1635):** the compile/runtime breaks and
> the `ownerStamped` stamp-value bug are FIXED — the union-find variant-match
> now lowers to a presence check on all five backends (`subjectShape:
> "absence"`), the .NET showcase builds under `/warnaserror` (verified in the
> SDK container), the generated Java showcase compiles (gradle), the Hono
> showcase type-checks + bundles (new `test:tsc` cell), Python `mypy --strict`
> is clean on showcase (seed datetime coercion), and the stamp writes the
> DECLARED claim (`currentUser.role`) on Hono/.NET/Java. Backend gate path
> filters now include `src/ir/**` + `src/generator/_expr/**`. Still open from
> P0: adding showcase to the python-build corpus (blocked on two ruff-level
> emitter cosmetics: an over-eager `UTC` import and `F841` on a dead `let`);
> the "compiles as generated" row of the matrix below describes the
> pre-fix state.

---

## Executive summary

**The tactical DDD core is genuinely good — far above what code generators
usually produce — on four of five backends.** Aggregates are real behavioral
objects (private state, invariant-asserting factories, operations with
`requires`/`precondition` gates, derived properties as members, events raised
inside the aggregate), repositories are per-root and aggregate-shaped, the
domain layer is persistence-ignorant, and even the generic `crudish` update
routes through a domain method that re-runs invariants. A senior DDD
practitioner would recognize the intent immediately.

**Three things keep it from being signable as-is:**

1. **The consistency story ends at the process boundary.** No backend emits any
   optimistic concurrency (no version column anywhere; blind last-writer-wins
   upserts / read-modify-write across two transactions). The aggregate is
   Loom's declared consistency boundary — without a concurrency token the
   boundary only holds within a single request.
2. **Phoenix is the outlier: its boundary only exists on the create path.**
   Generic update mass-assigns capability stamps and containments, operation
   persistence skips changeset validation, a cross-field invariant is silently
   dropped, derived properties vanish (while the served OpenAPI requires
   them), and events broadcast *pre-commit* into a topic nothing subscribes
   to — the declared saga is unreachable.
3. **Two flagship trees don't compile and one capability is broken three
   ways.** The showcase's Java and .NET outputs fail their compilers (union
   finds, seeds, stamps — see S1/S2), and `ownerStamped` stamps the wrong
   value on three backends while remaining client-writable on the wire on
   all five.

Strategically, the system is **more deliberate than "N CRUD services sharing a
database" — but the bounded context is only real one layer deep**: schema-per-
context and database-per-deployable are uniformly right; above the database
every backend (except Phoenix) collapses contexts into one flat namespace, one
DbContext/db-handle, one flat `/api/*` surface, and the declared `api`
contracts leave no trace in the output.

### Grade matrix (A–F per dimension, per backend)

| Dimension | Hono | .NET | Phoenix | Python | Java |
|---|---|---|---|---|---|
| Aggregate = consistency boundary | B+ | B | **D+** | A- | B |
| Rich vs anemic model | A- | A- | C | A | A- |
| Value objects | B | A | B+ | C+ | A- |
| Entities & typed IDs | A- | A | A- | A- | B+ |
| Repositories | B+ | B- | B+ | B+ | B+ |
| Domain events | B- | B- | **D** | B+ | C |
| Layering / persistence ignorance | A- | C+ | B | B | B+ |
| Transactions & concurrency | C- | C | C- | B- | C+ |
| Ubiquitous language | A- | A- | A- | A- | A- |
| Creation / factories | A | B+ | B | B+ | A |
| **Compiles as generated** | no¹ | **no** | yes | **no²** | **no** |

¹ Hono: two `tsc --strict` breaks (S2 variant-match, seed `Date` literal) — the
showcase hono output isn't in a tsc-gated corpus.
² Python: compiles/imports, but two workflow routes are broken at runtime
(`NameError`, `TypeError`) and would fail `mypy --strict` — showcase isn't in
the python-build corpus.

---

## Cross-backend systemic findings

These are the patterns that repeat across backends — each is one fix decision
made once (usually at the IR or migrations layer) and applied everywhere,
rather than five per-backend patches.

### S1 · `ownerStamped` capability is broken three ways (P0 — correctness + security)

The DSL declares `stamp onCreate { createdByRole := currentUser.role }` +
`filter this.createdByRole == currentUser.role`. Generated:

- **Hono stamps the wrong value**: `db/audit-stamp.ts` writes
  `createdByRole: ctx.actorId` (the principal's **id**) while every read
  filters `eq(engineers.createdByRole, requireCurrentUser().role)` — an
  API-created Engineer is invisible to all subsequent reads, including its
  creator's. Root cause: `exprUsesCurrentUser(a.value) ? "ctx.actorId" : …` in
  `src/generator/typescript/emit/audit-stamp.ts` collapses *any* currentUser
  expression to the actor id.
- **Java stamps the wrong value**: `emit/entity.ts` maps any
  currentUser-referencing stamp to `@CreatedBy`, and the emitted
  `AuditorAware<UUID>` returns the principal's **id** — for a `String` role
  field; the SpEL row filter then matches nothing.
- **.NET doesn't compile**: `auditable-interceptor.tpl.ts` special-cases only a
  *bare* `currentUser` ref; `currentUser.role` falls through to `renderCsExpr`
  and renders an undefined local (`AuditableInterceptor.cs:41`, CS0103).
- **All five require the stamped field from the client** on the create wire
  (`CreateEngineerRequest.createdByRole` is `[Required]` / zod-required /
  pydantic-required), then overwrite (or on Phoenix, *don't* overwrite on
  update — see S12) — a server-owned field in the public contract, and until
  the stamp works, the client controls the very column the row-security
  predicate filters on.

**Fix.** (a) In each stamp emitter, render the *declared* stamp expression
against the ambient principal (`currentUser.role` → the principal's role),
falling back to actor-id only for bare `currentUser.id`. (b) Exclude
stamp-target fields from Create/Update request DTOs — an OpenAPI-shape change,
so it lands as an all-backend parity slice (same shape as SYS-1). Python's
`_stamp_on_create` already stamps the right value; use it as the reference.

> **✅ (b) FIXED** — two layers, gated by
> `test/conformance/stamp-request-no-leak-parity.test.ts` (all 5 backends):
> **create** landed with #1629 (`promoteStampTargets` → `access: managed` →
> `forCreateInput`, every backend + frontend api-module); **update** was the
> remaining leak — the crudish `update` op params (which every update DTO is
> shaped from) were stamp-blind at the AST layer — closed in
> `writableUpdateFields`/`writableCreateFields` (`src/macros/api/factories.ts`).
> The frontend tail (walker `CreateForm`, HEEx form, Playwright page objects
> still rendering/filling raw `agg.fields`) now derives from
> `createInputFields` like the api-module and Angular already did.

### S2 · Variant-`match` over a union-returning find is broken on four backends (P0)

`find locate(name): Project or ProjectNotFound` lowers the repository find to
the documented absence shape (`Project | null` / `Project?`), but the
variant-`match` lowering over its result assumes the **tagged payload wire**:

- **Hono**: `outcome.type === "Project"` against a class with no `type` member
  (TS2339 + TS18047 under `tsc --strict`).
- **Python**: `outcome["type"]` subscripting a domain object (runtime
  `TypeError`), plus `cast` never imported.
- **.NET**: the workflow emitter calls `_projects.LocateAsync(...)` and matches
  `ProjectOrProjectNotFound_*` wrapper records — neither is ever emitted
  (CS1061/CS0246).
- **Java**: same missing sealed-union variants (`index.ts` collects union specs
  only from operation return types, not finds), plus `case … _ ->` uses an
  unnamed variable — preview-only on the pinned Java 21 toolchain.

**Fix (one decision, made once).** At lowering (`src/ir/lower/lower-workflow.ts`
knows the subject is an absence-shape union find), lower the match to an
absence check: the aggregate arm binds the non-null value, the error arm *is*
the null branch. Then each backend renders a null/nil check instead of a
discriminant probe — no wrapper types needed, and it matches how the
controllers already handle the same find. (Alternative — reify the union at
the repository port — is more DDD-expressive but a much bigger parity slice.)

### S3 · The compile gates didn't hold the line (P0 — meta)

Java and .NET showcase output fails compilation on `main`; Hono's fails
`tsc --strict`; Python's fails `mypy --strict` — yet all per-PR gates are
green. The gates exist (`generated-dotnet-build.test.ts` compiles showcase
under `/warnaserror`; `java-build.yml`; `hono-build.yml`) but either their
trigger paths let the recent showcase expansion (#1623) land unbuilt or their
corpora don't include the shapes that broke. Whatever slice fixes S1/S2 must
also close the gate hole: add showcase to the tsc/mypy-gated corpora and check
why the dotnet/java cells didn't go red.

### S4 · No optimistic concurrency anywhere (P1 — the missing half of "aggregate = consistency boundary")

Zero version columns across all five schemas; every operation route is a
read-modify-write (on Hono even across **two separate transactions** — `getById`
and `save` each open their own), persisted via unconditional upsert
(`onConflictDoUpdate` / blind `on_conflict_do_update` / tracked-entity save).
`promote`'s `total := total + 1` is the textbook lost update — and it's
race-prone via `POST /builds/{id}/promote` while *serializable* via the
workflow that wraps the same operation: two consistency levels for one
operation depending on entry point. The event-store appends
(`max(version) + 1` under a composite PK) turn concurrent appends into
unhandled 500s instead of retries.

**Fix.** One parity slice: `version` column in `MigrationsIR`
(`src/system/migrations-builder.ts`), guarded update (`WHERE id=… AND
version=…` → bump, or the native mechanism: EF `IsRowVersion()`/`xmin`, JPA
`@Version`, Ecto `optimistic_lock`, SQLAlchemy `version_id_col`), a
`ConcurrencyError` → **409** arm in each error mapper, and a conformance
assertion pinning the status. The DSL needs no new syntax — this is the
correct *default* for a toolchain whose pitch is the aggregate boundary; an
opt-out knob can come later.

### S5 · Domain events: right half raised, wrong half delivered (P1/P2)

The raising side is correct almost everywhere (events appended inside the
aggregate, drained via `pullEvents()`). Delivery diverges per backend, and none
has an outbox:

- **Phoenix (worst)**: broadcast happens **before** `persist_change` — phantom
  events on failed writes — into a PubSub topic with **zero subscribers**; the
  context `Dispatcher` is only ever invoked from inside the saga's own
  handlers, so the declared `ArchivalTracker` saga can never receive its
  trigger. The seam is severed, not just unreliable.
- **Hono**: dispatch after commit (correct ordering) but fire-and-forget — a
  crash between commit and dispatch silently loses the event; a dispatcher
  throw 500s a request whose write already committed.
- **.NET/Java**: publish happens *inside* the producing transaction via plain
  `@EventListener`/Mediator notification (atomic for the saga append — fine —
  but no `AFTER_COMMIT` seam exists for external effects). Java's
  `BuildService.publishEvents` only **logs** — `BuildPromoted` is silently
  dropped because no same-process listener happens to exist.
- **.NET/Java saga double-append**: both the `create`-by-correlation starter
  and the `on` handler subscribe to `ProjectArchived`; the starter appends
  unconditionally, so an existing stream folds each archive **twice**
  (`archivedCount` += 2). Hono pins the on→start order; .NET's Mediator order
  is unspecified — observable cross-backend divergence.

**Fix.** (a) Phoenix: emit events *after* the `{:ok, record}` branch of
`persist_change` and route them through the context `Dispatcher` (which
already exists) plus the PubSub broadcast — `operation-returns-emit.ts` +
`context-emit.ts`. (b) Starter guard: the event-sourced starter must no-op when
the stream exists (mirror the `on` handler's emptiness guard) — pin the
semantics in conformance. (c) Uniform publisher wiring on Java. (d) Outbox
(`__loom_outbox` written in the save transaction, relayed post-commit) as the
documented upgrade path for the `channelSource` broker story — the Python
emitter's `DomainEventDispatcher` Protocol docstring already names this seam;
make it real when brokers land.

### S6 · Rehydration re-runs creation invariants (P2 — Hono, Python)

Repositories reconstitute via `_create` → private constructor →
`_assertInvariants()`. Tighten an invariant and every pre-existing row becomes
unreadable — every `GET`/`findAll` throws, including the fix-it update path
(you must load to repair). Invariants guard *transitions*; reconstituted state
was valid when stored. (.NET/Java materialize via EF/JPA and don't re-assert —
divergent semantics across backends today.)

**Fix.** Give `_create`/rehydration a non-asserting construction path in
`emit/aggregate.ts` (TS + Python), keeping assertion on `create()` and every
mutator; pin the cross-backend semantics ("rehydration trusts the store") in
conformance.

### S7 · Repository ports: missing or leaking (P2)

- **Hono/Python**: no domain-owned repository abstraction at all — and the
  *domain service* (`ProjectQueries.nameTaken`) type-imports the **concrete
  infrastructure repository** (`domain/services.ts` → `db/repositories/…`;
  `app/domain/services/project_queries.py` → `app.db.repositories…`). The one
  backward edge in otherwise-clean layering, on both backends.
- **.NET**: the port exists but **speaks EF** — `ignoreFilters: string[]`
  (verbatim `IgnoreQueryFilters` vocabulary) and transport-shaped paging tuples
  on `IProjectRepository`; views (read models) also hang off the aggregate's
  port; workflow/saga/view handlers (and one Api controller) inject the
  concrete `AppDbContext` directly.
- **Java (contrast, the model to copy)**: domain-facing interface +
  package-private Spring Data repo behind an adapter — never injected upward.

**Fix.** Emit a domain-side port (TS interface / Python `Protocol`) derived
from the same find/wireShape IR the repo builders already consume; type domain
services and routes against it. .NET: move retrieval-bypass/view reads to an
application-tier read service; put transaction control and the event store
behind `IUnitOfWork`/`IWorkflowEventStore` ports.

### S8 · Compiler internals leak into the ubiquitous language (P2 — all backends)

The inline `retrieval { … }` literal becomes a **public domain-surface method
named by a structural hash**: `runFindAllByActiveNamedShaped1g7wy98` /
`FindAllByActiveNamedShaped1g7wy98Spec` (in the .NET **Domain** namespace) /
`run_find_all_by_active_named_shaped1g7wy98_project` on the Phoenix context
facade. The name is minted once at `src/ir/lower/lower-workflow.ts`
(`Shaped${shapeSignature(…)}`), so one fix covers all five: derive a readable
name from the shape (`FindAllByActiveNamedBySequenceDesc`) or emit anonymous
retrievals as private members of the repository implementation, keeping the
hash out of the domain vocabulary.

### S9 · Value objects are values only on .NET/Java (P2)

- **.NET/Java**: `sealed record` / `@Embeddable record` with compact-ctor
  validation — textbook. ✔
- **Python**: mutable public attribute, **no `__eq__`/`__hash__`** — identity
  equality, the one property a VO must have; `slug.value = ""` bypasses both
  invariants post-construction. Fix: `@dataclass(frozen=True)` +
  `__post_init__` (the events emitter already uses exactly this pattern).
- **Hono**: immutable ✔ but no `equals()` (reference identity) and invariant
  violations throw **bare `Error`** — a VO tripping on request input surfaces
  as 500, outside the `DomainError` taxonomy. Fix in `emit/value-objects.ts`.
- **Phoenix**: idiomatic schemaless-changeset + `new/1` ✔ (dinged only for the
  dropped derived member, part of S12).

### S10 · The `extern` escape hatch dissolves encapsulation aggregate-wide (P2 — Hono, .NET)

One `extern` operation widens **every** field: Hono emits public
invariant-skipping setters (`set name(v) { this._name = v; }` — nothing in the
tree uses them; the route re-asserts afterward but nothing forces other
callers to); .NET flips all setters to `internal` — in a **single-assembly**
app, `internal` ≡ any handler/controller/test. Fix: scope the mutation surface
to the extern handler (a draft/patch object whose `commit()` asserts), or at
minimum make the emitted setters re-assert invariants.

---

## Per-platform verdicts (condensed — full evidence lives in the findings above)

### Hono/TS — signable after S1/S2/S4

Rich aggregates done honestly: branded IDs, factory-only construction, one
`_assertInvariants` choke point on every declared mutation path, aggregate-
shaped repositories with child diff-sync in one transaction, events raised
inside and dispatched after commit, seeds routed through the factory + repo
(unusually disciplined). Biggest smell: the two-transaction read-modify-write
+ versionless schema (S4). Also: `toWire()` (presentation) lives on the
repository; the seed passes a string where `create` expects `Date`; the
`event_dispatched` log line always says `"Object"`.

### .NET — the right shape, pierced at the edges; doesn't compile

Genuinely senior mechanics: `OwnsMany("_pipelines", …)` over private backing
fields with `builder.Ignore(x => x.Pipelines)`, `readonly record struct` IDs,
ctor-validated record VOs, thin Mediator handlers, Ardalis specifications
reified from `Criterion<T>`, `open-in-view: false`, Flyway-owned schema. But:
one assembly (direction is convention, not enforcement), `IDomainEvent :
INotification` (Domain → Mediator), domain ops take the Api-side `Auth.User`,
`AppDbContext` injected into Application and Api, port speaks EF (S7), and
five independent compile breaks (S1/S2 + optional-id DTO mapping `Guid?`→`Guid`,
seed positional-args/string-datetime).

### Phoenix — not signable yet (the priority backend)

The skeleton is idiomatic (context facade as sole entry, per-aggregate
repository modules, pure domain cores, schemaless-changeset VOs, serializable
transaction where declared, PII-aware `Inspect`), but the boundary is
create-only:

- **Generic update mass-assigns**: `base_changeset` casts `@all_fields`
  including `created_by_role`/`superseded_by` (a `PATCH` rewrites the
  capability stamp keying the ownership filter) and `cast_assoc(:pipelines),
  on_replace: :delete` (a `PATCH {"pipelines": []}` bulk-deletes containment,
  bypassing `addPipeline`'s precondition). Fix: a dedicated `update_changeset`
  whose cast list is exactly the update wire fields (`changeset-emit.ts`).
- **Operation persistence skips validation**: `change/1` + `put_change` →
  bare `Repo.update` — no validator re-run on mutation.
- **Cross-field invariant `handle != email` is dropped on every path** (other
  backends 400 it at the domain floor).
- **Derived properties vanish** from domain and wire while the served OpenAPI
  marks them **required** — a self-contradicting contract and a structural
  parity break (the emitter documents the skip in `wire-serialize.ts`).
- **Events**: S5's worst case (pre-commit, subscriber-less, saga unreachable).
- Duplicated op bodies (pure core on the schema module + byte-similar copy
  inlined in the facade that never calls the core); `requires`/`precondition`
  raise `ArgumentError` → 500 where the spec says 403/422 (the workflow
  renderer already does tuples + `respond/2` correctly — the two renderers
  disagree about how the domain says "no"); legacy `Map.from_struct` dumps in
  views/workflows controllers (incl. a `NotLoaded` Jason crash on the
  no-preload shorthand view); a dead hard-`Repo.delete` on the softDeletable
  Squad's repository.

### Python — signable after the two runtime breaks + S9

The strongest layering discipline of the five in some ways: three cleanly
separated representations (domain classes / `*Row` persistence / pydantic
wire), session-per-request unit of work with a single commit at the dependency
exit, capability filter enforced fail-closed **inside the repository**,
`mypy --strict` shipped. Breaks: `reposFor()` misses the `if-let` arm so one
workflow route has an unbound repository name (`NameError` → 500); the
variant-match break (S2); plus S9's mutable VOs, S7's inverted domain-service
import, and `to_wire()` on the repository.

### Java — structurally the best; doesn't compile

jMolecules stereotypes backed by real deps, ports-and-adapters done right
(package-private Spring Data repo behind a domain-facing interface), record
VOs and `@EmbeddedId` typed IDs end-to-end, package-by-feature + real
`domain/` core, `@Transactional(readOnly)` hygiene, textbook factory pattern.
Breaks: S2 (missing sealed variants + Java-21 unnamed variable), seed
string→`Instant`, S1's `@CreatedBy` id-vs-role. Also: package-private entity
fields shared with controller/service (emit `private`; Hibernate field access
is fine), `tags()` returns the live mutable list while `pipelines()` defends,
views load full EAGER aggregates to produce row projections (emit JPQL
constructor projections), Spring *Data* auditing annotations inside the
domain class.

---

## Strategic DDD (system level)

**What's right and deliberate**: one Postgres server but **database per
deployable** + **schema per bounded context** on all five backends
(`catalog.projects`, `builds.builds`, `people.engineers`); id-only
cross-aggregate references enforced by the language; `.loom/wire-spec.json` +
the OpenAPI parity gate functioning as a real, CI-enforced published language;
honest `datasources.md` unused-flags.

**The gaps, ranked:**

1. **Context boundary is schema-only.** Above the database, every backend but
   Phoenix collapses contexts: flat namespaces (`DotnetApi.Domain.Projects` —
   `People` never appears; one flat `Domain/Events` mixing Catalog + Delivery),
   one `AppDbContext`/drizzle handle/SQLAlchemy `Base` spanning all schemas,
   flat `/api/*`. A cross-context join is a one-line import away and invisible
   in review. Fix: thread `context.name` into namespaces/packages/directories
   (`Domain.Catalog.Projects`, `features.catalog.projects`,
   `domain/catalog/project.ts`) and split the event unions per context —
   Phoenix already shows the shape.
2. **The `api` contract layer dissolves at emission.** `ProjectsApi` /
   `DeliveryApi` / `AccountsApi` produce no route prefix, no OpenAPI tag/group,
   no client-module grouping — the DSL's own open-host-service concept is
   unrecoverable from the artifact it governs. Fix: per-api OpenAPI tag groups
   (`x-loom-api`), grouped frontend clients.
3. **Artifacts overstate or misdraw the architecture** (all fixable now):
   `likec4.ts` hand-freezes `PERSISTENT = new Set(["node","dotnet","elixir","java"])`
   — **`pythonApi → db` edge silently missing** (the "derive, don't stamp"
   anti-pattern; derive from the registry's `needsDb`) [✅ FIXED — `likec4.ts`
   now derives persistence from `descriptorFor(d.platform).needsDb`, so every
   DB-backed backend incl. python wires its `db` edge]; `deployment.mmd` emits
   module nodes and edges to `ctx_*` nodes it never defines (the one diagram
   whose job is module→context ownership doesn't show it) [✅ FIXED — `mermaid.ts`
   now defines each context node nested under its owning subdomain 📦 and draws
   `serves` edges, so no edge dangles]; frontend deployables
   inherit the backend's `moduleNames` (enrichment #4) and so claim contexts
   they never touch [✅ FIXED at the artifact layer — the enrichment copy is
   needed for the page emitter's wire-scope, so `likec4.ts` + `mermaid.ts` now
   treat a frontend's inherited `contextNames` as scope, not ownership: a
   frontend contributes no C4 context components and draws no `serves` edges,
   only its `calls` edge to the backend]; `asyncapi.yaml` says
   `transport: hotCache` while compose
   provisions no redis and no backend has a redis client (the `channelSource`
   binding is silently inert — mark it `declared, not provisioned` until
   brokers land) [✅ FIXED — a bound transport now carries
   `transportStatus: "declared, not provisioned"`]; the saga's
   `archival_tracker_events` table escapes to
   `public` instead of `catalog.`; `wire-spec.json` keys aggregates by bare
   name (two contexts with a same-named aggregate would collide).
4. **Naming drifts across layers**: migrations say subdomain
   (`accounts_initial`), schemas say context (`people.*`), code says aggregate
   (`Domain.Engineers`) — the context map is only recoverable from the DB.

---

## Language-design recommendations (not emitter bugs)

- **Context-map relationship vocabulary**: the DSL cannot say
  upstream/downstream, customer–supplier, conformist, ACL, shared kernel — so
  no artifact can render them. A small `relation`/`acl` declaration would flow
  straight into `.loom/architecture.c4` edge labels and AsyncAPI operations.
- **System-of-record**: when N deployables serve one context (as showcase
  does), nothing designates authority; `migrationsOwner` is an internal
  approximation — surface it.
- **`crudish` on gated aggregates** deserves a lint: `archive()` requires
  admin + emits `ProjectArchived`, while the crudish `update` can set
  `active := false` silently. The generator renders both honestly; the
  *combination* is the modeling smell (validator, not emitter).
- **`softDeletable` with no reachable delete operation** (Squad) — declared
  state + read filter with no writer; warn. (The dead hard-`delete` on the
  Phoenix repository is an emitter defect; the missing route is faithful.)
- **Payload records don't exist in the output** (`RenameProjectCmd`,
  `ProjectCard`, `ProjectOutcome` — zero hits in any backend): deliberate for
  unreferenced payloads, but a ubiquitous-language cost worth revisiting once
  ops reference them.
- **Money carries no currency** — `money` maps to amount-only
  decimal/BigDecimal; fine for the wire, not a full Money VO.

---

## Prioritized remediation plan

| Pri | Slice | Scope | Emitters touched |
|---|---|---|---|
| **P0** | Compile/runtime breaks: Java ×3 (union variants, `_` binding, seed `Instant`), .NET ×5 (stamp local, union find, if-let DI, `Guid?` mapping, seed args), Hono seed `Date` + S2, Python if-let repo + S2 | per-backend, small | `java/{index,render-expr,emit/seed}.ts`, `dotnet/{auditable-interceptor.tpl,workflow-emit,dto-mapping,emit/seed}.ts`, `python/workflows-builder.ts`, `typescript/…seed` |
| **P0** | S2 root fix: lower variant-match over absence-shape union finds to a null-check at IR lowering | one decision, all backends | `ir/lower/lower-workflow.ts` + 5 render arms |
| **P0** | S1: stamp the declared expression, not the actor id (Hono/Java/.NET) | 3 backends | `typescript/emit/audit-stamp.ts`, `java/emit/{entity,jpa-auditing-config}.ts`, `dotnet/emit/auditable-interceptor.tpl.ts` |
| **P0** | S3: add showcase to tsc/mypy-gated corpora; explain the green dotnet/java cells | CI | `test/e2e/*`, workflows |
| **P1** | S4: optimistic concurrency (version column + guarded write + 409) as an all-backend parity slice | all 5 + wire | `system/migrations-builder.ts` + per-backend schema/repo/error emitters |
| **P1** | Phoenix boundary: dedicated `update_changeset` (no capability fields, no `cast_assoc`), validate-on-operation-persist, cross-field invariant rendering, 403/422 tuple flow, derived-property projection (or stop requiring them in OpenAPI) | elixir | `elixir/vanilla/{changeset-emit,context-emit,operation-returns-emit,wire-serialize}.ts` |
| **P1** | S5(a,b,c): Phoenix post-commit dispatch through the Dispatcher; .NET/Java saga starter guard + pinned order; uniform Java publisher | elixir, dotnet, java | see S5 |
| **P1** | S1(b): drop stamped fields from create/update DTOs (parity slice, OpenAPI change) | all 5 | dto/request emitters |
| **P2** | S6 rehydration trust, S7 ports, S8 retrieval naming, S9 VO upgrades, S10 extern scoping, .NET `AsNoTracking` + read-side split, Java private fields + projection views, Hono/Python `to_wire` off the repository | per-backend | various |
| **P2** | Strategic: per-context namespaces + event-union split; `api` → OpenAPI tag groups; artifact honesty (likec4 `needsDb` derivation, deployment.mmd context nodes, frontend edge truth, asyncapi transport honesty, saga table schema, wire-spec context keys) | generators + `src/system/` | `system/{likec4,mermaid,wire-spec}.ts` etc. |
| **P3** | Language: context-map relations, system-of-record, crudish-vs-gated lint, softDeletable lint, outbox for broker-backed channels | DSL design | proposals |

**Bottom line.** The generated code is recognizably the work of someone who
knows DDD — the aggregates, factories, typed IDs, specifications, and layering
are real, not cosmetic. To make it *deliberately perfect*: fix the four trees
that don't survive their own compilers and the one broken capability (P0),
give the consistency boundary its missing concurrency half (P1), bring Phoenix
up to the other backends' boundary discipline (P1), and then spend P2 on the
polish that separates "passes a DDD review" from "gets held up as the
reference": ports over concrete repos, outbox-grade event delivery,
context-shaped namespaces, and artifacts that never overstate the
architecture.
