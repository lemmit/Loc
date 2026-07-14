// UI-side factories — page construction for scaffold-style macros.
//
// Kept separate from `factories.ts` (which builds aggregate members)
// because the surfaces don't overlap: macros that target `aggregate`
// don't construct pages, and ui-targeted macros don't construct
// fields/operations.  Both files share the same origin-tagging
// machinery via `currentOrigin()` from `factories.ts`.

import type {
  Area,
  BinaryChain,
  BodyProp,
  BoolLit,
  CallArg,
  CallSuffix,
  Expression,
  IntLit,
  Lambda,
  MatchArm,
  MatchExpr,
  MenuMetaEntry,
  NameRef,
  NowExpr,
  Page,
  PageMenuMeta,
  PageProp,
  PostfixChain,
  RouteProp,
  StateBlock,
  StateField,
  StringLit,
  TernaryExpr,
  UiMember,
} from "../../language/generated/ast.js";
import {
  mkArea,
  mkBinaryChain,
  mkBodyProp,
  mkBoolLit,
  mkCallArg,
  mkCallSuffix,
  mkIntLit,
  mkLambda,
  mkMatchArm,
  mkMatchExpr,
  mkMenuMetaEntry,
  mkNameRef,
  mkNowExpr,
  mkPage,
  mkPageMenuMeta,
  mkPostfixChain,
  mkPrimitiveType,
  mkRouteProp,
  mkStateBlock,
  mkStateField,
  mkStringLit,
  mkTernaryExpr,
  mkTypeRef,
} from "./_mk.js";
import { _currentOrigin, _setContainer, _tag } from "./factories-internals.js";

// ---------------------------------------------------------------------------
// Atomic expression factories
// ---------------------------------------------------------------------------

/** A string literal expression.  The value is stored without the
 * surrounding quotes (matches the parser's strip-delimiters
 * behavior — see CLAUDE.md's gotcha list and re-quote on emission). */
export function stringLit(value: string): StringLit {
  const origin = _currentOrigin();
  return _tag(mkStringLit({ $type: "StringLit", value }), origin);
}

/** The current-timestamp builtin (`now()`).  The grammar parses `now()`
 * as a dedicated `NowExpr` node, NOT a function call — lowering's
 * `isNowExpr` guard recognises it and emits each backend's clock call
 * (.NET `DateTime.UtcNow`, etc.).  Building it as `callExpr("now", [])`
 * would lower to a generic call and render as a bogus `Now()`. */
export function nowExpr(): NowExpr {
  const origin = _currentOrigin();
  return _tag(mkNowExpr({ $type: "NowExpr" }), origin);
}

/** A boolean literal expression.  The grammar surfaces these as
 * `BoolLit { value: 'true' | 'false' }` (string, not boolean) since
 * the parser doesn't coerce; we pass it through as-is. */
export function boolLit(value: boolean): BoolLit {
  const origin = _currentOrigin();
  return _tag(mkBoolLit({ $type: "BoolLit", value: value ? "true" : "false" }), origin);
}

/** An integer literal expression (`level: 2`).  `IntLit.value` is a
 * number (the parser coerces the `INT` terminal). */
export function intLit(value: number): IntLit {
  const origin = _currentOrigin();
  return _tag(mkIntLit({ $type: "IntLit", value }), origin);
}

/** An expression-bodied lambda: `param => body` (e.g. a `Column`
 * accessor `o => o.name` or a `QueryView` `data:` lambda).  Block-body
 * lambdas (`p => { … }`) aren't needed by the scaffolders, so this only
 * builds the expression form (`stmts` stays empty). */
export function lambda(param: string, body: Expression): Lambda {
  const origin = _currentOrigin();
  const node = _tag(mkLambda({ $type: "Lambda", param, body, stmts: [] }), origin);
  _setContainer(body, node, "body");
  return node;
}

/** A bare name reference, suitable for use in expression positions
 * (e.g. as a body-call argument: `Of(of: Order)` — `Order` here).
 * Same shape as the statement-side `nameRef` in factories.ts but
 * re-exported here so ui-macro authors don't import from two files. */
export function nameRefExpr(name: string): NameRef {
  const origin = _currentOrigin();
  return _tag(mkNameRef({ $type: "NameRef", name }), origin);
}

/** A two-operand binary expression: `left <op> right` (e.g. the
 * `rowTestid` accessor `"orders-row-" + r.id`).  Post grammar-flatten
 * a binary is a `BinaryChain` carrying parallel `ops`/`rest` lists;
 * the scaffolders only need the single-operator form. */
export function binaryExpr(
  head: Expression,
  op: BinaryChain["ops"][number],
  rest: Expression,
): BinaryChain {
  const origin = _currentOrigin();
  const node = _tag(mkBinaryChain({ $type: "BinaryChain", head, ops: [op], rest: [rest] }), origin);
  _setContainer(head, node, "head");
  _setContainer(rest, node, "rest", 0);
  return node;
}

/** A ternary expression: `cond ? thenExpr : elseExpr` (e.g. a bool
 * cell renderer `o.active ? "Yes" : "No"`). */
export function ternaryExpr(
  cond: Expression,
  thenExpr: Expression,
  elseExpr: Expression,
): TernaryExpr {
  const origin = _currentOrigin();
  const node = _tag(mkTernaryExpr({ $type: "TernaryExpr", cond, thenExpr, elseExpr }), origin);
  _setContainer(cond, node, "cond");
  _setContainer(thenExpr, node, "thenExpr");
  _setContainer(elseExpr, node, "elseExpr");
  return node;
}

/** A predicate-arms `match { cond => value, … else => elseExpr }` expression
 * (e.g. the scaffolded list's filter switch).  Each arm's first matching
 * `cond` wins; `elseExpr` is the fallthrough. */
export function matchExpr(
  arms: Array<{ cond: Expression; value: Expression }>,
  elseExpr?: Expression,
): MatchExpr {
  const origin = _currentOrigin();
  const armNodes: MatchArm[] = arms.map(({ cond, value }) => {
    const arm = _tag(mkMatchArm({ $type: "MatchArm", cond, value }), origin);
    _setContainer(cond, arm, "cond");
    _setContainer(value, arm, "value");
    return arm;
  });
  const node = _tag(
    mkMatchExpr({ $type: "MatchExpr", arms: armNodes, varArms: [], elseExpr }),
    origin,
  );
  armNodes.forEach((a, i) => {
    _setContainer(a, node, "arms", i);
  });
  if (elseExpr) _setContainer(elseExpr, node, "elseExpr");
  return node;
}

// ---------------------------------------------------------------------------
// Call expressions — the building block of page bodies
// ---------------------------------------------------------------------------

/** A named call expression: `CreateForm(of: Order)` — `head` is the
 * callee name, `args` is a list of (optional-name, value) pairs.
 * Used to build body-prop calls and any other call-shaped
 * expression in macro output.
 *
 * Post grammar-flatten this emits a `PostfixChain` whose head is a
 * `NameRef(head)` and whose single suffix is a `CallSuffix` carrying
 * the args. */
export function callExpr(
  head: string,
  args: Array<{ name?: string; value: Expression }>,
): PostfixChain {
  const origin = _currentOrigin();
  const callee: NameRef = nameRefExpr(head);
  const callArgs: CallArg[] = args.map(({ name, value }) => {
    const a = _tag(mkCallArg({ $type: "CallArg", name, value }), origin);
    _setContainer(value, a, "value");
    return a;
  });
  const suffix: CallSuffix = _tag(mkCallSuffix({ $type: "CallSuffix", args: callArgs }), origin);
  callArgs.forEach((a, i) => {
    _setContainer(a, suffix, "args", i);
  });
  const chain: PostfixChain = _tag(
    mkPostfixChain({
      $type: "PostfixChain",
      head: callee,
      suffixes: [suffix],
      bypass: [],
      bypassAll: false,
    }),
    origin,
  );
  _setContainer(callee, chain, "head");
  _setContainer(suffix, chain, "suffixes", 0);
  return chain;
}

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

/** The `route: "/orders/:id"` prop on a page. */
export function routeProp(value: string): RouteProp {
  const origin = _currentOrigin();
  return _tag(mkRouteProp({ $type: "RouteProp", value }), origin);
}

/** The `body: <expr>` prop on a page.  Wraps any Expression. */
export function bodyProp(expr: Expression): BodyProp {
  const origin = _currentOrigin();
  const bp: BodyProp = _tag(mkBodyProp({ $type: "BodyProp", expr }), origin);
  _setContainer(expr, bp, "expr");
  return bp;
}

/** A single entry inside a `menu { ... }` block — `name: value`
 * pair such as `section: "Orders"` or `hidden: true`. */
function menuMetaEntry(name: string, value: Expression): MenuMetaEntry {
  const origin = _currentOrigin();
  const e: MenuMetaEntry = _tag(mkMenuMetaEntry({ $type: "MenuMetaEntry", name, value }), origin);
  _setContainer(value, e, "value");
  return e;
}

/** The `menu { … }` prop block on a page.  Accepts a record of
 * `name -> Expression` entries; the macro author builds the
 * values via stringLit/boolLit. */
export function pageMenuMeta(entries: Record<string, Expression>): PageMenuMeta {
  const origin = _currentOrigin();
  const entryNodes = Object.entries(entries).map(([k, v]) => menuMetaEntry(k, v));
  const meta: PageMenuMeta = _tag(
    mkPageMenuMeta({ $type: "PageMenuMeta", entries: entryNodes }),
    origin,
  );
  entryNodes.forEach((e, i) => {
    _setContainer(e, meta, "entries", i);
  });
  return meta;
}

// ---------------------------------------------------------------------------
// Page itself
// ---------------------------------------------------------------------------

/** A typed state field.  `string` fields init to `""` (the shape the scaffolded
 * list filter/sort inputs bind to); `int` fields init to the given number (the
 * scaffolded pager's `page` state, M-T1.1).  Callers pass either a bare name
 * (⇒ `string`-init-`""`) or an explicit `StateFieldSpec`. */
export interface StateFieldSpec {
  name: string;
  type: "string" | "int";
  /** Initial value: string init for `string` fields, number init for `int`. */
  init?: string | number;
}

function typedStateField(spec: StateFieldSpec): StateField {
  const origin = _currentOrigin();
  const base = _tag(mkPrimitiveType({ $type: "PrimitiveType", name: spec.type }), origin);
  const type = _tag(
    mkTypeRef({
      $type: "TypeRef",
      base,
      array: false,
      optional: false,
      alternatives: [],
      ctors: [],
    }),
    origin,
  );
  _setContainer(base, type, "base");
  const init =
    spec.type === "int"
      ? intLit(typeof spec.init === "number" ? spec.init : 0)
      : stringLit(typeof spec.init === "string" ? spec.init : "");
  const field = _tag(mkStateField({ $type: "StateField", name: spec.name, type, init }), origin);
  _setContainer(type, field, "type");
  _setContainer(init, field, "init");
  return field;
}

function normalizeStateSpec(s: string | StateFieldSpec): StateFieldSpec {
  return typeof s === "string" ? { name: s, type: "string" } : s;
}

/** A `state { … }` block prop carrying the given state fields (bare names ⇒
 * `string`-init-`""`; specs carry their own type + init). */
function stateBlock(specs: ReadonlyArray<string | StateFieldSpec>): StateBlock {
  const origin = _currentOrigin();
  const fields = specs.map((s) => typedStateField(normalizeStateSpec(s)));
  const block = _tag(mkStateBlock({ $type: "StateBlock", fields }), origin);
  fields.forEach((f, i) => {
    _setContainer(f, block, "fields", i);
  });
  return block;
}

/** A page declaration.  At minimum needs a name, route, and body;
 * `menu` and `state` (string-field names) are optional. */
export function page(opts: {
  name: string;
  route: string;
  body: Expression;
  menu?: Record<string, Expression>;
  state?: ReadonlyArray<string | StateFieldSpec>;
}): Page & UiMember {
  const origin = _currentOrigin();
  const props: PageProp[] = [];
  props.push(routeProp(opts.route));
  props.push(bodyProp(opts.body));
  if (opts.state && opts.state.length > 0) props.push(stateBlock(opts.state));
  if (opts.menu) props.push(pageMenuMeta(opts.menu));
  const p: Page = _tag(
    mkPage({
      $type: "Page",
      name: opts.name,
      params: [],
      props,
    }),
    origin,
  );
  props.forEach((prop, i) => {
    _setContainer(prop, p, "props", i);
  });
  return p as Page & UiMember;
}

/** An `area <Name> { … }` block grouping pages (and nested areas).  Members
 * are Pages and/or sub-Areas; their `$container` is wired to this area. */
export function area(name: string, members: Array<Page | Area>): Area & UiMember {
  const origin = _currentOrigin();
  const a: Area = _tag(mkArea({ $type: "Area", name, members }), origin);
  members.forEach((m, i) => {
    _setContainer(m, a, "members", i);
  });
  return a as Area & UiMember;
}
