# Macros — `scaffold`, `crudish`, `softDelete`

Macros are compile-time `with <name>(...)` clauses that splice
declarations into the host AST before lowering.  They expand to
ordinary DSL constructs you could have written by hand — every macro
documents its **source-equivalent**.

The stdlib ships three families:

- **Scaffolding** — `scaffold`, `scaffoldSubdomain`, `scaffoldContext`,
  `scaffoldAggregate`, `scaffoldWorkflow`.
  Synthesise UI pages from a domain.
- **CRUDish** — `crudish`.  Adds a generated `create(...)` factory,
  `update(...)` operation, and `destroy {}` terminator to an aggregate.
- **Cross-cutting capabilities** — `softDelete` /
  `softDeleteByDefault`.  Add soft-delete behaviour via
  the [capability surface](capabilities.md).  (Audit is no longer a
  macro — it ships as the builtin `capability auditable`; see below.)

Macros are applied with `with <macro>(<args>)` on the host
declaration:

```ddd
aggregate Order with crudish {
  subject: string
  implements "auditable"               // builtin capability, not a macro
}

context Sales with softDeleteByDefault {
  aggregate Order { subject: string }
}

ui WebApp {
  with scaffold(subdomains: [Sales])
}
```

The full grammar of `with` is in [`language.md`](language.md).
The expansion happens in AST phase ② (see
[`technical.md`](technical.md)); the macros' implementations live
under `src/macros/stdlib/`.

## `scaffold` family

The scaffold family synthesises pages for one or more domain elements.
It's composable end-to-end: the top-level `scaffold` fans out to
per-element composers, which fan out to leaf macros.

| Macro | Target | What it emits |
|---|---|---|
| `scaffold(subdomains:, contexts:, aggregates:, workflows:)` | `ui` | Home / Workflows-index singletons + invokes the composers below. |
| `scaffoldSubdomain(of: S)` | `ui` | One `scaffoldContext` per context in subdomain `S`. |
| `scaffoldContext(of: C)` | `ui` | One `scaffoldAggregate` / `scaffoldWorkflow` per member of context `C`. |
| `scaffoldAggregate(of: Agg)` | `ui` | A List page, a New (create-form) page, and a Detail page for `Agg`. |
| `scaffoldWorkflow(of: W)` | `ui` | A Form page for workflow `W`. |

| `scaffoldDashboard` | `context` | One singleton query-time `projection` per aggregate — a row count plus a sum per numeric/money field, aggregated in SQL. |

`scaffoldAggregate` and `scaffoldWorkflow` are the
**leaves** — they don't invoke other macros.  Everything else is a
composer that delegates via `invokeMacro`.

### `scaffoldDashboard` — KPIs computed by the database

```ddd
context Orders with scaffoldDashboard {
  aggregate Order { code: string  total: money  lineCount: int  … }
}
```
```ddd
// Orders gains
projection OrderTotals {
  rowCount: int   totalSum: money   lineCountSum: int
  from Order as o
  select rowCount = count(), totalSum = sum(o.total), lineCountSum = sum(o.lineCount)
}
```

A `ui` carrying `scaffold(...)` over the same context then grows its `Home`
page a row of `Stat` tiles bound to that projection — a money tile through
`Money`, since a `money` is a decimal.js `Decimal` client-side.

**Why a projection rather than a count in the page.** `.all` is paged by
default, so counting rows in the browser counts *one page*; and the aggregation
belongs in the database anyway — this emits one `SELECT` with
`COUNT(*)`/`SUM(...)` and materialises no rows.

**Why two macros.** A macro attaches to exactly one host, so the projection
(`context`) and the page (`ui`) can't come from one — the same split as
`scaffoldPaged` / `scaffoldPagedApi`. Both halves derive the projection name in
`_dashboard-shared.ts`, so a tile can't bind a projection the other didn't emit.

Notes:

- **One projection per aggregate**, not per context: a query-time projection has
  a single `from` source.
- **A hand-written `<Agg>Totals` wins** — the macro skips a name the context
  already declares, and the ui side binds whatever fields that projection
  declares. So the dashboard works without the macro too.
- **Nullable columns are excluded.** SQL `SUM` skips NULLs, so the tile would
  describe a different row set than the `rowCount` beside it.
- **The source has to have columns.** Every tile is a direct-table aggregation
  computed in SQL, so it can only name real columns
  (`loom.projection-columnless-source`). Three aggregate shapes get **no
  dashboard at all**: an `abstract` base and a `persistedAs: eventLog`
  aggregate (neither has a state table, so not even `COUNT(*)` has anything to
  count), and a `shape: document` aggregate. The document case is the
  interesting one — its table *is* `(id, data, version)`, so a bare `rowCount`
  tile is a real query on four of the five backends, and the macro used to keep
  exactly that tile. It no longer does, because that lone tile costs more than
  it is worth:
  - the moment the aggregate carries a read-filtering capability
    (`tenantOwned`, `softDeletable`, any `filter`) the tile is refused by
    `loom.projection-document-source-capability-filtered` — the filter
    predicates name `tenant_id` / `is_deleted`, which the triple has not — and
    before that gate existed it was a **silent cross-tenant count** on .NET/EF,
    which registers no `HasQueryFilter` for a document aggregate;
  - on `platform: java` it is refused by
    `loom.projection-whole-table-aggregation-unsupported` (its JPQL needs
    a JPA entity a document aggregate never gets).

  A scaffold whose default output fails `ddd parse` is worse than one tile
  short, so the skip lives in the macro. A row count over a document aggregate
  is still writable **by hand** on the four backends that emit it. Both halves
  read the same predicate in `_dashboard-shared.ts` (`hasDashboardTable`, which
  folds in `fieldsAreColumns`), so a tile can't survive a projection the macro
  skipped. (Header-visible only — a dataSource binding can override `shape:` at
  the system level, which the macro can't see; that case is caught by the IR
  gate.)
- Additive: a system that doesn't opt in keeps its welcome page unchanged.

### Composability

Unfolding one level on `with scaffold(subdomains: [Sales])` reveals one
`with scaffoldSubdomain(of: Sales)` per supplied subdomain.  Unfolding *that*
reveals per-context composers, then per-aggregate / workflow
leaves.  Users can drill into a single aggregate's scaffold without
flattening the whole UI.

The leaves all delegate page-shape decisions to `pagesForAggregate`
/ `pageForWorkflow` in `src/macros/stdlib/scaffold/_pages.ts`
— so all the macros agree on what a "list page" looks like.

### Overriding a scaffolded page

You don't have to choose between "scaffold everything" and "hand-write
everything".  A page you write **explicitly** replaces the scaffolded
one of the same name, and every sibling stays scaffolded — the scaffold
grows a hole exactly where you want custom UI.

Scaffolded pages live under a per-aggregate `area <Plural>` at the
role-scoped names `List` / `New` / `Detail`.  To override one, open the
matching `area` next to the `with scaffold(...)` clause and write the
page there:

```ddd
ui WebApp with scaffold(subdomains: [Core]) {
  area Tasks {
    page Detail(id: Task id) {
      route: "/tasks/:id"
      title: "Custom task"
      body: Stack {
        Heading { "My bespoke task console", level: 1 },
        testid: "custom-detail"
      }
    }
  }
}
```

One `generate system` later, `pages/tasks/detail.tsx` is *your* page,
`list.tsx` / `new.tsx` are the untouched scaffold, and the router wires
`/tasks/:id` to the custom component exactly once:

```tsx
// pages/tasks/detail.tsx — the explicit page wins
export default function TaskDetail() {
  return (
    <Stack data-testid="custom-detail">
      <Title order={1}>My bespoke task console</Title>
    </Stack>
  );
}
```

The mechanism is scope-local override-by-name in the macro splicer
(`mergeScopedMembers`, `src/macros/expander.ts`): a synthesised member
whose name collides with one already present at that scope is dropped,
and same-named `area` blocks merge recursively.  The singleton dashboard
pages (`Home`, the workflows index) override the same way — write
your own `page Home { … }` and the scaffolded one steps aside.

**Override vs. unfold.**  Override-by-name *replaces* a page wholesale
without seeing its generated body — reach for it when you're writing
something bespoke anyway.  [Unfolding](#composability) instead
materialises the scaffolded body as real `.ddd` source so you can *edit*
it — reach for it when the default is 90% right and you want to tweak,
not rewrite.  Both rungs, and where they sit on the path from all-scaffold
to all-custom, are walked in
[`customization-gradient.md`](customization-gradient.md).

## `crudish`

`with crudish` on an aggregate adds a generated `create(...)` factory,
an `update(...)` operation, and a `destroy {}` destructor — each with
one parameter per writable user field, and a body that assigns each
parameter to the matching field.

```ddd
aggregate Order with crudish {
  subject: string
  total: decimal
}
```

Source-equivalent:

```ddd
aggregate Order {
  subject: string
  total: decimal

  create(subject: string, total: decimal) {
    subject := subject
    total := total
  }

  operation update(subject: string, total: decimal) {
    subject := subject
    total := total
  }

  destroy {}
}
```

These surface on a backend as the `POST` (create), `POST /{id}/update`,
and `DELETE` routes — alongside the `GET /{id}` and `findAll` the
repository always emits.  A `repository` without `crudish` gets only
the read side (`getById` + `findAll`); `crudish` is what adds the
write side.

Which fields become parameters is decided per-surface (see the access
modifier matrix in [`language.md`](language.md)):

- `managed` / `token` / `internal` are dropped from both — they're not
  client-supplied.
- `immutable` is **kept by `create`** (settable once, at creation) but
  **dropped from `update`**.
- `secret` **stays on both** — write-only fields still belong in the
  create/update input.
- Fields contributed by another capability or macro (`createdAt` from
  `auditable`, `isDeleted` from `softDeletable`, …) are excluded
  regardless of access modifier.

Pass `with crudish(updateOnly: true)` to emit only `update` — no
canonical `create`/`destroy`.  Use it when another macro owns the
create/delete lifecycle, e.g. `with crudish(updateOnly: true),
softDeletable` leaves the soft-delete terminator uncontested.

## Audit — now the builtin `capability auditable`

> **Removed as macros.** `audit` / `auditable` / `auditedByDefault`
> no longer exist as macros.  Audit ships as the **builtin
> `capability auditable`** declared in `src/macros/prelude.ts` — apply
> it directly via the capability surface (`implements "auditable"` +
> the prelude's `filter` / `stamp` rules) rather than a `with`
> clause.  See [`capabilities.md`](capabilities.md).

The capability adds the four canonical audit fields (`createdAt`,
`updatedAt`, `createdBy: User id`, `updatedBy: User id`) and the
context-level stamping rules:

```ddd
context Sales {
  stamp for "auditable" onCreate {
    createdAt := now()
    createdBy := currentUser
  }
  stamp for "auditable" onUpdate {
    updatedAt := now()
    updatedBy := currentUser
  }

  aggregate Order {
    subject: string
    createdAt: datetime
    updatedAt: datetime
    createdBy: User id
    updatedBy: User id
    implements "auditable"
  }
}
```

Why keep fields and stamps separate?  The stamping rules are a
*context-level* concern — they assign the same fields the same way
for every audited aggregate — while the field declarations and the
`implements "auditable"` opt-in are *per-aggregate*.  See
[`capabilities.md`](capabilities.md) for the underlying surface.

## `softDelete` / `softDeleteByDefault`

Capability group: `"softDeletable"`.  The **state + filter** ship as
the builtin `capability softDeletable` (`isDeleted` + `deletedAt?` +
`filter !this.isDeleted`, co-located in `src/macros/prelude.ts`); the
`softDelete` **macro** adds only the two **operations**.  A capability
is a pure mixin, so compose them: `with softDeletable, softDelete`.

| Macro / capability | Target | What it adds |
|---|---|---|
| `softDeletable` (builtin **capability**) | aggregate | `isDeleted: bool`, `deletedAt: datetime?`, and the `!this.isDeleted` read filter. **No operations.** |
| `softDelete` (**macro**) | aggregate | The `softDelete()` and `restore()` mutations. **No state/filter** — pair it with the capability. |
| `softDeleteByDefault` (**macro**) | context | Invokes `softDelete` on every child aggregate. |

The filter is a *context-level* concern carried by the builtin
capability; the operations are *per-aggregate* (added by `softDelete`).

### Source-equivalent

```ddd
context Sales {
  aggregate Order with softDeletable, softDelete { subject: string }
  aggregate Public { name: string }            // not soft-deletable
}
```

↓

```ddd
context Sales {
  // filter for "softDeletable" !this.isDeleted  — carried by the builtin capability

  aggregate Order {
    subject: string
    isDeleted: bool
    deletedAt: datetime?

    operation softDelete() {
      this.isDeleted := true
      this.deletedAt := now()
    }
    operation restore() {
      this.isDeleted := false
      this.deletedAt := null
    }

    implements "softDeletable"
  }

  aggregate Public { name: string }
}
```

`Public` does not `implements "softDeletable"` and therefore the
capability-scoped filter doesn't apply — reads of `Public` are
unfiltered.

## Authoring a macro

Macros are TS modules under `src/macros/stdlib/<name>/` that default-export
a `defineMacro({...})` call.  Each macro declares:

```ts
defineMacro({
  name: "<macro-name>",
  target: "ui" | "context" | "aggregate" | …,
  apiVersion: 1,
  description: "<one-line>",
  expand({ target, args, invokeMacro, /* helpers */ }) {
    // Inspect `target` (the host AST node) and return AST fragments
    // to splice in.  Use `invokeMacro` to delegate to other macros.
  },
});
```

The `macro-api` (`src/macros/api/`) exposes typed AST factory helpers
(`operation`, `param`, `primType`, `boolLit`, `callExpr`, …) and
inspection utilities (`writableUpdateFields`,
`workflowsIn`, `aggregatesIn`).  Anything you can write by hand in
`.ddd` source, a macro can produce.

## What unfold writes back

Unfold prints the expanded AST through `src/language/print/`, so the text
that lands in the user's file is held to the same shape as hand-written
`.ddd`:

- **2-space indentation throughout**, including nested statement blocks
  (`for` / `if let` / `match`) and lambda block bodies
  (`onClick: e => { … }`) — each is indented as a block, not by a
  first-line prefix.
- **No line past 100 columns.**  The wrap budget is measured at the column
  the text will actually occupy: `print-expr.ts` tracks an ambient print
  column (`withIndent` / `atColumn`), and the code action seeds it with the
  indent the splice adds.
- **Blank lines between declarations, tight field runs.**  A member is
  separated from its neighbour when either spans multiple lines
  (`joinDecls`), and only declaration *containers* opt in — so a page's
  `route:`/`body:` props and an aggregate's field list stay glued.
- **No trailing whitespace**, including when unfolding into an empty
  `{ }` body.

These are gated by `test/language/print/print-block-layout.test.ts` (printer
shape) and `test/macro/unfold-layout.test.ts` (the code action's output, over
every offered unfold).  A macro that produces a construct the printer renders
badly is a printer bug — fix it there, not in the macro.

## Cross-references

- [`capabilities.md`](capabilities.md) — the `filter` / `stamp` /
  `implements` surface the builtin `auditable` capability and the
  `softDelete` macro target.
- [`page-metamodel.md`](page-metamodel.md) — the page DSL the
  scaffold macros emit.
- [`language.md`](language.md) — the `with <macro>(...)` clause and
  access modifiers consulted by `crudish`.
- [`technical.md`](technical.md) — phase ② macro expansion and how
  it sits relative to scope/link and lowering.
