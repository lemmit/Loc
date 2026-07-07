# Unfoldable API derivation — explicit contract, application, and transport layers

> Status: **PARTIALLY LANDED** — the grammar + IR slice (steps 1–2 of
> the phasing below) shipped in #1756: `commandHandler` / `queryHandler`
> context members, `route <M> "<path>" -> Context.Handler` api bindings
> with a cross-referenced `HandlerRef`, lowering, and the three
> one-directional layering validators (`loom.query-handler-saves`,
> `loom.command-handler-multi-aggregate`, `loom.route-handler-unresolved`).
> No backend reads the new nodes yet — codegen (steps 3+), the
> `scaffoldApi` stdlib, and the `wireShape` retirement remain design-only.
>
> Companion to [`lifecycle-operations.md`](./lifecycle-operations.md)
> (lifecycle kinds drive scaffold synthesis),
> [`lifecycle-url-style.md`](./lifecycle-url-style.md) (the existing
> per-api `urlStyle` becomes one slug-rule among others),
> [`payload-transport-layer.md`](./payload-transport-layer.md)
> (payloads are the contract layer's content), and
> [`workflow-and-applier.md`](./workflow-and-applier.md) (workflows
> are first-class application-layer citizens, not wrapped by
> handlers), and
> [`contract-typed-resources.md`](./contract-typed-resources.md) (unifies
> this proposal's `contract` layer with the inbound, consumed direction
> under one keyword — and **widens** the Layer-2 definition below to
> include operations, not records alone).

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
- One request DTO per route, derived ad-hoc from the aggregate's
  `wireShape` plus a create-vs-update access-modifier filter
  (`forCreateInput` / `forUpdateInput`).
- One response DTO per route, derived ad-hoc from `wireShape` plus
  the `forApiRead` filter.
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
| **contract** | command, query, response, error (the published wire vocabulary) | `context` | nothing in source — scaffolds project from domain at expansion time |
| **application** | commandHandler, queryHandler (orchestration; workflow stays where it is) | `context` | contract + domain |
| **api** | route (transport binding) | system | contract |

The layers are strictly one-directional, matching Loom's existing
pipeline discipline. A handler may consume a contract type and call a
domain method; it must not return a domain object. A route may
reference a contract type; it must not reach into a handler body or a
domain method.

```
              ┌─── api ───┐
              │           │
              ▼           ▼
          contract ◄──── (shared vocabulary) ──── application
                                                   │
                                                   ▼
                                                 domain
```

Both api and application depend on **contract** — they share its types
as their I/O vocabulary. Neither depends on the other directly: api
dispatches via a mediator (generator-emitted; not declared in DSL) to
the application handler that claims a given contract type.

In source the **contract → domain link is absent at runtime**. When a
contract is unfolded, it carries literal field declarations; when it
isn't, the scaffold projects its fields from the domain at expansion
time and emits literal source. After codegen, neither form retains any
runtime reference to the domain — the contract is a flat record on the
wire.

### Layer 1 — domain (unchanged from today)

Aggregates, repositories, workflows, value objects, enums. Already
context-scoped. Already pure of transport concerns. No change.

### Layer 2 — contract (the published language)

Holds `command`, `query`, `response`, `error` declarations — the
named, addressable wire shapes the system speaks. Lives inside
`context`, alongside the aggregates whose wire shape it publishes.

> **Superseded:** [`contract-typed-resources.md`](./contract-typed-resources.md)
> widens `contract` to hold **operations + their records** (not records
> alone), and unifies the published (outbound) and consumed (inbound,
> `from openapi(...)`) directions under the one keyword. The records-only
> framing below doesn't hold even here — Layer 4 calls the route list "the
> only thing that is actually a contract with the outside world," i.e. the
> operations *are* the contract.

Today these declarations exist (`payload-transport-layer.md` is the
relevant background) but are not the *only* expression of the wire
shape — every backend re-derives DTOs ad-hoc from the aggregate's
`wireShape` enrichment, with `forApiRead` / `forCreateInput` /
`forUpdateInput` filters applied per call site. The proposal: when
scaffolding has unfolded, *every* request and response shape on the
wire is a named contract declaration with literal fields. Backends
read those declarations directly. The `wireShape` enrichment retires
(see § "wireShape retires from the IR" below).

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
- **Both peer layers depend on it.** Both api and application reference
  contract types as their I/O vocabulary, but neither references the
  other directly. The contract is the *shared seam* that lets the
  mediator route between them (see § "The mediator seam" below).
- **`.loom/wire-spec.json` becomes redundant.** Today the artefact
  exists to crystallise the implicit wire shape for diff-based
  contract-change detection. With contract source declared explicitly,
  the artefact's job duplicates the source. It retires too (see
  § "wire-spec.json retires" below).

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

## The mediator seam

`route POST /orders -> Ordering.PlaceOrder` is **a registration, not a
call**. At runtime the generated api code:

1. Receives the HTTP request.
2. Deserialises the body into the contract type that the route binds
   (`PlaceOrderCommand`).
3. Hands the command to a mediator: `mediator.Send(command)`.
4. The mediator routes the command to the handler that registered for
   `PlaceOrderCommand` — `PlaceOrder` in this case.
5. The handler returns a contract response, which the api serialises
   to HTTP.

The mediator is **generator-emitted**, not declared in the DSL. It's
the canonical pattern in .NET (MediatR's `IRequestHandler<T>`
registrations), straightforward in Hono (a handler table keyed by
command type), and uniform across Phoenix. Every backend implements
the same dispatch contract.

This is why the contract layer earns its split structurally: it's the
*only* layer both api and application reference. Without it, api and
application would have to depend on each other directly, breaking the
strict one-directionality.

In the IR, the route's target is a `HandlerRef` (qualified handler
name). The runtime indirection through the mediator is a backend
emission detail, not a DSL concern.

## wireShape retires from the IR

`wireShape` — the canonical ordered field list stamped on every
`EnrichedAggregateIR` / `EnrichedEntityPartIR` /
`EnrichedValueObjectIR` by phase ⑥ enrichment — is doing **less
architectural work than its uniformity suggests**. Mechanically it is:

1. A walk: `id` → declared properties → containments → derived (with
   `inspect` excluded).
2. A set of five pure predicate filters keyed on the per-field access
   modifier (`forApiRead`, `forUiRead`, `forCreateInput`,
   `forUpdateInput`, `forUpdatePreconditions`).

There is **no transformation, reshaping, rename, or recomputation**.
Renaming `wireShape` to "the field list, filtered" describes it
exactly. The filters live in `src/ir/enrich/wire-projection.ts`
keyed on this matrix (`src/language/ddd.langium:1118-1119`):

| Access | apiRead | uiRead | createInput | updateInput | preconditions |
|---|---|---|---|---|---|
| editable (default) | ✓ | ✓ | ✓ | ✓ | – |
| immutable | ✓ | ✓ | ✓ | – | – |
| managed | ✓ | ✓ | – | – | – |
| token | ✓ | ✓ | – | – | ✓ |
| internal | – | ✓ | – | – | – |
| secret | – | – | ✓ | ✓ | – |

That matrix is the entire projection logic. It's already declarative.
It can stay in `wire-projection.ts` *as a scaffold-time helper*,
without enrichment ever stamping a `WireField[]` onto IR nodes.

### Why per-operation projection is wrong-grained today

The current pipeline routes *all* shapes through aggregate `wireShape`
plus an access-modifier filter. But lifecycle operations
(`lifecycle-operations.md`) already give each factory / operation /
destroyer its own typed parameter list (`OperationIR.params`). The
parameter list is the **natural source of truth** for a create or
update command — the user wrote it; the aggregate's field set is
irrelevant. `forCreateInput(wireShape)` was a workaround for the
pre-lifecycle world where factories had no typed parameters; now they
do.

Every contract shape has a natural source on a single IR node:

| Shape | Source |
|---|---|
| Command (create / operation / destroy / workflow handle) | the operation/handle's parameter list (`OperationIR.params` or `WorkflowHandleDecl.params`) |
| Query | the find's parameter list (`FindDecl.params`) |
| Response (single and list) | aggregate's `fields + containments + derived`, filtered by `apiRead` |

Two of three (command, query) don't touch wireShape at all — they
walk the operation or find's typed parameter list. The third
(response) is a one-shot walk-with-filter the scaffold can do at
expansion time without any IR state.

The lifecycle kind (`create` / `operation` / `destroy`) doesn't change
the command's shape — it's the same "walk params, emit a `command`
record". Kind only matters downstream at the handler and route
scaffolds, where it picks the body protocol and HTTP verb/path.

### What disappears

| Today | After |
|---|---|
| `EnrichedAggregateIR.wireShape: WireField[]` | Removed. |
| `EnrichedEntityPartIR.wireShape` | Removed. |
| `EnrichedValueObjectIR.wireShape` | Removed. |
| `wireShapeFor(entity)` | Removed. |
| Phase ⑥ wireShape stamping | Removed. (Phase keeps auto-`findAll`, associations, react `targets:`, `migrationsOwner`.) |
| `forApiRead`, `forCreateInput`, `forUpdateInput`, `forUiRead`, `forUpdatePreconditions` | **Stay**, but become scaffold-time helpers invoked once at expansion to filter literal fields. Not enrichment-stamped. |
| `EnrichedAggregateIR` brand | Stays — other enrichments still load-bearing. |

The backend emitters that today call `wireShapeFor(ent)` get
refactored to read contract declarations from the IR. No filter, no
walk — just iterate the contract's declared fields. The projection
logic relocates to a single point (scaffold expansion) instead of
running at every emit site.

### Why this isn't a `wire(X)` macro

A prior iteration of this proposal floated `with wire(X)` as a macro
that would expand an aggregate to a contract declaration. The audit
above shows there's nothing to name: the projection is "walk + filter
by access modifier", same logic each scaffold runs on its own source.
A dedicated `wire` keyword would suggest a fourth layer between domain
and contract; the truth is the edge has no compile-time or runtime
artefact at all — it's source generation only.

The relationship between domain and contract is therefore:

- **Macro form** (`with scaffoldApi(of: Sales)`): each layer scaffold walks
  the relevant domain node (operation params or aggregate fields) and
  emits contract declarations. The contract stays in sync with the
  domain by re-expansion.
- **Unfolded form** (literal contract source): contract declarations
  carry literal fields. They no longer track the domain; divergence
  must be re-scaffolded or hand-edited.

Same semantics every other Loom scaffold has — macro is the tracker,
unfold is the freeze. No additional language construct needed.

### Non-emitter consumers — sweep result

A separate exploration confirmed that the non-emitter consumers of
`wireShape` either already use the per-operation source (forms read
`op.params` directly) or already use literal contract declarations
(workflow validators read `createInputFields`):

| Consumer | Current source | Replacement |
|---|---|---|
| React form generation (`src/generator/react/walker/primitives/forms.ts`) | `op.params` | Already correct — no change. |
| Workflow validation (`src/ir/validate/checks/workflow-checks.ts`) | `createInputFields(agg)` reads `agg.createInput` literal contract | Already correct — no change. |
| Conformance tests (`test/generator/{hono,dotnet}/*-wire-conformance.test.ts`) | Compares post-emission OpenAPI / Zod / .NET artefacts | Unaffected (compares emitted output, not IR). |
| Discriminated unions (`src/generator/_payload/union-wire.ts`) | `agg.wireShape` per variant | Phase 2 — migrate to response-contract-keyed bundles. |
| Wire-spec artefact (`src/system/wire-spec.ts`) | `wireShape` | See § "wire-spec.json retires" below. |
| Migrations, traceability, SQL | None — use schema/operation IR | Unaffected. |

No hard blockers. The retirement is clean if staged in two phases (see
Migration story below).

## wire-spec.json retires

`.loom/wire-spec.json` exists primarily for diff-based contract change
detection — conformance tests parse it alongside backend OpenAPI to
verify wire parity across backends. With contract source declared
explicitly:

- **Contract source files become the diffable artefact.** `git diff`
  on `*.contract.ddd` tells you what changed between releases. CI
  gating becomes "any change to `*.contract.ddd` requires explicit
  review".
- **Cross-backend parity becomes a type-check on the source.** When
  every backend reads the same contract declarations, parity is
  structural by construction — not a runtime diff.
- **Debug escape hatch.** External tooling that consumes a JSON
  Schema dump (third-party OpenAPI generators, etc.) can request one
  on demand via `ddd snapshot --wire` (folded into the existing
  `ddd snapshot` from `provenance.md`). Not part of the default
  generate pipeline.

Three options for the retirement:

1. **Drop entirely.** Contract source is the diffable artefact.
2. **Generate on demand only.** `ddd snapshot --wire` for external
   tooling.
3. **Keep, derive from contract source.** One-line change in
   `src/system/wire-spec.ts` — walk contract declarations instead of
   `wireShape`. Byte-identical output for non-diverged contracts.

(1) with (2) as escape hatch is recommended.

## Scaffold tree

Three independent sub-trees, one per layer. Every leaf scaffold
materialises exactly one declaration.

**Naming rule** (matches today's `scaffoldAggregate(of: X)` /
`scaffoldWorkflow(of: X)` stdlib): one word per node kind, parameter
names the target. No `For` connectors, no per-output redundant
suffixes. Two unfold levels:

- **Per-source aggregators** — one source node fans out across all
  three layers (contract + application + api). Default unfold target.
- **Per-output leaves** — one declaration. Next unfold level when the
  aggregator-level granularity isn't fine enough.

**Polymorphism rule** ("scaffold reads its input's IR kind to
decide"): every scaffold reads its target's kind/structure to decide
what to emit. No per-kind macro variants — `scaffoldRoute(of: X)`
reads `X.kind` to pick the HTTP verb; `scaffoldHandler(of: X)` picks
`commandHandler` vs `queryHandler` from whether `X` is mutating.

```
scaffoldApi(of: Sales)
├── scaffoldContext(of: Ordering)
│   ├── scaffoldAggregate(of: Order)
│   │   ├── scaffoldOperation(of: Order.place)         ← aggregator level
│   │   │   ├── scaffoldCommand(of: Order.place)       ← leaf
│   │   │   ├── scaffoldHandler(of: Order.place)       ← leaf
│   │   │   └── scaffoldRoute(of: Order.place)         ← leaf
│   │   ├── scaffoldOperation(of: Order.cancel)        (similar fan-out)
│   │   ├── scaffoldOperation(of: Order.archive)
│   │   └── scaffoldResponse(of: Order)                ← leaf (no aggregator — response is per-aggregate)
│   ├── scaffoldRepository(of: Orders)
│   │   ├── scaffoldFind(of: Orders.byId)
│   │   │   ├── scaffoldQuery(of: Orders.byId)
│   │   │   ├── scaffoldHandler(of: Orders.byId)
│   │   │   └── scaffoldRoute(of: Orders.byId)
│   │   ├── scaffoldFind(of: Orders.byCustomer)        (similar)
│   │   └── scaffoldFind(of: Orders.findAll)
│   ├── scaffoldWorkflow(of: ReorderStockedItems)
│   │   ├── scaffoldCommand(of: ReorderStockedItems.invoke)
│   │   └── scaffoldRoute(of: ReorderStockedItems.invoke)
│   │   // No scaffoldHandler — workflow IS the application-layer node.
│   │   // Emitted only when the workflow exposes a `handle` member;
│   │   // scheduled-only / event-only workflows skip the route too.
│   └── scaffoldView(of: OrderListView)
│       ├── scaffoldResponse(of: OrderListView)        // walks view's fields with apiRead
│       ├── scaffoldHandler(of: OrderListView)         // queryHandler reading the view
│       └── scaffoldRoute(of: OrderListView)
```

### Source kinds each leaf accepts

| Leaf | Accepts | Walks |
|---|---|---|
| `scaffoldCommand(of: X)` | Operation, WorkflowHandle | `X.params` |
| `scaffoldQuery(of: X)` | Find | `X.params` |
| `scaffoldResponse(of: X)` | Aggregate, View | fields + containments + derived, with `apiRead` filter |
| `scaffoldHandler(of: X)` | Operation, Find, View | reads `X` to decide `commandHandler` vs `queryHandler` and pick the body protocol |
| `scaffoldRoute(of: X)` | Operation, Find, WorkflowHandle, View | reads `X.kind` (lifecycle) and source type to pick verb + path |

`scaffoldHandler` and `scaffoldRoute` are the polymorphic ones — they
read the target IR's kind to decide. Three leaves (`scaffoldCommand`,
`scaffoldQuery`, `scaffoldResponse`) just walk a field list. The
lifecycle distinction lives where the decision lives — not at the
command-payload site, where every kind has the same shape.

### What each aggregator emits

| Aggregator | Emits |
|---|---|
| `scaffoldOperation(of: op)` | `scaffoldCommand(of: op)`, `scaffoldHandler(of: op)`, `scaffoldRoute(of: op)` |
| `scaffoldFind(of: f)` | `scaffoldQuery(of: f)`, `scaffoldHandler(of: f)`, `scaffoldRoute(of: f)` |
| `scaffoldWorkflow(of: w)` | `scaffoldCommand(of: w.handle)`, `scaffoldRoute(of: w.handle)` (when `handle` exists) |
| `scaffoldView(of: v)` | `scaffoldResponse(of: v)`, `scaffoldHandler(of: v)`, `scaffoldRoute(of: v)` |
| `scaffoldAggregate(of: a)` | one `scaffoldOperation` per public operation/create/destroy + `scaffoldResponse(of: a)` |
| `scaffoldRepository(of: r)` | one `scaffoldFind` per find |
| `scaffoldContext(of: c)` | one aggregator per aggregate / repository / workflow / view in `c` |

Aggregators are pure composition — they invoke leaves. They never
emit declarations directly. Mirrors how today's
`scaffold(subdomains: …)` → `scaffoldSubdomain(of: …)` →
`scaffoldContext(of: …)` chain works.

### Overrides

Each scaffold accepts optional overrides as named params, matching
the existing macro-stdlib pattern:

```ddd
with scaffoldHandler(of: Order.place, name: "QuickPlace")
with scaffoldRoute(of: Order.cancel, path: "/orders/{id}/cancel")
with scaffoldResponse(of: Order, exclude: [internal, audit])
```

When the override fully describes the output (e.g. a custom body), the
unfolded form is the override verbatim. When the override is partial,
the scaffold uses the default for the unspecified parts. This is the
"magic where it's obvious" principle — defaults handle the common
case; overrides handle the rest; unfold materialises the literal.

Workflow bodies are user-written, not scaffolded — `scaffoldWorkflow`
only emits the *contract + route* glue for a workflow that exposes a
callable `handle` member. Scheduled-only / event-only workflows skip
that scaffold entirely.

Two scaffold-stdlib invariants:

1. **Aggregators compose; leaves emit.** `scaffoldApi` doesn't
   synthesise anything directly — it invokes `scaffoldContext`, which
   invokes the per-source aggregators (`scaffoldAggregate`,
   `scaffoldRepository`, `scaffoldWorkflow`, `scaffoldView`), which
   invoke the per-output leaves. Mirrors today's
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
        ('from' source=[Subdomain:ID])?       // optional now; carried by `with scaffoldApi(of: X)` macro
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
`Api` rule lets `api SalesApi with scaffoldApi(of: Sales)` parse.

### NOT NEW — no `wire X` operator

A prior draft proposed `wire X` as a type expression
(`response OrderResponse = wire Order`). It's deliberately dropped.
The domain → contract relationship is **scaffold-time only** — a walk
of `aggregate.fields + containments + derived` filtered by the
`apiRead` access modifier. The macro form (`with scaffoldApi(of: Sales)`)
runs that walk and emits literal contract source; the unfolded form
*is* the literal contract source. Neither carries a residual `wire`
reference into the AST, the IR, or the runtime.

See § "wireShape retires from the IR" above for the full reasoning.

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

## Worked example — four altitudes

### Macro form (level 0)

```ddd
api SalesApi with scaffoldApi(of: Sales)
```

### One-level unfold (level 1)

```ddd
subdomain Sales {
  context Ordering {
    // existing domain declarations …
    with scaffoldContext(of: Ordering)
  }
}

api SalesApi { source: Sales; with scaffoldContext(of: Ordering) }
```

`scaffoldContext` fans across all four output layers (contract + handler
inside the context; routes inside the api block). Replace either call
with hand-written declarations to take over one layer; the other
remains scaffolded.

### Two-level unfold (level 2 — per-source aggregators)

```ddd
context Ordering {
  // …
  with scaffoldAggregate(of: Order)        // emits operations + response
  with scaffoldRepository(of: Orders)      // emits finds
  with scaffoldWorkflow(of: ReorderStockedItems)
}

api SalesApi {
  source: Sales
  with scaffoldAggregate(of: Order)
  with scaffoldRepository(of: Orders)
  with scaffoldWorkflow(of: ReorderStockedItems)
}
```

### Fully unfolded (level 4 — leaves)

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

    // Response shapes are always literal in the unfolded form.
    // Produced by `scaffoldResponse(of: Order)` walking
    // Order.fields + containments + derived with the `apiRead` filter.
    response OrderResponse {
      id:         OrderId
      customerId: CustomerId
      items:      OrderLineResponse[]
      total:      Money
      placedAt:   timestamp
    }
    response OrderLineResponse {
      sku:   Sku
      qty:   int
      price: Money
    }

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

api SalesApi with scaffoldApi(of: Sales)
```

The macro stub stays in the root until every leaf scaffold has been
unfolded into its layer file — at which point the stub line can be
deleted.

## Compatibility with shipped api features

- **`urlStyle: literal | resource`** (D-URLSTYLE). Today's per-api
  setting drives `routeSlugFor` in enrichment. In the fully-unfolded
  form, the slug is *literal* in each `route` line — the urlStyle
  setting is redundant. In the *macro* form, `scaffoldApi(of: Sales,
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
- **`wireShape` enrichment**. Retires in two phases (see § "wireShape
  retires from the IR" above). Phase 1: backends switch from
  `wireShapeFor(ent)` to reading contract declarations directly,
  starting with the four DTO emitters (`src/generator/typescript/`,
  `src/generator/dotnet/dto-mapping.ts`,
  `src/generator/elixir/`, `src/generator/react/api-builder.ts`).
  Phase 2: discriminated-union bundles (`src/generator/_payload/union-wire.ts`)
  switch to response-contract-keyed bundles; the enrichment stamping
  and `wireShapeFor` can then be deleted. Phase 1 and 2 are
  independent.
- **`.loom/wire-spec.json` artefact**. Retires alongside `wireShape`
  (see § "wire-spec.json retires" above). Replaced by contract source
  as the diffable artefact, with `ddd snapshot --wire` as an optional
  on-demand JSON dump for external tooling.

## Migration story

Existing `.ddd` sources keep working: `api SalesApi from Sales {
urlStyle: resource }` is a legal level-0 form. The generators continue
to derive everything implicitly until the user unfolds a layer. There
is no flag day; unfolding is opt-in per scaffold, per file.

A `ddd unfold` CLI command (mirroring the LSP "unfold macro" code
action) would rewrite a single scaffold call in place, leaving the
rest of the macro tree intact.

## Open questions

1. **Single `handler` vs three keywords.** ~~Open.~~ **Resolved —
   three keywords.** The grammar + IR slice shipped
   `commandHandler` / `queryHandler` as distinct context members
   alongside `workflow`, each with its own validator contract
   (`loom.query-handler-saves`, `loom.command-handler-multi-aggregate`).
2. **Where do errors live?** Names are contract (per context; what
   counts as `NotFound` is domain-shaped). Status mapping is system
   policy (one truth). This proposal sketches the split; the policy
   surface itself wants its own short proposal. Open.
3. **HandlerRef vs system-flat handler names.** ~~Open.~~ **Resolved —
   qualified.** The shipped `HandlerRef` is `Context.Handler`
   (`context=[BoundedContext:ID] '.' handler=ID`); the route line
   documents the contract's bounded-context origin.
4. **`scaffoldApi(...)` macro name + arguments.** ~~Open (was
   `apiSurface`, positional).~~ **Resolved — `scaffoldApi(of: Sales)`.**
   The composer joins the `scaffold<NodeKind>(of: X)` family it heads
   (the earlier `apiSurface` broke that family; "spans layers" didn't
   justify a distinct word, since `scaffoldContext` spans them too and
   keeps the prefix). Named `of:` args match the rest of the macro
   stdlib.
5. **Should `commandHandler` / `queryHandler` be folded into
   workflow's existing `handle` / read-only-handle members?** The
   semantic overlap is real; the cost of a separate keyword is the
   ceremony of declaring a workflow for every single-aggregate
   handler. Open — see (1).
6. **Should routes target contract types directly instead of named
   handlers?** `route POST /orders body: PlaceOrderCommand` (mediator
   finds the registered handler) vs `route POST /orders -> PlaceOrder`
   (explicit registration). The first is more honest about the
   mediator's role; the second is more readable in source. Open.
7. **Access-modifier coverage.** Six access modifiers cover five
   projection modes today. If contract divergence introduces new
   projection modes (e.g. an `auditOnly` field that appears only in
   audit responses), we'd add a modifier rather than special-casing
   per scaffold. Worth a separate proposal if the need arises.

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

## Interaction with peer proposals

Three peer proposals touch the wire-shape pipeline this proposal
restructures. Coordinated landing is **not** strictly required — each
peer can ship its current design and adapt when this lands.

- **`payload-transport-layer.md`** is the closest peer. Its proposed
  `<Agg>Wire payload` (Phase 2 of that proposal) is a named version of
  the implicit `wireShape` enrichment — the next step toward
  first-class contracts. This proposal **goes further** by making
  contracts always literal source (no `<Agg>Wire` indirection).
  Compatibility: `<Agg>Wire payload` can ship as a transitional name
  that retires when scaffolds take over contract emission. The
  proposals don't conflict, but the auto-synthesised `<Agg>Wire`
  becomes redundant once scaffolds emit literal `response <Agg>Response`
  declarations.

- **`aggregate-inheritance.md`** I2 (TPH emission) currently walks the
  extends-chain to build the concrete's `wireShape` with inherited
  base fields appended after `id`. Under this proposal, the chain walk
  moves into the scaffold layer: `scaffoldResponse(of: concrete)`
  reads `concrete.extends?.fields` and emits literal contract fields
  for both. Functionally identical — the walk's home shifts from
  enrichment to scaffold expansion. I3 (TPC) is unaffected.

- **`workflow-and-applier.md`** is unchanged. Workflow's existing
  `create` / `handle` / `on` / `apply` members stay. The only
  extension: routes may target a workflow's `handle` directly via
  `HandlerRef`, so HTTP traffic can drive workflow continuation
  without a wrapper handler. The workflow members aren't promoted to
  top-level context members — `commandHandler` / `queryHandler` are
  new sibling kinds, not replacements.

## Cross-references

- `lifecycle-operations.md` — provides `OperationIR.kind`, which
  drives scaffold synthesis ("one commandHandler per `create` and
  `operation`; archive handler per `destroy`").
- `lifecycle-url-style.md` — `urlStyle` becomes a macro input, not a
  per-api IR field consumed by every backend.
- `payload-transport-layer.md` — see "Interaction" above. Payloads
  are the substance of the contract layer; this proposal removes
  the `wireShape` intermediary.
- `aggregate-inheritance.md` — see "Interaction" above. I2's
  inheritance walk moves from enrichment to scaffold expansion.
- `workflow-and-applier.md` — see "Interaction" above. Routes gain
  workflow `handle` as a target; workflow body grammar unchanged.
- `agent-tools-and-mcp.md` — explicit contract declarations make MCP
  tool descriptions trivial: each command/query is a tool input
  schema, each response is an output schema.
- `scaffold-macros.md` (doc, not proposal) — extends the scaffold
  stdlib with the new per-source aggregators and per-output leaves.

## Implementation phasing (sketch — not a plan)

If adopted, a reasonable ordering would be:

1. **Grammar + IR** for `commandHandler`, `queryHandler`, `route` as
   an api-body member, and `HandlerRef`.
2. **Lowering + validation** of the new members (one-directional
   layering checks: queryHandler must not save; commandHandler must
   not touch two aggregates; route target must resolve).
3. **Scaffold stdlib** — three sub-tree macros plus their leaves,
   following the existing `scaffoldSubdomain` /
   `scaffoldContext` / `scaffoldAggregate` composition pattern.
   `wire-projection.ts` filters relocate from enrichment-stamped
   to scaffold-time consumed at this step.
4. **`scaffoldApi` composer** wiring all three sub-trees, replacing
   the current `Api from Subdomain` implicit derivation.
5. **Backend DTO emitters** — each generator switches from
   `wireShapeFor(ent) → filter → emit` to reading literal contract
   declarations. The old path stays in parallel until every example
   migrates.
6. **`wireShape` IR field deletion (Phase 1)** — once every backend
   DTO emitter reads contracts, remove `wireShape` stamping from
   enrichment and `wireShapeFor` from the IR surface. Union-bundle
   emission still uses it; that's Phase 2.
7. **Discriminated-union bundle migration (Phase 2)** —
   `src/generator/_payload/union-wire.ts` switches to
   response-contract-keyed bundles. After this, `wireShape` can be
   fully deleted.
8. **`.loom/wire-spec.json` retirement** — contract source becomes
   the diffable artefact; `ddd snapshot --wire` lands as the
   on-demand JSON dump for external tooling. Conformance tests
   refactor to compare emitted backend artefacts against the
   contract source directly.
9. **`ddd unfold` CLI** and LSP code-action for per-scaffold
   unfolding. File-move tooling is a follow-up.

Each step is independent enough to ship behind its own PR; the
generators don't have to change until the IR has the new shape they
can read, and the `wireShape` retirement (steps 6-7) is independent
of the layer additions (steps 1-4) — they could be sequenced in
either order.
