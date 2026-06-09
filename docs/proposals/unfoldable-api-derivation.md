# Unfoldable API derivation — explicit contract, application, and transport layers

> Status: **PROPOSED** (design only — no grammar, IR, or generator
> work scheduled).
>
> Companion to [`lifecycle-operations.md`](./lifecycle-operations.md)
> (lifecycle kinds drive scaffold synthesis),
> [`lifecycle-url-style.md`](./lifecycle-url-style.md) (the existing
> per-api `urlStyle` becomes one slug-rule among others),
> [`payload-transport-layer.md`](./payload-transport-layer.md)
> (payloads are the contract layer's content), and
> [`workflow-and-applier.md`](./workflow-and-applier.md) (workflows
> are first-class application-layer citizens, not wrapped by
> handlers).

## Problem statement

`api SalesApi from Sales` is, today, a five-line declarative head that
silently produces an enormous amount of generated material:

- One mount path per aggregate (`/orders` from `Order`, derived via
  `snake(plural(name))`).
- Per-lifecycle-action HTTP verb + slug from `OperationIR.kind`
  (create / operation / destroy / canonical / `urlStyle`).
- One auto-`findAll` injection on every aggregate's repository
  (added in enrichment).
- One route per public aggregate method, repository find, and workflow
  trigger.
- One request DTO per route, derived from `wireShape`'s
  create-vs-update projection.
- One response DTO per route, derived from `wireShape`.
- One error → HTTP status mapping per declared error, from
  `src/util/error-defaults.ts` plus per-api `httpStatus` overrides.
- One OpenAPI tag per aggregate.
- The implicit *call protocol* between the HTTP handler and the
  aggregate method (load → mutate → save → emit → project to wire).

None of this is visible in source. To know what the api actually
exposes, you run the generators and read their output. To customise
*any* of it (rename a route, change a request shape, hide a field,
diverge a response from the model), you reach into the generators
themselves — there's no source-level seam.

This is the same problem `scaffold` already solved for the UI: the
synthesised pages are real AST under a macro head; unfold materialises
them as editable source. The API derivation deserves the same
treatment.

## Proposal

Promote everything between `api X from Y` and the running server to
**four explicit layers**, all macro-scaffolded by default, all
individually unfoldable to source:

| Layer | Holds | Lives in | Depends on |
|---|---|---|---|
| **domain** | aggregate, repository, workflow, value object, enum | `context` | nothing |
| **contract** | command, query, response, error (the published wire vocabulary) | `context` | domain (optional, via `wire X`) |
| **application** | commandHandler, queryHandler (orchestration; workflow stays where it is) | `context` | contract + domain |
| **api** | route (transport binding) | system | contract |

The layers are strictly one-directional, matching Loom's existing
pipeline discipline. A handler may consume a contract type and call a
domain method; it must not return a domain object. A route may
reference a contract type; it must not reach into a handler body or a
domain method.

```
              api
               │
               ▼
            contract ─────┐
               ▲          │
               │          ▼
          application ─> domain
```

The dependency arrow from contract to domain is **optional and
breakable** — `response OrderResponse = wire Order` consumes the
domain wire shape; `response OrderResponse { id: OrderId, … }` cuts
the dependency and lets the contract diverge from the model. This is
how versioning, deprecation, and anti-corruption translation are
expressed.

### Layer 1 — domain (unchanged from today)

Aggregates, repositories, workflows, value objects, enums. Already
context-scoped. Already pure of transport concerns. No change.

### Layer 2 — contract (the published language)

Holds `command`, `query`, `response`, `error` declarations — the
named, addressable wire shapes the system speaks. Lives inside
`context`, alongside the aggregates whose wire shape it publishes.

Today these declarations exist (`payload-transport-layer.md` is the
relevant background) but are not the *only* expression of the wire
shape — `wireShape` enrichment also synthesises DTOs at codegen time
from the aggregate. The proposal: when scaffolding has unfolded fully,
*every* request and response shape on the wire is a named contract
declaration. The codegen-time wireShape projection becomes a
**default** (used by `response X = wire Y`) rather than the source of
truth.

Each handler I/O type is a contract declaration. Each route's request
body and response body is a contract declaration. The api speaks
contract, not domain.

#### What earns the contract / domain split

- **Different change axis.** Domain changes when business rules
  change. Contract changes when consumers can tolerate it (additive
  fields, versioning, deprecation). Different review processes,
  different release cadence.
- **Different audience.** Contract is read by SDK generators, MCP
  tool descriptions, OpenAPI consumers, and reviewers checking what's
  exposed. Domain is read by people debugging behaviour. Mixing them
  in one file leaves neither audience served.
- **It already exists as an artefact.** `.loom/wire-spec.json` is
  exactly this layer crystallised. Promoting it from a generated
  artefact to a source-layer makes it the contract, not a
  side-effect.

### Layer 3 — application (the orchestration)

Three kinds of declaration, all context-scoped, all parallel:

| Keyword | Contract it asserts | Triggers | Body shape |
|---|---|---|---|
| `commandHandler` | single-aggregate, mutating, sync | call only | load → mutate → save → return |
| `queryHandler` | no mutation, sync | call only | query → return |
| `workflow` (existing) | cross-aggregate or stateful, may be async | `create` / `handle` / `on` (event, schedule, call) | orchestration via existing workflow members |

`commandHandler` and `queryHandler` are **new top-level context
members** — effectively top-level versions of today's
`WorkflowCreateDecl` / `WorkflowHandleDecl`. A `commandHandler X(cmd:
SomeCommand): SomeResponse { body }` is a `handle` lifted out of a
workflow when the orchestration is single-aggregate.

Workflows are unchanged. They keep `create` (starter), `handle`
(orchestration command), `on` (event reactor), `apply` (event fold),
and properties. The *only* extension to workflows: routes may target
a `handle` member when the workflow exposes one, so HTTP traffic can
drive workflow continuation without a wrapper handler.

#### Why three handler kinds, not one

A single `handler` keyword loses the contract the validator can
enforce:

- A `queryHandler` calling `.save()` is a layering error.
- A `commandHandler` touching two aggregates is a layering error
  (must be a workflow).
- A `commandHandler` returning a domain object is a layering error
  (must return a contract type).

Three keywords pay for three independent contracts. The alternative
(one keyword, contract derived from body shape) loses the explicit
intent and silently degrades layering.

### Layer 4 — api (transport binding)

The api block becomes a **flat list of routes**, each one a single
line. Removed from the api block:

- **`mount` / prefix groupings** — implementation detail of the backend
  router. The route's path is self-evidencing.
- **`expose Aggregate { … }` blocks** — pure decoration. The route's
  target already names the aggregate.
- **Inline schemas** — moved to the contract layer.
- **Error → status mapping** — moved to a system-level error policy
  (one source of truth; two apis on the same system shouldn't disagree
  on what `NotFound` means).

What remains:

- `source: Subdomain` — scoping check + macro fan-out input.
- The route list — the only thing that is actually a contract with
  the outside world.
- Optionally per-api OpenAPI metadata (title, version, servers,
  security schemes) — not addressed by this proposal.

A route is:

```
route <METHOD> <PATH> -> <Context>.<HandlerOrWorkflow>
```

Path params bind by name to the handler's parameters; the trailing
parameter (if any) is the request body. The validator pins the match.

## Scaffold tree

Three independent sub-trees, one per layer. Every leaf scaffold
materialises exactly one declaration.

```
scaffoldApiFromContext(of: Sales)
├── scaffoldContractForContext(of: Ordering)
│   ├── scaffoldContractForAggregate(of: Order)
│   │   ├── scaffoldCommandForOperation(of: Order.place)          ← leaf
│   │   ├── scaffoldCommandForOperation(of: Order.cancel)         ← leaf
│   │   ├── scaffoldCommandForOperation(of: Order.archive)        ← leaf
│   │   └── scaffoldResponseForAggregate(of: Order)               ← leaf
│   ├── scaffoldContractForRepository(of: Orders)
│   │   ├── scaffoldQueryForFind(of: Orders.byId)                 ← leaf
│   │   ├── scaffoldQueryForFind(of: Orders.byCustomer)           ← leaf
│   │   └── scaffoldQueryForFind(of: Orders.findAll)              ← leaf
│   └── scaffoldContractForWorkflow(of: ReorderStockedItems)      ← leaf
├── scaffoldApplicationForContext(of: Ordering)
│   ├── scaffoldHandlersForAggregate(of: Order)
│   │   ├── scaffoldHandlerForOperation(of: Order.place)          → commandHandler PlaceOrder
│   │   ├── scaffoldHandlerForOperation(of: Order.cancel)         → commandHandler CancelOrder
│   │   └── scaffoldHandlerForOperation(of: Order.archive)        → commandHandler ArchiveOrder
│   └── scaffoldHandlersForRepository(of: Orders)
│       ├── scaffoldHandlerForFind(of: Orders.byId)               → queryHandler GetOrderById
│       ├── scaffoldHandlerForFind(of: Orders.byCustomer)         → queryHandler ListOrdersByCustomer
│       └── scaffoldHandlerForFind(of: Orders.findAll)            → queryHandler ListOrders
└── scaffoldRoutesForContext(of: Ordering)
    ├── scaffoldRoutesForAggregate(of: Order)
    │   ├── scaffoldRouteForHandler(of: Ordering.PlaceOrder)      ← leaf
    │   ├── scaffoldRouteForHandler(of: Ordering.CancelOrder)
    │   └── scaffoldRouteForHandler(of: Ordering.ArchiveOrder)
    ├── scaffoldRoutesForRepository(of: Orders)
    │   └── … one per find …
    └── scaffoldRoutesForWorkflow(of: ReorderStockedItems)
        └── scaffoldRouteForWorkflow(of: ReorderStockedItems)     ← leaf
            // emitted only when the workflow exposes a callable surface
            // (a `handle` member). Scheduled-only / event-only workflows skip.
```

Workflows are user-written, not scaffolded — the application sub-tree
fans `scaffoldHandlersForAggregate` and `scaffoldHandlersForRepository`
only. The route sub-tree includes `scaffoldRoutesForWorkflow` because
the route is mechanical even if the workflow body isn't.

Two scaffold-stdlib invariants:

1. **Leaf scaffolds compose into composers.** `scaffoldApiFromContext`
   doesn't synthesise anything directly — it invokes the three
   layer composers, which invoke the per-aggregate composers, which
   invoke the per-method leaves. Mirrors today's
   `scaffold(subdomains: …)` →
   `scaffoldSubdomain(of: …)` →
   `scaffoldContext(of: …)` →
   `scaffoldAggregate(of: …)` chain.
2. **Override-by-name everywhere.** Writing a handler explicitly
   suppresses the leaf scaffold that would have synthesised it. Same
   rule today's UI scaffolds use.

## Grammar additions

Marked clearly so the implementation pass knows what is new vs.
existing.

### NEW — `commandHandler` and `queryHandler` as context members

```
ContextMember:
    … existing members …
  | CommandHandler
  | QueryHandler;

CommandHandler:
    'commandHandler' name=ID
        '(' (params+=Parameter (',' params+=Parameter)*)? ')'
        (':' returnType=TypeRef)?
    '{'
        body+=Statement*
    '}';

QueryHandler:
    'queryHandler' name=ID
        '(' (params+=Parameter (',' params+=Parameter)*)? ')'
        ':' returnType=TypeRef
    '{'
        body+=Statement*
    '}';
```

Function-signature form mirrors today's `Operation` and
`WorkflowHandleDecl`. `queryHandler` always has a return type;
`commandHandler` may omit it (`: void` equivalent for destroy-style
handlers).

### NEW — `route` as an api-body member

```
Api:
    'api' name=ID withClause=WithClause?
        ('from' source=[Subdomain:ID])?       // optional now; carried by `with apiSurface(X)` macro
        ('{'
            … existing urlStyle / statuses …
            (routes+=Route)*
        '}')?;

Route:
    'route' method=HttpMethod path=STRING '->' target=HandlerRef;

HttpMethod returns string:
    'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

HandlerRef:
    context=[BoundedContext:ID] '.' handler=ID;
```

`HandlerRef`'s second segment resolves to a `commandHandler`,
`queryHandler`, or a workflow's `handle` member. The validator picks
the right one and reports unambiguous "handler not found" otherwise.

### NEW — `with` on `Api`

The existing `WithClause` rule is grammar-level reusable; today's
aggregates and UI consume it. Adding `withClause=WithClause?` to the
`Api` rule lets `api SalesApi with apiSurface(Sales)` parse.

### NEW — `wire X` as a type expression

```
TypeAtom:
    … existing …
  | WireTypeRef;

WireTypeRef:
    'wire' target=[Aggregate:ID];
```

Used in payload-declaration value position: `response OrderResponse =
wire Order` — sugar for the literal wire-shape projection of `Order`.
This is the *only* place the contract layer is allowed to delegate to
the domain.

### EXISTING — leveraged unchanged

- `payload | command | query | response | error` declarations
  (`ddd.langium:875-881`). Already brace-bodied and union-capable. The
  proposal adds *no* new payload syntax; scaffolds emit existing forms.
- `Repository.find` (`ddd.langium:888-890`). Already
  function-signature.
- `Operation`, `WorkflowCreateDecl`, `WorkflowHandleDecl`. Handler
  body grammar reuses their `Statement*` rules.
- `WithClause` (the macro invocation form). Already wired on
  aggregates / UI; extended to api blocks here.

## Worked example — three altitudes

### Macro form (level 0)

```ddd
api SalesApi with apiSurface(Sales)
```

### One-level unfold (level 1)

```ddd
with scaffoldContractForContext(of: Ordering)
with scaffoldApplicationForContext(of: Ordering)

api SalesApi {
  source: Sales
  with scaffoldRoutesForContext(of: Ordering)
}
```

The three layers are now nameable; each is independently editable.

### Fully unfolded (level 3)

```ddd
subdomain Sales {
  context Ordering {

    // ====== Domain (unchanged) ===================================
    aggregate Order {
      customerId: CustomerId
      items:      contains OrderLine[]
      total:      Money
      placedAt:   timestamp managed

      create place(customerId: CustomerId, items: OrderLineInput[]) { … }
      operation cancel(reason: string) { … }
      destroy archive() { … }
    }
    repository Orders for Order {
      find byCustomer(customerId: CustomerId, page: int, pageSize: int): Order paged
    }
    workflow ReorderStockedItems {
      // existing workflow members; routes target `handle` entries via HandlerRef
    }

    // ====== Contract =============================================
    command  PlaceOrderCommand   { customerId: CustomerId, items: OrderLineInput[] }
    command  CancelOrderCommand  { reason: string }
    command  ArchiveOrderCommand { }
    payload  OrderLineInput      { sku: Sku, qty: int }

    query    OrdersByIdQuery       { id: OrderId }
    query    OrdersListQuery       { page: int = 1, pageSize: int = 25 }
    query    OrdersByCustomerQuery { customerId: CustomerId, page: int = 1, pageSize: int = 25 }

    response OrderResponse     = wire Order
    response OrderLineResponse = wire OrderLine

    // ====== Application ==========================================
    commandHandler PlaceOrder(cmd: PlaceOrderCommand): OrderResponse {
      // body uses existing Statement grammar — let / save / emit / return.
      // The "load → mutate → save → return wire" call protocol is
      // visible here as source, not buried in a generator.
    }
    commandHandler CancelOrder(id: OrderId, cmd: CancelOrderCommand): OrderResponse { … }
    commandHandler ArchiveOrder(id: OrderId) { … }                  // no return type

    queryHandler GetOrderById(q: OrdersByIdQuery): OrderResponse { … }
    queryHandler ListOrders(q: OrdersListQuery): OrderResponse paged { … }
    queryHandler ListOrdersByCustomer(q: OrdersByCustomerQuery): OrderResponse paged { … }
  }
}

api SalesApi {
  source: Sales

  route POST   "/orders"                          -> Ordering.PlaceOrder
  route POST   "/orders/{id}/cancellations"       -> Ordering.CancelOrder
  route DELETE "/orders/{id}"                     -> Ordering.ArchiveOrder
  route GET    "/orders"                          -> Ordering.ListOrders
  route GET    "/orders/by-customer"              -> Ordering.ListOrdersByCustomer
  route GET    "/orders/{id}"                     -> Ordering.GetOrderById
  route POST   "/workflows/reorder-stocked-items" -> Ordering.ReorderStockedItems
  // ↑ targets a `handle` member of the workflow
}
```

Every line that used to be implicit is now a source declaration.
Nothing in the generators reaches past these declarations into raw
aggregate structure — the generators consume the explicit IR.

## File organisation

Scaffolds emit declarations; they don't know about files. After
unfolding, the user (or a future "move to layer file" tooling action)
relocates each declaration to its layer file. Langium's scope provider
already spans multiple `.ddd` files within a project.

Recommended layout for a system that has been substantially unfolded:

```
sales/
  sales.ddd                          # subdomain shell + api macro stub (root)
  ordering/
    ordering.domain.ddd
    ordering.contract.ddd
    ordering.application.ddd
  billing/
    billing.domain.ddd
    billing.contract.ddd
    billing.application.ddd
  sales.api.ddd                      # the route list
```

Four files per context plus one api file per system. Each file is the
home of exactly one layer.

The root file (`sales.ddd`) stays roughly:

```ddd
subdomain Sales {
  context Ordering { /* domain only, if heavily unfolded */ }
  context Billing  { … }
}

api SalesApi with apiSurface(Sales)
```

The macro stub stays in the root until every leaf scaffold has been
unfolded into its layer file — at which point the stub line can be
deleted.

## Compatibility with shipped api features

- **`urlStyle: literal | resource`** (D-URLSTYLE). Today's per-api
  setting drives `routeSlugFor` in enrichment. In the fully-unfolded
  form, the slug is *literal* in each `route` line — the urlStyle
  setting is redundant. In the *macro* form, `apiSurface(Sales,
  urlStyle: resource)` continues to drive scaffold output: leaves
  pluralise slugs when emitting `route` lines. The IR field
  (`Api.urlStyle`) stays as a macro input; backends stop reading it
  because they no longer derive slugs.
- **`httpStatus <Error> <Code>`** overrides. Move to a system-level
  error-policy declaration (one source of truth across all apis in the
  system). Per-api override is removed; the macro takes the system
  policy as input. See follow-up *Errors as a system-level policy*
  below.
- **Auto-`findAll` enrichment**. Becomes a scaffold-time concern: a
  leaf scaffold emits the `findAll` query + handler if the repository
  has none. The enrichment pass that injects `findAll` today can stay
  as a back-compat for non-unfolded code, or be removed once every
  example is migrated.

## Migration story

Existing `.ddd` sources keep working: `api SalesApi from Sales {
urlStyle: resource }` is a legal level-0 form. The generators continue
to derive everything implicitly until the user unfolds a layer. There
is no flag day; unfolding is opt-in per scaffold, per file.

A `ddd unfold` CLI command (mirroring the LSP "unfold macro" code
action) would rewrite a single scaffold call in place, leaving the
rest of the macro tree intact.

## Open questions

1. **Single `handler` vs three keywords.** This proposal commits to
   `commandHandler` / `queryHandler` / `workflow` as three peers with
   different validator contracts. The cheaper alternative is one
   `handler` keyword with contract derived from body shape (`.save`
   present → command; cross-aggregate → workflow). Three is more
   honest; one is less to learn. Open.
2. **`wire X` semantics on collections.** A query handler returning
   `Order paged` and a contract declaring `response = wire Order`
   together imply `wire (Order paged) = (wire Order) paged`. Worth
   pinning the distribution rule (paged, option, array) as a single
   "wire distributes over carriers" axiom rather than leaving each
   carrier to its own emitter.
3. **Where do errors live?** Names are contract (per context; what
   counts as `NotFound` is domain-shaped). Status mapping is system
   policy (one truth). This proposal sketches the split; the policy
   surface itself wants its own short proposal.
4. **HandlerRef vs system-flat handler names.** `Ordering.PlaceOrder`
   qualifies by context. The alternative is system-flat names with
   uniqueness enforced. The qualified form documents the contract's
   bounded-context origin in the route line itself; the flat form
   reads cleaner. Open.
5. **`with apiSurface(...)` macro arguments.** Positional (`(Sales)`)
   vs named (`(of: Sales)`). The rest of the macro stdlib uses named
   (`of:` is canonical). Worth aligning before this lands.
6. **Should `commandHandler` / `queryHandler` be folded into
   workflow's existing `handle` / read-only-handle members?** The
   semantic overlap is real; the cost of a separate keyword is the
   ceremony of declaring a workflow for every single-aggregate
   handler. Open — see (1).

## Out of scope for this proposal

- The route-to-handler dispatch implementation (the call protocol
  itself). Captured by `payload-transport-layer.md` and the
  per-backend route builders today.
- OpenAPI emission from the route list. Mechanical once routes
  reference contract types directly.
- Per-route authorization. Belongs on the handler (or its target
  domain method), not the route. Tracked by
  [`authorization.md`](./authorization.md) / `frontend-acl.md`.
- Multi-version APIs. The contract / application separation makes
  this tractable (two apis, two contracts, one application layer);
  the versioning surface itself is a follow-up.

## Cross-references

- `lifecycle-operations.md` — provides `OperationIR.kind`, which
  drives scaffold synthesis ("one commandHandler per `create` and
  `operation`; archive handler per `destroy`").
- `lifecycle-url-style.md` — `urlStyle` becomes a macro input, not a
  per-api IR field consumed by every backend.
- `payload-transport-layer.md` — payloads are the substance of the
  contract layer; this proposal proposes nothing new there, only
  promotes them to the canonical wire-shape source.
- `workflow-and-applier.md` — workflow's existing `create` / `handle`
  / `on` / `apply` members stay unchanged; the proposal only extends
  routes to target a workflow's `handle` directly.
- `agent-tools-and-mcp.md` — explicit contract declarations make MCP
  tool descriptions trivial: each command/query is a tool input
  schema, each response is an output schema.
- `scaffold-macros.md` (doc, not proposal) — extends the scaffold
  stdlib with three new sub-trees (contract / application / routes).

## Implementation phasing (sketch — not a plan)

If adopted, a reasonable ordering would be:

1. **Grammar + IR** for `commandHandler`, `queryHandler`, `route` as
   an api-body member, `HandlerRef`, `wire X` type expression.
2. **Lowering + validation** of the new members (one-directional
   layering checks: queryHandler must not save; commandHandler must
   not touch two aggregates; route target must resolve).
3. **Scaffold stdlib** — three sub-tree macros plus their leaves,
   following the existing `scaffoldSubdomain` /
   `scaffoldContext` / `scaffoldAggregate` composition pattern.
4. **`apiSurface` composer** wiring all three sub-trees, replacing
   the current `Api from Subdomain` implicit derivation.
5. **Backend updates** — each generator consumes explicit routes +
   handlers + contract types instead of re-deriving from aggregates.
   The old derivation path stays until every example migrates.
6. **`ddd unfold` CLI** and LSP code-action for per-scaffold
   unfolding. File-move tooling is a follow-up.

Each step is independent enough to ship behind its own PR; the
generators don't have to change until the IR has the new shape they
can read.
