# 22. Macros & the `with` clause

A macro is a compile-time `with <Macro>(...)` clause that splices AST into its host declaration **before** lowering — it expands to ordinary `.ddd` you could have written by hand. The most instructive "output" of a macro is therefore the **expanded source**, not the target language: every macro has a source-equivalent, and the `unfold` refactor ejects it verbatim. This chapter covers the `with` invocation and its argument forms, the thirteen stdlib macros, the built-in *capabilities* they compose with, the `defineMacro` authoring surface, the macro validation gates, and `unfold`.

> **Grammar:** `WithClause`, `MacroCall`, `MacroArg`, `MacroArgValue` · **Pipeline:** macro expansion is phase ② (AST→AST), before scope/link · **Validators:** `loom.unknown-macro`, `loom.macro-target-mismatch`, `loom.macro-arg-*`, `loom.macro-threw`, `loom.macro-escapes-host`, `loom.macro-non-ast-result`, `loom.capability-host-invalid`, `loom.scaffold-filter-param-unsupported` · **Source:** [`src/macros/`](../../src/macros/) · **Docs:** [`../scaffold-macros.md`](../scaffold-macros.md), [`../macro-api.md`](../macro-api.md)

Macros expand at AST phase ②, so a synthesised member is indistinguishable from a hand-written one by the time scope resolution, validation, lowering, and codegen run. That is why the examples below pair the **written** `.ddd` with its **expanded** `.ddd` (a `macro` tab group) — and, where the macro feeds backend output, one `backend` tab showing what the expansion ultimately emits.

## The `with` clause

`with` attaches one or more macro calls to a host declaration's head. It is admitted on exactly four hosts — `aggregate`, `context`, `ui`, and `api` — matching the four macro target kinds (`MacroTarget` in [`src/macros/api/define.ts`](../../src/macros/api/define.ts)). Multiple calls are comma-separated and applied left to right, so they compose:

```ddd
aggregate Order with softDeletable, softDelete {   // capability, then macro
  reference: string
}
```

```ebnf
WithClause: 'with' calls+=MacroCall (',' calls+=MacroCall)*;
MacroCall:  name=ID ('(' (args+=MacroArg (',' args+=MacroArg)*)? ')')?;
```

A bare name (`with crudish`) is the zero-arg form; the parentheses are optional. The same clause carries capability names (`softDeletable`) and macro names (`softDelete`) interchangeably — the expander resolves each against the macro registry first, then the capability inventory (the built-in prelude plus any `capability` declared in the workspace; see [Capabilities](11-capabilities-filters-stamps.md)). A capability is a pure *domain-state* mixin, so it is rejected on a `ui` or `api` host (`loom.capability-host-invalid`).

## Argument forms

A macro arg is `name: value`. The grammar admits five value shapes (`MacroArgValue`); the arg *name* is a `LooseName`, so soft keywords like `aggregates:` / `contexts:` work as parameter names.

| Form | Syntax | Example | Used by |
|---|---|---|---|
| string | `"…"` | `of: "Order"` | project-local macros |
| bool | `true` / `false` | `updateOnly: true` | `crudish` |
| int | `42` | `depth: 2` | project-local macros |
| ref | bare `ID` | `of: Sales` | `scaffoldSubdomain(of:)` |
| ref-list | `[ID, ID, …]` | `subdomains: [Sales]` | `scaffold(subdomains:)` |

Ref / ref-list values are **bare identifiers**, not Langium cross-references — macro expansion runs before linking, so the expander resolves them against a document-wide inventory it builds itself (`MacroArgValue` in [`ddd.langium`](../../src/language/ddd.langium)). A macro declares each param's `kind` and, optionally, a `default`. A param is **optional** when it has a `default`, is a `refList` (it defaults to `[]`), or is a `ref` marked `optional`; anything else is required and its absence raises `loom.macro-arg-missing`. The stdlib only exercises bool / ref / ref-list; string and int are grammar-supported for project-local macros.

```ddd
ui WebApp with scaffold(subdomains: [Sales], aggregates: [Product]) { }
//                      └─ ref-list ───────┘  └─ ref-list ───────┘
aggregate Order with crudish(updateOnly: true) { reference: string }
//                           └─ bool ────────┘
```

## The stdlib

Thirteen macros ship in [`src/macros/stdlib/`](../../src/macros/stdlib/), registered at toolchain boot by `loadStdlibMacros()`. Grouped by target:

| Macro | Target | Params | Emits |
|---|---|---|---|
| `crudish` | `aggregate` | `updateOnly: bool = false` | `update(...)` + canonical `create(...)` + `destroy {}` |
| `softDelete` | `aggregate` | — | `softDelete()` / `restore()` operations |
| `softDeleteByDefault` | `context` | — | `implements softDeletable` + `with softDelete` on every child aggregate |
| `scaffoldDashboard` | `context` | — | one singleton query-time `projection` per aggregate (row count + a sum per numeric/money field, and a per-day series when a date field exists) |
| `scaffoldHandlers` | `context` | — | the contract records (`command`/`query`/`response`) + a `commandHandler`/`queryHandler` per operation, create, find and get-by-id read |
| `scaffoldPaged` | `context` | `of: Criterion` | a paged `queryHandler` over the read-only port (`Repo.run(<criterion>)`) |
| `scaffoldApi` | `api` | `of: Subdomain` | one `route` per handler `scaffoldHandlers` emits for the subdomain |
| `scaffoldPagedApi` | `api` | `of: Criterion` | the `GET …/projections/<criterion>` route binding to `scaffoldPaged`'s handler |
| `scaffold` | `ui` | `subdomains:`, `contexts:`, `aggregates:`, `workflows:` (all ref-lists) | Home / WorkflowsIndex singletons + delegates to the composers below |
| `scaffoldSubdomain` | `ui` | `of: Subdomain` | one `scaffoldContext` per context in the subdomain |
| `scaffoldContext` | `ui` | `of: BoundedContext` | one `scaffoldAggregate` / `scaffoldWorkflow` per member |
| `scaffoldAggregate` | `ui` | `of: Aggregate` | List / New / Detail pages for the aggregate (one `area`) |
| `scaffoldWorkflow` | `ui` | `of: Workflow` | the workflow Form page, plus read-only instance pages when the workflow is observable |

`scaffoldView` is **gone** — it was removed with the `view` declaration (replaced by `projection`; see [Projections](10-repositories-and-queries.md#projection--the-read-model)).

> **`auto-paged-table` is not a `with` macro.** [`stdlib/auto-paged-table.ts`](../../src/macros/stdlib/auto-paged-table.ts) is an **always-on** AST pass the expander runs after `with` expansion (`autoPagePagedTables(model)`, [`expander.ts`](../../src/macros/expander.ts)). It rewrites a hand-written `Table` over a paged read into the shape the scaffold emits — page `state`, `paged: true`, `serverPaged`, `totalPages` — because page state is a structural declaration the body walker cannot add. A `Table` that already carries `page:`/`serverPaged:`, a `QueryView` that already declares `paged:`, or a read that already passes arguments is left byte-identical.

## Macros vs. capabilities

They ride the same `with` clause and are easy to conflate, but they are different mechanisms:

| | Macro | Capability |
|---|---|---|
| Defined in | TypeScript (`defineMacro`) | `.ddd` (`capability X { … }`) or the built-in prelude |
| Can emit | any AST member | fields, `filter`, `stamp` — a pure mixin |
| Hosts | aggregate / context / ui / api | aggregate / context only |
| Takes args | yes | no |

Five capabilities ship built in ([`src/macros/prelude.ts`](../../src/macros/prelude.ts)); a workspace `capability` of the same name shadows the prelude one:

| Capability | Adds |
|---|---|
| `auditable` | `createdAt` / `updatedAt` / `createdBy` / `updatedBy` (all `managed`) + the `onCreate` / `onUpdate` stamp rules |
| `softDeletable` | `isDeleted` (`internal`) + `deletedAt?` (`managed`) + `filter !this.isDeleted` |
| `tenantOwned` | `tenantId` + `dataKey` (both `internal`) + the principal-claim stamp + the tenant read filter ([Tenancy](../tenancy.md)) |
| `tenantRegistry` | `parent: Self id?` (`immutable`) + materialized `dataKey: string?` (`managed`) — the tenant tree |
| `versioned` | `version: int token = 1` — the optimistic-concurrency marker |

## `crudish`

`with crudish` on an aggregate inspects the host's field list and emits a generated `update(...)` operation (one parameter per **writable update field**, body assigning each to its field), plus a canonical `create(...)` factory and a `destroy {}` terminator. "Writable update field" = a property whose access modifier admits external writes — `managed` / `token` / `internal` are dropped, `immutable` is dropped from `update` but kept by `create` (settable once, at creation), `secret` stays on both. Fields contributed by another capability/macro (e.g. `createdAt` from `auditable`) and any field targeted by a `stamp onCreate` / `stamp onUpdate` are skipped regardless of access.

Pass `updateOnly: true` to suppress `create`/`destroy` — for composing with a macro or capability that owns the create/delete lifecycle.

::: tabs macro
== written
```ddd
aggregate Product with crudish {
  name: string
  price: decimal
  sku: string immutable        // create-only: dropped from update
  createdAt: datetime managed  // server-seeded: dropped from both
}
```
== expanded
```ddd
aggregate Product {
  name: string
  price: decimal
  sku: string immutable
  createdAt: datetime managed

  operation update(name: string, price: decimal) {   // sku, createdAt absent
    name := name
    price := price
  }

  create(name: string, price: decimal, sku: string) {  // immutable sku kept
    name := name
    price := price
    sku := sku
  }

  destroy {}
}
```
::: end

> The `name := name` RHS resolves to the *parameter*, not the field — Loom name resolution prefers params over fields when shadowed (the right semantics here). The expanded source above is the literal output of the `unfold` refactor.

The generated `update` operation lowers exactly like a hand-written one: a domain method plus a `POST /{id}/update` route whose request body is the writable-field set.

::: tabs backend
== node
```ts
// domain/product.ts — operation update lowered to a method
public update(name: string, price: number): void {
  this._name = name;
  this._price = price;
  this._assertInvariants();
}
```
```ts
// http/product.routes.ts — request schema is the writable update fields
const UpdateProductRequest = z.object({
  name: z.string(),
  price: z.number(),
}).openapi("UpdateProductRequest");
// … POST /{id}/update → repo.findById → aggregate.update(body.name, body.price) → repo.save
```
::: end

## `softDelete` / `softDeletable`

Soft delete is split deliberately: the **state + read filter** ship as the built-in `capability softDeletable` (`isDeleted: bool`, `deletedAt: datetime?`, and `filter !this.isDeleted`); the `softDelete` **macro** adds only the two **operations**. A capability is a pure mixin, so compose them — `with softDeletable, softDelete`.

::: tabs macro
== written
```ddd
context Sales {
  aggregate Order with softDeletable, softDelete { reference: string }
}
```
== expanded (unfolding `softDelete` only)
```ddd
context Sales {
  aggregate Order with softDeletable {   // the capability stays — unfold ejects one call
    reference: string

    operation softDelete() {
      isDeleted := true
      deletedAt := now()
    }

    operation restore() {
      isDeleted := false
      deletedAt := null
    }
  }
}
```
::: end

The capability's `isDeleted` / `deletedAt` fields and its `!this.isDeleted` read filter are woven in at lowering, so every generated read path — `findById`, `findManyByIds`, the paged `all` — gains the predicate and soft-deleted rows never surface:

::: tabs backend
== node
```ts
// db/repositories/order-repository.ts — every read carries the capability filter
const rootRows = await this.db.select().from(schema.orders)
  .where(not(eq(schema.orders.isDeleted, true)))
  .orderBy(orderBy).limit(pageSize).offset(offset);
```
```ts
// domain/order.ts — the two operations
public softDelete(): void { this._isDeleted = true; this._deletedAt = new Date(); }
public restore(): void   { this._isDeleted = false; this._deletedAt = null; }
```
```sql
-- db/migrations/…_initial.sql — the capability fields are real columns
"is_deleted" BOOLEAN NOT NULL,
"deleted_at" TIMESTAMP WITH TIME ZONE NULL,
```
::: end

### `softDeleteByDefault`

`softDeleteByDefault` is the **context-level** convenience: it applies `implements softDeletable` to the context (fanning the state + filter to every aggregate) and invokes `softDelete` on each child aggregate. Unfolding it one level shows that fan-out as explicit per-aggregate clauses:

::: tabs macro
== written
```ddd
context Billing with softDeleteByDefault {
  aggregate Invoice { number: string }
  repository Invoices for Invoice { }
}
```
== expanded (one unfold level)
```ddd
context Billing {
  aggregate Invoice with softDelete { number: string }   // ← ops added per child
  repository Invoices for Invoice { }

  implements softDeletable                               // ← fans capability to every aggregate
}
```
::: end

## `scaffold` family — UI

The UI scaffold family synthesises pages from a domain. It is composable end to end: the top-level `scaffold` (target `ui`) fans out to per-element composers, which fan out to leaves. `scaffoldAggregate` / `scaffoldWorkflow` are the **leaves**; everything above delegates via `invokeMacro`. An `abstract aggregate` base is skipped by the leaf (it owns no table/routes — only its concrete `extends` subtypes get pages), and a workflow that is event-triggered-only gets no form page (it has no command route to bind).

Unfold is **one level only** — `scaffold(subdomains: [Sales])` does not flatten to pages; it reveals the next composer down plus the singleton pages emitted directly. Drill into a single `scaffoldAggregate` to materialise just its pages as source while leaving the rest of the UI under the macro.

::: tabs macro
== written
```ddd
ui WebApp with scaffold(subdomains: [Sales]) { }
```
== expanded (one unfold level)
```ddd
ui WebApp with scaffoldSubdomain(of: Sales) {
  page Home {                                  // ← singleton, emitted directly
    route: "/"
    body: Stack(
      Heading("Welcome", level: 2),
      Text("Pick a section from the sidebar to start, or jump straight in below."),
      Stack(
        Card(
          Heading("3 aggregates", level: 4),
          Text("Manage records of each kind from the sidebar.")
        )
      ),
      testid: "home"
    )
    menu {
      hidden: true
    }
  }
}
```
::: end

The WorkflowsIndex singleton appears only when at least one command-surfaced workflow exists, and Home's KPI row grows a `Stat` tile per aggregate whose context also carries `scaffoldDashboard`.

Generating the full system materialises the leaf pages — a Home plus per-aggregate `list` / `new` / `detail` (a `detail`-only pair when the aggregate has no create):

::: tabs frontend
== react
```
web_app/src/pages/home.tsx
web_app/src/pages/products/list.tsx     ← useAllProducts(), Table, "New product" button, pager
web_app/src/pages/products/new.tsx
web_app/src/pages/products/detail.tsx
```
```tsx
// pages/products/list.tsx (excerpt) — the List page binds the aggregate's paged findAll hook
export default function ProductList() {
  const productAll = useAllProducts({ page: pageNum, pageSize: 10, sort: sortKey, dir: sortDir });
  return (
    <Stack data-testid="products-list">
      {/* breadcrumbs, title, "New product" → navigate("/products/new") */}
      {/* loading skeletons, error alert, empty state, then a <Table> of rows + pager */}
    </Stack>
  );
}
```
::: end

The synthesised pages carry their **full** walker-stdlib body (not a placeholder), so `unfold` ejects real, editable `.ddd`. A page's *kind* is derived on demand from its role-scoped name + area — there is no stamped `origin`. Override-by-name lets you replace any scaffolded page (Home included) by writing one with the same name explicitly. See [UI pages](15-ui-pages-structure.md) for the page DSL the scaffolds emit.

### The scaffolded filter bar

The List page's filter bar wires one input per param of every array-returning repository `find`, and the arm is **all-or-nothing**: a find with a single unrenderable param is dropped from the bar whole, with `loom.scaffold-filter-param-unsupported` (a *warning*) naming it. The renderable set (`RENDERABLE_FILTER_PRIMITIVES`, [`src/util/filter-param-kinds.ts`](../../src/util/filter-param-kinds.ts)) is `string`, `guid`, `datetime` (a text `Field` — all three are `z.string()` on the wire), `int` / `long` (a `NumberField` whose unset sentinel is `0`), `bool` (a three-state `SelectField`), and `<X> id`. Two kinds are held back for reasons that live in the frontend emitters, not the macro: `decimal` / `money` (the `0` sentinel does not type-check on Feliz) and `enum` (every frontend types an enum-valued `state {}` field as bare `string` while the query param is a zod enum union).

```ddd
repository Products for Product {
  find byPrice(price: decimal): Product[] where this.price == price   // decimal → dropped
}
```
```
warning: the scaffolded list filter bar has no input for `price: decimal`, so repository
find 'byPrice' is omitted from it entirely and 'Product' cannot be filtered by that column
from this page.                                        [loom.scaffold-filter-param-unsupported]
```

Binding the find yourself in an explicit `page List { … }` override silences it — the gate only fires when nothing in the page body reads that find.

## `scaffold` family — application & transport

The same "one macro emits, its pair binds to it" split covers the handler and route layers, so a route can never target a handler the macro didn't emit.

`scaffoldHandlers` (target `context`) emits the API contract records first, then the handlers that realise it:

::: tabs macro
== written
```ddd
context Catalog with scaffoldHandlers {
  aggregate Product {
    name: string
    price: money
    operation rename(newName: string) { name := newName }
  }
  repository Products for Product { }
}
```
== expanded
```ddd
response ProductResponse {
  name: string,
  price: money,
  version: int
}

query GetProductQuery {
  productId: Product id
}

command RenameProductCommand {
  newName: string
}

queryHandler GetProduct(query: GetProductQuery): ProductResponse {
  let o = Products.getById(query.productId)
  return o
}

commandHandler RenameProduct(productId: Product id, cmd: RenameProductCommand) {
  let o = Products.getById(productId)
  o.rename(cmd.newName)
}
```
::: end

`scaffoldPaged(of: <Criterion>)` (target `context`) is the ergonomic paged read — one `queryHandler` over the read-only port:

::: tabs macro
== written
```ddd
context Catalog with scaffoldPaged(of: Named) {
  aggregate Product { name: string  price: money }
  repository Products for Product { }
  criterion Named(needle: string) of Product = this.name == needle
}
```
== expanded
```ddd
queryHandler ListProductByNamed(needle: string): Product paged {
  let r = Products.run(Named(needle))
  return r
}
```
::: end

`scaffoldApi(of: <Subdomain>)` and `scaffoldPagedApi(of: <Criterion>)` are the matching **`api`-target** macros — they emit the `route`s (POST for writes, GET for reads; `/projections/<criterion>` for the paged one) that bind to those handlers:

```ddd
subdomain Sales {
  context Catalog with scaffoldHandlers {      // emits the handlers …
    aggregate Product { name: string }
    repository Products for Product { }
  }
}
api SalesApi with scaffoldApi(of: Sales) from Sales   // … and this emits the routes onto them
```

`scaffoldDashboard` (target `context`) emits one singleton query-time `projection` per aggregate — `<Agg>Totals` (a row count plus a sum per numeric/money field, aggregated in SQL) and, when the aggregate carries a date field, a per-day `<Agg>Series`. Aggregates it cannot aggregate over a real table (abstract bases, `persistedAs: eventLog` streams, `shape: document` blobs) are skipped. The ui-side `scaffold` derives the same projection names from [`_dashboard-shared.ts`](../../src/macros/stdlib/scaffold/_dashboard-shared.ts), so a Home `Stat` tile can only bind a projection this macro emitted:

::: tabs backend
== node
```ts
// http/query-projections.ts — the emitted singleton projection's wire row
const ProductTotalsRow = z.object({
  rowCount: z.number().int(),
  priceSum: z.string(),
}).openapi("ProductTotalsRow");
const ProductTotalsResponse = ProductTotalsRow.openapi("ProductTotalsResponse");
```
::: end

## Audit — the built-in `capability auditable`

> **Not a macro.** `audit` / `auditable` no longer exist as `with` macros. Audit ships as the built-in `capability auditable` — apply it via the capability surface (`implements "auditable"`), not a `with` clause.

The capability adds the four canonical fields (`createdAt`, `updatedAt`, `createdBy: User id`, `updatedBy: User id`, all `managed`) and the context-level `onCreate` / `onUpdate` stamping rules (`createdAt := now()`, `createdBy := currentUser`, etc.). Fields + the `implements` opt-in are per-aggregate; the stamp rules are a context-level concern, so they live in the capability, not on each aggregate. See [Capabilities](11-capabilities-filters-stamps.md).

## Validation gates

Every macro diagnostic is raised by the expander in phase ②, so it points at your `with` clause, not at synthesised source:

| Code | Fires when |
|---|---|
| `loom.unknown-macro` | the name is neither a registered macro nor a capability (the message lists the available macros); a second form covers a macro that `invokeMacro`s an unknown child |
| `loom.macro-target-mismatch` | `with scaffold` on an aggregate — the macro's `target` ≠ the host kind |
| `loom.macro-arg-unknown` | an arg name the macro doesn't declare (the message lists the declared params) |
| `loom.macro-arg-duplicate` | the same arg name twice in one call |
| `loom.macro-arg-missing` | a required param omitted (no `default`, not a `refList`, not an `optional` ref) |
| `loom.macro-arg-kind-mismatch` | `crudish(updateOnly: "yes")` — value shape ≠ declared `kind` |
| `loom.macro-arg-unresolved-ref` | a ref / ref-list element naming a declaration that doesn't exist |
| `loom.macro-threw` | the `expand` function threw (two forms: direct, and invoked-from-parent) |
| `loom.macro-non-ast-result` | `expand` returned something that isn't an AST member or capability node |
| `loom.macro-escapes-host` | an emitted node targets a destination outside the host's subtree — a macro may only modify its host or its descendants |
| `loom.capability-host-invalid` | a capability name in a `with` clause on a `ui` or `api` host |
| `loom.scaffold-unexpanded` | an unresolved scaffold primitive survives into IR validation |

```ddd
aggregate A with scaffold { name: string }
// error: Macro 'scaffold' targets 'ui' but was invoked on a 'aggregate'.  [loom.macro-target-mismatch]

aggregate A with crudish(foo: true) { name: string }
// error: Unknown argument 'foo' for macro 'crudish'.  Declared parameters: updateOnly.
//                                                          [loom.macro-arg-unknown]

ui W with scaffoldAggregate(of: Nope) { }
// error: Macro 'scaffoldAggregate' requires argument 'of' (kind=ref).   [loom.macro-arg-missing]
// error: Argument 'of' to macro 'scaffoldAggregate' references unknown Aggregate 'Nope'.
//                                                          [loom.macro-arg-unresolved-ref]
```

### `ignoring` placement

`ignoring <Capability>` bypasses a capability read filter (the `softDeletable` case above). It rides `PostfixExpr`, which is admissible anywhere an expression is — so it parses cleanly in positions where nothing reads it back and the filter silently stays applied. `loom.ignoring-clause-placement` refuses those: the clause has exactly three homes — a repository `find … ignoring …`, a query-time projection's `where` slot (**before** `join` / `group by` / `select`), and an inline read bound by a `let`.

```ddd
projection Counts { status: string  n: int
  from Order as o
  group by o.status ignoring softDeletable        // ← DROPPED
  select status = o.status, n = count() }
// error: 'ignoring softDeletable' sits in a position that DROPS it.  [loom.ignoring-clause-placement]
```

## Authoring a macro (`defineMacro`)

A macro is a TypeScript module that default-exports a `defineMacro({ … })` call. It declares a `name`, a `target` host kind, optional typed `params`, and an `expand({ target, args, invokeMacro })` function returning the AST fragments to splice in. The host AST node is `target`; inspect it (its field list, members) and return members built **only** from the factories in [`src/macros/api/`](../../src/macros/api/) — those tag each node with origin metadata so validator diagnostics on synthesised members resolve back to the user's `with` clause.

```ts
// the shape every stdlib + project-local macro follows
export default defineMacro({
  name: "crudish",
  target: "aggregate",                       // "aggregate" | "context" | "ui" | "api"
  apiVersion: 1,
  params: { updateOnly: { kind: "bool", default: false } },
  expand({ target, args }) {
    const fields = writableUpdateFields(target).filter((f) => f.type != null);
    const params = fields.map((f) => param(f.name, cloneType(f.type)));
    const body = fields.map((f) => assignStmt(f.name, nameRef(f.name)));
    return [operation("update", params, body), /* … */];
  },
});
```

The API exposes typed AST factories (`operation`, `param`, `primType`, `boolLit`, `assignStmt`, `nameRef`, `commandHandler`, `route`, `singletonProjection`, `page`, `area`, …) and host-inspection helpers (`writableUpdateFields`, `writableCreateFields`, `aggregatesIn`, `workflowsIn`, `apiReadFields`). A context-, ui-, or api-level macro fans work outward with `invokeMacro(childName, { target })` — the composition pattern `scaffold` and `softDeleteByDefault` use. Inside-out invocation (an aggregate macro reaching up to a context) is refused by the expander's splice-time descendant check (`loom.macro-escapes-host`). The full factory catalogue is [`../macro-api.md`](../macro-api.md).

> **Honest gap — project-local discovery.** The `defineMacro` surface and the registry are built for project-local `.loom/macros/*.ts` modules (the registry doc-comment describes the intended `.ts → .js → load` path), but `bootMacros` only loads the **stdlib** — there is no wired filesystem-discovery loader for `.loom/macros/` in the CLI/LSP boot path today. A new macro must be registered in code (`registerMacro` / the stdlib barrel). Treat custom-macro authoring as the stdlib-extension path, not a drop-in plugin directory, until discovery lands.

## `unfold` — eject the expanded source

`unfold` rewrites a `with X(...)` clause into its expanded `.ddd` in place, proving macros are demonstrably sugar. It is reachable as the LSP code action (VS Code "Unfold macro 'X'") and as the transport-neutral toolkit call `unfoldMacro(source, macro, on)` ([`src/api/refactor.ts`](../../src/api/refactor.ts), exposed as the `loom_unfold_macro` agent tool) — it **returns** edits, it does not apply them. There is no dedicated `ddd unfold` CLI subcommand.

It is **one level only**: a composer's `invokeMacro(child, { target })` calls are *not* executed — each becomes a `with <child>(...)` clause on its target (the explicit fan-out you saw under `scaffold` and `softDeleteByDefault`), and you drill further by unfolding those children. The macro's directly-returned nodes are printed through the structural printer ([`src/language/print/`](../../src/language/print/)) and inserted before the host's closing `}`, and the host's `with` clause is rewritten atomically (the unfolded call removed, any new `with child` entries spliced in, the whole clause stripped if it ends up empty). The printer's round-trip guarantee means unfolded output re-parses to a working program.

A `ui`-target macro also offers **per-page** unfolds — "Unfold page 'Orders / Detail'" ejects one scaffolded page as source and leaves its siblings generated, relying on the same override-by-name merge an explicit `page <Name>` uses. That variant is insert-only: the `with` clause is not rewritten.

```ddd
// before — cursor on `crudish`, run "Unfold macro 'crudish'"
aggregate Product with crudish { name: string  price: decimal }
```
↓
```ddd
// after — the with clause is gone, the operations are now plain source
aggregate Product {
  name: string
  price: decimal

  operation update(name: string, price: decimal) {
    name := name
    price := price
  }

  create(name: string, price: decimal) {
    name := name
    price := price
  }

  destroy {}
}
```

> **Two limits.** Unfold resolves the host kind from the AST node and only handles `aggregate` / `ui` / `context` — the two `api`-target macros (`scaffoldApi`, `scaffoldPagedApi`) offer no code action. And because unfold re-runs `expand` against the **already-expanded** document, a macro that skips work it sees present (`scaffoldDashboard`'s "this projection already exists" guard) ejects nothing; read its source-equivalent from [`../scaffold-macros.md`](../scaffold-macros.md) instead.

## Cross-references

- [Capabilities](11-capabilities-filters-stamps.md) — the `filter` / `stamp` / `implements` surface the built-in `auditable` / `softDeletable` capabilities and the `softDelete` macro build on.
- [UI pages](15-ui-pages-structure.md) — the page DSL the scaffold macros emit.
- [Repositories & queries](10-repositories-and-queries.md) — the `projection` read model `scaffoldDashboard` emits, the `criterion` the paged scaffolds take, and the `ignoring` bypass.
- [`../scaffold-macros.md`](../scaffold-macros.md) — the authoritative stdlib reference.
- [`../macro-api.md`](../macro-api.md) — the `defineMacro` authoring surface and full factory catalogue.
- [`../technical.md`](../technical.md) — phase ② macro expansion relative to scope/link and lowering.
