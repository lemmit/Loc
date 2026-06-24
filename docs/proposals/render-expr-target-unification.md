# Proposal — `ExprTarget`: unify the per-backend expression renderers

> Status: **SHIPPED.** The `ExprTarget` contract + shared
> `renderExprWith(e, target, ctx)` dispatcher landed in
> `src/generator/_expr/target.ts`; all three backends
> (`typescript`/`dotnet`/`phoenix-live-view` `render-expr.ts`) are now
> leaf-only target tables delegating to it. Brought **forward of A4**
> rather than ridden on it (the original sequencing below): extracting
> the contract first means A4 authors its new `?`-propagation / or-union
> arms once behind `ExprTarget` instead of re-threading three
> dispatchers. Byte-identical-output gated — verified by regenerating
> every `examples/*.ddd` across all backends (1221 domain-logic files,
> sha256 before == after) plus the full fast suite. The original
> proposal text (pinned to ride A4) is retained below for context; §5.1
> of [`../plans/type-system-feature-migration.md`](../plans/type-system-feature-migration.md)
> no longer gates it.

## 1. Problem

The three domain-logic backends each carry a hand-written IR-expression
renderer:

| Backend | File | Lines | Entry point |
|---|---|---|---|
| TypeScript / Hono | `src/generator/typescript/render-expr.ts` | 379 | `renderTsExpr(e, ctx)` |
| .NET / C# | `src/generator/dotnet/render-expr.ts` | 467 | `renderCsExpr(e, ctx)` |
| Phoenix / Elixir | `src/generator/phoenix-live-view/render-expr.ts` | 547 | `renderExpr(e, ctx)` |

All three dispatch over the **same 17 `ExprIR.kind` arms** (`literal`,
`this`, `id`, `ref`, `member`, `method-call`, `call`, `lambda`, `new`,
`object`, `paren`, `unary`, `binary`, `ternary`, `convert`, `match`,
`list`) with **structurally identical recursion**: every sub-dispatcher
(`renderBinary`, `renderMember`, `renderMethodCall`, `renderCall`,
`renderRef`, `renderCollectionOp`) has the same control-flow shape in
each backend, with the same special-case checks in the same order. They
diverge **only at the leaf** — operator strings, naming convention,
language idiom.

Concretely, the divergence axes are small and enumerable:

1. **Operators** — `===`/`!==` (TS) vs `==`/`!=` (C#/Elixir); string
   concat `+` vs `<>`; `%` → `rem(...)` (Elixir).
2. **Naming** — `lowerFirst`/`upperFirst` (TS/C#) vs `snake` everywhere
   (Elixir); TS alone distinguishes private fields (`this._field` for
   `this-prop`).
3. **Money arithmetic** — `Decimal.js` method calls (TS) vs native
   `decimal` operators (C#, no special case) vs `Decimal.add/sub/...`
   module funcs (Elixir).
4. **Collection ops** — `Array` methods (TS) vs LINQ (C#) vs `Enum.*`
   (Elixir); identical 8-case dispatch (`count`/`sum`/`all`/`any`/
   `contains`/`where`/`first`/`firstOrNull`/default).
5. **`refColl.contains(x)` membership** — omitted in TS (falls through to
   the in-memory collection op), LINQ join-table `.Any(...)` in C#, an Ecto
   join/subquery membership check in Elixir.
6. **Regex** (`str.matches(p)`) — `/p/.test()` (TS) vs `Regex.IsMatch`
   (C#) vs `Regex.match?(~r/p/, ...)` (Elixir).
7. **`ref` semantics** — TS keeps `this-prop`/`this-vo-prop`/
   `this-derived` as three arms (private vs public); C#/Elixir collapse
   them into one (no private-field boundary at the render layer).
8. **`call` by `callKind`** — same 4–5-arm switch; value-object-ctor is
   `new Foo(...)` (TS/C#) vs a named-field struct literal
   `%Mod.Foo{...}` (Elixir); free functions take an injected `this`
   first-arg on Elixir.

This is the same shape of triplication the **body-walker** had before the
`WalkerTarget` extraction (`src/generator/_walker/target.ts`, PRs
#607–#627): one shared traversal, a handful of framework-shaped seams
pulled behind a contract. `ExprTarget` is that pattern applied to
`render-expr`.

The one **pure, backend-independent** slice of this surface —
`refCollectionFieldName`, which was copied verbatim into all three —
already landed in `src/ir/util/ref-collection.ts` (#793) as the single
extraction that did **not** need to wait for A4. Everything remaining is
leaf-emission, which is what `ExprTarget` parameterises.

## 2. Non-goals

- **Not a new IR.** `ExprTarget` consumes `ExprIR` exactly as the three
  renderers do today. No re-resolution, no target-backend IR (the
  architecture forbids it — `CLAUDE.md`, "No target-backend IR").
- **Not a Handlebars/template reintroduction.** The shared dispatcher
  stays procedural (`lines(...)` / string building), same as the
  emitters. Targets are TS objects, not templates.
- **Not statement unification (yet).** `render-stmt.ts` is a separate
  (larger, more divergent) surface. A4 rewrites it heavily too; whether
  a `StmtTarget` is worth it is a follow-up question this proposal does
  **not** answer. Scope here is expressions only.
- **Not byte-changing.** The extraction is gated on byte-identical
  output for every existing example × backend (§7) — exactly the gate
  that guarded each `WalkerTarget` seam slice.

## 3. The contract

`ExprTarget` is the per-backend leaf-emission surface; a single shared
`renderExpr(e, ctx, target)` owns the 17-arm dispatch and all recursion.
The contract captures **only** the eight divergence axes from §1.

```ts
// src/generator/_expr/target.ts  (proposed)
import type { BinOp, ExprIR, TypeIR } from "../../ir/types/loom-ir.js";

/** Where a ref resolves, post-lowering. Mirrors ExprIR ref kinds the
 *  renderers switch on. */
export type RefRole =
  | "param" | "let" | "lambda"
  | "this-prop" | "this-vo-prop" | "this-derived"
  | "helper-fn" | "enum-value" | "current-user" | "unknown";

/** Per-backend leaf emission. The shared dispatcher calls these; it
 *  never branches on the backend itself. Every method returns a source
 *  fragment — targets are pure, like the renderers they replace. */
export interface ExprTarget {
  /** Informational discriminator (`"ts"` / `"cs"` / `"elixir"`). */
  readonly lang: string;

  // --- naming -------------------------------------------------------------
  /** Apply the backend's identifier convention. `role` lets a backend
   *  case-split (TS lowercases helper-fns, Elixir snakes everything). */
  ident(name: string, role: RefRole): string;

  // --- refs ---------------------------------------------------------------
  /** Render a resolved `ref`. `thisName` is the receiver in scope
   *  (`"this"` inside the aggregate, the bound var when rendered from
   *  outside). Owns the private-field decision: TS emits `this._x` for
   *  `this-prop`; C#/Elixir emit `<thisName>.X` / `<thisName>.x`. */
  renderRef(name: string, role: RefRole, thisName: string, enumName?: string): string;

  // --- operators ----------------------------------------------------------
  /** Binary operator emission for the non-money, non-special path.
   *  `leftIsString` lets Elixir map `+` → `<>`. Returns the full
   *  `"<l> <op> <r>"` (so `%` → `rem(l, r)` is expressible). */
  renderBinary(op: BinOp, l: string, r: string, leftIsString: boolean): string;

  /** Money-typed binary, when `leftType` is `money`. Return `undefined`
   *  to fall back to `renderBinary` (C#: native `decimal` operators). */
  renderMoneyBinary?(op: BinOp, l: string, r: string): string | undefined;

  // --- member / collection ------------------------------------------------
  /** `recv.<member>` for the generic (non-collection, non-special) case
   *  plus the `.count`/`.length` projections on arrays/strings. */
  renderMember(recv: string, member: string, receiverType: TypeIR): string;

  /** One of the 8 collection ops (`count`/`sum`/`all`/`any`/`contains`/
   *  `where`/`first`/`firstOrNull`) or default passthrough. */
  renderCollectionOp(recv: string, name: string, args: readonly string[]): string;

  /** `str.matches(p)` regex test in the backend's idiom. `patternLit`
   *  is the source string literal when statically known (TS/Elixir can
   *  emit a literal regex), else undefined (use the rendered arg). */
  renderMatches(recv: string, renderedArg: string, patternLit?: string): string;

  // --- calls --------------------------------------------------------------
  /** A resolved `call`, switched on `callKind`. The shared dispatcher
   *  pre-renders args; the target owns ctor syntax (positional `new`
   *  vs named struct literal), the helper-fn receiver convention, and
   *  resource-op module resolution. */
  renderCall(call: ResolvedCall): string;

  // --- ref-collection membership ------------------------------------------
  /** `this.<refColl>.contains(x)` → a join/subquery, or `undefined` to
   *  fall through to `renderCollectionOp` (TS: in-memory `.includes`).
   *  C# emits the LINQ `.Any(...)`; Elixir emits an Ecto join/subquery. */
  renderRefCollectionContains?(assoc: AssociationLowering): string | undefined;
}
```

`ResolvedCall` and `AssociationLowering` are thin structs the shared
dispatcher fills from `ExprIR` + the render context (`callKind`, the
resolved `resourceOp`, the association looked up off `ctx.agg`), so the
target sees pre-resolved data and never re-walks the IR. The detailed
field lists are deferred to the implementation PR (they fall out of the
existing `renderCall` / membership code mechanically).

### What stays inline (the SCOPE DECISION, mirroring `WalkerTarget`)

Following `target.ts`'s own scope discipline, these stay in the shared
dispatcher or in backend-private code rather than bloating the contract:

- **The 17-arm dispatch + all recursion.** Shared. The whole point.
- **`literal` / `paren` / `this` / `id` rendering.** Trivially identical
  modulo literal escaping, which `ident`/a tiny `renderLiteral` covers;
  not worth distinct large arms.
- **`.NET`'s `collectCsExprUsings` import-collection pass.** Backend-
  private; it's a *separate* tree walk for `using` directives, not part
  of expression emission. Stays in `dotnet/`.
- **`object` / `new` / `convert` / `ternary` / `match` / `list`.** These
  are either uniform enough to live in the shared dispatcher with a
  one-line target hook, or (for `convert`/`match` in domain-logic
  position) rare; they get hooks only if the byte-identical gate forces
  one. Start minimal, widen only when a diff demands it.

Adding anything above to `ExprTarget` for zero cross-backend benefit is
exactly the interface bloat `target.ts:39` warns against.

## 4. Worked example — `binary`

The shared dispatcher arm:

```ts
case "binary": {
  const l = renderExpr(e.left, ctx, t);
  const r = renderExpr(e.right, ctx, t);
  const leftType = e.left.type; // already on the IR
  if (leftType?.kind === "primitive" && leftType.name === "money") {
    const money = t.renderMoneyBinary?.(e.op, l, r);
    if (money !== undefined) return money;
  }
  const leftIsString = leftType?.kind === "primitive" && leftType.name === "string";
  return t.renderBinary(e.op, l, r, leftIsString);
}
```

…and the three targets supply only the leaf:

```ts
// tsTarget
renderBinary: (op, l, r) =>
  `${l} ${op === "==" ? "===" : op === "!=" ? "!==" : op} ${r}`,
renderMoneyBinary: (op, l, r) => /* Decimal.js method form */,

// csTarget
renderBinary: (op, l, r) => `${l} ${op} ${r}`,
// no renderMoneyBinary — native decimal

// elixirTarget
renderBinary: (op, l, r, leftIsString) =>
  op === "%" ? `rem(${l}, ${r})` : `${l} ${elixirOp(op, leftIsString)} ${r}`,
renderMoneyBinary: (op, l, r) => /* Decimal.add/... form */,
```

The current per-backend `renderBinary` bodies map onto these one-to-one
— no logic moves, it's relocated behind a stable seam.

## 5. Payoff

- **Adding a fifth domain-logic backend** (the `elixir-ecto` /
  `java-backend` proposals) means writing **one `ExprTarget`** — a table
  of leaf rules — not re-deriving the 17-arm dispatch and its special
  cases (money, collection ops, ref-collection membership, regex) a
  fourth time. That is the same "emitters, not name resolution" payoff
  `CLAUDE.md` cites for the resolved IR, pushed one layer down.
- **One place to fix dispatch bugs.** Today a fix to the `member`-on-
  array projection rule (e.g. a new `.first`-style case) is three edits
  in three files that drift. After: one shared arm.
- **The divergence becomes legible.** The contract *is* the
  documentation of exactly how the backends differ — eight methods, each
  a named axis — instead of being implicit in three parallel files.

## 6. Why this rides A4, not a standalone PR

`exception-less.md` **A4** is the one coordinated PR that re-shapes
`find` returns to `T or NotFound` / `T option` and introduces the `?`
propagation operator. Per §5.1 of the migration plan, A4 **rewrites
`render-stmt` and `render-expr` heavily** — new arms for `?`
propagation, the or-union expression form, and the error-arm short
circuit, all of which the renderers must grow in lockstep across the
three backends.

That makes A4 the **cheap moment** for this extraction and a standalone
PR the **expensive** one:

- Extracting `ExprTarget` *before* A4 means A4 then has to re-thread its
  new arms through the freshly-extracted contract — doing the work
  twice, and rebasing a large mechanical refactor under a moving target.
- Doing it *as part of* A4 means the new `?`/or-union arms are authored
  **once** in the shared dispatcher with three small target hooks, which
  is the steady-state cost anyway.
- The byte-identical gate (§7) composes cleanly with A4's own fixture
  re-baseline (`exception-less.md:830`): extract behind the contract
  with output unchanged *first* (byte-identical), then layer A4's
  semantic change on top (re-baselined deliberately). Two legible steps
  in one PR, not a refactor fighting a feature.

The standalone-safe slice has **already been taken** (#793). The rest
waits — intentionally.

## 7. Extraction strategy (when A4 lands)

Mirror the `WalkerTarget` per-seam discipline (PRs #607–#627):

1. Land `src/generator/_expr/target.ts` (contract) + the shared
   `renderExpr(e, ctx, target)` dispatcher, initially a **mechanical
   copy** of one backend's dispatch with the leaf calls routed through a
   target. Wire `tsTarget` first.
2. Per backend, replace the bespoke renderer with `(e) => renderExpr(e,
   ctx, <lang>Target)`, **one seam at a time**, gating each slice on
   byte-identical output for every `examples/*.ddd` × that backend (the
   capture script + the existing generator fixtures) plus the live build
   gates (`LOOM_TS_BUILD`, `dotnet build /warnaserror`, `mix compile
   --warnings-as-errors`).
3. Only after all three are byte-identical behind the contract does A4's
   semantic re-shape (the `?` arm, the or-union form) get authored — once
   — in the shared dispatcher, with the fixture re-baseline A4 already
   schedules.

## 8. Open questions

- **`ResolvedCall` shape.** How much of the `callKind` resolution (esp.
  `resource-op` module lookup, which reads `ctx.resourceClasses` /
  `ctx.resourceModules`) belongs in the shared dispatcher vs. the
  target? Leaning: dispatcher resolves the module/class name via a
  small context accessor, target owns only the *call syntax*. Settle in
  the PR.
- **`this-prop` private-field divergence.** TS's `this._field` vs
  C#/Elixir's public access is the one place the *ref role* maps to
  different structure, not just naming. Handled inside `renderRef`
  (above) — confirm no other arm needs the private/public distinction.
- **Is a `StmtTarget` the natural sequel?** Out of scope here, but A4
  touches `render-stmt` even more. Worth a sibling proposal *after* this
  one proves the pattern on expressions — explicitly not bundled, to
  keep the A4 diff bounded.
