# Aggregate lifecycle operations — typed actions on aggregates

> Status: **Phase 1 shipped** (#722) — `create`/`destroy` keywords,
> `OperationIR.kind`, the `creates`/`destroys`/`canonical*` IR, and the
> name-conflict + `this.id`-in-create validators. Companion to
> [`loom-forms.md`](./loom-forms.md) (form generation depends on this
> proposal). Supersedes the implicit "API generators walk
> `aggregate.fields` to synthesise the create contract" behaviour in
> today's emitters.
>
> **Phase 2 (`urlStyle` + `routeSlug`) is superseded by
> [`lifecycle-url-style.md`](./lifecycle-url-style.md) ([D-URLSTYLE](../../decisions.md#d-urlstyle--lifecycle-url-style-on-the-api-body--per-action-routeslug)).**
> The §"URL conventions" and §"Grammar / IR / generator integration
> seams" text below assumes a fictional per-aggregate `api … for
> <Aggregate> { urlStyle }` form; the real grammar is `api … from
> <Subdomain>`, so `urlStyle` lives on an optional **api body** and
> `routeSlug` is a per-action `OperationIR` field. Read
> `lifecycle-url-style.md` for the shipped Phase-2 design; treat the
> api-shape details below as historical.
>
> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error.)** This proposal cites Ash both as prior art (a design influence on the typed-action model — kept as history) and as the live Phoenix emission target. The Phoenix backend no longer emits Ash resources/actions; the kind-tag → action mapping below now lowers onto plain Ecto/Phoenix.

## Problem statement

Today every user-declared behaviour on an aggregate is an `operation`:

```
aggregate Order {
  subject: string
  amount: decimal
  status: string

  operation cancel() { this.status := "cancelled" }
}
```

This works for instance-mutating actions where `this` is bound to an existing instance, but it papers over a fundamental DDD distinction: **creation and deletion are not instance operations.** They are lifecycle events.

- An instance operation has `this` bound. It modifies state on an existing aggregate. `cancel()` is a clear example.
- A **factory** (creation) has no `this`. There is no aggregate to operate on — the action *makes* one. The body assembles initial state; the framework persists; the result is a new instance.
- A **terminator** (deletion) has `this` bound to an instance that is about to vanish. The body may run cleanup logic, but the instance does not survive the action.

Modelling all three as the same `operation` produces three concrete problems:

### Problem 1 — API generators have to invent the create contract

The React form walker (`src/generator/react/body-walker.ts`) and the backend API generators (`src/generator/react/api-builder.ts`, `src/generator/ts/...`, `src/generator/dotnet/...`, `src/generator/phoenix-live-view/...`) all reach into `aggregate.fields` to derive the `POST /orders` body shape, filtering on writable-on-create criteria they re-implement individually. This is a layering inversion — the API layer reaching into raw structural data to invent semantics that aren't represented anywhere in the IR. Every backend has its own copy of the same filter. They will drift.

### Problem 2 — `CreateForm { of: X }` has nothing to bind to

The form walker today resolves `CreateForm { of: Order }` by walking `Order.fields` directly. The form layer and the API layer independently synthesise their idea of the create contract, with no shared source of truth. Any divergence (e.g., a field that should appear on the form but not on the API, or vice versa) requires double-edit and cannot be enforced.

### Problem 3 — Crudish is asymmetric and ill-named

The current `crudish` macro emits only an `update` operation; `create` and `delete` were deferred ("until input-type synthesis lands"; see `src/stdlib/crudish.macro.ts`). The CRUD acronym promises create + read + update + delete; only the U is delivered. The deferral was correct *as a symptom* — operation-shaped create is semantically wrong — but the underlying issue is the missing concept of a lifecycle action, not the missing input type.

## Prior art surveyed

Before landing on a design, we surveyed three reference frameworks. Each makes a different layering choice; understanding all three sharpens the rationale for Loom's choice.

### Naked Objects / Apache Causeway

Naked Objects (Richard Pawson's thesis, ~2001) and its successor frameworks — Apache Isis → Apache Causeway (Java), NakedObjects.NET (C#) — are the most extreme "the domain model IS the UI" pattern in practice. They've been deployed at scale for ~20 years. They had to confront the create/delete question head-on because their entire UI is auto-generated from the domain model via reflection.

**Naked Objects' answer: creation lives on services, not on entities.**

Every behaviour in the system is one of two things:

1. An **action on an entity** — instance method on a domain object. Has `this`. Modifies state. (Equivalent to Loom's `operation`.)
2. An **action on a domain service** — method on a registered singleton "service" object. No instance to operate on. This is where creation lives.

Concretely in Causeway:

```java
@DomainService
public class Customers {
  @Action
  public Customer createNewCustomer(String firstName, String lastName) { ... }

  @Action
  public List<Customer> findByName(String name) { ... }
}
```

The framework reflects over `@Action` methods. Parameter types become form fields; return types become navigation targets; companion methods (`validateXxx`, `defaultXxx`, `choicesXxx`) drive validation, defaults, and dropdowns. Creation surfaces in the auto-UI as a menu item ("New Customer") on the service, not on any entity.

Deletion is more pragmatic — Causeway allows both:
- `Customers.delete(customer)` on the service (purist), or
- `customer.delete()` on the entity, which internally calls `repositoryService.remove(this)` (the entity participates in its own removal but delegates to the repository).

**REST API: the Restful Objects spec.** Causeway exposes a published, HATEOAS-heavy REST API standard with two parallel resource trees:

```
/services/{serviceId}/actions/{actionId}/invoke
/objects/{domainType}/{instanceId}/properties/{propId}
/objects/{domainType}/{instanceId}/collections/{collId}
/objects/{domainType}/{instanceId}/actions/{actionId}/invoke
```

CRUD maps explicitly:

| Concern | URL |
|---|---|
| Create | `POST /services/Customers/actions/createNewCustomer/invoke` |
| Read | `GET /objects/Customer/42` |
| Property update | `PUT /objects/Customer/42/properties/email` |
| Instance action | `POST /objects/Customer/42/actions/cancel/invoke` |
| Delete (service-side) | `POST /services/Customers/actions/delete/invoke` |

The URL itself encodes the layering — creation under `/services/`, instance behaviour under `/objects/`. All actions are `POST`ed (with a `GET` relaxation for side-effect-free actions). HATEOAS links in every response tie things together.

**What Loom takes from Naked Objects:** the empirical proof that DDD-correct "creation lives outside the aggregate" works at scale — and the architectural cost (you need a richer "service" or "domain service" concept than thin data-access repositories provide).

**What Loom rejects:** the URL idiom. Restful Objects' two-tree resource model is conceptually elegant but unfamiliar; hand-written API clients targeting Loom-generated systems would face a learning curve that conventional REST avoids. Loom prefers `POST /orders` over `POST /services/Customers/actions/createNewCustomer/invoke`.

### Ash Framework (Elixir/Phoenix)

Ash was the Phoenix backend Loom generated code for at the time of writing (`src/generator/phoenix-live-view/`, the `ashPhoenix` HEEx design pack under `designs/ashPhoenix/`, `LOOM_PHOENIX_BUILD=1` CI). **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error. Ash remains relevant here only as the prior-art design influence below.)** It is explicitly "DDD-shaped" and resource-centric, with the most actively-developed answer to the same question.

**Ash's answer: typed actions on the resource.**

A resource declares *actions*. Each action has a **type** (`:create`, `:read`, `:update`, `:destroy`) and a **name**. Names are arbitrary; the type tag tells the engine what semantics to apply:

```elixir
defmodule MyApp.Shop.Order do
  use Ash.Resource, ...

  actions do
    defaults [:read, :destroy]                    # canonical no-body actions

    create :place do
      accept [:subject, :amount]
      change MyApp.Shop.Order.Changes.SetInitial
    end

    update :cancel do
      accept []
      change set_attribute(:status, :cancelled)
    end

    create :import do                             # multiple creates with different shapes
      accept [:subject, :amount, :external_id]
    end
  end
end
```

Crucial design choices visible here:

1. **`create` and `update` live in the same block on the same resource.** No relocation to a service or repository. The aggregate is still the namespace for everything that happens to it.
2. **The type tag captures the lifecycle asymmetry.** A `create` action starts from an empty changeset and has no `this`; an `update` action starts from an existing instance; a `destroy` action terminates. The engine branches on type — validators, authorization policies, changeset construction, return semantics — all differ by action type. The DSL doesn't pretend they're the same; the type tag *is* the encoding of the difference.
3. **Multiple actions per type are first-class.** `create :place` and `create :import` are two distinct creators with different accept lists. Same for updates. This handles the real DDD pattern where different lifecycle entry points produce the same aggregate type in different ways (customer-placed, admin-imported, derived-from-quote).
4. **`defaults [:create, :read, :update, :destroy]` generates the canonical four** with no custom body, directly from the resource's attributes. This is "defaults if none provided" baked into the framework.

**Ash also has a fifth action type — generic actions** (`action :send_invoice, :ok do ... end`) for domain logic that doesn't fit CRUD. Generic actions explicitly do NOT carry CRUD semantics and require the developer to declare their own HTTP routing in `AshJsonApi`.

**REST API: conventional + extensible.** `AshJsonApi` uses default routes for canonical CRUD:

```
POST   /orders          → create :create
GET    /orders/:id      → read :read
PATCH  /orders/:id      → update :update
DELETE /orders/:id      → destroy :destroy
```

Custom-named actions get explicit routes:

```elixir
routes do
  base "/orders"
  post :place                                  # POST /orders (uses :place)
  route :post, "/:id/cancel", :cancel          # POST /orders/:id/cancel
  route :post, "/import", :import              # POST /orders/import
end
```

The HTTP verb is author-chosen for non-default actions; the framework provides routing machinery but doesn't enforce verb semantics for non-CRUD actions.

**Forms: `AshPhoenix.Form.for_create(Order, :place)`** reads the action's `accept` list and `arguments` to render fields. No fallback to "walk the fields" — there's always a named action to bind to (even if it's a `defaults`-generated one).

**What Loom takes from Ash:** the typed-action model. The kind tag captures the lifecycle asymmetry without splitting the user's mental model across multiple constructs. Defaults are first-class. Multiple actions per type are mechanical.

**What Loom adjusts:** Ash exposes `:read` as an action type because reads, creates, updates, and destroys all share the same engine machinery (changesets, authorizations). Loom already has separate read-side machinery (views, finders, repositories), so adding `:read` to the aggregate's action surface duplicates concepts. Loom keeps reads out. Loom also drops the generic action type — see the "no escape hatch" decision below.

### Domain-Driven Design orthodoxy

Strict DDD (Evans's *Domain-Driven Design*, Vernon's *Implementing Domain-Driven Design*) is more opinionated than either framework:

- **Creation lives in factories** — separate factory objects, factory methods on aggregates (sometimes), or application services. Aggregates do not create themselves. Naked Objects follows this literally; Ash bends it by keeping creation on the resource with a type tag that captures factory semantics.
- **Hard delete is often a smell.** Real domains rarely physically remove. They cancel, archive, void, terminate. "Delete" is a SQL concept that leaks. Soft-delete with a state transition is the more DDD-honest pattern.
- **Operations should be domain-named** — `cancel`, `place`, `ship`, not `update`, `create`, `delete`. The ubiquitous language argument: domain experts don't say "the customer updated the order"; they say "the customer cancelled the order."
- **Aggregates are transactional boundaries** — one aggregate per transaction. Multi-aggregate writes coordinate through workflows / sagas / application services.

**What Loom takes from DDD orthodoxy:** the destroy-vs-delete naming choice (DDD-neutral `destroy`), the "named actions for domain language" emphasis, the aggregate-as-transactional-boundary principle.

**What Loom adjusts:** keeping `create` on the aggregate is a known, defensible deviation from purist DDD — but in good company (Ash, Entity Framework, ActiveRecord, MikroORM all do the same). Loom does NOT split creation off to a separate construct.

## Design — three keywords, typed actions, framework-owned persistence

The model adopted for Loom:

| Keyword | Role | `this` semantics | Persistence (framework-owned) |
|---|---|---|---|
| `create [name](params)` | Factory | Fresh blank instance, body populates | Allocate id → persist → return populated instance |
| `operation name(params)` | Named instance mutation | Loaded by id, body mutates | Persist changes → return updated instance |
| `destroy [name](params)` | Terminator | Loaded by id, about to be removed | Run body (cleanup) → remove → return nothing |

Three observations on this table:

1. **Same `this.field := ...` syntax in all three bodies.** The kind tag, not the body syntax, captures the semantic asymmetry. A `create` body looks identical to an `update` body; the framework knows what to do based on the keyword.
2. **`update` is not a keyword.** The canonical "edit all fields" handler is just an `operation update(...)` emitted by `crudish` or hand-written. There is no special case in the IR or in the generators for "the update action" — it's just one operation among many.
3. **`read` is not a keyword.** Reads stay handled by Loom's existing read-side machinery (views, finders, repositories). Adding `read` as an aggregate-resident action kind would duplicate that machinery.

### Body semantics in detail

The body of every kind operates on a pre-bound `this`. The kind tag tells the framework what `this` means and what to do after the body runs:

```
aggregate Order {
  subject: string
  amount: decimal
  status: string

  create place(subject: string, amount: decimal) {
    this.subject := subject
    this.amount := amount
    this.status := "pending"
  }

  create import(subject: string, amount: decimal, externalId: string) {
    this.subject := subject
    this.amount := amount
    this.externalId := externalId
  }

  operation cancel() {
    this.status := "cancelled"
  }

  operation update(subject: string, amount: decimal) {    # crudish-emitted
    this.subject := subject
    this.amount := amount
  }

  destroy { }                                              # canonical hard delete
  destroy archive() {                                      # named soft-flavoured destroy
    this.archivedAt := now()
  }
}
```

Mechanical rules:

1. **Framework owns persistence; body does not.** A body never calls `repo.add()`, `repo.delete()`, `INSERT`, `UPDATE`, or any persistence primitive. The body is purely behavioural; persistence is inferred from the kind tag. This is the single biggest reason the kind tag exists — it carries enough information for the framework to fill in everything else, and the body stays platform-neutral.

2. **`this.id` inside `create` bodies is a validator error.** Id isn't assigned until persistence. Reading it in a create body has no defined semantics. Validator code: `loom.this-id-in-create` (or similar — see open items).

3. **Implicit return.** No `return` keyword in the body. `create` returns the new instance (with id populated). `operation` returns the updated instance. `destroy` returns nothing (or the soft-deleted instance with `deletedAt` if the body set it).

4. **Cross-aggregate reads inside any body** use Loom's existing `find` expressions through repository finders, exactly as in current `operation` bodies. No new mechanism. The body has read access to the model graph; what it does NOT have is write access to other aggregates. Multi-aggregate writes stay in workflows — the existing Loom mechanism.

5. **Named variants for `create` and `destroy`.** `create place(...)`, `create import(...)`, `destroy archive()` — multiple per aggregate. The canonical (unnamed) form is at most one per aggregate and is what `crudish` or `defaults`-style macros emit.

6. **`destroy` body semantics**: spelled out as "instance loaded by id, body runs (cleanup), framework removes." A destroy body that throws prevents removal — this is the precondition mechanism. The body reads `this.x` freely; assignments are valid but pointless for the canonical hard-delete case (the row is going away). For named destroys that are soft-delete-flavoured (`destroy archive() { this.archivedAt := now() }`), assignments to fields like `archivedAt` are how the soft-delete state is established before the framework's removal step (which, under `softDeletable`, is non-destructive).

## URL conventions

Backend API generators map kind + name to HTTP verb + path mechanically:

| Source | Verb | Path |
|---|---|---|
| `create(...)` (canonical) | `POST` | `/orders` |
| `create import(...)` (named) | `POST` | `/orders/import` |
| `operation cancel(...)` | `POST` | `/orders/:id/cancel` |
| `operation update(...)` (crudish-emitted) | `POST` | `/orders/:id/update` |
| `destroy` (canonical) | `DELETE` | `/orders/:id` |
| `destroy archive()` (named) | `POST` | `/orders/:id/archive` |

**One rule: POST for everything that takes a body; DELETE only for the canonical no-body removal.** No PATCH.

### Why no PATCH

Conventional REST uses `PATCH /orders/:id` for partial updates. Loom drops the verb entirely:

- The canonical "edit all fields" handler becomes `operation update(...)` → `POST /orders/:id/update`. Same route shape as any other operation.
- The "should this be PATCH or POST?" branching in the API generator goes away. Every body-carrying action is POST.
- Generated TypeScript / C# / Phoenix clients have one method-per-action shape regardless of kind.

The cost: ~85% RESTful, ~15% RPC-flavoured (URLs like `/orders/:id/cancel`). This matches the public APIs of GitHub, Stripe, Shopify, Linear, and almost every real-world REST API of meaningful size. Restful-Objects-style spec purity is not the design target; conventional REST URL shapes are.

### REST-style URL alternative — `urlStyle: resource`

For projects that want noun-flavoured URLs (`/orders/:id/cancellations`, `/orders/:id/refunds`) rather than verb-flavoured (`/orders/:id/cancel`, `/orders/:id/refund`), the API declaration carries a global setting:

```
api OrdersApi for Order {
  urlStyle: literal | resource    // default: literal
}
```

- `literal` (default): URL slug is the operation/create/destroy name verbatim. `operation cancel()` → `POST /orders/:id/cancel`.
- `resource`: URL slug is the pluralised name. Loom's existing `plural` util (`src/util/naming.ts`) handles regular English pluralisation. `operation cancellation()` → `POST /orders/:id/cancellations`; `operation refund()` → `POST /orders/:id/refunds`; `create import()` → `POST /orders/imports`.

**Per-operation route overrides are explicitly not supported.** A `route:` clause on individual operations would leak API concerns into the domain layer and create an N-way override mess. URL-shape decisions are owned by the api-layer setting; the operation name plus pluralisation rule fully determines the URL.

**Naming becomes a domain choice.** If the user writes `operation cancel()` under `urlStyle: resource`, they get `POST /orders/:id/cancels` (their naming choice). If they want `/cancellations`, they name the operation `cancellation()`. The DSL does NOT include a verb→noun transformation table (English is too irregular to mechanise reliably).

Most teams will land on one of two coherent stances:
- **RPC-flavoured, verb-named operations.** Default. Familiar Loom-today behaviour.
- **Resource-flavoured, noun-named operations.** Opt-in via the api setting; scaffolds and crudish emit noun-style names by default.

Mixed conventions within one project become unappealing, which is healthy — it nudges toward consistency.

### REST purity scoreboard

| Pattern | URL form | RESTful score |
|---|---|---|
| Today (`operation cancel`) | `POST /orders/:id/cancel` | ~85% — RPC-flavoured, mainstream in real-world APIs |
| `urlStyle: resource` (noun names) | `POST /orders/:id/cancellations` | ~95% — looks RESTful; no GET counterpart |
| Full intent-resource modelling (return-type-driven URL + persistent action records) | `POST /orders/:id/cancellations` + `GET /orders/:id/cancellations/:cid` | ~100% — full HATEOAS-ready resources; deferred to a future event/audit proposal |

The last 5% (full intent-resource modelling, where each action emits a queryable record of itself) is **not** part of this proposal. It's a substantial architectural addition (persisted action records, GET handlers, audit-trail wiring) and belongs in its own design note, layered on top.

## Scaffold macro reframing

`crudish` is renamed in semantics, not in signature:

```
aggregate Order with crudish {
  subject: string
  amount: decimal
}
```

expands to:

```
aggregate Order {
  subject: string
  amount: decimal

  create create(subject: string, amount: decimal) {
    this.subject := subject
    this.amount := amount
  }
  operation update(subject: string, amount: decimal) {
    this.subject := subject
    this.amount := amount
  }
  destroy destroy() { }
}
```

URLs under `urlStyle: literal`:

```
POST   /orders            (create create)
POST   /orders/:id/update (operation update)
DELETE /orders/:id        (destroy)
```

URLs under `urlStyle: resource`:

```
POST   /orders            (create create — "creates" pluralisation doesn't show because canonical-named creates use the bare collection URL)
POST   /orders/:id/updates (operation update)
DELETE /orders/:id        (destroy)
```

The macro composes with `softDeletable`, `auditable`, `crossTenant`, etc. as today:
- `auditable` origin-tagged fields (`createdAt`, `updatedAt`, `createdBy`, `updatedBy`) are excluded from both the `create` and `operation update` parameter lists. The existing `writableUpdateFields` filter handles this; a parallel `writableCreateFields` factory is added (same shape, slightly different access-modifier inclusion — see below).
- `softDeletable` provides its own `destroy` (which sets `deletedAt` rather than removing). `crudish` defers to it via macro ordering (`with softDeletable, crudish`) — the existing macro composition mechanism handles which one wins.
- `crossTenant` doesn't interact with the lifecycle keywords directly.

### `writableCreateFields` vs `writableUpdateFields`

| Field characteristic | In `create` params? | In `update` params? |
|---|---|---|
| User-declared, default access | ✓ | ✓ |
| `immutable` (set once, never changed) | ✓ | ✗ |
| `managed` (framework-assigned, e.g. `createdAt`) | ✗ | ✗ |
| `token` (system-generated, e.g. version) | ✗ | ✗ |
| `internal` (not surfaced via API) | ✗ | ✗ |
| `secret` (write-only) | ✓ | ✓ |
| Field carrying an origin tag (auditable, etc.) | ✗ | ✗ |

`immutable` is the only access modifier that differs between the two. It belongs in `create` (you can set it on creation) but not in `update` (you cannot change it later). This is enough of a difference to warrant a separate factory.

## Grammar / IR / generator integration seams

### Language (`src/language/ddd.langium`)

Three new aggregate-member rules:

```
Create:
    'create' (name=ID)? '(' (params+=Param (',' params+=Param)*)? ')' '{' body+=Stmt* '}'

Destroy:
    'destroy' (name=ID)? ('(' (params+=Param (',' params+=Param)*)? ')')? '{' body+=Stmt* '}'

// Operation rule stays as-is — bare `operation X(...)` keeps today's semantics.
```

Notes:
- `create` requires parentheses (it's a factory and almost always takes arguments).
- `destroy` allows omitted parentheses for the canonical no-body case (`destroy { }`).
- Both keywords use existing `Param` and `Stmt` rules — no new grammar primitives.

API declaration extension:

```
Api:
    'api' name=ID 'for' target=[Aggregate] ('{' members+=ApiMember* '}')?

ApiMember:
    UrlStyleDecl | ... (other api members)

UrlStyleDecl:
    'urlStyle' ':' style=('literal' | 'resource')
```

### Validator (`src/language/ddd-validator.ts`)

New rules:

| Code | Rule |
|---|---|
| `loom.this-id-in-create` | Reading `this.id` inside a `create` body is invalid; id is not assigned until persistence. |
| `loom.create-name-conflict` | Two `create` declarations with the same name on one aggregate. |
| `loom.destroy-name-conflict` | Two `destroy` declarations with the same name on one aggregate. |
| `loom.canonical-create-conflict` | More than one canonical (unnamed) `create` on one aggregate. |
| `loom.canonical-destroy-conflict` | More than one canonical (unnamed) `destroy` on one aggregate. |
| `loom.url-style-naming-warn` | (Warning only.) Under `urlStyle: resource`, an operation/create/destroy with a verb-shaped name will pluralise to an awkward URL (`cancel` → `/cancels`). Suggest noun naming. |

### IR (`src/ir/loom-ir.ts`)

Existing `OperationIR` extended with a kind discriminator:

```ts
type OperationKind = 'create' | 'mutate' | 'destroy';

interface OperationIR {
  kind: OperationKind;
  name: string | null;        // null for canonical (unnamed) create/destroy
  params: ParamIR[];
  body: StmtIR[];
  routeSlug: string;          // derived in enrichment from name + urlStyle
  // ... existing fields
}
```

`AggregateIR` gains computed convenience accessors:

```ts
interface AggregateIR {
  // ... existing fields
  creates: OperationIR[];        // kind = 'create'
  operations: OperationIR[];     // kind = 'mutate' — what today's IR calls 'operations'
  destroys: OperationIR[];       // kind = 'destroy'
  canonicalCreate: OperationIR | null;
  canonicalDestroy: OperationIR | null;
}
```

`ApiIR` extended:

```ts
interface ApiIR {
  // ... existing fields
  urlStyle: 'literal' | 'resource';
}
```

### Lowering (`src/ir/lower.ts`, `src/ir/lower-expr.ts`)

- `lower.ts` walks `Create` and `Destroy` AST nodes, lowers them as `OperationIR` with the appropriate kind tag.
- `lower-expr.ts` handles body statements identically across kinds — the kind tag is metadata only.
- The `loom.this-id-in-create` check runs in lowering (where `this` references are resolved) rather than in the validator, since name resolution is where the AST `this.id` reference becomes a typed IR node.

### Enrichment (`src/ir/enrichments.ts`)

A new pass derives `routeSlug` on each operation:

```
routeSlug =
  if name is null then null                                 // canonical → bare collection URL
  else if apiUrlStyle = 'literal' then name
  else if apiUrlStyle = 'resource' then plural(name)
```

This pass also derives a `lifecycle` shape on the aggregate (analogous to the existing `wireShape` derivation) that consolidates: which actions exist, what their kinds are, what their canonical-vs-named status is, what their URL slugs resolve to. Backends consume `agg.lifecycle` rather than re-walking the operation list.

### Per-platform generators

#### TypeScript / Hono (`src/generator/ts/`)

Route emitter branches on `kind` for HTTP verb selection:

```
canonical create  → router.post('/orders', ...)
named create      → router.post('/orders/:slug', ...) where slug = action.routeSlug
operation         → router.post('/orders/:id/:slug', ...)
canonical destroy → router.delete('/orders/:id', ...)
named destroy     → router.post('/orders/:id/:slug', ...)
```

Body shape comes from the action's params (resolved + typed), not from `aggregate.fields`. The existing field-walking logic in the API generator is **removed and replaced** by action-param walking.

#### .NET (`src/generator/dotnet/`)

Same pattern using ASP.NET attribute routing: `[HttpPost]`, `[HttpDelete]`, route templates derived from `routeSlug`.

#### Phoenix (`src/generator/phoenix-live-view/`)

**(Superseded 2026: the Ash foundation was removed; this section described the Ash emission, which no longer exists. The Phoenix backend now emits plain Ecto/Phoenix.)** Loom's kind tag mapped 1:1 to Ash action types:

| Loom kind | Ash action type |
|---|---|
| `create` | `create` |
| `mutate` (operation) | `update` |
| `destroy` | `destroy` |

`AshJsonApi` route emission used the same urlStyle setting — Ash supports custom routes via the `route :post, "/:id/slug", :action_name` mechanism.

#### React (`src/generator/react/`)

- `api-builder.ts` — emits per-action client methods. Method signature comes from the action's params. URL comes from `routeSlug`. HTTP verb comes from `kind`.
- `body-walker.ts` — `CreateForm`, `OperationForm`, `DestroyForm` primitives bind to action IR. See companion [`loom-forms.md`](./loom-forms.md) proposal.

### Macro API (`src/macro-api/factories.ts`)

New factories for macros that need to emit lifecycle actions:

```ts
function createOp(name: string | null, params: ParamSpec[], body: StmtSpec[]): OperationDecl;
function destroyOp(name: string | null, params: ParamSpec[], body: StmtSpec[]): OperationDecl;
// existing operation(...) factory stays
function writableCreateFields(target: Aggregate): Property[];
// existing writableUpdateFields stays
```

`crudish` updated to emit the canonical trio via these factories.

## Decisions made and their rationale

### D1 — Keep lifecycle actions on the aggregate, not on a separate construct

We considered three places to put creation:

1. **On the aggregate** as a typed action (this proposal — Ash-style).
2. **On a separate "service" or "repository"** as a method (Naked Objects style).
3. **In a workflow** that produces the aggregate (Loom's existing workflow construct).

(1) is the chosen design. (2) is more DDD-orthodox but requires a substantial language addition (growing repositories or adding services into rich method containers). (3) works for cross-aggregate creates but is heavy for simple single-aggregate factories.

The deciding factor: Loom already targets Ash, which uses (1). Adopting the same model means the AshPhoenix backend becomes a near-1:1 translation rather than crossing an ontology mismatch. The Naked Objects approach (2) is empirically validated at scale, but the cost of growing repositories into domain-service containers exceeds the cost of adding two aggregate-member keywords.

### D2 — Three keywords (`create`, `operation`, `destroy`), not one with a modifier

We considered four syntactic shapes:

| Shape | Example | Verdict |
|---|---|---|
| a) Three keywords replace `operation` | `create place(...)`, `update cancel()`, `destroy purge()` | Rejected — breaking change. Every existing `operation` migrates to `update`. |
| b) One keyword with kind modifier | `operation create place(...)`, `operation update cancel(...)` | Rejected — `operation update cancel()` reads as semantically conflicting (update kind, POST routing). |
| c) Hybrid: keep `operation`, add `create` and `destroy` keywords | `create place(...)`, `operation cancel()`, `destroy purge()` | **Chosen.** Backward-compatible; two new keywords; one of them (`destroy`) is rarely written by hand. |
| d) Keyword names the route, not the kind | `update` keyword reserved for canonical PATCH-style edit; `operation` for named domain mutations | Considered but conflated with (c) once we dropped PATCH (see D4). |

### D3 — `destroy` not `delete`

| Concern | `delete` | `destroy` |
|---|---|---|
| HTTP verb alignment | Matches DELETE intuitively | No direct match |
| DDD neutrality | SQL-flavoured; implies physical removal | Neutral about hard vs soft removal |
| Soft-delete composition | "soft delete" reads as "soft hard removal" — odd | "soft destroy" / "soft termination" reads cleanly |
| Ash backend alignment | — | Ash uses `destroy` natively; 1:1 keyword mapping |

`destroy` chosen for DDD-honesty (neutral about hard vs soft) and Ash alignment. The cost — slightly less familiar to CRUD-only developers — is judged worth paying.

### D4 — No PATCH

Dropped from the URL conventions:

- Removes a routing branch (`canonical update → PATCH; named update → POST`) that buys marginal REST purity.
- Generated clients have a uniform shape across all kinds.
- POST for everything that takes a body matches what most auto-generated APIs do.

`update` ceases to be a special-cased verb; the canonical "edit fields" handler is just an `operation update(...)` that crudish emits, routed identically to any other operation.

### D5 — No generic action kind

Ash has generic actions (`action :send_invoice`); we considered adding a `run` or `call` kind for non-CRUD operations. Rejected because:

- "Generic operation" is an escape hatch that gets abused. Removing it forces honest modelling.
- Operations that don't mutate state either (a) ARE mutations with a "happened" marker (`this.lastInvoicedAt := now`), (b) are pure reads belonging in views/finders, or (c) coordinate external work belonging in workflows.
- The escape hatch is "use a workflow," not "use a generic operation."

This forces the user to decide whether a non-mutating action is really an aggregate concern. If it is, it's an update with a marker. If it isn't, it moves out.

### D6 — `read` stays out of the aggregate

Ash has `:read` actions because it unifies reads, mutations, and lifecycle under one engine. Loom has separate read-side machinery (views, finders, repositories) and would duplicate concepts by adding `:read` to the aggregate. Read remains in its current home.

### D7 — Per-operation `route:` alias rejected

Per-operation URL overrides would let users write `operation cancel() route: cancellations` to get `/cancellations` URLs while keeping `cancel()` in code. Rejected because:

- Mixes API/HTTP concerns into the domain layer.
- Creates an N-way override mess if every operation can re-specify its URL.
- The api-layer `urlStyle` setting is the right altitude for URL-shape configuration.

The cost: there's no syntactic way to express "I want `cancel()` in code but `/cancellations` in URL." The user's naming choice IS the URL choice, modulo the global setting. Teams pick a consistent stance.

### D8 — Auto-pluralisation is an api-layer setting, not a default

Hard-coded auto-pluralisation would be presumptuous. Different projects have legitimately different URL-style preferences. The `urlStyle` setting on the api declaration is the right scope — it's a cross-cutting external-contract decision, owned where APIs are configured.

### D9 — Multiple creates/destroys per aggregate are first-class

Following Ash. Real DDD has multiple factories per aggregate (customer-placed orders vs. admin-imported vs. derived-from-quote). Multiple named destroys are rarer but useful (hard delete vs. archive vs. tombstone).

The canonical (unnamed) form is at most one per kind per aggregate.

### D10 — Persistence is framework-owned, not body-owned

The body of any lifecycle action is purely behavioural — it mutates `this`. It does not call any persistence primitive. The framework infers the persistence operation from the kind tag (`create` → INSERT, `mutate` → UPDATE, `destroy` → DELETE). This is what makes the body platform-neutral: the same body emits TypeORM, EF Core, and Phoenix Ecto without modification. (At the time of writing the Phoenix target was Ash changesets; the Ash foundation was removed in 2026 and `platform: elixir` now emits plain Ecto/Phoenix.)

## Open items

1. **Validator naming convention.** `loom.create-this-id` vs `loom.this-id-in-create`. Bike-shed.

2. **`this.id` semantics inside create bodies.** Strictest stance is "validator error to reference at all." Looser stance is "returns a deferred / undefined value." This proposal recommends strict.

3. **Migration of existing examples.** Today's `operation` declarations stay valid (still represent named instance mutations). No mass migration needed. Only files that add `create`/`destroy` keywords get the new behaviour. CI's `examples/acme.ddd` and `web/src/examples/*.ddd` are unchanged.

4. **Scaffold macros (`scaffoldAggregate`, etc.) emit noun-style operation names by default**, so newly-scaffolded projects ship clean URLs under `urlStyle: resource`. Existing scaffold output (verb-named) stays as-is for backward compatibility.

5. **Effect on conformance / OpenAPI parity testing.** The `LOOM_E2E=1` suite includes an OpenAPI parity diff (`docs/tools.md`). Add fixtures covering create/destroy URL shapes; the parity check has to update to expect POST for canonical creates and POST + DELETE for destroys.

6. **Effect on the `partial-update.md` proposal.** That proposal introduces `command` + `option` fields for PATCH semantics on operations. Under the new model, the operation is still an `operation` (kind = mutate); the `option` machinery handles three-state field semantics inside the body and on the wire. No interaction concern, but worth a paragraph in each proposal noting orthogonality.

7. **GraphQL surface (if Loom grows one).** Each named action becomes a mutation. `placeOrder`, `cancelOrder`, `archiveOrder`. Clean by construction. Out of scope for v1 but the action-kind model maps cleanly.

8. **Idempotency markers** for caching/retry hints (PUT semantics for set-flag-to-true operations). Not v1. POST is universally non-idempotent in this model. Future refinement.

9. **Soft-delete composition with named destroys.** `aggregate Order with softDeletable { destroy archive() { ... } }` — does the `destroy archive()` cooperate with softDeletable's machinery (set `deletedAt`, don't actually remove), or is it independent? Probably the former; needs to be spelled out in the softDeletable macro.

10. **Test surface.** Add `test/lifecycle/*.test.ts` covering: per-kind parsing, per-kind validator rules, per-kind URL routing per backend, multi-create resolution, named-destroy resolution. Plus a `LOOM_TS_BUILD=1` and `LOOM_REACT_BUILD=1` build pass against `examples/acme.ddd` with the new keywords.

## Rejected alternatives summary

| Alternative | Why rejected |
|---|---|
| Move creation to a `repository` / `service` (Naked Objects style) | Most architecturally pure but splits the user's mental model. Repositories in Loom are thin; growing them into domain-service containers is a bigger lift than adding aggregate-member keywords. |
| `lifecycle` keyword (one keyword, marker for non-instance ops) | Invents Loom-specific ontology that doesn't map cleanly to mainstream frameworks. Ash-style typed actions are more honest and have industry precedent. |
| `operation create place(...)` (kind as modifier on one keyword) | Verbose. `operation update cancel()` reads as semantically conflicting. Saves grammar but loses readability. |
| Flat keywords replacing `operation` (three new, breaking) | Migration cost disproportionate to the benefit. Every existing `operation X()` becomes `update X()`. |
| Per-operation `route:` alias | Layering violation. Override mess. |
| Generic / `action` / `call` kind for non-CRUD operations | Escape hatch that gets abused. Real cases either mutate (update), are pure reads (views), or coordinate (workflows). |
| Generic `run` keyword | Same as above. |
| PATCH for canonical updates | Adds routing branch for marginal REST purity. Most generated APIs ignore PATCH. |
| `delete` keyword instead of `destroy` | SQL-flavoured. DDD-honesty argues for `destroy`. Ash alignment. |
| Auto-pluralisation as always-on default | Presumptuous. Should be project-level opt-in via `urlStyle: resource`. |
| Full intent-resource modelling (return-type-driven URL + persistent action records, Stripe/GitHub style) | Substantial architectural addition. Belongs in a separate proposal layered on top. |

## Phased delivery

A possible implementation sequence (~5 phases, each shippable independently):

### Phase 1 — Grammar + IR foundation (~3 days)

- Add `Create` and `Destroy` grammar rules; regen Langium artifacts.
- Add `kind` field + `creates`/`destroys`/`canonicalCreate`/`canonicalDestroy` convenience accessors on `AggregateIR`.
- Wire lowering for both new keywords.
- Validator rules D1–D6 above.
- Test surface: parsing + validation for each kind.

### Phase 2 — `urlStyle` setting + routeSlug enrichment (~2 days)

- Grammar for `urlStyle: literal | resource` on api declarations.
- Enrichment pass computing `routeSlug` per action.
- Validator warning for verb-named operations under `resource` style.

### Phase 3 — Backend route emission (~5 days, one per backend)

- TS/Hono: kind-based verb selection in route emitter.
- .NET: kind-based attribute selection.
- Phoenix: kind tag → Ecto/Phoenix lifecycle mapping (was Ash action types; Ash foundation removed 2026).
- React API client: per-action methods with correct verb + URL.
- Remove field-walking from API generators; switch to action-param walking.

### Phase 4 — `crudish` reframing + new factories (~2 days)

- Add `createOp`, `destroyOp`, `writableCreateFields` factories to macro API.
- Rewrite `crudish.macro.ts` to emit canonical trio.
- Update crudish tests (the stashed `phase-0-crudish-create` work needs to be redone under the new model).

### Phase 5 — Scaffold macro alignment (~1 day)

- Scaffold macros emit noun-named operations by default.
- Update scaffolded examples in `examples/` and `web/src/examples/` to match.
- Re-baseline fixtures.

Total: ~13 days serialised; ~7 days with parallelism (Phase 3 backends can split). Forms work ([`loom-forms.md`](./loom-forms.md)) blocks on Phase 1 + Phase 4 but can run in parallel with Phase 3.

## Relationship to companion proposals

- [`loom-forms.md`](./loom-forms.md) — the form generation layer that binds `CreateForm { of: X }` / `OperationForm { for: X.cancel }` / `DestroyForm { for: X.archive }` to action IR nodes. Forms read field shape from the action's params; no field-walking. **Required dependency** in both directions: forms need typed actions to bind to; this proposal motivates forms as the consuming use case.

- [`partial-update.md`](./partial-update.md) — `command` + `option`-typed fields for PATCH semantics inside an operation body. Orthogonal: a partial-update operation is still an `operation` (kind = mutate) under the new model; `option` handles three-state field semantics inside it.

- [`exception-less.md`](./exception-less.md) — typed errors propagating via `?` and RFC 7807 ProblemDetails translation at the API edge. Lifecycle actions throw / return errors the same way regular operations do. No interaction concerns.

- [`criterion.md`](./criterion.md) — `when <Criterion>` guards on operations (the canCommand pattern with auto-exposed `can-<op>` endpoints). Extends to lifecycle actions: `create place(...) when CanPlaceOrder { ... }` is the natural shape. The criterion proposal's open items should note this.

- [`authorization.md`](./authorization.md) — operation/view/workflow policy gates. Extends naturally to create/destroy. The authorization proposal's `policy { ... }` block should add `create` and `destroy` to the gateable surface.

- `scaffold-macros.md` (reference doc, not proposal) — describes the scaffold stdlib (`src/stdlib/scaffold/*`). Update once Phase 5 lands.

- `language.md` (reference doc) — describes the formal grammar. Update once Phase 1 lands.

- `generators.md` (reference doc) — per-platform emission matrix. Update once Phase 3 lands.

---

*Conversation thread that produced this proposal: design discussion in May 2026 covering the form-walker layering bug, Naked Objects / Causeway investigation, Ash typed-action model, REST URL conventions (Restful Objects spec, conventional REST, intent-resource modelling), keyword shape options (a/b/c), `delete` vs `destroy` naming, PATCH-vs-POST tradeoff, and final landing on the three-keyword + urlStyle-setting design.*
