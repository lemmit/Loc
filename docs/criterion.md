# Criteria — reusable predicate specifications

A `criterion` is a named, parameterised, **pure boolean predicate** over
a candidate type — the Specification Pattern (Eric Evans's
`isSatisfiedBy`, Spring Data's `Specification<T>`) made first-class in
the DSL. It names a cross-aggregate domain rule ("active customer",
"order in region", "may force-close") once, so the rule lives in one
place instead of being inlined and duplicated across `where` clauses and
guards.

> **Status.** This ships the *core* of
> [`docs/old/proposals/criterion.md`](old/proposals/criterion.md): the
> `criterion` declaration, body validation, and **inline use** in every
> existing boolean-expression position. A criterion referenced by a
> [`retrieval`](#reification-retrieval-and-find-criteria)'s or a `find`'s
> `where` additionally **reifies** — it emits a named, constructed
> predicate object on every backend rather than dissolving at compile time
> (see "Reification" below). `when <predicate>` operation guards with their
> auto-exposed side-effect-free `GET /<plural>/{id}/can_<op>` endpoints are
> **shipped on all five backends** — node / .NET / python / elixir / java (a
> false gate → 409 Disallowed; the companion returns `{ allowed }`).
> `Repo.findAll(<Criterion>, page?)` from workflow bodies is **shipped on every
> backend** — it desugars to a synthetic `findAllBy<Criterion>` retrieval (the
> enrich pass materialises it from the context's criteria), so it rides the
> existing retrieval pipeline.  Ordering / fetch-shaping is expressed by an
> **anonymous retrieval** — `Repo.run(retrieval { where: <Criterion> sort: […]
> loads: […] }, page?)` — the call-site twin of a declared `retrieval`; `findAll`
> stays the bare-criterion shorthand, shaping lives on the (named or anonymous)
> retrieval.  Its `where:` is a criterion reference in this release.  The
> single-result `Repo.find(<Criterion>)` is **shipped on every backend** as the
> source of an `if let` workflow statement — `if let x = Repo.find(<Criterion>)
> { … } else { … }` — which binds the first match (non-null) in the then-branch
> and runs `else` on no match (the workflow body's option/null-handling
> construct; it rides the same shared `findAllBy<Criterion>` retrieval as
> `findAll`, capped at one row, so no public endpoint leaks).  A composed
> anonymous `where:` and the `from <Criterion>(args)` parameter binding are
> **not yet shipped**.

## Declaration

```ddd
context Sales {
  enum OrderStatus { Draft, Confirmed, Closed }
  aggregate Customer { active: bool, region: string }
  aggregate Order { status: OrderStatus }
  repository Customers for Customer { }
  repository Orders for Order { }

  // Single-line form. `of Customer` names the candidate; inside the
  // body, bare field names (and `this`) resolve against the candidate
  // aggregate — the same convention as `invariant` / `derived` bodies.
  criterion ActiveCustomer of Customer = active == true

  // Parameterised. (The parameter is named distinctly from the `region`
  // field it compares against — a parameter shadows a same-named field.)
  criterion InRegion(rgn: string) of Customer = region == rgn

  // Block form — identical semantics to `= <expr>`.
  criterion CanForceClose of Order { where: status != Closed }

  // `of bool` — a pure ambient predicate with no candidate (reads only
  // parameters + ambient context such as `currentUser`).
  criterion HasManagerRole of bool = currentUser.role == "manager"
}
```

Grammar:

```
criterion <Name>(<Param>*) of <T> = <bool expression>
criterion <Name>(<Param>*) of <T> { where: <bool expression> }
```

`<T>` (the candidate) must be an **aggregate** or **`bool`** in this
release.

## Composition

Criteria compose with the ordinary boolean operators — the result is
just another boolean expression:

```ddd
criterion EligibleEuCustomer of Customer = ActiveCustomer && InRegion("EU")
```

There is no separate composition machinery: `&&` / `||` / `!` over
criterion references *are* the composition.

## Use sites

A criterion reference is **inlined at compile time** wherever a boolean
expression is expected. Today that means:

```ddd
// View filter:
view ActiveCustomers = Customer where ActiveCustomer

// Repository find filter (composed + parameterised):
repository Customers for Customer {
  find activeInRegion(r: string): Customer[] where ActiveCustomer && InRegion(r)
}

// Invariants and operation preconditions inline criteria the same way.
```

Because the reference is inlined — the predicate body is re-lowered with
its parameters substituted and the candidate rebound to the host
receiver — a criterion-driven `where` produces **exactly the same
lowered expression** (and therefore the same generated SQL) as the
equivalent hand-written inline filter. No backend query-engine change is
involved; criteria ride the existing `where`→SQL path on every backend.

## Reification (retrieval and find criteria)

There are positions where a criterion is **not** dissolved into its host:
when a [`retrieval`](old/proposals/retrieval.md)'s `where`, or a repository
`find`'s `where`, is *exactly* a named criterion reference. There the
criterion **reifies** — the backend emits a named, constructed predicate
object (the Specification pattern made real in generated code) that the
query method consumes, the functional analog of inlining lifted into a
reusable object:

```ddd
criterion NamedLike(needle: string) of Customer = this.name == needle
retrieval ByName(needle: string) of Customer { where: NamedLike(needle) sort: [name asc] }
repository Customers for Customer {
  find named(needle: string): Customer[] where NamedLike(needle)   // reifies too
}
```

| Backend | What the criterion reifies to |
|---|---|
| .NET / EF | a `Criterion<Customer>` (with `IsSatisfiedBy` + a query-side `ToExpression()`), fed into the retrieval's Ardalis `Specification<Customer>` bundle (and into a `find`'s `.Where(crit.ToExpression())`) |
| .NET / Dapper | a parameterised SQL `WHERE` fragment inlined into the retrieval's `Run<Name>Async` / the find method (Dapper emits SQL, not a reified object) |
| Hono / Drizzle | a module-level predicate function `const namedLikeCriterion = (needle) => eq(schema.customers.name, needle)`, called by `run<Name>` and the matching `find` |
| Phoenix / Ecto | a shared query fragment `def named_like_criterion(needle), do: dynamic([c], c.name == ^needle)` the read filters by |
| Java / JPA | a `Specification<T>` factory on `<Agg>Criteria`, consumed via `JpaSpecificationExecutor` (the first backend to consume `CriterionIR` directly) |
| Python / SQLAlchemy | inlines the predicate at the call site (non-reifying) |

A criterion shared by a retrieval and a find reifies to a **single**
predicate object (one module-level fn / one Ecto query fragment), consumed by
both.

The emitted predicate is **byte-identical** to what inlining would
produce — reification is a code-organisation choice, not a behavioural
one, so cross-backend conformance/wire parity is unchanged. The rule for
*when* a criterion reifies is simply **"if it has a name."** A `where`
that is exactly one named criterion reifies; a *composed* one
(`Active && InRegion(r)`) or an anonymous boolean expression (most
invariants, preconditions, capability filters) has nothing to reify and
stays inline. See
[`docs/old/proposals/reified-criteria.md`](old/proposals/reified-criteria.md) for
the full design and the remaining-work register (the anonymous `filter`
capability predicates and the principal/tenancy factory are the parts
that still inline).

## Validation

| Diagnostic | When |
|---|---|
| `loom.criterion-unsupported-target` | Candidate type is neither an aggregate nor `bool` (e.g. `of decimal` — reserved for the future `from`-binding surface). |
| `loom.criterion-impure` | The body calls a mutating `operation`. Criteria are pure — call a pure `function` instead. |
| `loom.criterion-cycle` | A criterion (transitively) references itself. |
| `loom.criterion-arity` | A criterion call supplies the wrong number of arguments. |

The body is an ordinary expression, so mutation (`:=`, `+=`), `emit`,
and workflow calls are already excluded by the grammar.

## See also

- [`docs/old/proposals/criterion.md`](old/proposals/criterion.md) — the full
  design, including the deferred `findAll` / `when` / `from` surfaces.
- [`docs/old/proposals/reified-criteria.md`](old/proposals/reified-criteria.md) —
  the Specification-reification design (shipped for retrieval criteria;
  the remaining-work register for `find` / capability-filter reification).
- [`docs/views.md`](views.md) — views, whose `where` accepts a criterion.
- [`docs/workflow.md`](workflow.md) — repository finds.
