# Macro authoring API

Macros are compile-time `with <name>(...)` clauses that splice
declarations into the host AST before lowering.  Every shipped stdlib
macro (see [`scaffold-macros.md`](scaffold-macros.md)) is written
against this API; future project-local macros will use the same
surface.

This doc is the **authoring reference** — what types and helpers the
API exposes.  For each macro's source-equivalent and intent, see
`scaffold-macros.md`.

## Where macros live

| Source | Discovery |
|---|---|
| **Stdlib** | `src/macros/stdlib/<name>/*.macro.ts`. Registered once at toolchain boot by `loadStdlibMacros()` in `src/macros/stdlib/index.ts`. |
| **Project-local** | The registry (`src/macros/registry.ts`) accepts user-supplied `MacroDefinition`s via `registerMacro(...)`.  A workspace-level auto-discovery seam under `.loom/macros/*.js` is documented in the registry's header comment but **not yet wired** to the CLI / LSP boot path — today the only way to add a macro is to drop it into `src/macros/stdlib/` and rebuild the toolchain. |

The shape of a macro module is the same in both cases.  Each macro
file default-exports a single `defineMacro({ ... })` call.

## The entry point

```ts
import { defineMacro } from "../../api/index.js";

export default defineMacro({
  name: "<macro-name>",
  target: "aggregate" | "ui" | "context",
  apiVersion: 1,
  description: "<one-line>",
  params: { /* declared parameters, see below */ },
  expand(ctx) {
    // Inspect ctx.target, build AST fragments via factories,
    // return them. The expander splices them into the host's
    // members[] array.
  },
});
```

`defineMacro` is an identity function — its only role is to infer
the `ExpandContext` type so `ctx.args` is typed against the declared
`params`.

## `target` — which host the macro attaches to

The three host kinds:

| Target | Host AST node | What the macro returns |
|---|---|---|
| `"aggregate"` | `Aggregate` | `AggregateMember[]` — properties, operations, invariants, capability declarations. |
| `"context"` | `BoundedContext` | `ContextMember[]` — aggregates, repositories, workflows, views, capability declarations, value objects, enums. |
| `"ui"` | `Ui` | `UiMember[]` — pages, components, menu blocks, helper imports, api parameters. |

The expander rejects a macro applied at the wrong target with a
validator error pointing at the `with` clause.

## `params` — typed parameter declarations

```ts
params: {
  modules:    { kind: "refList", of: "Module" },
  contexts:   { kind: "refList", of: "BoundedContext", default: [] },
  prefix:     { kind: "string", default: "" },
  audited:    { kind: "bool", default: true },
}
```

Each value is a `ParamType`:

| `kind` | Runtime type in `ctx.args` | Notes |
|---|---|---|
| `"string"` | `string` | Optional `default`. |
| `"bool"` | `boolean` | Optional `default`. |
| `"int"` | `number` | Optional `default`. |
| `"ref"` | the AST node it points at | `of:` is the declared kind. Add `optional: true` to allow it to be missing. |
| `"refList"` | `readonly Node[]` | Defaults to `[]` when omitted. |

`ref` / `refList`'s `of:` selects the AST kind the validator will
cross-reference the argument against.  Accepted values:

```
Aggregate | Module | BoundedContext | Workflow | View | ValueObject | EnumDecl
```

A user-typed `with myMacro(target: NonExistent)` errors at parse
time with the same "no such X" diagnostic any other reference would.

## `expand(ctx)` — the body

```ts
expand({ target, args, origin, invokeMacro }): MemberTypeOf[T][]
```

| Field | Meaning |
|---|---|
| `target` | The host AST node (typed against `MacroTarget`). |
| `args` | Parsed, type-checked, default-filled argument bag. |
| `origin` | Opaque tag attached to every synthesised member by the factories so diagnostics on synthesised code can point back at the `with` call site. |
| `invokeMacro(name, { target, args? })` | Programmatic invocation of another registered macro.  Used by composer macros (`scaffoldContext` calls `scaffoldAggregate`; `softDeleteByDefault` calls `softDelete` per aggregate).  The returned nodes are tagged with the passed target, not the caller's host — splice-time descendant checks reject inside-out invocation (an aggregate macro can't call a context macro). |

The returned array's element type is enforced at the TS level:
`target: "aggregate"` requires `AggregateMember[]`, `"ui"` requires
`UiMember[]`, etc.

## Factory functions

AST construction must go through the factories so synthesised nodes
carry `origin` metadata.  The full surface is `src/macros/api/`:

### `factories.ts` — domain-side AST nodes

| Helper | Builds |
|---|---|
| `field(name, type, opts?)` | A `Property` with optional `provenanced`, `access` modifier. |
| `operation(name, params, body, opts?)` | A public domain operation. |
| `param(name, type)` | A `Parameter` for an operation. |
| `primType(kind)` | A primitive `TypeRef` (`"string"`, `"int"`, `"datetime"`, …). |
| `namedType(name)` | A type reference by name (enum / value-object / aggregate-id). |
| `thisRef()` | The expression `this`. |
| `idRef(name)` | An identifier expression. |
| `nameRef(name)` | A bare name reference (for `magic` identifiers like `currentUser`). |
| `memberAccess(receiver, member, opts?)` | A `recv.member` expression; pass `call: true` for `recv.member()` calls. |
| `not(expr)` | The expression `!e`. |
| `nullLit()` | The literal `null`. |
| `assignStmt(target, value)` | `target := value` (target is a single identifier). |
| `assignStmtPath(path, value)` | `path := value` for a path expression. |
| `contextFilter(expr, opts?)` | A context-scope `filter` declaration; `opts.capability` adds the `for "<name>"` qualifier. |
| `contextStamp(event, assignments, opts?)` | A context-scope `stamp` declaration; same `opts.capability` rule. |
| `implementsCapability(name)` | An `implements "<name>"` declaration. |

### `ui-factories.ts` — UI-side AST nodes

| Helper | Builds |
|---|---|
| `page(name, props)` | A `Page` declaration. |
| `routeProp(s)` / `bodyProp(expr)` / `pageMenuMeta(entries)` | Props inside a page. |
| `callExpr(target, args)` | A call expression — used to invoke builtin primitives like `Stack(...)`, `Heading(...)`. |
| `stringLit(s)` / `boolLit(b)` | Literal expressions. |
| `nameRefExpr(name)` | A bare-name reference expression. |

### Inspection helpers

| Helper | Returns |
|---|---|
| `targetFields(agg)` | Plain `Property[]` on the aggregate (excludes containments, derived, operations, entity parts, tests). |
| `writableUpdateFields(agg)` | Subset of `targetFields` suitable for `update(...)` operation parameters — applies the access-modifier matrix (excludes `immutable` / `managed` / `token` / `internal`; keeps `secret`).  See [`language.md`](language.md#field-access-modifiers). |
| `writableCreateFields(agg)` | Subset suitable for `create(...)` — keeps `immutable`, excludes `managed` / `token` / `internal`. |
| `aggregatesIn(ctx)` | All aggregates in a bounded context. |
| `viewsIn(ctx)` | All views in a bounded context. |
| `workflowsIn(ctx)` | All workflows in a bounded context. |
| `originOf(node)` | The `OriginToken` for a synthesised node (or `undefined` for user-written code).  Used by composer macros to filter out macro-synthesised fields when scanning the host. |

## When macros run

Macro expansion is **AST phase ②**, between parse and scope/link
(see [`technical.md`](technical.md)).  Implications:

- Macros see the **raw AST**, before name resolution or type
  inference.  References inside a `with X(...)` arg are
  resolved by the validator *before* expansion via the param
  kind (`ref`/`refList`), so `target` and `args` are already
  pointing at concrete AST nodes.
- Synthesised members participate in scope computation, so other
  declarations can reference them by name.
- Macros do NOT see IR.  A macro that needs to know an aggregate's
  fields inspects `target.members` (AST), not `AggregateIR.fields`.
  Use the inspection helpers (`targetFields`, etc.) for this.

## Composability

Composer macros call leaf macros via `invokeMacro`.  The rule is
**outside-in only**:

- A `context` macro can call an `aggregate` macro against each
  child aggregate (`softDeleteByDefault` calls `softDelete`
  per aggregate).
- A `ui` macro can call other `ui` macros (`scaffold` calls
  `scaffoldSubdomain`).
- An `aggregate` macro **cannot** call a `context` macro — the
  expander's splice-time descendant check rejects it.

The factories tag each returned node with the **invocation's** target,
not the caller's.  So when `softDeleteByDefault` runs at context
scope and calls `softDelete` against a child aggregate, the
returned `AggregateMember[]` is spliced into that aggregate, not the
context.

## Worked example

A trivial trait macro that adds a `tag: string` field to every host
aggregate:

```ts
import {
  defineMacro,
  field,
  primType,
} from "../../api/index.js";

export default defineMacro({
  name: "tagged",
  target: "aggregate",
  apiVersion: 1,
  description: "Adds a `tag: string` field to the host aggregate.",
  expand({ target }) {
    if (target.members.some(m => m.$type === "Property" && m.name === "tag")) {
      return []; // idempotent — don't double-add
    }
    return [field("tag", primType("string"))];
  },
});
```

Usage:

```ddd
aggregate Order with tagged {
  total: int
}
```

…lowers to:

```ddd
aggregate Order {
  total: int
  tag: string                          // <- spliced by `tagged`
}
```

## Cross-references

- [`scaffold-macros.md`](scaffold-macros.md) — the stdlib macros
  this API ships.  Read those for examples of every helper in use.
- [`capabilities.md`](capabilities.md) — the `filter` / `stamp` /
  `implements` surface that `contextFilter` / `contextStamp` /
  `implementsCapability` factories emit.
- [`technical.md`](technical.md) — phase ② macro expansion in the
  compiler pipeline.
- [`language.md`](language.md) — the `with <macro>(...)` clause
  surface (where macros are invoked).
