// The Flutter WalkerTarget — Dart/Flutter seam implementations consumed by the
// shared `walkBody` engine.  Flutter is structurally a Feliz clone: a non-JSX,
// function-call-tree target (`Column(children: [ … ])` ≈ Feliz's
// `Html.div [ prop.children [ … ] ]`), so it rides the shared walker core through
// this seam object rather than adding a WALKER_PRIMITIVE.  The primary model is
// `src/generator/feliz/feliz-target.ts`; only the syntax below is Dart, not F#.
//
// WALKING-SKELETON SCOPE (this file): the read/display path — List / Detail
// pages.  Every REQUIRED seam emits real Dart; the expression leaves forward to
// `DART_LEAVES` (`./dart-expr.ts`).  State follows the Riverpod convention: reads
// dereference the projected state record (`state.<field>`), writes call a
// Notifier method (`notifier.set<Field>(…)`) — the Riverpod projector (Track D)
// binds the actual notifier, so the intent is emitted consistently with a
// `TODO(flutter): notifier` marker where the binding lands.
//
// DEFERRED to full parity (intentionally omitted so they fall back, or stubbed):
// the seven whole-primitive form/action overrides (`renderCreateForm` /
// `renderOperationForm` / `renderDestroyForm` / `renderWorkflowForm` /
// `renderModal` / `renderAction` / `renderUserComponent`) and the interactive-
// table / store seams.  The skeleton renders List + Detail display only.

import type { LiteralKind, TypeIR } from "../../ir/types/loom-ir.js";
import { lowerFirst, upperFirst } from "../../util/naming.js";
import type { ApiCallSite, RenderPosition, StateRef, WalkerTarget } from "../_walker/target.js";
import { DART_LEAVES, dartString, dartZeroValue } from "./dart-expr.js";

/** True when a value is provably a `string` already, so a `Text(…)` child can
 *  take it without the `.toString()` coercion. */
function isStringType(type: TypeIR | undefined): boolean {
  return type?.kind === "primitive" && type.name === "string";
}

/** A dotted attribute / route name → a safe camelCase Dart identifier
 *  (`data-testid` → `dataTestid`).  Keeps a dynamic named-arg binding legal Dart
 *  even when the source name carries hyphens. */
function dartIdent(name: string): string {
  const camel = name.replace(/[^a-zA-Z0-9]+([a-zA-Z0-9])?/g, (_m, c: string | undefined) =>
    c ? c.toUpperCase() : "",
  );
  return lowerFirst(camel);
}

/** A Notifier setter method name for a state field (`step` → `setStep`). */
function setterName(field: string): string {
  return `set${upperFirst(field)}`;
}

/** A route template (`/products/:id`) → a Dart string with `:param` segments
 *  interpolated as `${value}` (Dart string interpolation).  Literal segments
 *  pass through verbatim; a `:param` uses the matching named arg's value, else
 *  its bare name. */
function dartRoute(
  routeTemplate: string,
  args: ReadonlyArray<{ name: string; value: string }>,
): string {
  const byName = new Map(args.map((a) => [a.name, a.value]));
  const segs = routeTemplate.split("/").filter((s) => s.length > 0);
  const rendered = segs.map((s) => {
    if (!s.startsWith(":")) return s;
    const name = s.slice(1);
    return `\${${byName.get(name) ?? name}}`;
  });
  return `'/${rendered.join("/")}'`;
}

/** The provider-local var a detected api call resolves to (`Customer` + `all` →
 *  `customerAll`).  Track D wires the matching Riverpod provider; the view only
 *  names the local it reads. */
function apiVarName(aggregateName: string, operation: string): string {
  return `${lowerFirst(aggregateName)}${upperFirst(operation)}`;
}

/** Assemble a guarded Dart-3 `switch` EXPRESSION from predicate arms — the
 *  Flutter analogue of Feliz's `if/elif/else` chain (Dart has no
 *  predicate-arm-without-subject match, so `switch (0) { _ when p => v, … }`
 *  carries the predicates as wildcard guards).  Both value and markup-child
 *  position use it (arm values are already rendered).  With no `else` arm the
 *  terminal is `const SizedBox.shrink()` (renders nothing). */
function dartPredicateSwitch(
  arms: ReadonlyArray<{ predicate: string; value: string }>,
  elseArm: string | undefined,
): string {
  const terminal = `_ => ${elseArm ?? "const SizedBox.shrink()"}`;
  const clauses = arms.map((a) => `_ when ${a.predicate} => ${a.value}`);
  return `switch (0) { ${[...clauses, terminal].join(", ")} }`;
}

export const flutterTarget: WalkerTarget = {
  framework: "flutter",

  // --- State seam — Riverpod projected-state reads + Notifier writes --------
  // Reads dereference the projected immutable state record the view holds
  // (`state.<field>`); the field keeps its source (camelCase) name.
  renderStateRead: (ref: StateRef, _pos: RenderPosition) => `state.${ref.name}`,
  // A `state.<field> := <value>` write inside an event handler calls the
  // Notifier's generated setter.  The projector (Track D) binds `notifier`; the
  // TODO marks where that binding lands.
  renderStateWrite: (ref: StateRef, value: string) =>
    `notifier.${setterName(ref.name)}(${value}) /* TODO(flutter): notifier */`,
  // A multi-segment write (`order.shipping.zip := v`) → a Notifier update on the
  // root field; the projector fills the immutable rebuild.
  renderNestedStateWrite: (segments: readonly string[], valueJs: string) => {
    const [root, ...rest] = segments;
    const path = rest.length ? `${root}.${rest.join(".")}` : (root ?? "");
    return `notifier.${setterName(root ?? "")}(${valueJs}) /* TODO(flutter): nested write ${path} */`;
  },

  // --- API seam — thin Riverpod projection ---------------------------------
  // A detected api call resolves to a provider-local (`customerAll`); the args
  // render through the walker context so param/state refs propagate.
  buildHookUse: (detected, renderArg) => {
    const varName = apiVarName(detected.aggregateName, detected.operation);
    return {
      varName,
      hookName: varName,
      importFrom: `../providers/${lowerFirst(detected.aggregateName)}`,
      argsRendered: detected.args.map(renderArg),
    };
  },
  // The IR call site emits the provider local (the FutureBuilder / `ref.watch`
  // reads it — hoisted below); chained `.data` / `.value` come from the walk.
  renderApiCall: (call: ApiCallSite) =>
    call.varName ?? apiVarName(call.aggregateName, call.operation),
  // The magic route `id` (`Order.byId(id)`) resolves to the local `id` the page
  // shell binds from its route arguments.
  renderRouteId: () => "id",
  // Thin-but-real per-page hoist: one `ref.watch(<var>Provider)` per distinct
  // read.  The full Riverpod async wiring (AsyncValue.when / loading / error) is
  // Track D's; this names the binding the body references.
  renderApiHoisting: (uses: ApiCallSite[]) => {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const u of uses) {
      const v = u.varName ?? apiVarName(u.aggregateName, u.operation);
      if (seen.has(v)) continue;
      seen.add(v);
      lines.push(`    final ${v} = ref.watch(${v}Provider); // TODO(flutter): Riverpod async`);
    }
    return lines;
  },

  // --- Match expression seam — Dart-3 guarded switch -----------------------
  renderMatch: (arms, elseArm) => dartPredicateSwitch(arms, elseArm),
  renderMatchChild: (arms, elseArm, _depth) => dartPredicateSwitch(arms, elseArm),

  // --- List-comprehension seam — `.map` spread into a widget children list --
  // `For { each: coll, x => <markup> }` → `...coll.map((x) => <widget>)`, spliced
  // into the enclosing children list (Dart's collection spread).  An `empty:` arm
  // folds into a collection-`if`; the index binding is emitted only when used.
  renderForEach: (coll, itemVar, indexVar, keyExpr, body, _depth, emptyBody) => {
    // Word-boundary match — a substring test would false-positive on a
    // single-letter index (`i`) inside any identifier (`x.id`).
    const idxRe = new RegExp(`\\b${indexVar}\\b`);
    const usesIndex = idxRe.test(keyExpr) || idxRe.test(body);
    const mapped = usesIndex
      ? `...${coll}.asMap().entries.map((entry) { final ${indexVar} = entry.key; final ${itemVar} = entry.value; return ${body}; })`
      : `...${coll}.map((${itemVar}) => ${body})`;
    if (emptyBody === undefined) return mapped;
    return `if (${coll}.isEmpty) ${emptyBody} else ${mapped}`;
  },

  // --- Navigation seam — Navigator.pushNamed -------------------------------
  renderNavigate: (routeTemplate, args, stateExpr) => {
    const path = dartRoute(routeTemplate, args);
    if (stateExpr !== undefined) {
      return `Navigator.pushNamed(context, ${path}, arguments: ${stateExpr})`;
    }
    // Args consumed by a `:param` segment are already interpolated into the
    // route; only the LEFTOVER args ride along as a Navigator arguments map.
    const routeParams = new Set(
      routeTemplate
        .split("/")
        .filter((s) => s.startsWith(":"))
        .map((s) => s.slice(1)),
    );
    const extra = args.filter((a) => !routeParams.has(a.name));
    const argMap =
      extra.length > 0
        ? `, arguments: {${extra.map((a) => `${dartString(a.name)}: ${a.value}`).join(", ")}}`
        : "";
    return `Navigator.pushNamed(context, ${path}${argMap})`;
  },
  // `Button(to: "/products")` → the bare navigate call (bound as a statement by
  // `renderEventHandler`).  The dest arg is already rendered.
  renderNavigateExpr: (toArg: string) => `Navigator.pushNamed(context, ${toArg})`,

  // --- Type-default seam ---------------------------------------------------
  defaultInitFor: (type) => dartZeroValue(type),

  // --- Markup seams — Dart/Flutter flavoured -------------------------------
  renderComment: (text: string) => `/* ${text} */`,
  // Child-position interpolation → a `Text(…)` widget.  A provably-string value
  // is passed straight; anything else is coerced via Dart string interpolation
  // (`Text('${expr}')`), which stringifies any type.
  renderInterpolation: (jsExpr: string, exprType?: TypeIR) =>
    isStringType(exprType) ? `Text(${jsExpr})` : `Text('\${${jsExpr}}')`,
  // A dynamic attribute → a named widget argument (leading space, camelCased
  // name so a hyphenated source attr stays a legal Dart identifier).
  renderAttrBinding: (name: string, jsExpr: string) => ` ${dartIdent(name)}: ${jsExpr}`,
  // A conditional child → a ternary over two widgets (a single child expression,
  // valid anywhere a widget is expected).
  renderConditionalChild: (cond, thenS, elseS, _depth) => `(${cond} ? ${thenS} : ${elseS})`,
  // Flutter has no CSS `style` attribute — styling is per-widget.  Empty, like
  // Feliz.
  renderStyleAttr: () => "",
  // Raw text for a Dart single-quoted string body (the pack wraps it in
  // `Text('…')`): escape the backslash, the quote, `$`, and the newline.
  escapeText: (text: string) =>
    text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\$/g, "\\$").replace(/\n/g, "\\n"),

  // --- Handler seams — Dart closures ---------------------------------------
  // A button's `onPressed:` binds a `VoidCallback`.  The expression form is an
  // arrow; the block form a brace body (each stmt already `;`-terminated).
  renderEventHandler: (stmts, expr) => {
    if (expr !== undefined) return `() => ${expr}`;
    const body = (stmts ?? []).join(" ");
    return `() { ${body} }`;
  },
  // A named `action` → a local closure at the widget-build top; the body reuses
  // the shared `:=`/`+=` statement lowering (Notifier writes).
  renderNamedHandler: (name, param, bodyStmts) => {
    const body = bodyStmts.join(" ");
    const sig = param ? `void ${name}(dynamic ${param})` : `void ${name}()`;
    return `    ${sig} { ${body} }`;
  },

  // --- Expression-syntax leaves (Dart) — forwarded to the shared table ------
  exprLiteral: (lit: LiteralKind, value: string) => DART_LEAVES.literal(lit, value),
  exprBinary: (left, right, op) => DART_LEAVES.binary(left, right, op),
  exprUnary: (op, operand) => DART_LEAVES.unary(op, operand),
  exprTernary: (cond, then, otherwise) => DART_LEAVES.ternary(cond, then, otherwise),
  exprConvert: (value, target, from) => DART_LEAVES.convert(value, target, from),
  exprList: (elements) => DART_LEAVES.list(elements),
  exprObject: (fields) => DART_LEAVES.object(fields),
};
