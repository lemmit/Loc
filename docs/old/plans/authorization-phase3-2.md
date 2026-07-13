# Authorization Phase 3.2 — named policy functions (requires-gated predicates)

Status: shipped (PR #1746, merged). Scope: **P3.2 only** — reusable, named, parameterised
boolean authorization predicates declared at context level and attached to
operations/actions via the EXISTING `requires` gate. Stacked on P3.1 (the
policy WRITE ladder, PR #1742). Full design source:
[`docs/old/proposals/authorization.md`](../proposals/authorization.md) §4 (helpers).

## Problem

Authorization gates today are inline `requires <expr>` clauses. A non-trivial
gate (`currentUser.permissions.contains(permissions.approve) && amount <= cap`)
must be re-typed at every operation it guards — no way to name the rule once and
reuse it. The proposal (§4) settles the shape: a named policy helper is a pure
boolean predicate over `currentUser` + its own parameters, referenced from a
`requires` clause. `criterion … of bool` is the closest shipped analogue
(inline pure predicate), but a criterion is a *domain* specification (candidate
aggregate, reification machinery); an authorization predicate is *ambient*
(currentUser + params, no candidate) and lives in the authz namespace.

## P3.2 surface

A new context-level member — a function-form `policy` declaration (sibling to
the P3.1 `policy {}` read-ladder block, disambiguated by the parentheses):

```ddd
context Orders {
  permissions { approve, manage }

  // named policy function — ambient (currentUser + params), returns bool
  policy CanApprove(cap: money): bool =
    currentUser.permissions.contains(permissions.approve) && cap <= 10000

  policy IsManager(): bool { currentUser.permissions.contains(permissions.manage) }

  aggregate Order { amount: money, status: OrderStatus }
  repository Orders for Order {
    operation approve() {
      requires CanApprove(amount)   // ← inlined at the gate, 403 on false
      status := OrderStatus.Approved
    }
  }
}
```

- **Spelling.** `policy <Name>(<params>): bool ( = <expr> | { <expr> } )`.
  Parentheses are **required** (even for zero params) so the parser can
  distinguish the function form (`policy Name(`) from the P3.1 block form
  (`policy Name? {` / `policy {`).
- **Return type** must be `bool` (`loom.policy-fn-return-type` otherwise).
- **Ambient scope.** The body sees `currentUser`, the declaration's own
  parameters, module `permissions.<name>`, enum values, and sibling `policy`
  functions / criteria. It does **not** see a candidate aggregate's fields —
  pass those in as arguments (`CanApprove(amount)`). This keeps a policy
  function a *point gate* (currentUser + params), not a set filter.

## Semantics — inline at the `requires` site

A `requires PolicyName(args)` reference **inlines** the predicate body into the
gate expression, substituting the call arguments for the parameters — exactly
the criterion-inlining mechanism (`inlineCriterion`, `lower-expr.ts`). Because
the result is an ordinary boolean `ExprIR` in a `requires` statement, **every
backend enforces it through the existing `requires` → 403 path with no new
render code** — the predicate is emitted wherever the gate is emitted:

| Backend | requires seam (unchanged) |
|---|---|
| node/Hono | route-handler guard → `ForbiddenError` (403) |
| .NET/EF | CQRS handler pre-check → 403 ProblemDetails |
| Python/FastAPI | route guard → `HTTPException(403)` |
| Java/Spring | controller/service guard → 403 |
| Elixir/Phoenix | `with :ok <- ensure(pred, :forbidden)` → 403 |

Composition falls out of ordinary boolean operators (`requires IsManager() &&
CanApprove(cap)`), like criteria. A reference cycle is broken +
`loom.policy-fn-cycle` reported.

## Validation

| Diagnostic | When |
|---|---|
| `loom.policy-fn-return-type` | the return type annotation is not `bool` |
| `loom.policy-fn-arity` | a `PolicyName(args)` call supplies the wrong argument count |
| `loom.policy-fn-cycle` | a policy function (transitively) references itself |

`currentUser` is permitted in a policy-function body (it is the whole point);
mutation / `emit` are already excluded by the expression grammar.

## Not in scope (P3.x follow-ups)

The `resource` scope (referencing the gated row's fields directly rather than
passing them as args), field masking, `deny`, and hosting policy functions
inside the `policy {}` block. Those remain later proposal work.
