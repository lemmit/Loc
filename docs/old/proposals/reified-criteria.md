# Reified criteria — specifications as constructed objects

> **[2026-06-20 status audit]** Backend count understated — find/retrieval criteria now reify on FIVE domain backends incl. Java (`src/generator/java/emit/repository.ts:~50`); Python emits retrievals but is not yet reified.

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain
> Ecto/Phoenix only; `foundation: ash` is now a validation error.)** Where the text
> below says "Phoenix/Ash" and describes Ash-specific output (a `:boolean` Ash
> calculation, `Ash.Query.filter`, the Ash `actor`, `base_filter`), read it as the
> plain-Ecto/Phoenix backend: the criterion reifies to an Ecto query fragment /
> module-level predicate composed into the context query, not an Ash calculation.
> The Ash idiom is retained only as design history.

> Status: **PARTIAL — retrieval *and* find criteria reified on all four
> backends.** The Specification reframe landed first on the .NET/EF backend
> in four slices: Slice 1a — emit `Criterion<T>` + `IsSatisfiedBy` (the
> in-memory evaluate face, #890); Slice 2a — emit the `ToExpression()` query
> face (#901); Slice 2b — retrievals consume `ToExpression` (#910) and
> `find` consumes it (#926); Slice 3 — the retrieval **Ardalis
> `Specification<T>` bundle**, EF-only (#936); Dapper retrievals as
> parameterised SQL (#943).
> Generated under `src/generator/dotnet/{criteria-emit,spec-emit,find-emit}.ts`;
> `render-expr.ts` gates query-translatable bodies via
> `canEmitToExpressionFor()`. A `retrieval` whose `where` is exactly a named
> criterion now **reifies on Hono** (a module-level Drizzle predicate fn,
> `<name>Criterion`, #952) and **on Phoenix/Ash** (a `:boolean` Ash
> **calculation** the read action filters by, #955) — and the same is now
> true for a repository **`find`** whose `where` is exactly a named criterion
> on Hono (#963) and Phoenix/Ash (#964) (a criterion shared by a find and a
> retrieval reifies to a single fn/calculation). These are code-organisation
> only — the emitted predicate is byte-identical to the inline form, so
> conformance parity is unchanged (functional parity predates the reify).
> Still inline everywhere: the anonymous **`filter` capability** predicates
> on Hono/Ash (the #760/#762 `contextFilters` mechanism) and the
> principal/tenancy factory (`currentUser.<field>` as a constructor arg) —
> reifying those is the remaining work. The architecture below
> reverses the current pipeline's
> "inline everything" decision for `criterion` (and the anonymous `filter`
> capability): instead of substituting a criterion's body into an
> `ExprIR` at every use-site, backends consume `CriterionIR` directly and
> emit a **constructed Specification object** — the Evans / Spring-Data
> `Specification<T>` pattern, made real in the generated code rather than
> dissolved at compile time. This is the design the inline work
> (PRs #760 / #762 / #767, and
> [`criterion-everywhere.md`](./criterion-everywhere.md)) backed into:
> those PRs are the inline approach carried to its limit, and #767 is
> where it visibly cracks. Supersedes the *mechanism* of
> `criterion-everywhere.md` (its selectability model and use-site rules
> survive — see "Relationship to the inline work"). Aligns with
> [`java-backend.md`](./java-backend.md), whose `Specification<T>` emission
> is the same idea on a fourth backend.

## TL;DR

A `criterion` is a **constructed object**, not an inlined expression.
Every operand of its body that is not a stored column is a **constructor
argument** — and `currentUser.<field>` is just one such argument,
resolved at construction time from the request principal. That single
reframe dissolves the special cases the inline approach accreted (find
filters thread `currentUser` as a method parameter; capability filters
read it from an injected accessor — the *same value, two mechanisms, in
one repository*).

Three pieces, identical in shape on every backend:

1. **The spec** — a pure value object built from the criterion body.
   References its constructor args; no ambient access. (.NET / Java
   `Specification<T>`; Hono a closure returning a Drizzle predicate; Ash
   a query fragment built with the actor.)
2. **The factory** — the *one* place request-scoped dependencies are
   read. Holds the injected user-context; constructs specs, binding
   `currentUser.*` and literal arguments.
3. **The consumer** — the repository / query applies a spec
   (`.WithSpecification(spec)` / `.where(spec)` / composed query) and
   knows nothing about principals.

`CriterionIR` stops being "retained for tooling / future query emission"
and becomes the artifact backends actually consume.

## Remaining-work register (shipped ✓ / left ▢)

The retrieval- *and* find-criterion reification paths are **shipped on all
four backends**; everything below is the residue. Each row keys to a phase
in "Implementation sketch (phased)".

| | Work | Backends | Phase | PRs |
|---|---|---|---|---|
| ✓ | `retrieval` `where` = named criterion → reified Specification/predicate object | .NET (EF + Dapper), Hono, Phoenix/Ash | 0 | #890 #901 #910 #926 #936 #943 #952 #955 |
| ✓ | **`find` `where` = named criterion** → same reified object (deduped with the retrieval's); Dapper finds emit inline parameterised SQL, like Dapper retrievals — no reified object | .NET EF, Hono, Phoenix/Ash (Dapper = SQL) | 1 | #926 (.NET EF) #963 (Hono) #964 (Phoenix) |
| ✅ | **Anonymous `filter` capability** predicates reify (the #760/#762 `contextFilters` mechanism) — **Hono** (a `filter <Criterion>` calls the module-level `<name>Criterion` fn) **and Phoenix/Ash** (`base_filter` references an Ash boolean calculation), both deduped with find/retrieval consumers of the same criterion; `AggregateIR.contextFilterRefs` carries the ref | ~~Hono~~, ~~Phoenix/Ash~~ | 1, 3 | — |
| ◐ | **Principal/tenancy** (`currentUser.<field>`) bound at the reified query-face. **.NET + Hono find/retrieval query-faces shipped (DEBT-24):** a `find`/`retrieval` whose `where` references `currentUser` reifies its predicate into a static position (.NET `Specification<T>` ctor; Hono module-level `<name>Criterion` fn) and now resolves the principal through the same ambient accessor the capability filters use — .NET `RequestContext.Current!.CurrentUser!` (the shared `AMBIENT_CURRENT_USER`), Hono `requireCurrentUser()`, so each backend has **one principal source**. This *fixed a latent compile bug on both* — .NET and Hono reify the predicate into a *static position* (the `Specification<T>` ctor / a module-level fn), where it previously named an unbound `currentUser` (.NET CS0103 / Hono `tsc` `Cannot find name`). **Java and Python were audited and are already correct** — neither reifies a principal criterion into a static factory; both route it to the inline query path which binds the principal from the ambient accessor (Java `@Query` SpEL `@currentUserAccessor.user()?.tenantId()`; Python `require_current_user()`), so the compile-bug residue is **drained across every reifying backend**. Still ▢: reifying a principal criterion into a `Criterion<T>`/named *object* (it stays excluded from the static class and falls to the inline path), retiring the now-redundant `usesUser` find-parameter threading, and the **Phoenix** query-face — Phoenix does **not** reify criteria at all today (the Ash reify path was removed), so it needs reification added first (a separate, larger task), not a principal-binding tweak (the held-#767 case) | .NET + Hono ✓; Java + Python already-correct; Criterion-object + `usesUser` retirement + Phoenix ▢ | 2, 3 | (holds #767) |
| ▢ | **`isSatisfiedBy` duality** — route invariant/precondition/guard use-sites through the spec's in-memory face; replace the selectability *validator* with the spec's `toExpression()` capability | all | 4 | — |
| ▢ | **Java** `Specification<T>` falls out for free | Java (when the backend lands) | 5 | see [`java-backend.md`](./java-backend.md) |

The shipped rows are **code-organisation only** — each emits the
byte-identical predicate the inline form did, so conformance/wire parity
is unchanged. The ▢ rows are where reification *changes the shape* of
generated code (the principal-binding factory) or *removes* a mechanism
(the `usesUser` threading), so they land in slices behind the
build-gates, per the sketch.

## The problem the inline model has

The shipped pipeline inlines criteria: `criterion.md` states it
plainly — *"a criterion is inlined wherever it is referenced … the
use-site re-lowers the predicate body with its parameters substituted …
so no backend consumes `CriterionIR` directly today"*
(`src/ir/types/loom-ir.ts` `CriterionIR.body`: *"Use-sites inline a
freshly-substituted copy rather than reading this; it exists for tooling
/ traceability / future query emission"*). The anonymous `filter`
capability (`contextFilters`) is the same thing without a name.

Inlining works while the body is **closed** — `!this.isDeleted` lowers to
a self-contained predicate. It breaks the moment the body references a
value that isn't a column, because an inlined fragment has **nowhere to
bind** a request-scoped value. That is exactly what happened with
`currentUser`:

| Position | How `currentUser` is bound today | Source |
|---|---|---|
| `find … where ownerId == currentUser.id` | **threaded as a method parameter** (`Mine(User currentUser, …)`), passed by the route handler | pre-existing `usesUser` path |
| `filter this.tenantId == currentUser.tenantId` | **read from an injected `ICurrentUserAccessor`** (`_currentUser.User`) | PR #767 |

Same value, **two mechanisms, in the same repository class.** That
incoherence is the symptom. The disease is inlining a thing that wants to
be constructed: a closed expression has no constructor, so each use-site
invents its own way to smuggle the principal in.

## The model

A criterion is the Specification pattern (Evans `isSatisfiedBy`,
Spring-Data `Specification<T>`), and a specification is an **object you
construct**. `InMyTenant` is really `InTenant(tenantId)` where
`tenantId` is a constructor argument bound, at construction, from the
principal. Reading `currentUser.tenantId` as a constructor argument —
rather than an ambient value to smuggle into the query layer — is the
whole design.

### Three pieces (worked, .NET)

```csharp
// 1. The spec — a value object. No ambient access, no magic.
//    One per criterion; constructor args are its non-column operands.
public sealed class InTenant : Specification<Doc>
{
    public InTenant(TenantId t) => Query.Where(d => d.TenantId == t);
}
public sealed class NotDeleted : Specification<Doc>
{
    public NotDeleted() => Query.Where(d => !d.IsDeleted);
}

// 2. The factory — the ONE place currentUser is read, at construction.
//    Holds the request-scoped deps; binds principal- and literal args.
public sealed class DocSpecs(ICurrentUserAccessor user)
{
    public ISpecification<Doc> Tenant()  => new InTenant(user.User.TenantId);
    public ISpecification<Doc> Active()  => new NotDeleted();
    public ISpecification<Doc> Eligible() => Tenant().And(Active());   // composition
}

// 3. The consumer — applies a spec; knows nothing about principals.
var docs = await _db.Docs.WithSpecification(spec).ToListAsync(ct);
```

`currentUser` is now **ordinary** — an argument resolved from the
principal at construction, identical in kind to a literal parameter. The
find path and the capability-filter path construct the same spec the same
way, so the two-mechanisms smell disappears: there is one mechanism.

### Per-backend shape (same three pieces)

| Backend | Spec | Factory | Consumer |
|---|---|---|---|
| **.NET** | `Specification<T>` (Ardalis-style, or hand-rolled `Expression<Func<T,bool>>` holder) | DI service holding `ICurrentUserAccessor` | repo `.WithSpecification(spec)` / `.Where(spec.ToExpression())` |
| **Java** | `org.springframework.data.jpa.domain.Specification<T>` — *literally* the platform type | `@Component` holding the principal accessor | `repository.findAll(spec)` |
| **Hono** | a function `(tenantId) => and(eq(docs.tenantId, tenantId), …)` returning a Drizzle predicate | a factory closure built with the request ctx | `db.select().from(docs).where(spec)` |
| **Phoenix/Ash** | a query fragment / `Ash.Query.filter(...)` builder | built with the Ash `actor` | composed into the read action |

The variation is only in *how each platform spells a predicate object* —
the structure (construct → compose → apply) is identical, which is why
this generalizes instead of special-casing.

## Why this is the senior design, not just a refactor

- **One mechanism for the principal.** The data layer reads the
  request-scoped user-context **once** (every backend already has it:
  .NET `ICurrentUserAccessor`, Hono request ctx, Ash `actor`). Every
  `current-user` reference — find filter, capability filter, future
  positions — resolves against that one source. The find-parameter
  threading retires.
- **`currentUser` stops being a feature.** There is no
  "principal-referencing capability filter" special case to port to two
  more backends. There is a constructor argument that happens to come
  from the principal.
- **Selection ↔ validation becomes structural.** A constructed spec
  carries **both** `toExpression()` (the SQL/Drizzle/Ash predicate) and
  `isSatisfiedBy(candidate)` (the in-memory boolean) on the *same
  object*. The consistency guarantee
  [`criterion-everywhere.md`](./criterion-everywhere.md) tried to enforce
  with a validator ("the rule you query by is the rule you validate by")
  becomes a property of the type — you cannot have two divergent rules
  because there is one object. Selectability stops being a gate and
  becomes "does this spec implement `toExpression()`."
- **`CriterionIR` earns its keep.** It already carries exactly what a
  reified emitter needs — `name`, `params`, `targetType`, `body`
  (`src/ir/types/loom-ir.ts`). Today it is built and then ignored
  (backends read the inlined copy). Here it is *the* input: lower the
  body **once**, recognize a `principal` argument alongside `param`
  args, and never substitute at use-sites.

## Relationship to the inline work (what survives, what is superseded)

`criterion-everywhere.md` and PRs #760 / #762 / #767 are the inline
approach taken to its limit. This proposal **supersedes their
mechanism** but **keeps their semantics**:

| From the inline work | Fate under reification |
|---|---|
| Selectability model (which operands are DB-translatable) | **Survives** — it is now "does the spec implement `toExpression()`," computed once from the body, not re-checked per use-site. |
| Use-site enforcement semantics (gate → 403, filter → row-subset, invariant → 422) | **Survives unchanged** — the consumer decides what applying / failing a spec means. |
| `currentUser.<scalar>` / `now()` as request-time values | **Survives, simplified** — they are constructor arguments, not "bound params threaded per read site." |
| Inlining at use-sites (`lower-expr.ts` substitution) | **Superseded** — criteria are constructed, not substituted. |
| Find-parameter threading of `currentUser` (`usesUser`) | **Superseded** — the factory supplies it. |
| `HasQueryFilter` for non-principal / injected accessor for principal (#767) | **Unified** — one factory-constructed spec, applied uniformly. |
| `contextFilters` as anonymous inlined predicates | **Reified** — a capability `filter` becomes an (anonymous or named) spec applied by the consumer. |
| `retrieval`'s `Run<Name>` method ([`retrieval.md`](./retrieval.md), shipped inline: Hono PR #801, .NET PR #810) | **Reified** — the per-aggregate `RunByXAsync` repo method (which hand-composes `.Where(<inlined criterion>).OrderBy().Skip()`) becomes a constructed bundle: the `retrieval` is the `Specification<T>`, its `where:` criteria are `Criterion<T>` objects fed in via `Query.Where(crit.ToExpression())`. The method shrinks to `repo.ListAsync(spec)`. |

### The retrieval `Run<Name>` method is the inline high-water mark for the bundle

`retrieval.md` ships the **bundle** (`criterion` + sort + loads) inline:
each backend hand-composes a query method (`RunByRegionAsync` on .NET,
`runByRegion` on Hono) whose `.Where(...)` is the **inlined** criterion
body. Reification flips this to the constructed-object shape — and the
.NET target is concretely:

```csharp
// criterion InRegion → a Criterion<T> (the atom)
public sealed class InRegion : Criterion<Customer>
{
    public InRegion(string rgn) => Where(x => x.Region == rgn);
}

// retrieval ByRegion → an Ardalis-style Specification<T> (the bundle)
// that COMPOSES criteria + sort + page — the Criterion<T>-feeds-
// Specification<T> has-a relationship made real in generated code.
public sealed class ByRegion : Specification<Customer>
{
    public ByRegion(string rgn, (int? offset, int? limit)? page = null)
    {
        Query.Where(new InRegion(rgn).ToExpression());   // atom → bundle
        Query.OrderByDescending(x => x.Name);
        if (page is { } p) { /* Skip/Take */ }
    }
}

// the workflow consumer just applies it
var matched = await _customers.ListAsync(new ByRegion(rgn, (0, 100)), ct);
```

`Criterion<T>` / `Specification<T>` stay **generated-C#-local type
names** (Ardalis's vocabulary) — they never become Loom-level words. Loom
keeps `criterion` (atom) + `retrieval` (bundle); the inline `Run<Name>`
methods are simply the pre-reification rendering of the bundle as a
*call* rather than an *object*.

### Disposition of the open PRs (decided)

The inline filter work is a live three-PR stack: **#760** (Hono
filter-capability, non-principal) → **#762** (Phoenix `base_filter`,
non-principal, stacked on #760) → **#767** (.NET principal/tenancy via an
injected `ICurrentUserAccessor`, stacked on #762). #767 is where the
inline mechanism visibly cracks — the two-mechanisms split (find-param
threading vs injected accessor) lives there.

**Decision: land #760 + #762, hold #767.**

- **#760 / #762 ship.** They are non-principal (soft-delete / `filter
  !this.isDeleted`), fix real latent bugs (the dropped bare-boolean
  Drizzle predicate; Phoenix's silent filter no-op), and their *output*
  is exactly what reification would emit for a closed criterion. Nothing
  about them is the redundant mechanism — they're the baseline
  reification builds on, not the part it removes.
- **#767 is held.** Its *output* is right but its *mechanism* (inject the
  principal at the .NET repo, threaded a second, different way from the
  find path) is precisely the redundancy this proposal removes. Rather
  than merge it and then delete it, the principal/tenancy case is
  implemented **directly in reified form** — `currentUser.<field>` as a
  constructor argument bound by the factory — so tenancy ships *once*,
  the clean way, on every backend uniformly.

Trade-off accepted: tenancy stays unshipped slightly longer (it rides
the reification work instead of #767), in exchange for never landing —
then unwinding — the two-mechanisms code. Soft-delete / non-principal
filtering is unaffected: it ships now via #760 / #762.


## Implementation sketch (phased)

This reverses a deliberate pipeline decision, so it lands in slices, each
keeping the suite green.

**Sequencing decision: `retrieval` first.** Rather than begin by tearing
out the shipped inline paths, the work starts on the *greenfield*
[`retrieval.md`](./retrieval.md) surface — a new keyword with no existing
behaviour to preserve. Building `retrieval` end-to-end forces the
`RetrievalIR` / `LoadPlanIR` / `CriterionRefIR` seam into existence
against a clean target, proves the reified-consumption path on a feature
that *only* has the reified path, and only *then* reuses that proven seam
to migrate the inline criterion use-sites underneath. The risky
inline-removal becomes "point the old use-sites at a seam that already
works," not "invent the seam and remove the old code at once."

0. **`retrieval` end-to-end (greenfield).** Grammar + scope + lower to a
   named `RetrievalIR` (the `where` lowers through a *reified*
   `CriterionRefIR` — the first real consumer) + `LoadPlanIR` (default
   `whole(agg)`) + `Repo.run`; emit on all backends. No inline code
   touched; nothing to keep green except the new tests. This stands up
   the whole seam. (See `retrieval.md` §Phasing.)
1. **Stop inlining; keep constructing.** With the seam proven, lower the
   criterion body once and have *inline* use-sites carry a
   `CriterionRefIR` (the same node `retrieval` already uses) instead of a
   substituted body. Resolve a `current-user` operand to a recognized
   `principal` argument kind (alongside `param`).
   (`src/ir/lower/lower-expr.ts`, `loom-ir.ts`.)
2. **Principal/tenancy directly in reified form (.NET first).** Emit spec
   + factory + consumer; the held-#767 case (`currentUser.tenantId`)
   lands here as a constructor argument bound by the factory — *not* the
   injected-accessor mechanism #767 used. Delete the `usesUser` find
   threading. Prove `dotnet build /warnaserror` green.
3. **Hono, then Phoenix.** Same three pieces; retire their inline render
   paths (the non-principal #760 / #762 output stays byte-identical,
   now produced by the reified path). Prove `hono-build` /
   `phoenix-build` gates.
4. **Selection/validation duality.** Emit `isSatisfiedBy` on each spec;
   route invariant/precondition/guard use-sites through it. Replace the
   selectability *validator* with the spec's `toExpression()`
   capability.
5. **Java** (when the backend lands) — `Specification<T>` falls out for
   free; this is the proposal's natural payoff
   ([`java-backend.md`](./java-backend.md)).

## Naming — "Specification" is a backend word, not a Loom word

The word "Specification" is overloaded across the ecosystems this design
touches, and the overload is the source of real confusion. Pinning it:

- **Hibernate** splits `Criterion` (a predicate fragment) from `Criteria`
  (a full query). **Spring Data JPA** has `Specification<T>` as its
  *predicate* type (composed with `.and()/.or()`), and no bundle type at
  all — the bundle is the `findAll(spec, Pageable)` *call*. **Ardalis
  (.NET)** uses `Specification<T>` for the *bundle* (predicate + sort +
  page + includes in one object). So the same word, "Specification,"
  names the **atom** on JPA and the **bundle** on .NET. The frameworks
  disagree.

Loom therefore does **not** adopt "Specification" as a source keyword or
an IR type name. The word stays *generated-code-local*, meaning whatever
the target framework makes it mean. Loom's vocabulary lives on three
strictly separated shelves:

| Shelf | Atom (predicate) | Bundle (predicate + sort + loads) |
|---|---|---|
| **Source keyword** | `criterion` *(shipped)* | `retrieval` *(see [`retrieval.md`](./retrieval.md))* |
| **IR type** | `CriterionIR` / `CriterionRefIR` | `RetrievalIR` (+ `LoadPlanIR` for the fetch shape) |
| **Generated-code-local** | .NET `Criterion<T>` · JPA `Specification<T>` · Hono predicate closure · Ash filter fragment | .NET Ardalis `Specification<T>` · JPA `findAll(spec, Pageable)` · Hono query builder · Ash read action |

The discipline: **`criterion` and `retrieval` are the only words an
author writes; `CriterionIR` / `LoadPlanIR` / `RetrievalIR` are the only
names the IR uses; "Specification" never travels upward from generated
code.** That is why a reified criterion can emit *as* a JPA
`Specification<T>` (the atom) and *as* part of an Ardalis
`Specification<T>` (the bundle) without any clash in Loom's own model —
those names simply don't exist at the Loom level.

### The internal seam — `CriterionIR` + `LoadPlanIR` + `RetrievalIR`

Reifying criteria introduces two IR-level structures, paired at every
retrieval site. They are deliberately **separate** because they have
different lifetimes:

```
CriterionIR     — the predicate atom. Shared: one per `criterion`,
                  reused at every use-site. Reified (this proposal);
                  use-sites reference it via CriterionRefIR, not inline.

LoadPlanIR      — the fetch shape for one retrieval. Per use-site:
                  the same criterion can be retrieved with different
                  load shapes at different calls. Default value is
                  `whole(agg)` — the full owned aggregate tree,
                  cross-aggregate refs as ids (the default-whole policy
                  from load-specifications.md). Enrich-phase derivable
                  from the aggregate's `contains` + fields, exactly like
                  `wireShape`; `loads:` transforms it (restrict / expand).

RetrievalIR     — the bundle node tying them together:
                  { criterion: CriterionRefIR, sort?, loadPlan,
                    targetType }.  No `page` field — pagination is a
                  call-site argument on the retrieval's executor, never
                  part of the bundle.
```

The predicate is shared and stable; the load shape is per-call and
derived. Folding them into one object would force either re-deriving the
predicate per site (back to inlining) or attaching a per-site load shape
to a shared object (wrong scope) — so the honest model is two
structures, met at `RetrievalIR`.

**`LoadPlanIR` is a second *secondary, derived* IR** — the first being
`MigrationsIR` (CLAUDE.md: *"the only secondary IR is `MigrationsIR`"*).
This is a deliberate addition, justified the same way: derive once,
share across every backend. Its **default (`whole(agg)`) is structural**
(no analysis — falls straight out of the aggregate shape in enrich phase
⑥); only the *narrowing* of that default by body inference is
analysis-heavy, and that — like `load-specifications.md`'s inference — is
explicitly **v2**. v1 populates `LoadPlanIR` from `whole(agg)` +
explicit `loads:` only.

The synthesised-vs-named axis: ad-hoc `Repo.findAll(criterion, sort?,
page?, loads?)` synthesises a `RetrievalIR` per call; a declared
`retrieval` ([`retrieval.md`](./retrieval.md)) lowers to a *named,
reusable* one. Same node, two doors.

## Open questions

1. **Anonymous capability filters.** `filter !this.isDeleted` has no
   name. Reify it as an anonymous spec applied by the consumer, or
   synthesize a name? (Lean: anonymous spec; the consumer composes it
   into the base query.)
2. **Spec library dependency (.NET).** Adopt Ardalis.Specification (a
   real dependency, well-known) or emit a minimal in-tree
   `Specification<T>` base? (Lean: minimal in-tree — no new runtime dep,
   matches the "emit, don't depend" stance elsewhere.)
3. **`isSatisfiedBy` for non-selectable bodies.** A validation-only
   criterion (domain-method calls) has no `toExpression()` but does have
   `isSatisfiedBy`. The spec type must allow one without the other —
   model as two optional capabilities on the spec, surfaced to the
   use-site check.
4. **Composition across candidates.** `&&` over two `of Doc` specs is an
   `.And()`; the existing validator already forbids cross-candidate
   composition — keep that rule.
5. **Migration ordering vs. the open PRs** — *decided* (see "Disposition
   of the open PRs"): land #760 + #762, hold #767, reify the principal
   case directly. Sequencing: `retrieval` first (see "Implementation
   sketch").

## Cross-references

- [`criterion-everywhere.md`](./criterion-everywhere.md) — the inline
  approach this supersedes; its selectability + enforcement semantics
  survive.
- [`criterion.md`](./criterion.md) — the parent criterion design
  (`from` / `when` / `findAll` surfaces); reification is compatible with
  those use-sites (they construct + apply specs).
- [`retrieval.md`](./retrieval.md) — the named *bundle* keyword
  (`retrieval` + `Repo.run`) that graduates the `RetrievalIR` /
  `LoadPlanIR` seam defined here into source.
- [`java-backend.md`](./java-backend.md) — `Specification<T>` emission is
  this proposal on the Java backend; the two should land together.
- [`docs/criterion.md`](../../criterion.md) — shipped criterion core.
- [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) —
  tenancy is the motivating principal-argument case; the factory is where
  `WHERE TenantId = @currentTenant` is constructed.
