# Exception-less flow — `Result`, `Option`, propagation, wire-edge mapping

> Status: proposal. **Upstream proposal**:
> [`payload-transport-layer.md`](./payload-transport-layer.md) — this
> doc consumes its Phase 3+4 (carrier-bounded generics + tagged
> unions), its `: carrier` bound widening, its aggregate-as-carrier
> projection rule, and its variant-name-tagged identity rule. Read
> that doc first.

## TL;DR

Loom today uses exceptions for "non-domain-invariant" failures —
not-found, validation, parse errors, external API failures. This
proposal removes them everywhere **except** aggregate invariant
violations, by:

1. Adding native `Option<T>` / `Result<T, E>` as payload unions (falls
   out of the upstream proposal's Phase 3+4).
2. Adding a `?` propagation operator so the typed flow doesn't
   become a five-line `match` at every call site.
3. Adding a declarative wire-edge status mapping (`on wire { ... }`
   clause) on `Err` variants, so `Err<NotFound>` → 404 without
   per-route boilerplate.
4. Re-shaping find variants so `find one` returns `Result<T,
   NotFound>` and `find first` returns `Option<T>` natively.
5. Re-shaping parse / validate / external API call lowerings to
   return Result, never throw.

The two-regime line is **explicit**: aggregate invariants (`requires`
/ `ensures`) may throw; everything else returns a carrier. The
validator enforces this.

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
2. **Every backend route emitter is a try/catch tower.** `src/generator/ts/...routes`,
   the .NET controller emission, and the Phoenix action handlers all
   carry parallel implementations of "if this exception class, return
   that status code". They drift; they have to.
3. **Composition is awful.** Calling three operations in sequence
   today means either three try/catch blocks or letting all exceptions
   bubble to the route layer where the mapping is uniform but
   imprecise. Typed Result + propagation operator collapses both
   options into one ergonomic call.

The user-facing pitch: **standard flows shouldn't go through the
exception channel.** Exceptions belong in domain invariants — places
where reaching the code is itself a bug.

## Scope and non-goals

**In scope (v1)**:

- `Option<T>`, `Result<T, E>` as native payload unions.
- `?` propagation operator with scoping rules.
- `on wire { ... }` clause on Err payloads for HTTP status mapping.
- Find-variant re-shape (`find one` → `Result`, `find first` →
  `Option`, `find all` unchanged).
- Parse intrinsics return `Result<T, ParseError>`.
- `validate for X { ... }` (from upstream proposal Phase 5) returns
  `Result<X, ValidationError[]>`.
- External API calls (`call api Foo.bar(x)`) return `Result<T,
  ApiError>`.
- Carrier stdlib (`map`, `flatMap`, `orElse`, `orError`, `combine`)
  for the closed builtin set — A7a below.
- Two-regime enforcement: validator rejects throws outside aggregate
  bodies.

**Deferred (v2 or later)**:

- User-authored carrier-generic functions (writing your own
  `MyCarrier.map`) — A7b below. Needs structural rules pinned in
  upstream proposal but no v1 use case strong enough to justify the
  type-system work.
- `Validated<T, NEL<E>>` / applicative error accumulation. Covered
  for v1 by `Result<T, ValidationError[]>` + `Result.combine` helper.
- Async / `IO<T>` / `Task<T>` effect types. Loom doesn't expose async
  surface to authors today.
- Higher-kinded types, type classes (`Functor`, `Monad`). v1 ships
  monomorphized per-instantiation helpers; no shared abstract
  signature.
- `?.`-style chained access on Option (e.g. `customer?.address?.city`).
  Sugar; defer until concrete demand.
- `try`/`catch` in user code (it never appears).

## The two regimes — pinned

| Regime | What it covers | Failure model |
|---|---|---|
| **Domain core** | Aggregate invariants (`requires` / `ensures`), aggregate construction preconditions, internal generator-emitted assertions | **May throw.** A violation is a programmer bug, not a value worth propagating. |
| **Application / boundary** | Find / lookup, parse, validate, external API call, file IO, type coercion, operation bodies that orchestrate the above | **Never throws.** Returns `Result<T, E>` or `Option<T>`. |

The line is **enforced by the validator**:

- Any expression appearing inside an `aggregate { operation { ... }
  }` body whose return type is `T` (not `Result<T, _>`) may
  throw via invariant checks — that's the only legal channel.
- Any expression elsewhere — operation bodies declared with a
  Result/Option return, repository methods, parse intrinsics,
  validator bodies, external API call lowerings — must return a
  carrier. The validator forbids `raise`/`throw`-shaped lowering in
  these contexts.

Observability mapping (preserves today's catalog):

- `invariant_violated` / `precondition_evaluated` from #480 — fired
  by aggregate-invariant throws (unchanged).
- `domain_error` — repurposed: fires on `Err<E>` returned at the
  wire edge with no specific status mapping. Today's catch-all stays
  as a fallback, not a primary signal.

## Result and Option as native payload unions

```
payload Option<T: carrier> = Some<T> | None
payload Some<T: carrier> { value: T }
payload None { }

payload Result<T: carrier, E: carrier> = Ok<T> | Err<E>
payload Ok<T: carrier> { value: T }
payload Err<E: carrier> { error: E }
```

These are declared in the **carrier stdlib** (a new
`src/stdlib/payloads.ddd` or equivalent embedded source), not as
keywords. They're regular payload unions; nothing special about them
at the type-system level beyond being blessed members of the carrier
universe.

### Wire encoding

Per upstream proposal §"Discriminated unions": the `kind`
discriminator carries the variant name.

```json
// Result<OrderId, PlaceError>
{ "kind": "Ok",  "value": "ord_abc123" }
{ "kind": "Err", "error": { "kind": "NotFound", "what": "Customer", "id": "..." } }

// Option<CustomerWire>
{ "kind": "Some", "value": { "id": "...", "name": "...", "email": "..." } }
{ "kind": "None" }
```

The wire encoding is uniform across all four backends; per upstream
proposal that's the whole point of the structural transport layer.

### Per-backend lowering

| Backend | Encoding |
|---|---|
| TS / Hono / React | Discriminated union of plain objects; narrowing on `kind` is native TS. |
| .NET / Mediator | Sealed-record hierarchy with `[JsonDerivedType]` polymorphic JSON. One record per variant. |
| Phoenix / Ash | `{:ok, _} \| {:error, _}` for `Result`, `{:some, _} \| :none` for `Option` — idiomatic Elixir tuples. `with` syntax provides propagation for free (see §"`?` propagation operator"). |

### The `Customer` vs `CustomerWire` question (resolved)

Per the upstream proposal's **aggregate-as-carrier projection rule**:

- Inside a function body, `Option<Customer>`'s `Some.value` is typed
  as `Customer` (the aggregate handle, with methods).
- At the wire edge, the encoder projects `Customer` to `CustomerWire`
  automatically. The serialised form is `Option<CustomerWire>`.

The two types are distinct — aggregate ≠ wire — but the carrier
mechanism bridges them via the existing `wireShape` enrichment. No
new IR concept; just a hook in the union-arm lowering pass.

Authors who want to be explicit about transport (e.g., a field whose
static type *is* the wire form) write `Option<CustomerWire>`
directly. Both forms coexist; on the wire they're equivalent.

## The `?` propagation operator

### Motivation

```
# Without ?:
operation placeOrder(cmd: PlaceOrderCommand): Result<OrderId, PlaceError> {
  let customerResult = customers.find one cmd.customerId
  match customerResult {
    Err -> return customerResult
    Ok -> { }
  }
  let customer = customerResult.value
  let totalResult = pricing.compute(cmd.items)
  match totalResult {
    Err -> return totalResult
    Ok -> { }
  }
  let total = totalResult.value
  let order = Order.create(customer, total)
  return Ok { value: order.id }
}

# With ?:
operation placeOrder(cmd: PlaceOrderCommand): Result<OrderId, PlaceError> {
  let customer = customers.find one cmd.customerId?
  let total    = pricing.compute(cmd.items)?
  let order    = Order.create(customer, total)
  return Ok { value: order.id }
}
```

Without the operator, every Result-returning call costs five lines
and a nested `match`. Authors revert to throwing. With it, the typed
flow reads like sequential code.

### Scoping rules

- `?` is a postfix operator on an expression of type `Result<T, E>`
  or `Option<T>`.
- Legal **only inside a function body whose declared return type is**
  `Result<_, E'>` (for `?` on Result) or `Option<_>` (for `?` on
  Option, OR for `?` on Result when the enclosing return is Result
  via the coercion in the next bullet).
- For `Result<T, E>?` inside a `Result<_, E'>`-returning function:
  `E` must be **coercible** to `E'`. Coercion paths:
  - `E ≡ E'` — trivial.
  - `E'` is a union that includes `E` as a variant — automatic widen.
  - `E` is not a variant of `E'` — validator error. Author must
    `.mapErr(...)` first.
- `Option<T>?` inside a `Result<_, E>`-returning function — validator
  error. Author must `.orError(MyNotFoundError)` first to convert.
- `Option<T>?` inside an `Option<_>`-returning function — short-circuits
  with `None`.

### Lowering per backend

| Backend | Lowering of `let x = expr?` |
|---|---|
| TS | `const __r = expr; if (__r.kind === "Err") return __r; const x = __r.value;` (variable name mangled, scope-local). |
| .NET | Per-project generated `Result.Bind` helper, or a source-generator that emits the same `if (r.IsErr) return r; var x = r.Value;` shape. |
| Phoenix | Collapses into native `with {:ok, x} <- expr, ... do ... else err -> err end` at the function level. Multiple `?` uses in one body coalesce into one `with` block. |

### Alternative: `try` keyword instead of `?`

Considered. `?` is terser, lifts directly from Rust/Swift idioms
authors will recognise. `try` reads more domain-y but eats a keyword.
**Pinned to `?`**; revisit if user testing shows the symbol is
surprising. Listed in open questions below for explicit human
review.

## Wire-edge status mapping — `on wire { ... }`

### Motivation

Without this, the exception-less model leaks at the boundary: an
`Err<NotFound>` returned from an operation has to become a 404
*somewhere*. Today every backend's route emitter has a parallel
"exception class → status code" table. We replace those with one
declarative table per error payload.

### Syntax

```
payload PlaceError = NotFound | OutOfStock | Forbidden | ValidationFailed
  on wire {
    NotFound          -> 404
    OutOfStock        -> 409
    Forbidden         -> 403
    ValidationFailed  -> 422
  }
```

Each variant maps to an HTTP status. The clause is optional; defaults
apply when missing:

- `Option<T>` returned from an HTTP operation: `Some` → 200, `None`
  → 404. **No `on wire` clause needed for `Option`** — its
  defaults are universal.
- `Err<E>` with no explicit mapping for variant `V` — fallback to
  500 + emit `domain_error` event (today's catch-all behaviour,
  preserved). Validator emits a `loom.unmapped-err-variant` **warning**
  (not an error — authors may legitimately want the 500 default for
  truly unexpected errors).

### IR + lowering

- New IR enrichment pass: `errorStatusMap` per payload union, sibling
  to `wireShape` in `src/ir/enrichments.ts`. Pure pass; computes the
  variant → status table from the AST clause.
- Each backend's route emitter consumes the map:

| Backend | Route-edge shape |
|---|---|
| TS Hono | `match (result) { Ok -> c.json(value, 200); Err -> c.json(error, statusFor(error.kind)); }` |
| .NET | Controller action returns `ActionResult<T>`; switches on `Err.kind` to pick `NotFound()` / `Conflict()` / etc. |
| Phoenix | LiveView action returns the tuple; the route handler maps `:error, %{kind: ...}` to a `conn |> put_status(...) |> json(...)`. |

### Multi-error responses

Some endpoints return `Result<T, E[]>` (e.g., from a multi-field
validator). The wire-edge mapping uses the **highest-priority**
status from the error array, with priority defined by status-code
order (4xx beats 5xx, lower codes win ties). Authors can override
with an explicit `on wire combine { ... }` clause (deferred to v2 if
the default isn't sufficient).

## Find-variant alignment

Biggest practical win — re-shape the find variants so they participate
in the carrier system natively:

| Today | Proposed | Lowering site |
|---|---|---|
| `find first X where ...` (returns nullable / `X?`) | `Option<X>` | `src/ir/lower.ts` find lowering + each backend's repository builder |
| `find one X where ...` (throws on missing) | `Result<X, NotFound>` | Same |
| `find all X where ...` (returns array) | `X[]` (unchanged; empty array is the absence signal) | Same |

### `find one`'s default error type

Pinned to `NotFound` for v1:

```
payload NotFound { what: string, id: string }
  on wire { NotFound -> 404 }
```

`find one` lowers to `Result<X, NotFound>` automatically. Per-aggregate
override (`find one X where ... or Err<MyLookupError>`) is a v2
extension if real use shows that authors want different error shapes
per aggregate.

### Migration impact

This is the **big coordinated change** in the phasing. Every:

- Repository implementation in every backend's emitter
  (`*Repository.ts`, `*Repository.cs`, `*_repository.ex`).
- Route handler that today catches `NotFoundException` and emits
  404 — those try/catches go away; the union dispatch replaces them.
- Existing `.ddd` example file that uses `find one` (which is most
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
parse Money from "10.50 USD"  : Result<Money, ParseError>
parse int  from someString    : Result<int, ParseError>
parse uuid from userInput     : Result<uuid, ParseError>
```

`ParseError` is a stdlib payload with `on wire { ParseError -> 400 }`.

### Validators (upstream Phase 5)

```
validate for OrderItem {
  quantity > 0
  unitPrice > 0
}
```

Lowers to a function `validate(x: OrderItem): Result<OrderItem,
ValidationError[]>` that **accumulates** all field errors (not
short-circuiting on the first). `ValidationError` is a stdlib payload
with `{ field: string, code: string, message: string }`.

Multi-error accumulation is handled by `Result.combine` (carrier
stdlib, A7a) — no need for a separate `Validated<T, NEL<E>>` type
for v1.

### External API calls

```
# call api Foo.bar(x) lowers to a Result-returning fetch
let result = call api Foo.bar({ id: 123 })?
# result: ResponseDTO

# Today's macro-wrapped throwing call becomes typed:
# Result<ResponseDTO, ApiError>
```

`ApiError` is a stdlib payload:

```
payload ApiError = TransportFailure | UnexpectedStatus | DeserializeError
  on wire {
    # Note: these statuses are for *re-emission* to the caller, when
    # an ApiError surfaces from a server-side operation. Inbound API
    # call failures don't go on the wire; they're consumed by the
    # caller in the operation body.
    TransportFailure   -> 502
    UnexpectedStatus   -> 502
    DeserializeError   -> 502
  }
```

### File IO

If/when Loom exposes file IO to authors, same shape: `read file ... :
Result<bytes, IoError>`. Out of scope for v1 (Loom has no file IO
surface today).

## Carrier stdlib — A7a and A7b

### A7a: the closed builtin set

Generator-emitted, per-instantiation. No DSL surface for declaring
new helpers; the generator stamps these for every used instantiation.

```
Option<T>.map      : (Option<T>, T -> U) -> Option<U>
Option<T>.flatMap  : (Option<T>, T -> Option<U>) -> Option<U>
Option<T>.orElse   : (Option<T>, T) -> T
Option<T>.orError  : (Option<T>, E) -> Result<T, E>
Result<T,E>.map    : (Result<T,E>, T -> U) -> Result<U, E>
Result<T,E>.flatMap: (Result<T,E>, T -> Result<U, E>) -> Result<U, E>
Result<T,E>.mapErr : (Result<T,E>, E -> F) -> Result<T, F>
Result<T,E>.combine: Result<T, E>[] -> Result<T[], E[]>
```

Per-backend, these are one helper per used instantiation. TS gets
generic functions (free). .NET gets a per-instantiation static class
method. Phoenix gets a module function per instantiation, though in
practice most of these collapse into Elixir stdlib calls
(`Enum.map`, `with`-chains).

**A7a needs first-class function types in the IR** (`T -> U`) for the
helper signatures — but **not in the surface DSL** for v1. Authors
can't pass arbitrary lambdas to `.map` yet; they invoke the helpers
via blessed call sites that the lowering layer recognises (e.g.,
`opt.map(field)` for projecting a single field). A future A7b extends
this.

### A7b: user-declarable carrier-generic functions

Deferred. Requires:

- First-class function types in the surface DSL.
- Exhaustive `match` on generic union instantiations in the type
  checker.
- The variant-name-tagged identity rule pinned in the upstream
  proposal (so monomorphisation is unambiguous).

```
# A7b — not in v1:
fn map<T: carrier, U: carrier>(opt: Option<T>, f: T -> U): Option<U> {
  match opt {
    Some -> Some { value: f(opt.value) }
    None -> None { }
  }
}
```

A7b ships when there's a concrete demand from real DSL programs. v1
covers the 95% case with A7a.

## Migration phases — A1 through A7

Layered on top of upstream proposal's Phase 1–5:

| Phase | Scope | Dependency |
|---|---|---|
| **A1** | `Option<T>` and `Result<T, E>` as stdlib payload unions. Type-checks; can be declared as operation return types. Validator enforces no-throw outside aggregate bodies (regime separation). | Upstream Phase 1+3+4 (payload + generics + unions) |
| **A2** | `?` propagation operator. Scoping rules. Per-backend lowering. | A1 |
| **A3** | Wire-edge status mapping (`on wire { ... }` clause). `errorStatusMap` IR enrichment. Each backend's route emitter consumes the map. | A1 |
| **A4** | Re-shape find variants. `find one` → `Result<T, NotFound>`, `find first` → `Option<T>`. Migrate every example .ddd + every backend's route/repository emitter. **Single coordinated PR.** | A1, A3 |
| **A5** | Parse intrinsics return `Result<T, ParseError>`. External API calls return `Result<T, ApiError>`. Macro-wrapped throwing helpers retired. | A1, A2 |
| **A6** | `validate for X` (upstream Phase 5) returns `Result<X, ValidationError[]>`. Multi-error accumulation via `Result.combine`. | A1, A2, upstream Phase 5 |
| **A7a** | Generator-emitted carrier stdlib (`.map`, `.flatMap`, `.orElse`, `.orError`, `.mapErr`, `.combine`) for `Option` and `Result`. Per-instantiation monomorphic helpers per backend. | A1 |
| **A7b** | (Deferred to v2.) User-declarable carrier-generic functions. First-class function types in surface DSL. | A7a, plus surface-DSL extensions |

**A1 + A2 + A3 are the minimum coherent ship.** Without all three,
authors either can't express Result, can't compose Result calls
ergonomically, or can't return Result to HTTP. Ship them together.

**A4 is the user-visible turning point.** After A4 the standard
generated route layer has no try/catch for not-found; the catalog's
`not_found` event sources from `Err` encoding, not exception capture.

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
  from "exception captured" to "Err encoded at wire" but the on-wire
  events look the same to operators.

## Hard parts (honest list)

- **A1's two-regime validator rule.** Detecting "this code is
  inside an aggregate operation vs inside an application-boundary
  operation" needs the IR to know the enclosing context. Likely a
  field on the IR's expression context (`callKind` or similar in
  `src/ir/loom-ir.ts`). Net change is small but threads through every
  call lowering.
- **A2's `?` scoping.** Validator must propagate "is this enclosing
  fn Result-returning, what's the `E'` type" through the type-check
  pass. Coercion rules (`E` is a variant of `E'`) need the union
  variant lookup to be cheap — straightforward but new.
- **A3's IR enrichment for `errorStatusMap`.** Pure pass, but the
  consumers (per-backend route emitters) need updating in lockstep.
  Manageable; mirrors today's `wireShape` enrichment + consumer
  pattern.
- **A4 is the coordinated migration.** Every example .ddd, every
  backend repo emitter, every backend route emitter, every fixture.
  Plan one PR; don't split. Estimate: 2-3 days of mechanical work
  per backend, plus fixture re-baseline.
- **Phoenix's `with` collapsing.** Multiple `?` uses in a body
  should lower to a single `with` block, not nested ones. The
  Phoenix `render-stmt.ts` emitter needs to recognise the propagation
  pattern at function scope and coalesce.
- **TS narrowing and the `kind` discriminator.** Authors will
  inspect `result.kind === "Ok"` in handwritten TS interop code.
  Make sure the generated types export the variant names as
  discriminated string literals so TS narrows correctly.
- **Two-regime line at the validator boundary.** A `validate for X`
  body that calls a Result-returning helper and then `?`-propagates
  it is fine. A `validate for X` body that tries to `raise
  ValidationFailed { ... }` directly should fail validation — but
  there's a natural author confusion ("isn't this an exceptional
  case?"). Documentation matters here.

## What this enables, downstream

Once shipped, several follow-ups become small:

- **`Page<T>` as a carrier** (already in upstream proposal) — paginated
  finds return `Result<Page<X>, FindError>`, propagation operator
  threads through.
- **`Envelope<P>` for queues / event bus** — `Result<T, E>` carried
  inside an `Envelope` for at-least-once delivery, idempotency keys,
  etc.
- **`Validated<T, NEL<E>>` as a v2 carrier** if `Result<T, E[]>` +
  `combine` proves insufficient for complex form validation.
- **Better error catalogues** — because every operation declares its
  `Err<E>` shape, the OpenAPI / GraphQL schema generation can emit
  precise error response types (today: bespoke per-route or absent).
- **Composable retry / circuit-breaker macros** — wrap a `Result`-returning
  call once at the macro layer; today's exception-based retry has
  to live inside the throw/catch dance.

## Open questions (need human input)

1. **Carrier bound name** (also in upstream): `carrier` vs `value` vs
   `data`. Lean `carrier`. **Recommended answer: `carrier`.**
2. **`?` operator vs `try` keyword.** Lean `?`. **Recommended:
   `?`.** Revisit if user testing shows the symbol surprises domain
   authors used to verbose languages.
3. **Default error type for `find one`.** `NotFound` only, or
   per-aggregate override (`find one X where ... or Err<MyError>`)?
   **Recommended: `NotFound` only in v1; per-aggregate override is
   v2 if demand surfaces.**
4. **`Err<E>` with no explicit `on wire` mapping**: silent default
   (500 + `domain_error`) vs validator-error-forcing-explicit. **Recommended:
   warning, not error.** Authors should be able to ship without
   over-specifying.
5. **Variant union naming**: `Ok` / `Err` / `Some` / `None` (terse,
   FP-flavoured) vs `Success` / `Failure` / `Present` / `Absent`
   (verbose, reads naturally to non-FP authors). **Recommended:
   terse.** Domain authors learn one set quickly; verbose names
   make `?`-chained code visually noisy.
6. **Two-regime enforcement strictness**: validator-error vs
   warning when a non-aggregate-body throws. **Recommended:
   warning in early phases (A1-A3), upgrade to error after A4 lands
   and the find-variant migration has settled.** Avoids blocking
   adoption on partial migrations.
7. **Where regime-violation diagnostics surface**: `loom.throw-outside-domain`
   validator code. Per CLAUDE.md's convention of `loom.<id>` codes.

## File-level work breakdown (for the implementing agent)

### A1 — Option / Result as stdlib payload unions

- `src/stdlib/` (new dir) or embedded source — declare `Option<T>`,
  `Result<T, E>`, `Some<T>`, `None`, `Ok<T>`, `Err<E>` as payload
  unions. Wire into the parser as if they were authored payloads.
- `src/ir/loom-ir.ts` — no new node kinds needed if upstream Phase
  3+4 is in. Otherwise add `PayloadGenericIR`, `PayloadUnionIR`.
- `src/language/ddd-validator.ts` — add `loom.throw-outside-domain`
  check. Walk each operation body's IR; reject `raise`/`throw` shapes
  unless the enclosing context is an aggregate operation.
- Tests: one parsing test per builtin carrier; one negative
  validator test for each regime-violation pattern.

### A2 — `?` propagation operator

- `src/language/ddd.langium` — add postfix `?` in the expression
  rule. Pin grammar to avoid recursive AST types (per CLAUDE.md
  "use a discriminator field over inferred actions").
- `src/ir/lower-expr.ts` — lower `expr?` to a `Propagate(expr,
  enclosing-return-type)` IR node.
- `src/ir/loom-ir.ts` — `PropagateExprIR { inner: ExprIR, mode:
  'result' | 'option', errorCoercion?: VariantWiden }`.
- `src/language/ddd-validator.ts` — typecheck scope rules from
  §"Scoping rules" above. Reject mis-use.
- Each backend's `render-expr.ts` / `render-stmt.ts` — lower the IR
  per §"Lowering per backend" above.
- Phoenix specifically: the `render-stmt.ts` emitter must coalesce
  multiple `Propagate` nodes in one function body into a single
  `with` block.
- Tests: one parsing test; one scoping test per violation; one
  lowering test per backend; one e2e test that a real operation
  round-trips through `?`.

### A3 — `on wire { ... }` clause

- `src/language/ddd.langium` — add `OnWireClause` rule attaching to
  `PayloadUnionDecl`.
- `src/ir/loom-ir.ts` — `errorStatusMap?: Map<VariantName, HttpStatus>`
  on `PayloadUnionIR`.
- `src/ir/enrichments.ts` — new pure pass: walk every `Err`-shaped
  payload union, compute the map.
- Each backend's route emitter (`emit/routes.ts` for TS,
  `Controller.cs` builder for .NET, action handler for Phoenix) —
  consume `errorStatusMap` to emit per-variant status dispatch.
- Tests: one parsing test for the clause; one validator test for
  missing mappings (warning, not error); one per-backend emission
  test asserting the status dispatch.

### A4 — Find-variant re-shape

- `src/ir/lower.ts` — update find lowering: `find one` → emit
  `Result<X, NotFound>`-typed result; `find first` → emit `Option<X>`.
- Each backend's repository builder — return `Result`/`Option`
  shapes from repo methods. Eliminate the today's-throwing path.
- Each backend's route emitter — delete the try/catch for
  `NotFoundException`. The Err-encoding path already covers it via
  A3.
- Every `examples/*.ddd` and `web/src/examples/*.ddd` — audit for
  `find one` usage. Update operation bodies to use `?` (now that
  A2 is in).
- `test/fixtures/` — coordinated re-baseline. One PR, every
  fixture.
- Single PR. Don't split.

### A5 — Parse / external API

- `src/stdlib/` — declare `ParseError`, `ApiError` as stdlib
  payloads with `on wire` clauses.
- `src/ir/lower-expr.ts` — `parse X from Y` expression lowers to
  `Result<X, ParseError>`.
- `src/generator/ts/api-client.ts` (and equivalents) — `call api
  Foo.bar(x)` lowers to a `Result<T, ApiError>`-returning fetch.
  Eliminate the today's macro-wrapped throwing path.
- Tests: parsing tests for the new return types; per-backend
  emission tests.

### A6 — Validators

- Depends on upstream Phase 5. Once `validate for X { ... }` is in,
  its lowering emits `Result<X, ValidationError[]>`. Combine multiple
  rules via `Result.combine`.
- Tests: validator semantics on multi-rule accumulation.

### A7a — Carrier stdlib

- Per-backend: generate the helpers per used instantiation.
- TS: a generic function in `src/generator/ts/emit/payloads.ts` —
  trivial.
- .NET: a per-instantiation static class — one emitted file per
  `(carrier, T, U)` triple. Or a single source-generator that emits
  on demand.
- Phoenix: a module function per instantiation; many collapse into
  Elixir stdlib calls. Module: `<App>.Carriers`.
- Recognise the call sites at the IR level — `opt.map(field)` lowers
  to a `CarrierMapIR { inner: opt, projection: field }` rather than
  a general function call.

## Cross-references

- [`payload-transport-layer.md`](./payload-transport-layer.md) —
  **upstream**. Required reading before this doc. The carrier bound
  widening, aggregate-as-carrier projection rule, and
  variant-name-tagged identity rule are all pinned there because
  this doc depends on them.
- [`aggregate-inheritance.md`](./aggregate-inheritance.md) — sister
  proposal to the upstream. Unaffected by this doc; aggregates stay
  nominal and concrete.
- `docs/observability.md` — catalog of standard events. `not_found`,
  `domain_error`, `validation_failed` shift sources after A4–A6 but
  on-wire shape preserved.
- `src/ir/enrichments.ts` — `wireShape` enrichment is reused for
  aggregate-as-carrier projection in A1. Sibling enrichment
  `errorStatusMap` added in A3.
- `src/language/ddd-validator.ts` — new diagnostics:
  `loom.throw-outside-domain`, `loom.unmapped-err-variant`,
  `loom.propagate-bad-scope`, `loom.propagate-incompatible-error`.
- #480 — Ash domain trace via `:telemetry`. `invariant_violated`
  events stay sourced from aggregate-invariant throws (regime 1);
  unaffected by this proposal.
