# 22. Macros & the `with` clause

A macro is a compile-time `with <Macro>(...)` clause that splices AST into its host declaration **before** lowering — it expands to ordinary `.ddd` you could have written by hand. The most instructive "output" of a macro is therefore the **expanded source**, not the target language: every macro has a source-equivalent, and the `unfold` refactor ejects it verbatim. This chapter covers the `with` invocation and its argument forms, the stdlib (`scaffold*`, `crudish`, `softDelete`/`softDeleteByDefault`), the `defineMacro` authoring surface, and `unfold`. The cross-cutting *capability* surface that `softDeletable`/`auditable` build on lives in [Capabilities](11-capabilities-filters-stamps.md).

> **Grammar:** `WithClause`, `MacroCall`, `MacroArg`, `MacroArgValue` · **Pipeline:** macro expansion is phase ② (AST→AST), before scope/link · **Source:** [`src/macros/`](../../src/macros/) · **Docs:** [`../scaffold-macros.md`](../scaffold-macros.md)

Macros expand at AST phase ②, so a synthesised member is indistinguishable from a hand-written one by the time scope resolution, validation, lowering, and codegen run. That is why the examples below pair the **written** `.ddd` with its **expanded** `.ddd` (a `macro` tab group) — and, where the macro feeds backend output, one `backend` tab showing what the expansion ultimately emits.

## The `with` clause

`with` attaches one or more macro calls to a host declaration's head. It is admitted on exactly three hosts — `aggregate`, `context`, and `ui` — each with its own macro target kind. Multiple calls are comma-separated and applied left to right, so they compose:

```ddd
aggregate Order with softDeletable, softDelete {   // capability, then macro
  reference: string
}
```

```ebnf
WithClause: 'with' calls+=MacroCall (',' calls+=MacroCall)*;
MacroCall:  name=ID ('(' (args+=MacroArg (',' args+=MacroArg)*)? ')')?;
```

A bare name (`with crudish`) is the zero-arg form; the parentheses are optional. The same clause carries capability names (`softDeletable`) and macro names (`softDelete`) interchangeably — the expander resolves each against the macro registry first, then the workspace's capability inventory ([Capabilities](11-capabilities-filters-stamps.md)).

## Argument forms

A macro arg is `name: value`. The grammar admits five value shapes (`MacroArgValue`):

| Form | Syntax | Example | Used by |
|---|---|---|---|
| string | `"…"` | `of: "Order"` | project-local macros |
| bool | `true` / `false` | `updateOnly: true` | `crudish` |
| int | `42` | `depth: 2` | project-local macros |
| ref | bare `ID` | `of: Sales` | `scaffoldAggregate(of:)` |
| ref-list | `[ID, ID, …]` | `subdomains: [Sales]` | `scaffold(subdomains:)` |

Ref / ref-list values are **bare identifiers**, not Langium cross-references — macro expansion runs before linking, so the expander resolves them against a document-wide inventory it builds itself (`MacroArgValue` in [`ddd.langium`](../../src/language/ddd.langium)). A macro declares each param's `kind` and an optional `default`; the validator coerces and type-checks the call against that spec and defaults any omitted optional param. The stdlib only exercises bool / ref / ref-list; string and int are grammar-supported for project-local macros.

```ddd
ui WebApp with scaffold(subdomains: [Sales], aggregates: [Product]) { }
//                      └─ ref-list ───────┘  └─ ref-list ───────┘
aggregate Order with crudish(updateOnly: true) { reference: string }
//                           └─ bool ────────┘
```

## `crudish`

`with crudish` on an aggregate inspects the host's field list and emits a generated `update(...)` operation (one parameter per **writable update field**, body assigning each to its field), plus a canonical `create(...)` factory and a `destroy {}` terminator. "Writable update field" = a property whose access modifier admits external writes — `managed` / `token` / `internal` are dropped, `immutable` is dropped from `update` but kept by `create` (settable once, at creation), `secret` stays on both. Fields contributed by another capability/macro (e.g. `createdAt` from `auditable`) are skipped regardless of access.

Pass `updateOnly: true` to suppress `create`/`destroy` — for composing with a macro that owns the create/delete lifecycle.

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
  create(name: string, price: decimal) {             // immutable sku would appear here
    name := name
    price := price
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
  price: z.coerce.number(),
}).openapi("UpdateProductRequest");
// … POST /{id}/update → repo.getById → aggregate.update(body.name, body.price) → repo.save → 204
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
== expanded
```ddd
context Sales {
  // filter for "softDeletable" !this.isDeleted — carried by the built-in capability

  aggregate Order {
    reference: string
    isDeleted: bool          // ← from the softDeletable capability
    deletedAt: datetime?     // ← from the softDeletable capability

    operation softDelete() {  // ← from the softDelete macro
      this.isDeleted := true
      this.deletedAt := now()
    }
    operation restore() {
      this.isDeleted := false
      this.deletedAt := null
    }

    implements "softDeletable"
  }
}
```
::: end

The capability's `!this.isDeleted` read filter is woven into every generated read path — `findAll` and `getById` both gain the predicate, so soft-deleted rows never surface:

::: tabs backend
== node
```ts
// db/repositories/order-repository.ts — findAll gains the capability filter
const rootRows = await this.db.select().from(schema.orders)
  .where(not(eq(schema.orders.isDeleted, true)));
```
```ts
// domain/order.ts — the two operations
public softDelete(): void { this._isDeleted = true; this._deletedAt = new Date(); }
public restore(): void   { this._isDeleted = false; this._deletedAt = null; }
```
```sql
-- db/migrations/…_initial.sql — the capability fields are real columns
is_deleted BOOLEAN NOT NULL,
deleted_at TIMESTAMP WITH TIME ZONE NULL,
```
::: end

### `softDeleteByDefault`

`softDeleteByDefault` is the **context-level** convenience: it applies `implements softDeletable` to the context (fanning the state + filter to every aggregate) and invokes `softDelete` on each child aggregate. Unfolding it one level shows that fan-out as explicit per-aggregate clauses:

::: tabs macro
== written
```ddd
context Orders with softDeleteByDefault {
  aggregate Order    { reference: string }
  aggregate Customer { name: string }
}
```
== expanded (one unfold level)
```ddd
context Orders {
  implements softDeletable                 // ← fans capability to every aggregate

  aggregate Order    with softDelete { reference: string }   // ← ops added per child
  aggregate Customer with softDelete { name: string }
}
```
::: end

## `scaffold` family

The scaffold family synthesises UI pages from a domain. It is composable end to end: the top-level `scaffold` (target `ui`) fans out to per-element composers, which fan out to leaves.

| Macro | Target | Emits |
|---|---|---|
| `scaffold(subdomains:, contexts:, aggregates:, workflows:, views:)` | `ui` | Home / Workflows-index / Views-index singletons + invokes the composers below |
| `scaffoldSubdomain(of: S)` | `ui` | one `scaffoldContext` per context in subdomain `S` |
| `scaffoldContext(of: C)` | `ui` | one `scaffoldAggregate`/`scaffoldWorkflow`/`scaffoldView` per member of `C` |
| `scaffoldAggregate(of: Agg)` | `ui` | a List, New (create-form), and Detail page for `Agg` (one `area` block) |
| `scaffoldWorkflow(of: W)` | `ui` | a Form page for workflow `W` |
| `scaffoldView(of: V)` | `ui` | a List page for view `V` |

`scaffoldAggregate` / `scaffoldWorkflow` / `scaffoldView` are the **leaves**; everything above is a composer that delegates via `invokeMacro`. An `abstract aggregate` base is skipped by the leaf (it owns no table/routes — only its concrete `extends` subtypes get pages).

Unfold is **one level only** — `scaffold(subdomains: [Sales])` does not flatten to pages; it reveals the next composer down plus the singleton pages emitted directly. Drill into a single `scaffoldAggregate` to materialise just its three pages as source while leaving the rest of the UI under the macro.

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
    body: Stack(Heading("Welcome", level: 2), Text("…"),
      Stack(Card(Heading("1 aggregate", level: 4), Text("…"))), testid: "home")
    menu { hidden: true }
  }
}
```
::: end

Generating the full system materialises the leaf pages — a Home plus per-aggregate `list` / `new` / `detail`:

::: tabs frontend
== react
```
web_app/src/pages/home.tsx
web_app/src/pages/orders/list.tsx     ← useAllOrders(), Table, "New order" button
web_app/src/pages/orders/new.tsx
web_app/src/pages/orders/detail.tsx
```
```tsx
// pages/orders/list.tsx (excerpt) — the List page binds the aggregate's findAll hook
export default function OrderList() {
  const orderAll = useAllOrders();
  return (
    <Stack data-testid="orders-list">
      {/* breadcrumbs, title, "New order" → navigate("/orders/new") */}
      {/* loading skeletons, error alert, empty state, then a <Table> of rows */}
    </Stack>
  );
}
```
::: end

The synthesised pages carry their **full** walker-stdlib body (not a placeholder), so `unfold` ejects real, editable `.ddd`. A page's *kind* is derived on demand from its role-scoped name + area — there is no stamped `origin`. Override-by-name lets you replace any scaffolded page (Home included) by writing one with the same name explicitly. See the [UI pages](15-ui-pages-structure.md) for the page DSL the scaffolds emit.

## Audit — the built-in `capability auditable`

> **Not a macro.** `audit` / `auditable` no longer exist as `with` macros. Audit ships as the built-in `capability auditable` — apply it via the capability surface (`implements "auditable"`), not a `with` clause.

The capability adds the four canonical fields (`createdAt`, `updatedAt`, `createdBy: User id`, `updatedBy: User id`, all `managed`) and the context-level `onCreate` / `onUpdate` stamping rules (`createdAt := now()`, `createdBy := currentUser`, etc.). Fields + the `implements` opt-in are per-aggregate; the stamp rules are a context-level concern, so they live in the capability, not on each aggregate. See [Capabilities](11-capabilities-filters-stamps.md).

## Authoring a macro (`defineMacro`)

A macro is a TypeScript module that default-exports a `defineMacro({ … })` call. It declares a `name`, a `target` host kind, optional typed `params`, and an `expand({ target, args, invokeMacro })` function returning the AST fragments to splice in. The host AST node is `target`; inspect it (its field list, members) and return members built **only** from the factories in [`src/macros/api/`](../../src/macros/api/) — those tag each node with origin metadata so validator diagnostics on synthesised members resolve back to the user's `with` clause.

```ts
// the shape every stdlib + project-local macro follows
export default defineMacro({
  name: "crudish",
  target: "aggregate",                       // "aggregate" | "context" | "ui"
  params: { updateOnly: { kind: "bool", default: false } },
  expand({ target, args }) {
    const fields = writableUpdateFields(target).filter((f) => f.type != null);
    const params = fields.map((f) => param(f.name, cloneType(f.type)));
    const body = fields.map((f) => assignStmt(f.name, nameRef(f.name)));
    return [operation("update", params, body), /* … */];
  },
});
```

The API exposes typed AST factories (`operation`, `param`, `primType`, `boolLit`, `assignStmt`, `nameRef`, …) and host-inspection helpers (`writableUpdateFields`, `writableCreateFields`, `aggregatesIn`, `viewsIn`, `workflowsIn`). A context- or ui-level macro fans work outward with `invokeMacro(childName, { target })` — the composition pattern `scaffold` and `softDeleteByDefault` use. Inside-out invocation (an aggregate macro reaching up to a context) is forbidden by the expander's splice-time descendant check.

> **Honest gap — project-local discovery.** The `defineMacro` surface and the registry are built for project-local `.loom/macros/*.ts` modules (the registry doc-comment describes the intended `.ts → .js → load` path), but `bootMacros` currently only loads the **stdlib** — there is no wired filesystem-discovery loader for `.loom/macros/` in the CLI/LSP boot path today. A new macro must be registered in code (`registerMacro` / the stdlib barrel). Treat custom-macro authoring as the stdlib-extension path, not a drop-in plugin directory, until discovery lands.

## `unfold` — eject the expanded source

`unfold` rewrites a `with X(...)` clause into its expanded `.ddd` in place, proving macros are demonstrably sugar. It is reachable as the LSP code action (VS Code "Unfold macro 'X'") and as the transport-neutral toolkit call `unfoldMacro(source, macro, on)` ([`src/api/refactor.ts`](../../src/api/refactor.ts), exposed as the `loom_unfold_macro` agent tool) — it **returns** edits, it does not apply them. There is no dedicated `ddd unfold` CLI subcommand.

It is **one level only**: a composer's `invokeMacro(child, { target })` calls are *not* executed — each becomes a `with <child>(...)` clause on its target (the explicit fan-out you saw under `scaffold` and `softDeleteByDefault`), and you drill further by unfolding those children. The macro's directly-returned nodes are printed through the structural printer ([`src/language/print/`](../../src/language/print/)) and inserted before the host's closing `}`, and the host's `with` clause is rewritten atomically (the unfolded call removed, any new `with child` entries spliced in, the whole clause stripped if it ends up empty). The printer's round-trip guarantee means unfolded output re-parses to a working program.

```ddd
// before — cursor on `crudish`, run "Unfold macro 'crudish'"
aggregate Product with crudish { name: string; price: decimal }
```
↓
```ddd
// after — the with clause is gone, the operations are now plain source
aggregate Product {
  name: string
  price: decimal
  operation update(name: string, price: decimal) { name := name; price := price }
  create(name: string, price: decimal) { name := name; price := price }
  destroy {}
}
```

## Cross-references

- [Capabilities](11-capabilities-filters-stamps.md) — the `filter` / `stamp` / `implements` surface the built-in `auditable` / `softDeletable` capabilities and the `softDelete` macro build on.
- [UI pages](15-ui-pages-structure.md) — the page DSL the scaffold macros emit.
- [`../language.md`](../language.md) — the `with` clause grammar and access modifiers `crudish` consults.
- [`../scaffold-macros.md`](../scaffold-macros.md) — the authoritative stdlib reference.
- [`../technical.md`](../technical.md) — phase ② macro expansion relative to scope/link and lowering.
