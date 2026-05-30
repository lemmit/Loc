# Reified criteria — specifications as constructed objects

> Status: **PROPOSED / architectural.** Reverses the current pipeline's
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

### Disposition of the open PRs

Two options; this proposal recommends the first:

1. **Land #760 / #762 / #767 as the inline high-water mark, refactor on
   top.** They are correct, tested, and tenant-safe *as output*; merging
   them keeps the feature working while reification lands incrementally
   behind them. Reification then deletes the inline paths it replaces.
   Lower risk; the migration is a series of "replace inline render with
   spec construction" changes, each gated by the existing tests.
2. **Hold #767 (the one that cracks) and reify the principal case
   directly.** Cleaner history, but larger first step and leaves tenancy
   unshipped longer.

Recommendation: **option 1.** #767's *output* is right; its *mechanism* is
the redundant one this proposal removes — and removing it is safer as a
follow-up refactor against green tests than as a prerequisite.

## Implementation sketch (phased)

This reverses a deliberate pipeline decision, so it lands in slices, each
keeping the suite green.

1. **Stop inlining; keep constructing.** Lower the criterion body once;
   resolve a `current-user` operand to a recognized `principal` argument
   kind (alongside `param`). Use-sites carry a *reference* to the
   criterion + its argument expressions, not a substituted body.
   (`src/ir/lower/lower-expr.ts`, `loom-ir.ts` — `CriterionIR` already
   has the fields; add a `CriterionRefIR` use-site node.)
2. **One backend end-to-end (.NET).** Emit spec + factory + consumer;
   delete the inline `HasQueryFilter`/injected-accessor split and the
   `usesUser` find threading. Prove `dotnet build /warnaserror` green.
3. **Hono, then Phoenix.** Same three pieces; retire their inline render
   paths. Prove `hono-build` / `phoenix-build` gates.
4. **Selection/validation duality.** Emit `isSatisfiedBy` on each spec;
   route invariant/precondition/guard use-sites through it. Replace the
   selectability *validator* with the spec's `toExpression()`
   capability.
5. **Java** (when the backend lands) — `Specification<T>` falls out for
   free; this is the proposal's natural payoff
   ([`java-backend.md`](./java-backend.md)).

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
5. **Migration ordering vs. the open PRs** — option 1 vs. 2 above;
   pinned by the maintainer.

## Cross-references

- [`criterion-everywhere.md`](./criterion-everywhere.md) — the inline
  approach this supersedes; its selectability + enforcement semantics
  survive.
- [`criterion.md`](./criterion.md) — the parent criterion design
  (`from` / `when` / `findAll` surfaces); reification is compatible with
  those use-sites (they construct + apply specs).
- [`java-backend.md`](./java-backend.md) — `Specification<T>` emission is
  this proposal on the Java backend; the two should land together.
- [`docs/criterion.md`](../criterion.md) — shipped criterion core.
- [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) —
  tenancy is the motivating principal-argument case; the factory is where
  `WHERE TenantId = @currentTenant` is constructed.
