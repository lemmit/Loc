// UI-side factories — page construction for scaffold-style macros.
//
// Kept separate from `factories.ts` (which builds aggregate members)
// because the surfaces don't overlap: macros that target `aggregate`
// don't construct pages, and ui-targeted macros don't construct
// fields/operations.  Both files share the same origin-tagging
// machinery via `currentOrigin()` from `factories.ts`.

import type {
  BodyProp,
  BoolLit,
  CallArg,
  CallExpr,
  Expression,
  MenuMetaEntry,
  NameRef,
  Page,
  PageMenuMeta,
  PageProp,
  RouteProp,
  StringLit,
  UiMember,
} from "../language/generated/ast.js";
import { _currentOrigin, _setContainer, _tag } from "./factories-internals.js";

// ---------------------------------------------------------------------------
// Atomic expression factories
// ---------------------------------------------------------------------------

/** A string literal expression.  The value is stored without the
 * surrounding quotes (matches the parser's strip-delimiters
 * behavior — see CLAUDE.md's gotcha list and re-quote on emission). */
export function stringLit(value: string): StringLit {
  const origin = _currentOrigin();
  return _tag({ $type: "StringLit", value } as unknown as StringLit, origin);
}

/** A boolean literal expression.  The grammar surfaces these as
 * `BoolLit { value: 'true' | 'false' }` (string, not boolean) since
 * the parser doesn't coerce; we pass it through as-is. */
export function boolLit(value: boolean): BoolLit {
  const origin = _currentOrigin();
  return _tag(
    { $type: "BoolLit", value: String(value) } as unknown as BoolLit,
    origin,
  );
}

/** A bare name reference, suitable for use in expression positions
 * (e.g. as a body-call argument: `Of(of: Order)` — `Order` here).
 * Same shape as the statement-side `nameRef` in factories.ts but
 * re-exported here so ui-macro authors don't import from two files. */
export function nameRefExpr(name: string): NameRef {
  const origin = _currentOrigin();
  return _tag({ $type: "NameRef", name } as unknown as NameRef, origin);
}

// ---------------------------------------------------------------------------
// Call expressions — the building block of page bodies
// ---------------------------------------------------------------------------

/** A named call expression: `List(of: Order)` — `head` is the
 * callee name, `args` is a list of (optional-name, value) pairs.
 * Used to build body-prop calls and any other call-shaped
 * expression in macro output. */
export function callExpr(
  head: string,
  args: Array<{ name?: string; value: Expression }>,
): CallExpr {
  const origin = _currentOrigin();
  const callee = nameRefExpr(head);
  const callArgs: CallArg[] = args.map(({ name, value }) => {
    const a = _tag(
      { $type: "CallArg", name, value } as unknown as CallArg,
      origin,
    );
    _setContainer(value, a, "value");
    return a;
  });
  const ce: CallExpr = _tag(
    { $type: "CallExpr", callee, args: callArgs } as unknown as CallExpr,
    origin,
  );
  _setContainer(callee, ce, "callee");
  callArgs.forEach((a, i) => _setContainer(a, ce, "args", i));
  return ce;
}

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

/** The `route: "/orders/:id"` prop on a page. */
export function routeProp(value: string): RouteProp {
  const origin = _currentOrigin();
  return _tag({ $type: "RouteProp", value } as unknown as RouteProp, origin);
}

/** The `body: <expr>` prop on a page.  Wraps any Expression. */
export function bodyProp(expr: Expression): BodyProp {
  const origin = _currentOrigin();
  const bp: BodyProp = _tag(
    { $type: "BodyProp", expr } as unknown as BodyProp,
    origin,
  );
  _setContainer(expr, bp, "expr");
  return bp;
}

/** A single entry inside a `menu { ... }` block — `name: value`
 * pair such as `section: "Orders"` or `hidden: true`. */
function menuMetaEntry(name: string, value: Expression): MenuMetaEntry {
  const origin = _currentOrigin();
  const e: MenuMetaEntry = _tag(
    { $type: "MenuMetaEntry", name, value } as unknown as MenuMetaEntry,
    origin,
  );
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
    { $type: "PageMenuMeta", entries: entryNodes } as unknown as PageMenuMeta,
    origin,
  );
  entryNodes.forEach((e, i) => _setContainer(e, meta, "entries", i));
  return meta;
}

// ---------------------------------------------------------------------------
// Page itself
// ---------------------------------------------------------------------------

/** A page declaration.  At minimum needs a name, route, and body;
 * `menu` is optional. */
export function page(opts: {
  name: string;
  route: string;
  body: Expression;
  menu?: Record<string, Expression>;
}): Page & UiMember {
  const origin = _currentOrigin();
  const props: PageProp[] = [];
  props.push(routeProp(opts.route));
  props.push(bodyProp(opts.body));
  if (opts.menu) props.push(pageMenuMeta(opts.menu));
  const p: Page = _tag(
    {
      $type: "Page",
      name: opts.name,
      params: [],
      props,
    } as unknown as Page,
    origin,
  );
  props.forEach((prop, i) => _setContainer(prop, p, "props", i));
  return p as Page & UiMember;
}
