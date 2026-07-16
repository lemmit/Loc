# Retrieval — the named query bundle (`criterion` + sort + page + loads)

> **[2026-06-20 status audit]** Retrieval emission ships on all FIVE backends now (add Java `java/emit/repository.ts:~138` + Python `python/repository-builder.ts:~336`), not 'four'. Explicit `loads:` plan still gated (`loom.retrieval-loads-unsupported`, `query-checks.ts:~204`).

> Status: **PARTIAL.** Surface + IR + lowering + validation shipped (#794);
> emission shipped on **all five backends** — .NET `Run<Name>Async` + workflow
> `foreach` (#810), Hono `run<Name>` (#952), Phoenix Ecto context query (#955).
> *(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain
> Ecto/Phoenix only and `foundation: ash` is a validation error — the Phoenix
> retrieval now emits a plain Ecto query, not an Ash read action.)*
> Remaining: the explicit `loads:` load-plan (gated
> `loom.retrieval-loads-unsupported` — retrievals load the whole aggregate;
> no backend consumes a load plan yet). Adds one source
> keyword, `retrieval`, and one repository builtin, `Repo.run(...)`. A
> `retrieval` names a reusable, pre-shaped query: a composed `criterion`
> predicate plus `sort` and `loads` shaping. It is the *bundle* layer the
> criterion family has always implied but never named — Hibernate's
> `Criteria` to `criterion`'s `Criterion`, Ardalis's `Specification<T>`
> to a predicate, Spring's `FluentQuery` to a `Specification`. Depends on
> [`criterion.md`](./criterion.md) (the predicate atom) and
> [`load-specifications.md`](./load-specifications.md) (the `loads:`
> shape + default-whole policy); realised internally by the
> `RetrievalIR` / `LoadPlanIR` seam described in
> [`reified-criteria.md`](./reified-criteria.md).

## TL;DR

A `criterion` is a **predicate** — `isSatisfiedBy(t) → bool`, the atom.
A **retrieval** is the **bundle**: that predicate *plus* the shaping a
real query carries — ordering, eager-load shape, (and, at the call site,
pagination). Where `criterion.md` covered the bundle only as an *ad-hoc
call* (`Repo.findAll(criterion, sort?, page?, loads?)`), `retrieval`
lets you **name** it, declare it once, review it as a unit, and run it
from a workflow:

```ddd
context Sales {
  criterion ActiveCustomer of Customer = this.active
  criterion InRegion(region: string) of Customer = this.region == region

  retrieval ActiveInRegion(region: string) of Customer {
    where:  ActiveCustomer && InRegion(region)   # composed predicate
    sort:   [name asc]                           # ordering (part of the rule)
    loads:  [this.address]                       # eager-load shape (past default-whole)
  }
}

workflow regionalActives(region: string): Customer[] {
  # page is supplied per call — it is request state, not part of the rule:
  return Customers.run(ActiveInRegion(region), page: { offset: 0, limit: 50 })
}
```

`where` / `sort` / `loads` are **fixed by the retrieval** (they are the
named rule). `page` is **call-site only** (it is request state and
varies per invocation). That split is the whole design decision: the
durable shape is named; the volatile shape is an argument.

## Why a named bundle (and why now)

`criterion.md` deliberately split the predicate (`criterion`, shipped)
from query shaping (sort/page/loads, per-call), and explicitly declined
a "Specification" keyword that bundled them, because the ad-hoc
`Repo.findAll(criterion, sort?, page?, loads?)` covered the
"repository-with-40-methods" problem without a new construct. That holds
for one-off queries. It leaves two gaps:

1. **No name for a reused shape.** A query used from five workflows —
   same predicate, same ordering, same eager-load set — is retyped five
   times, and the `sort` / `loads` can silently drift between call sites.
   The predicate is named (the `criterion`); the *shape around it* is
   not.
2. **No reviewable unit.** "What does the active-orders list load, and in
   what order?" has no single declaration to point at. The answer is
   smeared across call sites.

`retrieval` names the shape once. It is to `criterion` what a saved
`view` is to an inline `where` — the same composition, hoisted to a
declaration with an identity, a signature, and one place to change.

This is the bundle layer the precedents always had above the predicate:

| Ecosystem | predicate atom | **bundle** |
|---|---|---|
| Hibernate | `Criterion` | `Criteria` (full query) |
| Spring Data JPA | `Specification<T>` | `findBy(spec, FluentQuery)` / `findAll(spec, Pageable)` |
| Ardalis (.NET) | `Expression<Func<T,bool>>` | `Specification<T>` (criteria + sort + page + includes) |
| **Loom** | **`criterion`** | **`retrieval`** |

## Surface — declaration

Slotted shape, mirroring `criterion`. The `of <T>` annotation is the
aggregate the retrieval returns. Slots:

```
retrieval <Name>(<Param>*) of <T> {
  where:  <bool expression>        # required — composed criteria / inline predicate
  sort:   [<field> asc|desc, ...]  # optional — default: unordered (insertion/PK order)
  loads:  [<path>, ...]            # optional — default: whole(T) (see load-specifications.md)
}

# Single-line shorthand, when only `where` is set:
retrieval <Name>(<Param>*) of <T> = <bool expression>
```

- **`where`** is the predicate. It is the *same* expression position as
  `criterion`'s `where:` and `find … where` — so it composes named
  criteria with `&&` / `||` / `!`, or inlines a bare predicate. The
  selectability rules from [`criterion-everywhere.md`](./criterion-everywhere.md)
  apply unchanged (a retrieval's `where` is a selection position).
  Candidate references follow the shipped `criterion` convention —
  **bare field names + `this`** (`this.active`, `region == "EU"`), *not*
  a `self` receiver. `self` is not a Loom token; the `this.<path>` forms
  in the `loads:` examples below mean "rooted at the candidate `T`."
- **`sort`** uses the existing ordering vocabulary (`[name asc, createdAt desc]`).
- **`loads`** uses the path-expression syntax from
  [`load-specifications.md`](./load-specifications.md) and **transforms
  the default-whole load** — restrict to a subset or expand past the
  aggregate boundary (eager cross-aggregate refs). Omitted → `whole(T)`.

Examples:

```ddd
# Minimal — predicate only; sort unordered, loads default-whole.
retrieval AllActive of Customer = ActiveCustomer

# Parameterised, ordered, expanded load.
retrieval HighValueInRegion(region: string, floor: Money) of Order {
  where:  InRegion(region) && OrderTotalAtLeast(floor)
  sort:   [total desc, createdAt asc]
  loads:  [this.lines[].product, this.customer.address]   # eager cross-agg
}

# Restricted load for a high-throughput read path.
retrieval ActiveIds of Customer {
  where:  ActiveCustomer
  loads:  [this.id, this.status]                          # subset; skip the owned tree
}
```

## Running a retrieval — `Repo.run`

Every repository gains a builtin:

```
Repo.run(<Retrieval>(args), page?) : <T>[]
```

- The retrieval supplies `where` / `sort` / `loads`.
- `page` is an optional **call-site** argument — `{ offset, limit }` —
  never part of the declaration. Omitted → unpaged (all matching rows,
  subject to the retrieval's `loads`).
- Returns `<T>[]` (or the paged carrier when `payload-transport-layer.md`
  pagination lands; see Open questions).

```ddd
workflow priceRegional(region: string) {
  # named retrieval, paged at the call site:
  let orders = Orders.run(HighValueInRegion(region, Money(1000, "EUR")),
                          page: { offset: 0, limit: 100 })
  for o in orders {
    o.applyPricing()   # loads: [this.lines[].product] already covers applyPricing's needs
  }
}
```

### `run` vs `findAll` — both stay

`retrieval` does **not** replace the ad-hoc `Repo.findAll(criterion,
sort?, page?, loads?)` from `criterion.md`. They are the named and
anonymous forms of one mechanism:

| Form | Call | Use when |
|---|---|---|
| ad-hoc | `Repo.findAll(ActiveCustomer && InRegion("EU"), sort: …, loads: …)` | one-off; shape not reused |
| **named** | `retrieval X { … }` + `Repo.run(X(args), page?)` | shape reused / named / reviewed |

`findAll` is the inline expression of a retrieval; `run` executes a
declared one. The decision is "distinct builtin, not an overload of
`findAll`" — `run` reads as "execute this named, pre-shaped query," and
keeps `findAll`'s signature single-meaning.

### The `loads` interaction — default-whole still holds

A retrieval with **no** `loads:` slot loads `whole(T)` — the full owned
aggregate tree, cross-aggregate refs as ids
([`load-specifications.md`](./load-specifications.md) §"Default is whole
aggregate"). The same compile-time `loads`-sufficiency checks apply: if a
workflow calls `o.applyPricing()` (which declares `loads Order {
lines[].product }`) on the result of a retrieval whose `loads` doesn't
cover that path, `loom.retrieval-loads-insufficient` fires — exactly as
for a bare `findAll(…, loads: …)`. Naming the bundle does not change the
load contract; it just attaches it to a declaration.

## Internal model — lowers to `RetrievalIR`

`retrieval` is the **source-level realisation of the `RetrievalIR`
bundle node** introduced in [`reified-criteria.md`](./reified-criteria.md).
Before this proposal, `RetrievalIR` is synthesised only for ad-hoc
`findAll` call sites; with `retrieval`, a declaration lowers to a named,
reusable `RetrievalIR`:

```
RetrievalIR {
  name, params,
  targetType,                       # of <T>
  criterion : CriterionRefIR,       # the composed predicate (reified, shared)
  sort?     : SortIR,
  loadPlan  : LoadPlanIR,           # default whole(T); transformed by `loads:`
  # NB: no page field — page is a call-site argument on Repo.run, never on the node
}
```

- **`CriterionRefIR`** — the `where` lowers through the *reified* path
  (it references criteria, it does not inline them) — this is the first
  real consumer of the reified-criteria model for named bundles.
- **`LoadPlanIR`** — `whole(T)` by default (enrich-phase derivable from
  the aggregate's `contains` + fields, like `wireShape`); `loads:`
  narrows or expands it.
- **No `page`** — pagination enters at `Repo.run`'s call site as an
  argument, lowered onto the *call*, not the retrieval node. This is the
  IR encoding of the page-is-call-only decision.

The three-shelf naming discipline (see `reified-criteria.md` §"Naming"):
`criterion` and `retrieval` are the only **source** words; `CriterionIR`
/ `LoadPlanIR` / `RetrievalIR` are **IR** names; the emitted bundle is
spelled in each backend's **own idiom** and never imported upward.

## Per-backend emission

A `retrieval` is what each backend renders as its native query bundle:

| Backend | Bundle render |
|---|---|
| **Hono / Drizzle** | a pre-shaped query builder — `db.select().from(t).where(spec).orderBy(…).limit(?).offset(?)` with the eager-load joins/`findManyByIds` batch the `loadPlan` implies; `page` spliced from the `run` arg |
| **.NET / EF Core** | an Ardalis-style `Specification<T>` object holding `Query.Where(crit.ToExpression())` + `OrderBy` + `Include(…)`; `page` applied as `Skip/Take` from the `run` call |
| **JPA / Spring** | a `Specification<T>` (the predicate) executed via `findAll(spec, Pageable)`; `sort` → `Sort`, `page` → `PageRequest`, `loads` → `@BatchSize` on owned collections + `@EntityGraph` for cross-aggregate to-one expansion (see `load-specifications.md`; **not** a hand-rolled CriteriaBuilder fragment) |
| **Phoenix / Ecto** | a composable `Ecto.Query` built in the context module; `sort`/`loads`/page as query options. *(Superseded 2026: the Ash foundation was removed — the original row read "a read action / `Ash.Query` composed with the actor".)* |

The framework word (`Specification<T>`, `Criteria`, `FluentQuery`) stays
**generated-code-local**. Loom's upward name is `retrieval`.

## Validation

- **`where` selectability** — a retrieval's `where` is a selection
  position; the `loom.criterion-not-selectable` rule
  ([`criterion-everywhere.md`](./criterion-everywhere.md)) applies.
- **`sort` fields exist on `T`** — `loom.invalid-sort-field`.
- **`loads` paths exist** — `loom.invalid-path` (shared with
  `load-specifications.md`).
- **`loads` sufficiency at `run` consumers** —
  `loom.retrieval-loads-insufficient`, as for `findAll`.
- **Cross-candidate composition forbidden** — `&&` over two criteria of
  different `of T` is already rejected; unchanged.
- **`page` only on `run`** — a `page:` slot inside a `retrieval { … }`
  is a parse/validate error (`loom.retrieval-no-page-slot`), pointing the
  author to pass `page:` at the call.

## Grammar sketch

Adds a `Retrieval` context member next to `Criterion`
(`ddd.langium:612` `ContextMember` alternation):

```langium
Retrieval:
  'retrieval' name=ID ('(' (params+=Param (',' params+=Param)*)? ')')?
  'of' target=TypeRef
  ( '=' where=Expr
  | '{' 'where' ':' where=Expr
        ('sort'  ':' sort=SortList)?
        ('loads' ':' loads=PathList)?
    '}' );
```

`Repo.run` joins the repository builtin set alongside `getById` /
`findById` / `findAll` (`criterion.md` §"Repository list queries");
`page?` is an optional trailing named argument on the call.

## Phasing

Follows the standard add-a-language-feature recipe
(`docs/technical.md`), and depends on the reified-criteria seam:

1. **Grammar + scope** — `retrieval` decl, `Repo.run` call; scope the
   `where` against context criteria + the candidate `T`.
2. **IR** — lower to the named `RetrievalIR` (reuse the
   reified-criteria node); `LoadPlanIR` default `whole(T)` + `loads:`
   transform; `page` on the `run` call node.
3. **Validate** — the rules above (selectability, sort/loads paths,
   loads-sufficiency, no-page-slot).
4. **Backends** — render the bundle per the table; reuse each backend's
   existing find/order/paginate/eager-load machinery.
5. **Tests** — one parse, one negative (page-slot / non-selectable /
   loads-insufficient), one generator test per backend, one workflow
   `Repo.run` e2e.

## Open questions

1. **Paged return carrier.** `Repo.run(R, page: …)` returning a bare
   `T[]` loses the total count. When `payload-transport-layer.md`
   pagination lands, `run` with a `page:` arg should return the paged
   carrier (`T page`) instead; until then, `T[]`. Pin the carrier when
   that layer ships.
2. **Anonymous-criterion `where`.** A `retrieval` whose `where` is a bare
   inline predicate (not a named criterion) — reify it as an anonymous
   `CriterionRefIR`, consistent with `reified-criteria.md`'s anonymous
   `filter` handling.
3. **`sort` / `loads` as call-site *overrides*.** Should `Repo.run`
   accept `sort:` / `loads:` overrides like `findAll` does, or are those
   sealed by the declaration (only `page` is call-site)? Lean: sealed —
   if you need a different shape, declare a different retrieval or drop
   to `findAll`. Keeps the named shape meaningful.
4. **Retrieval-calls-retrieval / composition.** Can one retrieval's
   `where` reference another retrieval (not just criteria)? Lean: no —
   compose at the `criterion` layer (predicates compose; bundles don't),
   matching `criterion && criterion`.

## Cross-references

- [`criterion.md`](./criterion.md) — the predicate atom and the ad-hoc
  `Repo.findAll(criterion, sort?, page?, loads?)`; `retrieval` is its
  named form, `run` its named executor.
- [`reified-criteria.md`](./reified-criteria.md) — the `RetrievalIR` /
  `LoadPlanIR` / `CriterionRefIR` internal seam and the three-shelf
  naming discipline this keyword graduates into.
- [`load-specifications.md`](./load-specifications.md) — `loads:` syntax,
  default-whole, and the JPA `@BatchSize` / `@EntityGraph` fetch story.
- [`criterion-everywhere.md`](./criterion-everywhere.md) — selectability
  of the `where` predicate (selection position).
- [`java-backend.md`](./java-backend.md) — JPA `Specification<T>` +
  `findAll(spec, Pageable)` is this proposal's bundle on the Java
  backend.
