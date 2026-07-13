# RFC: `contract` — typed resources you create and call

**Status:** Draft / Proposed (design only — no grammar, IR, or generator
work scheduled).

**Scope:** Introduce a single declaration, `contract`, for a **typed REST
resource**: a named set of operations and their I/O records. One keyword
serves both directions — the interface you *publish and implement*
(sourced from your domain) and the interface you *consume and call*
(sourced from a foreign spec). Direction is carried by the `from`
clause, not by a different keyword.

Companions:

- [`resource-model-and-source-types.md`](./resource-model-and-source-types.md)
  and [`workflow-resource-consumption.md`](./workflow-resource-consumption.md)
  — the `storage` / `resource` model this builds on. A `contract` is the
  *typed* layer over a `kind: api` resource.
- [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md) — the
  outbound api derivation. This RFC supersedes that proposal's narrow,
  records-only definition of "contract" (see §6).

---

## 1. The problem

### Outbound: the published interface isn't a source-level thing

`api SalesApi from Sales` silently generates request/response DTOs, verbs,
slugs, and error→status mappings, all derived ad-hoc from `wireShape`.
None of it is visible or editable in source
([`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md) §
"Problem statement"). To know what the API exposes, you run the
generators and read the output.

### Inbound: external APIs are reachable but untyped

The resource model already makes an external HTTP API first-class:

```ddd
storage payments { type: restApi, config: { baseUrl: "https://pay.example.com" } }
resource payApi  { for: Orders, kind: api, use: payments }
```

But the call surface is a **closed, untyped verb vocabulary** — raw paths
in, raw `json` out ([`resources.md`](../../resources.md) § "Verb vocabulary"):

```ddd
workflow PlaceOrder(cmd: PlaceOrderCmd) {
  let res = payApi.post("/v1/charges", { amount: cmd.total, currency: "usd" })
  // res : json   — no field types, no operation name, no compile-time check
}
```

`payApi.post("/v1/charges", …): json` has no operation identity, no typed
request, no typed response. A typo in the path, a wrong field name, or a
misread of the response shape all survive to runtime. The external API
publishes an OpenAPI document that describes exactly these operations and
shapes — Loom just doesn't read it.

**Both problems are the same shape with the direction flipped: a typed
interface exists conceptually but has no first-class source declaration.**

## 2. The model in one screen

A `contract` is a named set of **operations** (the verbs you call) and the
**records** they carry (their typed I/O). Its `from` clause names the
source of truth, which decides the direction:

```ddd
// OUTBOUND — sourced from your domain.
// You are the source of truth; Loom generates the server that IMPLEMENTS it.
// Changing it can break consumers.
contract SalesApi from Sales

// INBOUND — sourced from a foreign spec.
// They are the source of truth; Loom generates the typed client you CALL.
// Their change can break you.
contract Stripe from openapi("specs/stripe.openapi.json")
```

| | outbound (`from <context>`) | inbound (`from openapi(...)`) |
|---|---|---|
| source of truth | your domain | the foreign spec |
| Loom generates | the server (routes + handlers + validation) | a typed client |
| you write | the implementation | the call (`Stripe.createCharge(...)`) |
| breaking change direction | yours breaks *consumers* | theirs breaks *you* |
| binding to runtime | the deployable that serves it | a `kind: api` resource (§4) |

The word fits both because the *kind of thing* is identical — a published,
typed interface. Direction is not a difference in kind; it is just which
side authored it.

## 3. What a `contract` holds

An unfolded `contract` is operations + records:

```ddd
contract Stripe from openapi("specs/stripe.openapi.json") {
  record CreateCharge { amount: int; currency: string; customer: string? }
  record Charge       { id: string; status: ChargeStatus; amount: int }

  operation createCharge(body: CreateCharge): Charge        // POST /v1/charges
  operation getCharge(id: string): Charge                   // GET  /v1/charges/{id}
}
```

- **Records** are flat, transport-shaped types (the same wire vocabulary as
  `command` / `query` / `response` / `error` today). They are *not* domain
  aggregates — a contract record carries no behaviour and no runtime link to
  the domain.
- **Operations** name a callable verb with a typed parameter list and a typed
  result. An operation maps to one HTTP method + path (inbound: read from the
  spec; outbound: derived from the lifecycle action / route, as
  [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md) describes).

Operations are the *primary* content of a contract — they are what a caller
references. The records exist to type the operations.

### Scaffolded by default, unfoldable to source

Like `scaffold` for UI pages and the api derivation, a `contract` is a macro
head by default and materialises real source on unfold:

- **Inbound**, the head `contract Stripe from openapi("…")` projects operations
  and records from the spec at expansion time; unfold writes them out as
  literal declarations you can prune (hide operations you never call) or
  re-shape (narrow a response to the fields you use).
- **Outbound**, the head `contract SalesApi from Sales` projects from the domain
  (today's `wireShape` + the create/read/update filters); unfold writes the
  request/response records and the operation list as editable source.

After expansion, neither form retains a runtime reference to its source — a
contract is a flat, self-contained interface.

## 4. Inbound contracts bind through a `kind: api` resource

A `contract` is *types and operations* — it has no base URL, no auth, no
client. Those already live on the resource model. An inbound contract names
the `kind: api` resource that carries its runtime wiring:

```ddd
storage payments { type: restApi, config: { baseUrl: "https://api.stripe.com" } }
resource payApi  { for: Orders, kind: api, use: payments, contract: Stripe }
```

This is the clean separation the resource model already draws, now applied to
the call surface:

- `storage` — *where* it is (base URL, region).
- `resource` — the *configured binding* (auth, interface selection, the emitted
  client).
- `contract` — *what* it offers (typed operations + records).

The workflow then calls the contract's operations instead of slinging raw
paths — the untyped verb vocabulary's typed upgrade:

```ddd
workflow PlaceOrder(cmd: PlaceOrderCmd) {
  let charge = payApi.createCharge({ amount: cmd.total, currency: "usd" })
  // charge : Charge   — typed request, typed response, named operation
}
```

`payApi.get(path): json` / `payApi.post(path, body): json` remain available as
the untyped escape hatch for operations a spec doesn't cover (or APIs with no
spec at all). The contract is the typed *fast path*, not a replacement of the
verb vocabulary.

## 5. What this buys

- **One mental model, two directions.** "A contract is a typed interface;
  `from` says who owns it." No inbound/outbound vocabulary split, no second
  keyword (`integration` / `provider` / `client` / `gateway`) to learn.
- **Compile-time checking of external calls.** Wrong field, wrong operation
  name, misread response shape — all become validator errors, the same class
  of safety the domain already has internally.
- **Typed client generation per backend.** The existing `kind: api` adapter
  (hono `fetch`, .NET `HttpClient`, Phoenix `Req`) gains a typed method per
  operation instead of a single `get`/`post` pair.
- **Symmetry with the outbound story.** The same declaration that the
  unfoldable-api proposal needs for the *published* interface serves the
  *consumed* one — one feature, not two.

## 6. Reconciliation with `unfoldable-api-derivation.md`

That proposal defines a Layer-2 `contract` as **records only** (`command` /
`query` / `response` / `error`), pushing operations into a separate `api`
layer. This RFC **widens that definition**: a contract holds operations *and*
their records.

This is a correction, not a clash:

- The narrow definition does not hold up inside its own document — the api
  section calls the route list "the only thing that is actually a contract with
  the outside world," i.e. the *operations* are the contract.
- "Contract" everywhere outside that one proposal (design-by-contract, "the
  OpenAPI contract", "the API contract") centrally means the operations, with
  the I/O records as their vocabulary.
- A records-only `contract` cannot describe an inbound API at all — the thing
  you import and call *is* a set of operations.

Under this RFC the four-layer api model still stands; `contract` simply owns
operations + records together (outbound), and `api` keeps only the
transport-binding route list + the mediator seam.

## 7. Open questions (not decided here)

- **`from` source grammar.** `openapi("path")` for inbound; is the outbound
  form `from <Context>` (today's `api … from …`) or a distinct verb? Likely the
  former, for symmetry.
- **Spec dialects.** OpenAPI 3.0 / 3.1 first; AsyncAPI, gRPC/proto, GraphQL SDL
  are future `from` sources behind the same keyword.
- **Versioning & drift.** An inbound contract is pinned to a spec snapshot; how
  do we detect upstream drift (re-fetch + diff) versus the outbound
  `wire-spec.json` change detection? The two are mirror images and may share
  machinery.
- **Auth & per-operation config** — lives on the `resource`, but operation-level
  overrides (scopes, idempotency keys) need a home.
- **Partial import.** Default to projecting the whole spec, or require an
  explicit operation allow-list so the generated client stays small?

## 8. Why not a different keyword

`integration` / `provider` / `client` / `gateway` / `extern` were considered.
They name the *role* a thing plays ("a Stripe integration") rather than the
*kind of thing* it is. Two costs:

1. They describe only the inbound case, forcing a second word for the outbound
   published interface — losing the symmetry that is the whole point.
2. `contract` is the precise word for "a published typed interface" and is
   currently **free** — not a grammar keyword, used only informally in comments
   and as one filename (`src/diagnostics/contract.ts`). Adopting it costs no
   migration and reads naturally in both directions.

The keyword names what the declaration *is*; the `from` clause names what it
*does for you*.
