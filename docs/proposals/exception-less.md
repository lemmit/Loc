# Exception-less flow — `or` unions, `option`, `?` propagation, `error` payloads

> **[2026-06-20 status audit]** `or`-union operation returns now ship on node/dotnet/python/java/elixir-vanilla (`structural-checks.ts:~551`), not 'node/dotnet; gated on elixir'. (`?` propagation operator already removed — see failure-taxonomy.)

> Status: proposal — **partially landed, and partially walked back**.
> Shipped already: `error` payloads (a `PayloadKind`), the anonymous
> `or`-union return surface on operations (emitting on node/dotnet;
> gated on elixir — `loom.operation-return-unsupported`), and per-error
> `httpStatus` mapping on the api body feeding RFC 7807 ProblemDetails
> ([`validation-error-extension.md`](./validation-error-extension.md)
> is fully shipped on all three backends).
>
> **The `?` propagation operator (A2) is DROPPED and its surface
> REMOVED** (maintainer decision, 2026-06-10). The surface + validation
> had shipped in #1030 (grammar `PropagateExpr`, `ExprIR` kind
> `propagate`, gates `loom.propagate-unsupported` /
> `loom.propagate-incompatible-error`) but no backend ever emitted it;
> the grammar rule, IR kind, lowering arm, both gates, print-expr arm,
> and tests have since been deleted. `expr ? then : else` (the ternary)
> is unaffected. Do not re-introduce.
>
> **Revisited by**:
> [`failure-taxonomy.md`](./failure-taxonomy.md) — a step-back design
> note that keeps this proposal's structural core (errors-as-data,
> HTTP-blind domain + edge `httpStatus`, two-regime throw/return) and
> reconsiders its ergonomics (the `?` operator — now dropped, see
> above — and the carrier-monad stdlib), and grounds the validation
> story in the shipped value-object `invariant` (routed to 422 — not a
> new `validate` keyword). Read that for the current thinking on the
> overall error story.
>
> **Upstream proposal**:
> [`payload-transport-layer.md`](./payload-transport-layer.md) — this
> doc consumes its Phase 3+4 (carrier-bounded generics + tagged
> unions, both named and anonymous-`or`), its `: carrier` bound
> widening, its aggregate-as-carrier projection rule, its
> variant-name-tagged identity rule, and the `error` sugar keyword
> introduced there. Read that doc first.

## TL;DR

Loom today uses exceptions for "non-domain-invariant" failures —
not-found, validation, parse errors, external API failures. This
proposal removes them everywhere **except** aggregate invariant
violations, by:

1. **No `Result<T, E>` wrapper.** Operations return anonymous `or`
   unions directly: `operation placeOrder(...): OrderId or NotFound
   or OutOfStock`. The `error` sugar keyword (from upstream proposal)
   marks variants that participate in `?` propagation.
2. **`option` as ML-postfix sugar** for `T or none` — the common
   nullable-return case. `string option` reads as "an optional
   string"; the `find` re-shape lowers `: X?` returns to this.
3. **`?` propagation operator** — short-circuits any value of an
   `error`-marked variant, threads non-error values onward.
4. **Status mapping lives in the api surface, not on the error.**
   Domain `error` declarations are HTTP-blind. The api surface
   carries `status <Error> <Code>` lines for user errors (with
   stdlib defaults baked into the generator). At runtime the route
   emitter translates errors to **RFC 7807 ProblemDetails** JSON
   bodies with the appropriate status code; success bodies carry
   the variant data directly with HTTP 200.
5. **Find re-shape**: a find declared `: X` returns `X or NotFound`;
   declared `: X?` returns `X option`; declared `: X[]` stays an
   array.
6. **Parse / external API / validators** return `T or <Error>` shapes
   instead of throwing.

The two-regime line is **explicit and validator-enforced**: aggregate
invariants (`requires` / `ensures`) may throw; everything else returns
a carrier shape.

## Why this matters

Aggregates throw today because there's no first-class way to spell
"this might fail with a known error". Routes catch exceptions and
map them to status codes in every backend's emitter. Three
consequences:

1. **Error shape is hidden.** An author reading an operation
   signature can't see what failure modes the caller has to handle.
   The signature says "returns OrderId"; only by reading the body do
   you learn it might throw `NotFound`, `OutOfStock`, or
   `ValidationFailed`. Worse, the *set* isn't enumerated anywhere.
2. **Every backend route emitter is a try/catch tower.**
   `src/generator/ts/...routes`, the .NET controller emission, and
   the Phoenix action handlers all carry parallel implementations of
   "if this exception class, return that status code". They drift;
   they have to.
3. **Composition is awful.** Calling three operations in sequence
   today means either three try/catch blocks or letting all
   exceptions bubble to the route layer where the mapping is uniform
   but imprecise. Typed `or` unions + propagation operator collapse
   both options into one ergonomic call.

The user-facing pitch: **standard flows shouldn't go through the
exception channel.** Exceptions belong in domain invariants — places
where reaching the code is itself a bug.

## Scope and non-goals

**In scope (v1)**:

- `error` payloads as the marker for `?`-propagation eligibility
  (declared in upstream proposal §"Subtypes"; HTTP-blind — no
  status code on the declaration).
- API-surface `status <Error> <Code>` mapping clause + stdlib
  default table baked into the generator.
- Auto-generated **RFC 7807 ProblemDetails** translation at the
  api route boundary.
- Anonymous `or` unions in return types (declared in upstream
  proposal §"Discriminated unions on payloads"; usage here).
- `option` ML-postfix carrier as sugar for `T or none` (declared in
  upstream proposal §"Syntax — ML-postfix for type positions").
- `?` propagation operator with scoping rules.
- Find-variant re-shape (`: X` → `X or NotFound`, `: X?` → `X option`,
  `: X[]` unchanged).
- Parse intrinsics return `T or ParseError`.
- `validate for X { ... }` (from upstream proposal Phase 5) returns
  `X or ValidationError[]` (multi-error accumulation).
- External API calls (`call api Foo.bar(x)`) return `T or ApiError`.
- Carrier stdlib (`map`, `flatMap`, `orElse`, `orError`, `combine`)
  for the closed builtin set — A7a below.
- Two-regime enforcement: validator rejects throws outside aggregate
  bodies.

**Deferred (v2 or later)**:

- User-authored carrier-generic functions (writing your own
  `MyCarrier.map`) — A7b below.
- Multi-success/multi-error `combine`-style applicative accumulation
  beyond the simple `X or ValidationError[]` shape.
- Async / `IO<T>` / `Task<T>` effect types. Loom doesn't expose async
  surface to authors today.
- Higher-kinded types, type classes (`Functor`, `Monad`). v1 ships
  monomorphised per-instantiation helpers; no shared abstract
  signature.
- `?.`-style chained access on `option` (e.g.
  `customer?.address?.city`). Sugar; defer until concrete demand.
- `try`/`catch` in user code (it never appears).

## Three layers — where things live

Loom already has three layers (see `docs/architecture.md` and
`docs/workflow.md`). This proposal aligns with them; it doesn't
invent a new application-layer concept.

| Layer | Existing role | Failure model after this proposal |
|---|---|---|
| **Aggregate operation** | Pure domain. Mutates own state; invariants + preconditions throw `DomainException`. **Cannot load other aggregates, cannot call externs.** | Throws stay for invariants and "this must be true" preconditions (bug-shaped). Operations *may* additionally return `T or BusinessError` for **designed-in own-domain outcomes** (e.g., `InsufficientCredit` from `Account.debit`). `?` propagation is allowed but limited — only against sibling-aggregate operations' `or`-returns and parse intrinsics on params. |
| **Workflow** | Cross-aggregate orchestration. Loads via `Repo.getById` (throws `AggregateNotFound`), calls operations, saves. `precondition` throws `DomainException`. Optionally `transactional` with an isolation level. | `?` propagation lives here as the workhorse. `Repo.getById` returns `T or NotFound` (was: throw). Workflow `precondition` keeps throwing — route translates to 400 ProblemDetails (see "Preconditions throw — at both layers" below). Aggregate-op `or`-returns thread through. Workflow signature is the union of every typed failure it can produce. |
| **API auto-exposure** | `api X from M` derives operations from the module: `byId`/`create`/`update`/`delete` per aggregate + named finds + workflows. Route handlers per-backend catch DomainException / AggregateNotFound and map to status codes. | Each route returns the corresponding `or`-union. Per-backend auto-generated **ProblemDetails translator** emits status + body from the api's `status` mapping + stdlib defaults. Aggregate-invariant throws hit the env-aware 500 fallback. |

The **"every operation needs some application layer" answer**: yes,
and it's already there via the api's CRUD auto-exposure for the
trivial case (load → mutate → save). Authors only write an
explicit `workflow` when the orchestration touches more than one
aggregate or needs `transactional` semantics. The exception-less
proposal does not change this; it just changes the *failure shape*
at each layer.

### Preconditions throw — at both layers

`precondition Expr` is a **guard**, not a designed-in business
outcome. If it fails, the caller violated the call's contract.
That's bug-shaped, not user-recoverable; it doesn't belong in the
typed-return channel.

Both layers' preconditions throw, with different status codes at
the route:

| Where the precondition fires | Throw class | Route translation |
|---|---|---|
| Aggregate operation body (`precondition amount > 0`) | `PreconditionViolation` (aggregate-internal) | **500** ProblemDetails. Env-aware exposure (dev shows aggregate state, prod redacts). The HTTP caller — the api client — shouldn't see internal contracts between workflow and aggregate; from their perspective, the workflow didn't validate properly = a bug. |
| Workflow body (`precondition cmd.amount > 0`) | `PreconditionViolation` (workflow-level) | **400** ProblemDetails. The precondition's source text is safe to put in `detail` regardless of env — the caller needs to know what contract they violated. |

The translator distinguishes by where the throw originated, not by
exception class. The catalog logs full context regardless of env.

What does *not* go through `precondition`: **designed-in business
outcomes that the caller might want to handle differently**. Those
use typed `or` returns instead. The author chooses by intent:

```
aggregate Customer {
  operation deductCredit(amount: decimal): or InsufficientCredit {
    # Bug-shaped guards (caller should have validated):
    precondition amount > 0

    # Designed business outcome (caller may want to react):
    if creditLimit < amount {
      return InsufficientCredit { requested: amount, available: creditLimit }
    }

    creditLimit := creditLimit - amount
  }
}
```

The split lets `?` propagation work uniformly on typed errors while
keeping preconditions out of every workflow's signature noise.

### Two-regime split — by failure type, per layer

| Failure | Layer | What happens |
|---|---|---|
| Aggregate invariant or aggregate-op precondition fails | Aggregate operation | **Throws.** Hits env-aware 500 ProblemDetails fallback at the route. Catalog `invariant_violated` event always logged. |
| Aggregate operation returns its `or`-typed business error | Aggregate operation | `?`-propagated by caller (workflow or sibling op). |
| `Repo.getById(id)` returns `NotFound` | Workflow | `?`-propagated; widens workflow signature. Translates to 404 ProblemDetails. |
| Workflow `precondition` fails | Workflow | **Throws** `PreconditionViolation` (workflow-level). Route translates to 400 ProblemDetails with rule text in `detail`. Not in workflow signature. |
| Aggregate-op `precondition` fails | Aggregate operation | **Throws** `PreconditionViolation` (aggregate-internal). Route translates to 500 ProblemDetails with env-aware exposure (api client shouldn't see internal contracts). |
| Validator returns `ValidationError[]` | Workflow / api | `?`-propagated. 422 ProblemDetails with `errors` extension. |
| External API call (`call api ...`) fails | Workflow | `?`-propagated as `ApiError` variant. 502 ProblemDetails. |
| Any throw in any layer not caught explicitly | Any | Hits the env-aware 500 ProblemDetails fallback. |

The line is **enforced by the validator**:

- Aggregate operation body: cannot call `Repo.<find>` / `Repo.<getById>` /
  externs / `call api` (loading other aggregates is workflow business).
  Validator: `loom.aggregate-cannot-orchestrate` (ERROR).
- Workflow body: throws are allowed but typed-return is preferred
  (`loom.workflow-prefers-error` warning). `getById` / external
  calls always typed-return.
- API route bodies (generated): no user-written throws; auto-translator
  catches everything and emits ProblemDetails.

Observability mapping (preserves today's catalog):

- `invariant_violated` / `precondition_evaluated` from #480 — fired
  by aggregate-invariant and aggregate-op-precondition throws
  (unchanged).
- `domain_error` — fires on any uncaught throw bubbling to the 500
  fallback. Today's catch-all stays.

## Surface — `error`, `or`, `option` working together

A worked example showing the layering end-to-end. Domain →
workflow → api:

```
# === Domain (aggregate) — pure, no orchestration ===
aggregate Customer {
  creditLimit: decimal
  invariant creditLimit >= 0

  operation deductCredit(amount: decimal): or InsufficientCredit {
    precondition amount > 0                  # throws on violation (bug)
    if creditLimit < amount {
      return InsufficientCredit { requested: amount, available: creditLimit }
    }
    creditLimit := creditLimit - amount
  }
}

aggregate Order {
  customerId: Customer id
  status: OrderStatus

  # Takes primitives only. Does NOT receive a Customer aggregate
  # handle — that would smuggle a load into the domain layer.
  operation place(lines: OrderLine[]): or OutOfStock {
    precondition lines.length > 0            # throws on violation (bug — workflow should validate)
    # ... own-state mutations; may return OutOfStock based on self.lines
  }
}

# === Stdlib errors (HTTP-blind) — declared once, reused ===
error NotFound       { what: string, id: string }                  # stdlib (404)
error InsufficientCredit { requested: decimal, available: decimal } # domain
error OutOfStock     { sku: string, requested: int }                # domain

# === Workflow (application layer) ===
workflow placeOrder(cmd: PlaceOrderCommand): OrderId or NotFound or InsufficientCredit or OutOfStock transactional {
  precondition cmd.lines.length > 0                        # throws → 400 (not in signature)
  let customer = Customers.getById(cmd.customerId)?       # NotFound
  customer.deductCredit(cmd.totalAmount)?                  # InsufficientCredit
  let order = Order.create({ customerId: customer.id, status: Draft })
  order.place(cmd.lines)?                                  # OutOfStock from own domain
  return order.id
}

# === API surface (status mapping) ===
api SalesApi from Sales {
  status InsufficientCredit 409
  status OutOfStock         409
  # NotFound, PreconditionFailed: stdlib defaults (404, 400) — no lines needed
}
```

What flows where:

- Aggregate `Customer.deductCredit` returns `or InsufficientCredit`.
  The workflow `?`-propagates it.
- `Customers.getById(...)?` is the re-shape of today's throwing
  `getById` — returns `Customer or NotFound`; `?` widens the
  workflow signature.
- `precondition cmd.lines.length > 0` becomes `PreconditionFailed`
  typed return.
- Workflow `?` operator unifies all error sources into one signature
  union.
- API auto-exposes `POST /workflows/place_order`; the generated
  route handler translates each variant to ProblemDetails (status
  from api map + stdlib defaults).

Aggregate operations never see `NotFound` or `Forbidden` in their
signatures — those concepts don't exist inside the domain. The
domain knows `InsufficientCredit` and `OutOfStock` because they're
its own business outcomes.

### Why no `Result<T, E>` wrapper

Compare the two encodings of the same return:

| Form | Type expression | Success wire | Error wire |
|---|---|---|---|
| Old (with Result wrapper) | `Result<OrderId, NotFound>` | `{"kind":"Ok","value":"ord_abc"}` | `{"kind":"Err","error":{"kind":"NotFound",...}}` |
| New (`or` union) | `OrderId or NotFound` | `"ord_abc"` (HTTP 200) | `{"what":"Customer","id":"..."}` (HTTP 404) |

The Result wrapper double-tags every value on the wire and forces
authors to write `Ok { value: ... }` / `Err { error: ... }`
constructors where the type itself already carries the variant. The
`or` form drops a layer of ceremony and matches what every
hand-rolled REST API does — return the data on success, return an
error body with the appropriate status on failure.

### What about `option`?

`option` is sugar for `T or none`, where `none` is a stdlib unit
type. So `string option` is exactly `string or none` — same wire
shape, same propagation rules, just more readable.

```
operation findActiveSession(userId: User id): Session option {
  let session = sessions.findActiveFor(userId)?    # ? propagates `none`
  return session
}
```

Wire encoding for `option` returns: at HTTP boundaries, `none`
defaults to 404 (with a ProblemDetails body indicating the missing
resource), `some(value)` is 200 with the value's wire shape. The
404 default is baked into the api generator for `none`; no
declaration needed.

## The `?` propagation operator

### Motivation

Without the operator, every `or`-union-returning call costs five
lines of `match`. Authors revert to throwing. With it, the typed
flow reads like sequential code (see the worked example above).

### Propagation rule

`expr?` where `expr: T1 or T2 or … or Tn` short-circuits if the
runtime value is an `error`-marked variant, returning that variant
from the enclosing function. Otherwise it unwraps to the
non-error type union (typically a single non-error variant; if
multiple, the result type is the `or`-union of just the non-error
variants).

Formally:

- For each `Ti` in the operand's type, check `isErrorMarked(Ti)`
  (via the `error` keyword declaration, or `none`'s implicit
  error-marking for `?` purposes).
- Partition variants: `errors = { Ti | isErrorMarked(Ti) }`,
  `successes = { Ti | !isErrorMarked(Ti) }`.
- The propagation requires `errors ⊆ enclosingReturnErrors`. If
  any error variant in the operand isn't a variant of the enclosing
  function's return type, validator emits
  `loom.propagate-incompatible-error`.
- The unwrapped type is `successes` joined via `or` (or just the
  single success type if `|successes|=1`).
- At runtime: if the value is an error variant, return it from the
  enclosing function (short-circuit); otherwise, the expression
  evaluates to the non-error value.

### Examples

```
# Enclosing return: OrderId or NotFound or OutOfStock
let customer = customers.findById(id)?   # operand: Customer or NotFound
                                         # NotFound is error-marked, listed in enclosing return → propagates
                                         # customer: Customer (the unwrapped success type)

# Enclosing return: OrderId or NotFound
let prices = pricing.compute(items)?     # operand: Prices or OutOfStock
                                         # OutOfStock NOT in enclosing return → ERROR
                                         # author must .mapErr(...) or change enclosing signature

# Enclosing return: Session option (= Session or none)
let session = sessions.findActiveFor(uid)?   # operand: Session or none
                                              # none is propagable → propagates
                                              # session: Session
```

### Grammar — `?` disambiguation

Loom's grammar already uses `?` in three positions:

| Position | Meaning | Example |
|---|---|---|
| `contains X?` (declaration) | Optional containment (from #477) | `aggregate Order { contains note? }` |
| `T?` (type suffix) | Nullable type | `phone: string?` |
| `expr ? thenExpr : elseExpr` | Ternary | `x > 0 ? "pos" : "neg"` |

The propagation operator adds a **fourth position**: postfix `?`
on an **expression** in a statement / let-binding context, where it
is **not followed by `:`**. The parser disambiguates by lookahead —
`?` immediately followed by `:` parses as ternary; `?` followed by
a statement separator / line end / non-ternary token parses as
propagation. No grammar ambiguity, but the LSP and Monaco
highlighting need updates to render the four uses distinctly. Flag
this for the grammar work in A2.

### Lowering per backend

| Backend | Lowering of `let x = expr?` |
|---|---|
| TS | `const __r = expr; if (isErrorVariant(__r)) return __r; const x = __r;` — `isErrorVariant` is a small generated helper checking `kind` against the error-variant set. `__r` is the unwrapped non-error value when the check passes. |
| .NET | Per-project generated propagation helper: `var __r = expr; if (__r is IDomainError) return __r; var x = __r;`. The `IDomainError` marker interface is generated on every `error` payload's record class. |
| Phoenix | Collapses multiple `?` in one body into a single `with` block: `with %{kind: "ok"} <- expr1, %{kind: "ok"} <- expr2 do ... else err -> err end`. Idiomatic Elixir. |

### Alternative: `try` keyword

Considered. `?` is terser, lifts directly from Rust/Swift idioms
authors will recognise. `try` reads more domain-y but eats a
keyword. **Pinned to `?`**; revisit if user testing shows the
symbol is surprising.

## API-edge ProblemDetails translation

The api route boundary is the **only** place where domain errors get
mapped to HTTP. Domain `error` declarations don't know about HTTP
at all. The api surface owns the mapping; the generator emits the
translator.

### Three layers, one translator

| Layer | Today (throws) | After (carrier-returning) |
|---|---|---|
| Aggregate (domain) | Throws invariant violations | Still throws; caught by global 500 + ProblemDetails fallback |
| Application / handlers | Throws typed failures | Returns `T or <Errors>...` directly; no throws for typed cases |
| API route | Hand-written try/catch tower that translates exception classes to status codes | Auto-generated: matches on the `or`-union variant, emits ProblemDetails with the right status |

The N-times-per-backend "translator from exception to ProblemDetails"
that .NET / Hono / Phoenix authors all hand-write is **generated**
from the api-surface mapping + stdlib defaults.

### Status mapping lives in the api surface

```
api SalesApi for Sales {
  # Stdlib defaults apply automatically — no lines needed for these:
  #   NotFound        -> 404
  #   ValidationError -> 422
  #   ParseError      -> 400
  #   Forbidden       -> 403
  #   TransportFailure / UnexpectedStatus / DeserializeError -> 502
  #
  # Custom statuses for domain-specific errors:
  status OutOfStock      409
  status PaymentDeclined 402
}
```

User-declared errors with **no** `status` line in the api → default
500 + `loom.unmapped-error-status` warning. Authors who want the
500 for "unexpected" errors get it silently; the warning prompts
explicit annotation for the ones they care about.

The stdlib default table is hardcoded in
`src/system/error-defaults.ts` (or per-platform equivalent) — not
in any `.ddd` file. Stdlib errors don't carry status annotations
because *no* error declaration does.

### ProblemDetails body — auto-derived fields

Every error variant returned from an api operation lowers to a
ProblemDetails JSON body:

| ProblemDetails field | Derived from |
|---|---|
| `status` | api-surface `status` mapping (or stdlib default) |
| `title` | Error name prettified (`NotFound` → `"Not Found"`, `OutOfStock` → `"Out of Stock"`) |
| `type` | Auto-generated URI: `/errors/<kebab-case-name>` (e.g., `/errors/out-of-stock`) |
| `detail` | Auto-interpolation from the error's fields: `"{title}: ${fieldList}"` |
| `instance` | Current request path, filled by the route handler at runtime |
| Extension members | Any error fields beyond the standard set surface as ProblemDetails extensions |

Per-error customisation of `type` URIs, `title`, or `detail`
templates is **deferred to v2**. v1 is auto-derived only.

### Multi-error responses

Operations that accumulate errors (typically validators returning
`T or ValidationError[]`) become a ProblemDetails with an `errors`
extension array — RFC 7807 §3.2 form:

```json
{ "type": "/errors/validation",
  "title": "Validation Failed",
  "status": 422,
  "detail": "2 fields failed validation",
  "errors": [
    { "field": "quantity", "code": "must-be-positive", "message": "..." },
    { "field": "unitPrice", "code": "must-be-positive", "message": "..." }
  ]}
```

Status: 422 (stdlib default for `ValidationError`). The
top-level body shape is one ProblemDetails; the per-field errors
land in the extension array.

### IR + lowering

- New IR enrichment pass: each `api` declaration carries
  `errorStatuses: Map<ErrorTypeName, HttpStatus>` populated from
  the `status` clauses + stdlib defaults.
- New stdlib payload: `ProblemDetails { type: string?, title:
  string, status: int, detail: string?, instance: string? }` in
  `src/stdlib/payloads/`.
- Each backend's route emitter consumes the `errorStatuses` map
  and the `ProblemDetails` shape:

| Backend | Route-edge shape |
|---|---|
| TS Hono | `if (isErrorVariant(result)) { const pd = toProblemDetails(result, errorStatuses); return c.json(pd, pd.status); } return c.json(result, 200);` |
| .NET | Controller returns `ActionResult<T>`; the global `IExceptionHandler` + per-route filter use the same `errorStatuses` table to build `ProblemDetails`. Idiomatic ASP.NET Core pipeline; Loom generates the wiring. |
| Phoenix | Action returns the value; route handler maps non-success variants via `ProblemDetails.from(variant, errorStatuses)` and `conn |> put_status(pd.status) |> json(pd)`. |

### Implementation status — producer-side translation (as shipped)

A1's stdlib status table + the api `httpStatus` override clause + the
operation-return → ProblemDetails translation have shipped on **two of
the three backends**. The find-variant re-shape (A4) has *not* shipped, so
the producer surface is exercised only by **explicit** union returns today
(`operation foo(): X or NotFound { return … }`).

| Backend | Operation-return translation | Notes |
|---|---|---|
| **Hono / `node`** | ✅ shipped | The domain method returns an inline TS tagged union; the route captures the result and translates (error variant → ProblemDetails with the stdlib-or-overridden status, success → 200). |
| **.NET / `dotnet`** | ✅ shipped | "Pure Domain + mapping": a pure Domain union (no serialization attrs) the aggregate method returns; the command/handler carry it (`ICommand<Union>`); the controller `switch`-translates — error variant → `Problem(...)`, success → 200 wrapped in the Application `[JsonPolymorphic]` wire DTO. |
| **Phoenix / `phoenixLiveView`** | ⛔ **deferred** | Gated by `loom.operation-return-unsupported` (`SUPPORTED_RETURN_BACKENDS` excludes it). The architectural blocker + the intended design are below. |

#### Why Phoenix is deferred

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain
> Ecto/Phoenix only — `foundation: ash` is now a validation error. The Ash
> update-action / generic-action blocker described below no longer applies;
> union-returning operations ship on the vanilla foundation via a tagged
> `{:ok, value} | {:error, tag, data}` tuple. The Ash design notes here are
> retained as a historical record.)**

On Phoenix, a Loom `operation` lowers to an **Ash `update` action** — its
body runs inside `change fn changeset, _ctx -> … changeset end` and the
action's result is the **resource record** (`%Order{}`). That model
**cannot return a discriminated union**:

- An `update` action's return type is the resource struct, not an arbitrary
  value — so `return NotFound { resource: code }` has nowhere to go (a
  `change` function must return a changeset, not a `%{type: "NotFound", …}`
  map).
- This is unlike Hono (a domain method that already returns an arbitrary
  value) and .NET (a command handler that already returns `TResponse`) —
  both had a natural seam for a union result. Phoenix's update-action /
  changeset model does not.

#### Intended design (when un-deferred)

Emit a union-returning operation as an **Ash 3.x generic action**
(`action :<op>, :map do … run fn input, _ctx -> {:ok, tagged_map} end
end`) rather than an `update` action:

- The `run` function loads the record by id, runs the operation body, and
  returns `{:ok, %{type: "<tag>", …}}` — the same tagged-wire map the find
  serializer (`tag_<union>/1`, P4d) and the Hono/.NET producers emit.
- The controller calls the generic action's code-interface and translates
  on `result.type`: an error variant → `ProblemDetails.problem_response/4`
  with the stdlib-or-overridden status; a success variant → `200` JSON.
- **Scope caveat:** the operation body renderer currently assumes a
  changeset context (field mutations lower to `Ash.Changeset.*`). A generic
  action has no changeset, so the first slice should support
  **return-dominant** bodies (the shape every current fixture uses);
  *mutation-then-return* needs the body renderer to also emit the
  generic-action mutation form (`record |> Ash.Changeset.for_update(…) |>
  Ash.update!()`) and is a follow-up.

Until this lands, a `.ddd` that declares a union-returning operation on a
Phoenix-served context fails validation with `loom.operation-return-unsupported`
(message lists the supported backends), so the gap is a hard, discoverable
error rather than silent mis-emission.

### Aggregate-invariant throws

These hit the global error middleware on every backend. Generated:
500 ProblemDetails with `type: "/errors/internal"`, `title:
"Internal Server Error"`, structured logging of the underlying
exception via the catalog's `invariant_violated` event. The
**catalog event** carries full context regardless of environment
(exception class + message + stack + aggregate state snapshot +
rule text + correlation id); the **response body** shape is
controlled by `LOOM_EXPOSE_INTERNAL_ERRORS` — see next subsection.

### Env-aware internals exposure

Dev/test wants stack traces and aggregate state in the response
body for fast debugging; prod must redact — both for security and
to avoid information leakage to clients. The 500 fallback is
**env-aware**.

**Single Loom-level env var** drives the behaviour:

```
LOOM_EXPOSE_INTERNAL_ERRORS=true    # full body — dev / test default
LOOM_EXPOSE_INTERNAL_ERRORS=false   # minimal body — prod default
```

**Defaults** when the env var is unset, per backend's native "is
dev" check:
- TS/Hono: `process.env.NODE_ENV !== "production"` → `true`, else `false`.
- .NET: `IHostEnvironment.IsDevelopment()` → `true`, else `false`.
- Phoenix: `config :<App>, env:` if `:dev` or `:test` → `true`,
  else `false`.

The env var overrides the native check when set.

**`expose=true` body** carries extension members beyond the
standard ProblemDetails fields:

```json
{
  "type": "/errors/internal",
  "title": "Internal Server Error",
  "status": 500,
  "detail": "Invariant violation in Order.placeLine: quantity must be > 0",
  "instance": "/orders/abc",
  "_exception": {
    "type": "InvariantViolation",
    "message": "quantity must be > 0",
    "rule": "quantity > 0",
    "aggregate": "Order",
    "operation": "placeLine"
  },
  "_stack": [
    "src/generator/.../OrderRepository.cs:142",
    "src/generator/.../OrderController.cs:87"
  ],
  "_state": { "id": "...", "lines": [...] }
}
```

**`expose=false` body** — constant shape, no info leak:

```json
{
  "type": "/errors/internal",
  "title": "Internal Server Error",
  "status": 500,
  "detail": "An internal error occurred. Reference: 2025-05-25-abc123",
  "instance": "/orders/abc"
}
```

The correlation id in `detail` lets operators look up the full
catalog event server-side. The body is constant-shape regardless of
which invariant fired — no information leakage.

### Sensitivity intersection (even in dev)

Even with `LOOM_EXPOSE_INTERNAL_ERRORS=true`, fields marked
`sensitive(<tag>)` (per
[`sensitivity-and-compliance.md`](./sensitivity-and-compliance.md))
**stay redacted** in the body. The dev convenience does not
override the sensitivity contract — a `sensitive(pii)` field
appears as `"[redacted:pii]"` in `_state` even in dev. The
sensitivity proposal's sink-rejection rule extends to the
dev-exposure path.

This applies only to the implicit internals of the 500 fallback.
For **expected** errors (`NotFound`, `OutOfStock`, etc.), the
ProblemDetails body carries author-declared fields only; the
author's sensitivity annotations on those fields are honoured at
every status code, in every environment.

## Repository-access re-shape — `getById` / `findById`

These calls live in workflows (per `docs/workflow.md`'s body
vocabulary) and in the auto-exposed `byId` CRUD operation. They're
the entry points for "load an aggregate by id"; today both throw on
absence. The re-shape:

| Call (today) | Today's behaviour | After this proposal | Lowering |
|---|---|---|---|
| `Repo.getById(id)` | Throws `AggregateNotFound` if missing | Returns `T or NotFound` | `?`-propagable in workflows / aggregate-op-sibling-call contexts |
| `Repo.findById(id)` | Returns nullable (not yet legal in workflows) | Returns `T option` | Legal in workflows; `?` propagates `none` if the enclosing return is option-shaped, else use `.orError(...)` |
| `Repo.<find>(...)` returning a single non-nullable aggregate (declared `: X`) | Throws on absence | Returns `X or NotFound` | Same as `getById` |
| `Repo.<find>(...)` returning a list (declared `: X[]`) | Returns array | Returns `X[]` (unchanged) | — |
| `Repo.<find>(...)` returning a page (declared `: X page`) | Returns page | Returns `X page` (unchanged) | — |
| Named find declared with optional return (`: X?`) | (Today: not yet supported in workflows) | Returns `X option`; legal in workflows | — |

The lowering site is `src/ir/lower.ts` find-decl lowering plus each
backend's repository builder. The route emitter dispatches on the
result carrier exactly as the API-edge translation section specifies
(error variants → ProblemDetails with status from api mapping;
`none` → 404 default).

**Backwards compatibility**: today's `Repo.getById(id)` call inside
a workflow body becomes `Repo.getById(id)?` after the migration.
The `?` propagates `NotFound` to the workflow's return signature.
Authors who specifically want the throwing shape (rare; usually a
mistake under this model) can use `.unwrap()` (a carrier-stdlib
helper that panics on error variants — equivalent to today's throw
behaviour).

Example migration in a workflow body:

```
# Before:
workflow placeOrder(customerId: Customer id, ...) {
  let customer = Customers.getById(customerId)   # throws on missing → 404
  ...
}

# After:
workflow placeOrder(customerId: Customer id, ...): OrderId or NotFound or ... {
  let customer = Customers.getById(customerId)?  # NotFound propagated
  ...
}
```

The workflow's return-type union widens to include `NotFound` (and
any other variants its body can produce). The api auto-exposes the
workflow as `POST /workflows/place_order`; the route handler
translates `NotFound` → 404 ProblemDetails (stdlib default), success
variant → 200 with body data.

### `NotFound`'s default status

`NotFound` is a stdlib `error` payload (HTTP-blind, like every error
declaration):

```
# In src/stdlib/payloads/errors.ddd:
error NotFound { what: string, id: string }
```

Its **404 status** comes from the generator's stdlib defaults table
(`src/system/error-defaults.ts`), not from the declaration. Any
api surface that uses `NotFound` gets 404 without writing a `status`
line; the override path is the same as any other error if needed.

Per-aggregate override (a find declaring `: X` but mapping absence
to a custom error type) is a v2 extension if demand surfaces.

### Migration impact

This is the **big coordinated change** in the phasing. Every:

- Repository implementation in every backend's emitter
  (`*Repository.ts`, `*Repository.cs`, `*_repository.ex`).
- Workflow body that uses `Repo.getById(...)` or a `: X`-returning
  find — `?` added at every call site.
- Auto-exposed api CRUD route (`byId`, `update`, `delete`) — today's
  try/catch for `NotFoundException` gone; variant dispatch replaces
  it. Generated, no user code touched.
- Existing `.ddd` example file using these patterns (which is most
  of them).

The fixture-byte-identical regression bar (per CLAUDE.md's
`test/fixtures/`) needs a coordinated re-baseline. Plan a single
PR that touches every fixture; don't split.

## Parse, validate, and external API calls

All today's exception sources at the application boundary get
re-shaped:

### Parse intrinsics

```
# Today: parse Money from "10.50 USD" throws on malformed input.
# Proposed:
parse Money from "10.50 USD"  : Money or ParseError
parse int   from someString   : int   or ParseError
parse uuid  from userInput    : uuid  or ParseError
```

`ParseError` is a stdlib `error` payload (HTTP-blind):

```
error ParseError { input: string, expected: string, message: string }
```

Its 400 status comes from the generator's stdlib defaults table —
not from the declaration.

### Validators (upstream Phase 5)

```
validate for OrderItem {
  quantity > 0
  unitPrice > 0
}
```

Lowers to a function `validate(x: OrderItem): OrderItem or
ValidationError[]` that **accumulates** all field errors (not
short-circuiting on the first). `ValidationError` is a stdlib
`error` payload (HTTP-blind, like every error):

```
error ValidationError { field: string, code: string, message: string }
```

Its 422 status comes from the generator's stdlib defaults table.

Multi-error accumulation is handled by the carrier stdlib's
`combine` helper. No separate `Validated<T, NEL<E>>` carrier needed
for v1 — `T or ValidationError[]` + `combine` covers the common
form-validation case.

### External API calls

```
# call api Foo.bar(x) lowers to an or-returning fetch:
let result = call api Foo.bar({ id: 123 })?
# result: ResponseDTO

# Type: ResponseDTO or ApiError
```

`ApiError` is a stdlib `error` payload union (each variant
HTTP-blind):

```
error TransportFailure  { message: string }
error UnexpectedStatus  { status: int, body: string }
error DeserializeError  { expected: string, raw: string }

# Convenience named union for external API call sites:
payload ApiError = TransportFailure | UnexpectedStatus | DeserializeError
```

Default statuses (each → 502) live in the generator's stdlib table.
Inbound `call api` failures *usually* aren't re-emitted to the
caller verbatim — the caller's operation typically does
`.mapErr(...)` or pattern-matches — but the 502 defaults apply when
they bubble through to an api response.

### File IO

If/when Loom exposes file IO to authors, same shape: `read file ...
: bytes or IoError`. Out of scope for v1 (Loom has no file IO
surface today).

## Carrier stdlib — A7a and A7b

### A7a: the closed builtin set

Generator-emitted, per-instantiation. No DSL surface for declaring
new helpers; the generator stamps these for every used instantiation.

```
# (signatures here are sketches; surface-DSL function types are A7b)
(T option).map      : ((T option), T -> U) -> U option
(T option).flatMap  : ((T option), T -> U option) -> U option
(T option).orElse   : ((T option), T) -> T
(T option).orError  : ((T option), E) -> T or E
(T or E).map        : ((T or E), T -> U) -> U or E      # map success type
(T or E).mapErr     : ((T or E), E -> F) -> T or F      # map error type
(T or E).combine    : (T or E)[] -> T[] or E[]          # accumulate
```

Per-backend, these are one helper per used instantiation. TS gets
generic functions (free). .NET gets a per-instantiation static
class method. Phoenix gets a module function per instantiation,
though in practice most of these collapse into Elixir stdlib calls
(`Enum.map`, `with`-chains).

**A7a needs first-class function types in the IR** (`T -> U`) for
the helper signatures — but **not in the surface DSL** for v1.
Authors can't pass arbitrary lambdas to `.map` yet; they invoke the
helpers via blessed call sites that the lowering layer recognises
(e.g., `opt.map(field)` for projecting a single field). A future
A7b extends this.

### A7b: user-declarable carrier-generic functions

Deferred. Requires:

- First-class function types in the surface DSL.
- Exhaustive `match` on generic union instantiations in the type
  checker.
- The variant-name-tagged identity rule pinned in the upstream
  proposal (so monomorphisation is unambiguous).

```
# A7b — not in v1:
fn map(T: carrier, U: carrier)(opt: T option, f: T -> U): U option {
  match opt {
    some -> some(f(opt.value))
    none -> none
  }
}
```

A7b ships when there's concrete demand from real DSL programs. v1
covers the 95% case with A7a.

## Migration phases — A1 through A7

Layered on top of upstream proposal's Phase 1–5:

| Phase | Scope | Dependency |
|---|---|---|
| **A1** | `error` payload sugar keyword (no status clause — domain stays HTTP-blind). `none` unit type + `option` postfix sugar. Stdlib error payloads (`NotFound`, `ParseError`, `ApiError` variants, `ValidationError`) and stdlib `ProblemDetails` payload. Generator-side stdlib status defaults table. Validator enforces no-throw outside aggregate bodies. | Upstream Phase 1+3+4 |
| **A2** | `?` propagation operator with error-marker dispatch. Scoping rules. Per-backend lowering. | A1 |
| **A3** | API-surface `httpStatus <Error> <Code>` clause + per-api `errorStatuses` enrichment. Per-backend route emitter auto-generates ProblemDetails translation (status from api mapping or stdlib default; body auto-derived). Aggregate-invariant throws hit a global 500-ProblemDetails fallback per backend. **Status: shipped on Hono + .NET; Phoenix originally deferred** (the historical Ash update-action model couldn't return a union — see "Implementation status" above; the Ash foundation has since been removed and union returns ship on vanilla elixir). The clause spelling is `httpStatus` (not `status`) to avoid colliding with the very common `status:` field name. | A1 |
| **A4** | Re-shape find variants. `: X` → `X or NotFound`, `: X?` → `X option`. Migrate every example .ddd + every backend's route/repository emitter. **Single coordinated PR.** | A1, A3 |
| **A5** | Parse intrinsics return `T or ParseError`. External API calls return `T or ApiError`. Macro-wrapped throwing helpers retired. | A1, A2 |
| **A6** | `validate for X` (upstream Phase 5) returns `X or ValidationError[]`. Multi-error accumulation via `combine`. | A1, A2, upstream Phase 5 |
| **A7a** | Generator-emitted carrier stdlib (`.map`, `.flatMap`, `.orElse`, `.orError`, `.mapErr`, `.combine`) for `option` and `or` unions. Per-instantiation monomorphic helpers per backend. | A1 |
| **A7b** | (Deferred to v2.) User-declarable carrier-generic functions. First-class function types in surface DSL. | A7a, plus surface-DSL extensions |

**A1 + A2 + A3 are the minimum coherent ship.** Without all three,
authors either can't declare typed errors, can't compose
error-returning calls ergonomically, or can't return errors to
HTTP. Ship them together.

**A4 is the user-visible turning point.** After A4 the standard
generated route layer has no try/catch for not-found; the catalog's
`not_found` event sources from `NotFound`-variant encoding, not
exception capture.

A5 and A6 chase the long tail. A7a polishes ergonomics.

## What this proposal explicitly does NOT do

- **Reach into aggregate code.** Aggregate-invariant throws stay.
  The two-regime line is held precisely so the domain core stays
  rich and expressive (operations can fail loudly when an invariant
  is wrong).
- **Force monadic style on authors.** `?` is the only new operator;
  every other operation reads like ordinary procedural code. The
  carrier stdlib's `.map`/`.flatMap` are available but optional.
- **Introduce effects / monads as first-class concepts.** No
  `IO<T>`, no do-notation beyond the single `?` operator, no type
  classes for `Functor`/`Monad`. v2 conversations.
- **Replace today's observability story.** The catalog stays. Some
  events (`not_found`, `domain_error`, `validation_failed`) shift
  from "exception captured" to "error variant encoded at wire" but
  the on-wire events look the same to operators.
- **Bring back `Result<T, E>` or `Option<T>` as named wrapper
  types.** Anonymous `or` unions + the `option` postfix sugar cover
  every case. The Ok/Err/Some/None variant constructors are gone;
  values carry their own variant identity by their type.

## Hard parts (honest list)

- **A1's two-regime validator rule.** Detecting "this code is
  inside an aggregate operation vs inside an application-boundary
  operation" needs the IR to know the enclosing context. Likely a
  field on the IR's expression context (`callKind` or similar in
  `src/ir/loom-ir.ts`). Net change is small but threads through
  every call lowering.
- **A2's `?` scoping.** Validator must propagate "is this enclosing
  fn's return an `or` union containing this expression's error
  variants" through the type-check pass. Variant set membership
  needs to be cheap — straightforward but new.
- **A3's per-api enrichment.** Per-api `errorStatuses` map is a
  pure pass merging stdlib defaults with author-declared overrides.
  The consumers (per-backend route emitters + the generated
  ProblemDetails translators) need updating in lockstep. Mirrors
  today's `wireShape` enrichment + consumer pattern.
- **A4 is the coordinated migration.** Every example .ddd, every
  backend repo emitter, every backend route emitter, every fixture.
  Plan one PR; don't split. Estimate: 2-3 days of mechanical work
  per backend, plus fixture re-baseline.
- **Phoenix's `with` collapsing.** Multiple `?` uses in a body
  should lower to a single `with` block, not nested ones. The
  Phoenix `render-stmt.ts` emitter needs to recognise the
  propagation pattern at function scope and coalesce.
- **HTTP success-body shape**: when an operation returns
  `OrderId or NotFound`, the success body on HTTP 200 is just the
  `OrderId` data (no `{"kind": "OrderId"}` envelope, because the
  status code IS the discriminator). But for non-HTTP carriers
  (queue messages), the tagged envelope IS needed (no out-of-band
  status). The wire-encoding pass distinguishes — small but
  important rule.
- **`error` keyword adoption.** Authors used to throwing might miss
  that they need to *declare* their errors as `error` payloads.
  Validator's `loom.throw-outside-domain` (upgraded to ERROR after
  A4) catches the regression; documentation needs a "from try/catch
  to typed errors" migration guide.

## What this enables, downstream

Once shipped, several follow-ups become small:

- **`page` as a carrier for paginated finds** — `find findAll(...):
  X page` returns `X page` directly; if pagination can fail,
  `X page or NotFound`. The propagation operator threads through
  unchanged.
- **`envelope<P>` for queues / event bus** — `OrderPlaced envelope`
  carries an event with id/timestamp/correlation metadata. The
  envelope itself can be wrapped in an `or` union if delivery can
  fail.
- **Better error catalogues for OpenAPI** — because every operation
  declares its full set of error variants in the return type, the
  OpenAPI emission emits precise per-status response schemas (today:
  bespoke per-route or absent).
- **Composable retry / circuit-breaker macros** — wrap an
  `or`-returning call once at the macro layer; today's
  exception-based retry has to live inside the throw/catch dance.

## Open questions (need human input)

1. **Carrier bound name** (also in upstream): `carrier` vs `value`
   vs `data`. Lean `carrier`. **Recommended: `carrier`.**
2. **`?` operator vs `try` keyword.** Lean `?`. **Recommended:
   `?`.**
3. **`NotFound` as the default error type for find `: X` returns.**
   `NotFound` only, or per-aggregate override (`: X or MyError`)?
   **Recommended: `NotFound` only in v1.**
4. **User error with no explicit `status` line in any api surface**:
   silent default (500 + `domain_error`) vs
   validator-error-forcing-explicit. **Recommended: warning
   (`loom.unmapped-error-status`), 500 default body.**
5. **Variant naming for `none`**: `none` (lowercase, lean) vs
   `nothing` / `unit` / `void` / `nil`. **Recommended: `none`.**
6. **Two-regime enforcement strictness over time**: warning vs
   error when a non-aggregate body throws. **Recommended: warning
   in A1-A3, ERROR after A4.**
7. **Where regime-violation diagnostics surface**:
   `loom.throw-outside-domain` validator code. Per CLAUDE.md's
   convention of `loom.<id>` codes.
8. **Success-body shape on HTTP 200 for `or` unions with primitive
   success types**: `"ord_abc123"` (bare value), `{"value":
   "ord_abc123"}` (single-key envelope), or `{"kind": "OrderId",
   "value": "ord_abc123"}` (tagged)? **Recommended: bare value for
   primitives, payload-as-object for payload types; never the
   `kind` envelope on the success path (the HTTP status IS the
   discriminator).** Open for confirmation.

## File-level work breakdown (for the implementing agent)

### A1 — `error` keyword + `none`/`option` + stdlib + two-regime validator

- Upstream proposal Phase 1 already adds the `error` keyword as a
  sugar-payload; this phase consumes it and adds semantics.
- `src/stdlib/payloads/` (new) — declare `none` unit type,
  `NotFound`, `ParseError`, `ApiError` variants, `ValidationError`
  as stdlib `error` payloads. Toolchain bootstrap: parse stdlib at
  startup; expose pre-declared types to user programs without
  imports.
- `src/ir/loom-ir.ts` — `isErrorVariant` derived from the `error`
  keyword on the payload declaration.
- `src/language/ddd-validator.ts` — add `loom.throw-outside-domain`
  diagnostic. Walk operation bodies; reject `raise`/`throw`-shaped
  lowering unless enclosing context is an aggregate operation body.
  (Warning in A1-A3, ERROR after A4 — see Open Q6.)
- Tests: parsing tests for declaring `error` payloads; one
  negative throw-outside-domain test per regime-violation pattern;
  one test verifying `string option` desugars to `string or none`.

### A2 — `?` propagation operator

- `src/language/ddd.langium` — add postfix `?` in `Expression`
  rule with the disambiguation lookahead from §"Grammar — `?`
  disambiguation". LSP / Monaco tokeniser updates so the four `?`
  uses highlight distinctly.
- `src/ir/lower-expr.ts` — lower `expr?` to a `PropagateExprIR`
  that records the variant partition (errors to short-circuit,
  successes to unwrap).
- `src/ir/loom-ir.ts` — `PropagateExprIR { inner: ExprIR,
  errorVariants: VariantName[], successVariants: VariantName[] }`.
- `src/language/ddd-validator.ts` — enclosing-fn return-type check;
  variant-set subset rule; `loom.propagate-bad-scope`,
  `loom.propagate-incompatible-error`.
- Each backend's `render-expr.ts` / `render-stmt.ts` — lower per
  §"Lowering per backend" above.
- Phoenix: the `render-stmt.ts` emitter coalesces multiple
  `Propagate` nodes in one body into a single `with` block.
- Tests: parsing test; one scoping test per violation; per-backend
  lowering tests; one end-to-end test threading three `?` calls.

### A3 — API-surface `status` mapping + ProblemDetails translation

- Grammar (`src/language/ddd.langium`): `status <ErrorTypeRef>
  <IntegerLit>` clause inside `api Foo for Bar { ... }` blocks.
  Zero or more lines.
- IR (`src/ir/loom-ir.ts`): `errorStatuses: Map<ErrorTypeName,
  HttpStatus>` on `ApiIR`. Populated from the AST clauses.
- Enrichment (`src/ir/enrichments.ts`): for each api, merge
  generator-side stdlib defaults (`src/system/error-defaults.ts`)
  with the per-api overrides. Result: a complete map for every
  error type the api can encounter.
- Stdlib payload: `ProblemDetails { type: string?, title: string,
  status: int, detail: string?, instance: string? }` in
  `src/stdlib/payloads/`.
- Generator-side stdlib status table: `src/system/error-defaults.ts`
  (or equivalent). Hardcoded `{ NotFound: 404, ValidationError:
  422, ParseError: 400, Forbidden: 403, TransportFailure: 502,
  UnexpectedStatus: 502, DeserializeError: 502 }`.
- Each backend's route emitter — generate the ProblemDetails
  translator + dispatch:
  - TS Hono: helper `toProblemDetails(value, errorStatuses)`;
    route handler matches on the variant and emits status + body.
  - .NET: per-api `IExceptionHandler` + per-route filter; uses
    the same map. Idiomatic ASP.NET Core wiring; Loom generates
    it.
  - Phoenix: action returns value; route handler maps via
    `ProblemDetails.from/2` and `put_status` + `json`.
- Global fallback per backend: aggregate-invariant throws hit a
  500 ProblemDetails handler with `type: "/errors/internal"`.
  Body shape is **env-aware** (controlled by
  `LOOM_EXPOSE_INTERNAL_ERRORS`; defaults from each backend's
  native dev/prod check). Dev/test → full details (exception,
  stack, aggregate state); prod → minimal body with a
  correlation id pointing at the catalog event. Sensitive fields
  stay redacted in either mode (see "Sensitivity intersection"
  subsection above). The catalog `invariant_violated` event has
  the full context regardless.
- Validator: `loom.unmapped-error-status` warning when an error
  variant flows into an api but has no mapping (neither per-api
  nor stdlib).
- Tests: parsing test for the api `status` clause; per-backend
  emission tests asserting the ProblemDetails shape; one
  end-to-end test with an error returning a 4xx with the full
  ProblemDetails body; one test asserting success bodies carry NO
  `kind` envelope and NO ProblemDetails wrapping; one test
  asserting aggregate-invariant throws yield the 500 ProblemDetails
  fallback with the catalog event logged.

### A4 — Find-variant re-shape

- `src/ir/lower.ts` — find-decl lowering wraps declared return
  type into the carrier per the find-variant table.
- Backends: each repository builder returns `or` shapes; each
  route emitter deletes the try/catch for `NotFoundException` (A3
  now covers it via variant dispatch).
- Examples: every `examples/*.ddd` and `web/src/examples/*.ddd`
  audited; finds updated to use `?` at call sites where needed.
- Fixtures: **coordinated re-baseline** of `test/fixtures/`.
  Capture script: `scripts/capture-baseline-fixture.mjs`. Single
  PR.
- Validator upgrade: `loom.throw-outside-domain` becomes ERROR
  (was warning in A1).
- Tests: one e2e per backend asserting a `: X` find returns 404 on
  missing.

**Risk**: this is the big coordinated migration. **One PR**, no
splits. Block A5–A7 until A4 lands.

### A5 — parse intrinsics + external API as `or`

- `src/ir/lower-expr.ts` — `parse X from Y` expression lowers to
  `X or ParseError`.
- API client lowering — `call api Foo.bar(x)` lowers to a fetch
  returning `T or ApiError`. Macro-wrapped throwing helpers
  retired.
- Per-backend updates.
- Tests: per-backend.

### A6 — `validate for X` returns `or`

- Lowering: `validate for X { ... }` emits a function returning
  `X or ValidationError[]`.
- Per-backend: invocation sites use `?` to propagate.
- Tests: multi-rule accumulation tests.

### A7a — Carrier stdlib helpers

- Per-backend code-gen for the helper set per used instantiation.
- TS: generic functions in `src/generator/ts/emit/payloads.ts`
  (trivial).
- .NET: per-instantiation static class.
- Phoenix: module function per instantiation; many collapse into
  Elixir stdlib calls. Module: `<App>.Carriers`.
- IR recognition: `opt.map(field)` lowers to `CarrierMapIR` rather
  than a general function call.
- Tests: per-helper, per-backend.

## Wire-spec impact

Today's `<outdir>/.loom/wire-spec.json` artifact (built by
`src/system/wire-spec.ts` from `wireShape`) captures aggregate wire
contracts for diff-based change detection. With this proposal:

- Every named or anonymous `or` union used in an operation return
  adds an entry to the spec.
- Each api's resolved `errorStatuses` map (per-api overrides merged
  with stdlib defaults) is captured per-api in the spec, so
  status-code drift surfaces in the diff.
- Stdlib `error` payloads (`NotFound`, `ParseError`, etc.) appear
  once globally in the spec; their default statuses come from the
  generator-side defaults table.

`src/system/wire-spec.ts` needs a small extension in A1/A3 to emit
the error-payload and `or`-union entries plus per-api status
tables. The diff-detection consumers (CI gate, OpenAPI parity
check) work unchanged because the spec stays JSON-shaped.

## Cross-references

- [`payload-transport-layer.md`](./payload-transport-layer.md) —
  **upstream**. Required reading before this doc. The carrier
  bound widening, aggregate-as-carrier projection rule,
  variant-name-tagged identity rule, `error` sugar keyword, and
  anonymous-`or`-unions construct are all pinned there because this
  doc depends on them.
- [`criterion.md`](./criterion.md) — adds **criteria**
  (parameterised pure predicates over a type; Spring-Data / Evans
  Specification Pattern) bound to parameters via
  `from <Criterion>(args)` and to operation guards via
  `when <Criterion>` (canCommand pattern with auto-exposed
  `can-<op>` query endpoints). Also adds built-in
  `Repo.list(criterion, sort?, page?, loads?)` for generic list
  queries (solves "repository with 40 methods"). Resolves the
  "cross-aggregate domain rule" question this doc doesn't fully
  address. Also adds `private workflow` (reusing the existing
  `private` modifier from `private operation` /
  `private invariant`) plus workflow-calls-workflow for reusable
  mutating orchestration.
- [`aggregate-inheritance.md`](./aggregate-inheritance.md) — sister
  proposal to the upstream. Unaffected by this doc; aggregates stay
  nominal and concrete.
- [`partial-update.md`](./partial-update.md) — PATCH-style command
  pattern using `command` + `option`-typed fields. Wire-encoding
  rule (field-omit vs explicit null) is driven by the `command`
  keyword + position-driven encoding.
- [`implementation-plan.md`](./implementation-plan.md) — overall
  delivery plan covering this proposal alongside the upstream and
  the aggregate-inheritance proposal.
- `docs/observability.md` — catalog of standard events. `not_found`,
  `domain_error`, `validation_failed` shift sources after A4–A6 but
  on-wire shape preserved.
- `src/ir/enrichments.ts` — `wireShape` enrichment is reused for
  aggregate-as-carrier projection in A1. Sibling `errorStatuses`
  enrichment (per-api, merged with stdlib defaults) added in A3.
- `src/system/error-defaults.ts` (new) — generator-side hardcoded
  stdlib status defaults table. Stdlib `.ddd` files never carry
  status annotations.
- `src/language/ddd-validator.ts` — new diagnostics:
  `loom.throw-outside-domain`, `loom.unmapped-error-status`,
  `loom.propagate-bad-scope`, `loom.propagate-incompatible-error`.
- #480 — Elixir domain trace via `:telemetry` (originally the Ash
  foundation, now plain Ecto/Phoenix after Ash was removed).
  `invariant_violated` events stay sourced from aggregate-invariant
  throws (regime 1); unaffected by this proposal.
