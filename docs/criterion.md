# Criteria — reusable predicate specifications

A `criterion` is a named, parameterised, **pure boolean predicate** over
a candidate type — the Specification Pattern (Eric Evans's
`isSatisfiedBy`, Spring Data's `Specification<T>`) made first-class in
the DSL. It names a cross-aggregate domain rule ("active customer",
"order in region", "may force-close") once, so the rule lives in one
place instead of being inlined and duplicated across `where` clauses and
guards.

> **Status.** This ships the *core* of
> [`docs/proposals/criterion.md`](proposals/criterion.md): the
> `criterion` declaration, body validation, and **inline use** in every
> existing boolean-expression position. The proposal's further surfaces —
> `Repo.findAll(criterion, sort?, page?, loads?)`, `when <Criterion>`
> operation guards with auto-exposed `can-<op>` endpoints, and
> `from <Criterion>(args)` parameter binding — depend on the
> exception-less / payload-transport layers and are **not yet shipped**.

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

- [`docs/proposals/criterion.md`](proposals/criterion.md) — the full
  design, including the deferred `findAll` / `when` / `from` surfaces.
- [`docs/views.md`](views.md) — views, whose `where` accepts a criterion.
- [`docs/workflow.md`](workflow.md) — repository finds.
