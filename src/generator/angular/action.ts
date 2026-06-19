import type { ExprIR } from "../../ir/types/loom-ir.js";
import { humanize, lowerFirst, upperFirst } from "../../util/naming.js";
import { emitActionThen } from "../_walker/primitives/controls.js";
import { renderPrimitive } from "../_walker/render-primitive.js";
import { namedArgValue, positionalArgs } from "../_walker/shared/args.js";
import { emitExpr, styleAttr, testidAttr, type WalkContext } from "../_walker/walker-core.js";

// ---------------------------------------------------------------------------
// Angular `Action(inst.op)` renderer — a button that fires an aggregate
// operation mutation, forked from the shared (React-shaped) `emitAction` via
// the `renderAction` walker seam.
//
// Angular template event bindings bind a STATEMENT, not a function value, and
// forbid arrow functions.  Two shapes:
//
//   - No `then:` — the click handler is the inline call
//     `<localVar>.mutate(<idExpr>, {})` (id passed AT CLICK TIME so an async
//     QueryView record id resolves correctly).  The page-shell hoists only
//     `readonly <localVar> = use<Op><Agg>()`.
//   - `then:` — the after-resolve effect needs a `.then(...)` continuation the
//     template can't host, so the click captures the id into an `<op>Id` signal
//     and calls a component METHOD; the page-shell emits
//     `async on<Op><Agg>() { await this.<localVar>.mutate(this.<op>Id(), {});
//     <then> }`.  Same id-capture trick the operation-dialog Modal uses.
// ---------------------------------------------------------------------------

/** What the page-shell needs to wire one Action's mutation. */
export interface AngularActionSpec {
  localVar: string;
  hookName: string;
  importFrom: string;
  /** Present when the Action carries a `then:` effect — the shell emits an
   *  id-capture signal + an `async` method instead of just the hoist. */
  method?: { name: string; idSig: string; thenJs: string };
}

/** Prefix bare class-field identifiers with `this.` for a method-body context,
 *  skipping string-literal regions (so a route like `"/orders/:id"` is never
 *  rewritten).  Template-scope expressions read fields bare; method bodies need
 *  `this.`. */
function prefixThis(expr: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return expr;
  // Even indices = code, odd = captured "string literals" — rewrite code only.
  return expr
    .split(/("(?:[^"\\]|\\.)*")/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = part;
      for (const n of names) {
        out = out.replace(new RegExp(`(?<![.\\w])${n}\\b`, "g"), `this.${n}`);
      }
      return out;
    })
    .join("");
}

export function renderAngularAction(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  _depth: number,
): string | null {
  if (call.kind !== "call") return null;

  const opRef = positionalArgs(call)[0];
  if (!opRef || opRef.kind !== "member" || opRef.receiver.kind !== "ref") return null;
  const instanceName = opRef.receiver.name;
  const opName = opRef.member;
  const aggName = ctx.paramTypes?.get(instanceName);
  if (!aggName) {
    return ctx.target.renderComment(
      `Action(${instanceName}.${opName}): '${instanceName}' is not an in-scope aggregate instance`,
    );
  }
  const agg = ctx.aggregatesByName.get(aggName);
  if (!agg) {
    return ctx.target.renderComment(
      `Action(${instanceName}.${opName}): aggregate ${aggName} not found`,
    );
  }
  const op = agg.operations.find((o) => o.name === opName && o.visibility === "public");
  if (!op) {
    return ctx.target.renderComment(
      `Action(${instanceName}.${opName}): no public operation '${opName}' on ${agg.name}`,
    );
  }

  const localVar = `${lowerFirst(op.name)}${agg.name}`;
  const hookName = `use${upperFirst(op.name)}${agg.name}`;
  const importFrom = `../../api/${lowerFirst(agg.name)}`;
  // Receiver id is evaluated in TEMPLATE scope (bare `<handle>.data()!` for a
  // QueryView record, `<param>` for a component prop) — what the inline `(click)`
  // statement / the id-capture `set(...)` needs.
  const idExpr = `${emitExpr(opRef.receiver, ctx)}.id`;

  const thenArg = namedArgValue(call, "then");
  const spec: AngularActionSpec = { localVar, hookName, importFrom };
  let onClick: string;
  if (thenArg) {
    // The `then:` effect (e.g. `navigate(...)`) renders in template scope; the
    // method body needs class-field reads `this.`-prefixed.  `emitActionThen`
    // sets `usesNavigate`, so the shell injects `Router`.
    const thenTemplate = emitActionThen(thenArg, ctx);
    const fieldNames = new Set<string>([
      "router",
      ...[...ctx.usedApiHooks.values()].map((h) => h.varName),
      ...ctx.stateNames,
      ...ctx.paramNames,
    ]);
    const methodName = `on${upperFirst(op.name)}${agg.name}`;
    const idSig = `${localVar}Id`;
    spec.method = { name: methodName, idSig, thenJs: prefixThis(thenTemplate, fieldNames) };
    onClick = `${idSig}.set(${idExpr}); ${methodName}()`;
  } else {
    onClick = `${localVar}.mutate(${idExpr}, {})`;
  }

  ctx.angularActions ??= [];
  const specs = ctx.angularActions as AngularActionSpec[];
  if (!specs.some((s) => s.localVar === localVar)) specs.push(spec);

  return renderPrimitive(ctx, "primitive-button", {
    label: humanize(op.name),
    onClick,
    hasOnClick: true,
    disabled: undefined,
    hasDisabled: false,
    loading: undefined,
    hasLoading: false,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}
