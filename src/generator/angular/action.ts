import type { ExprIR } from "../../ir/types/loom-ir.js";
import { humanize, lowerFirst, upperFirst } from "../../util/naming.js";
import { renderPrimitive } from "../_walker/render-primitive.js";
import { namedArgValue, positionalArgs } from "../_walker/shared/args.js";
import { emitExpr, styleAttr, testidAttr, type WalkContext } from "../_walker/walker-core.js";

// ---------------------------------------------------------------------------
// Angular `Action(inst.op)` renderer — a button that fires an aggregate
// operation mutation, forked from the shared (React-shaped) `emitAction` via
// the `renderAction` walker seam.
//
// Angular template event bindings bind a STATEMENT, not a function value, and
// forbid arrow functions — so the click handler is the inline call
// `<localVar>.mutate(<idExpr>, {})` (id passed AT CLICK TIME so an async
// QueryView record id resolves correctly).  The page-shell hoists
// `readonly <localVar> = use<Op><Agg>()` from the recorded spec.
//
// `then:` effects need a `.then(...)` continuation — an arrow the template
// can't host — so an Action carrying `then:` returns null here and falls back
// to the shared path (which stubs the page).  A method-emitting variant for
// `then:` is a follow-up.
// ---------------------------------------------------------------------------

/** What the page-shell needs to hoist one Action's mutation. */
export interface AngularActionSpec {
  localVar: string;
  hookName: string;
  importFrom: string;
}

export function renderAngularAction(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  _depth: number,
): string | null {
  if (call.kind !== "call") return null;
  // `then:` continuation can't be expressed inline — defer to the shared path.
  if (namedArgValue(call, "then") !== undefined) return null;

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
  // QueryView record, `<param>` for a component prop) — exactly what the inline
  // `(click)` statement needs.
  const idExpr = `${emitExpr(opRef.receiver, ctx)}.id`;
  const onClick = `${localVar}.mutate(${idExpr}, {})`;

  ctx.angularActions ??= [];
  const specs = ctx.angularActions as AngularActionSpec[];
  if (!specs.some((s) => s.localVar === localVar)) {
    specs.push({ localVar, hookName, importFrom });
  }

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
