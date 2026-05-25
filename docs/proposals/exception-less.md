# Exception-less flow — `or` unions, `option`, `?` propagation, `error` payloads

> Status: proposal. **Upstream proposal**:
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

## The two regimes — pinned

| Regime | What it covers | Failure model |
|---|---|---|
| **Domain core** | Aggregate invariants (`requires` / `ensures`), aggregate construction preconditions, internal generator-emitted assertions | **May throw.** A violation is a programmer bug, not a value worth propagating. |
| **Application / boundary** | Find / lookup, parse, validate, external API call, file IO, type coercion, operation bodies that orchestrate the above | **Never throws.** Returns a carrier — either `T option` (when absence is normal) or `T or <Error>...` (when typed errors are possible). |

The line is **enforced by the validator**:

- Any expression appearing inside an `aggregate { operation { ... }
  }` body whose return type is `T` (not a carrier) may throw via
  invariant checks — that's the only legal channel.
- Any expression elsewhere — operation bodies declared with a
  carrier return type, repository methods, parse intrinsics,
  validator bodies, external API call lowerings — must return a
  carrier. The validator forbids `raise`/`throw`-shaped lowering in
  these contexts.

Observability mapping (preserves today's catalog):

- `invariant_violated` / `precondition_evaluated` from #480 — fired
  by aggregate-invariant throws (unchanged).
- `domain_error` — repurposed: fires on an `error`-marked variant
  returned at the wire edge with no specific status mapping. Today's
  catch-all stays as a fallback, not a primary signal.

## Surface — `error`, `or`, `option` working together

A worked example showing all four mechanisms at once:

```
# Declare typed errors (sugar keyword from upstream proposal).
# Domain-side: pure payload declarations. No status codes here —
# the api surface owns the status mapping.
error NotFound   { what: string, id: string }
error OutOfStock { sku: string, requested: int }
error Forbidden  { actor: string }

# Elsewhere, in the api surface:
#   api SalesApi for Sales {
#     status OutOfStock 409    # explicit; default would be 500+warning
#     status Forbidden  403    # explicit
#     # NotFound: covered by stdlib default (404), no line needed.
#   }

# Operation returns an anonymous `or` union of one success + three errors.
# No Result wrapper, no Ok/Err variants — the type IS the union.
operation placeOrder(cmd: PlaceOrderCommand): OrderId or NotFound or OutOfStock or Forbidden {
  ensureAuthorised(cmd.actor)?              # if Err-variant, short-circuit
  let customer = customers.findById(cmd.customerId)?   # ? propagates NotFound
  let prices   = pricing.compute(cmd.items)?           # ? propagates OutOfStock
  let order    = Order.create(customer, prices)        # may throw — invariant
  return order.id                            # the OrderId variant (success)
}

# Find with optional return — `: X?` → `X option`
find findById(id: Customer id): Customer? { ... }
# Lowering type: customer option

# Find with required return — `: X` → `X or NotFound`
find findByEmail(email: string): Customer { ... }
# Lowering type: Customer or NotFound
```

In the operation body:
- `?` on `customer or NotFound` short-circuits if `NotFound`,
  otherwise unwraps to `Customer`.
- `?` on `prices or OutOfStock` propagates `OutOfStock` to the
  caller because the caller's return type already lists it.
- Returning `order.id` (an `OrderId`) is the non-error variant — no
  `Ok` wrapper needed; the value's type matches one of the union's
  arms.

Wire encoding for the response (api surface auto-generates this from
the status mapping + ProblemDetails translation):

- Success → HTTP 200, body is the `OrderId` data (`"ord_abc"` for a
  primitive, or the object shape for a payload). No `{"kind":
  "OrderId"}` envelope.
- `NotFound` → HTTP 404, body is a **ProblemDetails** object:
  ```json
  { "type": "/errors/not-found", "title": "Not Found", "status": 404,
    "detail": "Customer cus_abc not found", "instance": "/orders" }
  ```
  Status comes from the stdlib default (NotFound → 404). `type`,
  `title`, `detail` auto-derived. Error fields (`what`, `id`)
  become ProblemDetails extension members.
- `OutOfStock` → HTTP 409 (from api-surface `status OutOfStock 409`),
  ProblemDetails body shaped the same way.
- `Forbidden` → HTTP 403 (from api-surface `status Forbidden 403`),
  ProblemDetails body.

The HTTP status carries the discriminator at the route boundary; no
`kind` envelope needed for success. For non-HTTP carriers (queue
messages, persisted snapshots) the tagged `kind` form is used —
because there's no out-of-band discriminator there.

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

## Find-variant alignment

Today's grammar doesn't have `find one` / `find first` / `find all`
as kind keywords — a find is `find <name>(<params>): <returnType>`,
and the *return type declaration* drives the shape. The re-shape is
therefore at the return-type level, not a keyword change:

| Author-declared return type | Lowers to | Semantics |
|---|---|---|
| `: X` | `X or NotFound` | The find must return an X; absence is `NotFound` |
| `: X?` | `X option` (= `X or none`) | The find may or may not return an X; absence is `none` |
| `: X[]` | `X[]` (unchanged) | Multi-result; empty array is the absence signal |
| `: X page` | `X page` (unchanged; page itself is a carrier) | Multi-result paginated |

The lowering site is `src/ir/lower.ts` find-decl lowering plus each
backend's repository builder. The route emitter dispatches on the
result carrier exactly as the API-edge translation section specifies
(error variants → ProblemDetails with status from api mapping;
`none` → 404 default).

**Backwards compatibility**: today's `: X` finds that throw on
missing become Result-shaped. Existing call sites need migration —
most become `find(...)?` inside operation bodies (the `?`
propagates `NotFound` to the caller). Authors who want the old
throwing shape can `.unwrap()` (a carrier-stdlib helper that
panics on error variants).

Example migration:

```
# Before (throws):
let customer = customers.findById(cmd.customerId)

# After (typed; ? threads NotFound to caller):
let customer = customers.findById(cmd.customerId)?
```

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
- Route handler that today catches `NotFoundException` and emits
  404 — those try/catches go away; the variant dispatch replaces
  them.
- Existing `.ddd` example file using a find with non-array return
  (which is most of them).

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
| **A3** | API-surface `status <Error> <Code>` clause + per-api `errorStatuses` enrichment. Per-backend route emitter auto-generates ProblemDetails translation (status from api mapping or stdlib default; body auto-derived). Aggregate-invariant throws hit a global 500-ProblemDetails fallback per backend. | A1 |
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
- #480 — Ash domain trace via `:telemetry`. `invariant_violated`
  events stay sourced from aggregate-invariant throws (regime 1);
  unaffected by this proposal.
