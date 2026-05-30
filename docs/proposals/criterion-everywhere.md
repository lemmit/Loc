# Criterion everywhere — the selectability model

> **Mechanism superseded by
> [`reified-criteria.md`](./reified-criteria.md).** This doc's *inline*
> approach (substitute the criterion body at each use-site; bind
> `currentUser` per use-site) is replaced by constructing a Specification
> object, where `currentUser` is an ordinary constructor argument. **This
> doc's *semantics* survive** — its selectability model and use-site
> enforcement rules are kept by reification; only the inlining mechanism
> changes.

> Status: **DRAFT / refinement.** Sharpens one under-specified corner of
> [`docs/proposals/criterion.md`](./criterion.md) — the "queryable
> subset" — into a concrete, per-operand **selectability** classification,
> and folds `currentUser` / `now()` into it as request-time bound
> parameters. Builds on the shipped core
> ([`docs/criterion.md`](../criterion.md)), which already inlines a
> criterion reference into *every* boolean-expression position (`find` /
> `view` `where`, invariants, operation preconditions). Nothing here
> changes the grammar; it is a validator + lowering + IR-tagging
> refinement. Adjacent to
> [`docs/auth.md`](../auth.md),
> [`docs/capabilities.md`](../capabilities.md),
> [`docs/proposals/multi-tenancy-design-note.md`](./multi-tenancy-design-note.md).

## TL;DR

A `criterion` is one named predicate, but it is consumed in two
*structurally different* ways:

- **Selection** — pushed into a SQL `WHERE` clause (`find` / `view`
  filter, `filter` capability). Must be **DB-translatable**.
- **Validation** — evaluated in-memory in domain logic (invariant,
  `precondition`, `requires`/`when` gate). May use the **full**
  expression language.

The earlier proposal gates criterion bodies on a single global "queryable
subset." That is too coarse: it would reject perfectly good
*validation-only* criteria (e.g. anything calling a domain method),
**and** it draws the selectable boundary in the wrong place by excluding
`currentUser`. This note replaces the global rule with a **per-leaf-operand
classification**, decided *per use-site*:

1. **A criterion is selectable iff every leaf operand is a column,
   literal, or request-time scalar, and every operator is
   DB-expressible.** `currentUser.<scalarField>` and `now()` are
   request-time scalars — they **bind as parameters**, exactly like a
   `find` argument. So they are selectable, not excluded.
2. **What stays validation-only** is behavioural: domain-method calls,
   computed capability checks (`permissions.canX`), and cross-aggregate
   navigation that is not a representable join. Those have nothing to
   bind.
3. **Enforcement semantics belong to the use-site, not the criterion.**
   The same boolean means "403 the request" as a gate, "subset the rows"
   as a filter, and "422 the write" as an invariant. The criterion is
   shared; the consequence of failure is the position's.

## Why this matters: source-DRY's real payoff is consistency

The shipped feature already lets you *name* a rule once and reference it
from `find`, `view`, invariant, and `precondition`. The duplication worth
eliminating is not the second mention of `ActiveCustomer` — it is the
same business rule **restated in two different syntactic forms** that can
silently drift:

```ddd
criterion Eligible of Customer = active == true && region == "EU"

find eligible(): Customer[] where Eligible          // selection
operation enroll() { precondition Eligible }         // validation — same rule, can't drift now
```

Unify them under one `criterion` and the compiler *guarantees* the rule
you query by is the rule you validate by. That guarantee is only sound if
the selection use and the validation use are both legal for that
particular criterion — which is exactly what the selectability model
decides. Without it, "criterion everywhere" is a footgun: drop an
ambient predicate into a `find where` and you get either a compile error
deep in the backend or, worse, silently wrong SQL.

## Background: what already ships, what this adds

| Already shipped (`docs/criterion.md`) | This note adds |
|---|---|
| `criterion` declaration, purity check, cycle/arity checks | — |
| Inline use in `find` / `view` `where`, invariant, `precondition` | A **per-use-site** legality check (selection vs validation) |
| Candidate convention: bare field names + `this` | `currentUser` / `now()` as **request-time bound params** in selection |
| One global "queryable subset" notion (in the proposal) | Replaced by **per-leaf-operand selectability** |
| Per-error status codes scattered across surfaces | A single **use-site-owns-enforcement** rule |

## The selectability model

A criterion body is **selectable** (can be lowered into a `WHERE`
clause) when both of the following hold.

### 1. Every leaf operand is bindable

| Leaf operand | Selectable as | Notes |
|---|---|---|
| stored column of the candidate (`region`, `ownerId`) | column ref | the common case |
| literal (`"EU"`, `true`, `42`) | literal | — |
| criterion parameter (`rgn` from `InRegion(rgn)`) | bound param | already works |
| **request-time scalar** — `currentUser.<scalarField>`, `now()` | **bound param** | the refinement; see below |
| derived prop that reduces to a SQL expression (`total` = Σ lines) | computed column / correlated subquery | iff the derivation is itself selectable |
| behavioural method call (`this.computeRisk()`, a pure `function` with a body the DB can't evaluate) | — | **validation-only** |
| computed capability (`permissions.canForceClose`) | — | **validation-only** |
| cross-aggregate navigation that is not a representable join | — | **validation-only** |

`currentUser.orders.any(...)` (navigating the *principal's* relations,
which may live in another bounded context/service) is **not** a
representable join from this aggregate's table and stays validation-only.
`ownerId == currentUser.id` is.

### 2. Every operator is DB-expressible

`==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, `in`, and the
collection ops that already lower to join-subqueries today
(`.contains(...)`, `.any(p)`, `.all(p)`). A `match` over an enum lowers
to a `CASE`/`IN` set and is selectable when its arms are. Anything else
(arbitrary lambdas, non-translatable folds) is validation-only.

### The rule

> A criterion is **legal in a selection position** (`find` / `view`
> `where`, `filter` capability) iff it is selectable. It is **legal in a
> validation position** (invariant, `precondition`, `requires` / `when`)
> **always** (subject to the existing purity check). Selectable ⊂
> validatable.

Reuse the *existing* find-filter translation as the oracle: a criterion
is selectable iff `lowerToDrizzle` (and its `.NET` / Ash / JPQL peers)
can lower its body. That check already exists for inline `find where`
filters — selectability classification is running it over the
**inlined** criterion body and surfacing the result as a diagnostic
instead of an internal throw.

### Diagnostic

| Diagnostic | When |
|---|---|
| `loom.criterion-not-selectable` | A criterion used in a `find` / `view` `where` or `filter` capability has a non-bindable leaf operand or non-DB-expressible operator. Message names the offending operand and suggests moving the use to a validation position (or splitting the criterion). |

Validation positions need no new diagnostic — the purity check
(`loom.criterion-impure`) already governs them, and the full expression
language is otherwise fair game.

## `currentUser` and `now()` as request-time bound parameters

The earlier proposal lists `currentUser.role` under both the "queryable
subset" and the in-memory `when` vocabulary without saying how it crosses
into SQL. It crosses the same way a `find` argument does: its **value is
known when the query executes**, so it binds as a parameter. Every
backend already has the ambient accessor:

| Backend | Principal accessor | Bound form |
|---|---|---|
| Hono / Drizzle | request context | closed-over runtime value: `eq(orders.ownerId, principal.id)` |
| .NET / EF Core | `IHttpContextAccessor` / injected `ICurrentUser` | `.Where(x => x.OwnerId == _principal.Id)` |
| Spring / JPA | `SecurityContextHolder` | `:currentUserId` named param |
| Phoenix / Ash | the actor | `^actor(:id)` — first-class current-actor-in-filter |

So `criterion OwnedByMe of Order = ownerId == currentUser.id` lowers to
`WHERE owner_id = :currentUserId` with no DSL signature change. This is
not a grudging allowance — for ownership and multi-tenancy it is the
*correct* place for the predicate (row-level isolation). The canonical
tenancy filter becomes an ordinary criterion:

```ddd
criterion InMyTenant of Order = tenantId == currentUser.tenantId
context Sales { filter for "tenancy" InMyTenant }   // ambient, every aggregate
```

### IR consequence

`currentUser` stops being a free variable and becomes a recognised
**implicit parameter**. The lowering must *tag* any selectable filter
whose body references the principal, so each backend splices its accessor
in at emit time:

- IR: a `usesPrincipal: boolean` (or a small `implicitParams: ("principal" | "clock")[]`) on the lowered filter / `FindIR`.
- `now()` is tagged the same way (clock injection), so a backend can bind a single stable timestamp per query rather than re-reading the clock per row.

Only the *scalar* members of `currentUser` are bindable. `currentUser.id`,
`.role`, `.tenantId` → param. A non-scalar/behavioural access
(`permissions.canX`, a method) is **not** selectable and falls under
`loom.criterion-not-selectable` if used in a filter — pushing the author
to use it as a `requires` gate instead, where it belongs.

## Use-site owns the enforcement semantics

A single predicate fails differently depending on where it sits. This is
a feature, not a contradiction — but it must be explicit, because the
criterion declaration says nothing about it.

| Use-site | On failure | Status | Visibility of "other" data |
|---|---|---|---|
| `requires` (auth gate) | reject whole request | **403** | request denied; state never revealed |
| `when` (state gate) | reject whole request | **409** `Disallowed` | per existing proposal |
| `precondition` (guard) | reject whole request | **422** `CriterionFailed` | — |
| invariant | reject the write | **422** | — |
| `find` / `view` / `filter` (selection) | **silently subset rows** | **200** | the excluded rows simply aren't returned |

The sharp edge: `currentUser.role == "manager"` as a `requires` is
all-or-nothing (403); the *same* criterion as a `filter` silently hides
rows (200 with fewer results). Unifying the rule under one `criterion` is
correct; the enforcement is the **position's** contract, not the
criterion's. (This is why auth still evaluates `requires` *before* any
state gate — see the existing proposal's ordering rules; nothing here
changes that.)

A criterion that is *both* selectable and validation-capable can be used
in both kinds of position, and the consistency guarantee from the
motivation section holds. A validation-only criterion can be used only in
validation positions — the diagnostic enforces that.

## Out of scope

**Structural / polymorphic criteria** — `criterion Active of any with
(active: bool)` reusable across every aggregate carrying an `active`
field. It is the other axis of "DRY," but it needs structural typing in
the DSL and erodes bounded-context clarity (a criterion stops naming a
*specific* domain rule). Much higher cost, much lower payoff than
use-site unification. Explicitly deferred.

## Work breakdown

This is validator + lowering + IR tagging. No grammar change.

| Area | File(s) | Work |
|---|---|---|
| Selectability oracle | `src/ir/lower/lower-expr.ts` (+ the per-backend `lowerToDrizzle` / LINQ / Ash / JPQL lowerers) | Surface "can this body lower to a filter?" as a queryable boolean, reused by the validator instead of throwing internally |
| Per-use-site check | `src/ir/validate/validate.ts` (or the relevant validator under `src/language/validators/`) | Emit `loom.criterion-not-selectable` when a non-selectable criterion lands in a `find` / `view` / `filter` position |
| Principal/clock tagging | `src/ir/types/loom-ir.ts`, `src/ir/lower/lower-expr.ts` | `usesPrincipal` / `implicitParams` on the lowered filter; recognise `currentUser.<scalar>` and `now()` as bound params |
| Backend accessor splice | `src/generator/<platform>/` find/filter emitters | Bind the principal/clock param via each backend's ambient accessor (table above) |
| Docs | `docs/criterion.md`, `docs/capabilities.md` | Document selectability + the enforcement-by-position table |
| Tests | `test/ir/`, `test/generator/<platform>/` | One negative selectability test; one `currentUser`-in-filter lowering test per backend; one consistency test (same criterion → filter + precondition) |

## Effort

**~1–1.5 weeks**, backend-agnostic. The inlining and the find-filter
lowerers already exist; the work is exposing the lowerability check as a
diagnostic, tagging implicit params, and wiring four ambient accessors.
It raises the value of the eventual Java `Specification<T>` reification
(see the Java-backend discussion): more rules flow through criteria, more
reach the selection position, more become reusable specs.

## Cross-references

- [`docs/proposals/criterion.md`](./criterion.md) — parent design
  (`from` / `when` / `findAll` surfaces). This note refines its "queryable
  subset" §"What `where` expressions can reference".
- [`docs/criterion.md`](../criterion.md) — shipped core.
- [`docs/auth.md`](../auth.md) — `requires` ordering and 403 semantics
  (unchanged).
- [`docs/capabilities.md`](../capabilities.md) — the `filter` capability,
  the primary new *selection* consumer of criteria.
- [`docs/proposals/multi-tenancy-design-note.md`](./multi-tenancy-design-note.md)
  — tenancy filter expressed as an ambient `currentUser.tenantId`
  criterion.
