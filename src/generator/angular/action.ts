import type { ExprIR } from "../../ir/types/loom-ir.js";
import { humanize, lowerFirst, upperFirst } from "../../util/naming.js";
import { tryRenderGate } from "../_frontend/gate-expr.js";
import { emitActionThen } from "../_walker/primitives/controls.js";
import { renderPrimitive } from "../_walker/render-primitive.js";
import { namedArgValue, positionalArgs } from "../_walker/shared/args.js";
import { emitExpr, styleAttr, testidAttr, type WalkContext } from "../_walker/walker-core.js";
import { angularSink } from "./walker/sink.js";

// ---------------------------------------------------------------------------
// Angular `Action(inst.op)` renderer — a button that fires an aggregate
// operation mutation, forked from the shared (React-shaped) `emitAction` via
// the `renderAction` walker seam.
//
// Angular template event bindings bind a STATEMENT, not a function value, and
// forbid arrow functions.  Rather than stage state in the markup, every Action
// renders a "dumb template" — one event, one method call:
//
//   <button (click)='on<Op><Agg>()' [disabled]='<localVar>.isPending()'>…
//
// and the page-shell emits a component method that reads the record id INSIDE
// the method (a `?.id` access with an early-return guard), awaits the mutation,
// then runs the optional `then:` effect:
//
//   async on<Op><Agg>(): Promise<void> {
//     const id = this.<receiver>?.id;
//     if (!id) return;
//     await this.<localVar>.mutate(id, {});
//     <then>;
//   }
// ---------------------------------------------------------------------------

/** What the page-shell needs to wire one Action's mutation + method. */
export interface AngularActionSpec {
  localVar: string;
  hookName: string;
  importFrom: string;
  /** The component method the `(click)` calls — reads the id, guards, mutates,
   *  then runs the optional `then:` effect. */
  method: { name: string; idAccess: string; thenJs?: string };
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
  depth: number,
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
  const methodName = `on${upperFirst(op.name)}${agg.name}`;

  // The record id is read INSIDE the method, not pre-staged in the markup.  Its
  // receiver renders in TEMPLATE scope (`<handle>.data()!` for a QueryView
  // record, `<param>` for a component prop); for the method body, strip the
  // non-null `!` (the method guards with `?.id`) and `this.`-prefix the
  // class-field reads.
  const fieldNames = new Set<string>([
    "router",
    ...[...ctx.usedApiHooks.values()].map((h) => h.varName),
    ...ctx.stateNames,
    ...ctx.paramNames,
  ]);
  const receiverTemplate = emitExpr(opRef.receiver, ctx).replace(/!+$/, "");
  const idAccess = `${prefixThis(receiverTemplate, fieldNames)}?.id`;

  // The `then:` effect (e.g. `navigate(...)`) renders in template scope, then
  // gets `this.`-prefixed for the method body.  `emitActionThen` sets
  // `usesNavigate`, so the shell injects `Router`.
  const thenArg = namedArgValue(call, "then");
  const thenJs = thenArg ? prefixThis(emitActionThen(thenArg, ctx), fieldNames) : undefined;

  const spec: AngularActionSpec = {
    localVar,
    hookName,
    importFrom,
    method: { name: methodName, idAccess, thenJs },
  };
  const specs = angularSink(ctx).actions;
  if (!specs.some((s) => s.localVar === localVar)) specs.push(spec);

  const button = renderPrimitive(ctx, "primitive-button", {
    label: humanize(op.name),
    onClick: `${methodName}()`,
    hasOnClick: true,
    disabled: `${localVar}.isPending()`,
    hasDisabled: true,
    loading: undefined,
    hasLoading: false,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
    // Action button's visible text (the humanised op) is its accessible name.
    a11yAttr: "",
  });

  // Action-button gating (D-AUTH-OIDC, the action-level mirror of the page
  // `requires` guard — the Angular copy of the shared `emitAction` gate, which
  // this `renderAction` fork bypasses).  On an `auth: ui` frontend, `@if`-hide
  // the button at runtime when EVERY `requires` predicate on the operation is
  // currentUser-only (the verified session claims decide it client-side); the
  // page-shell injects the `SessionService` + `currentUser` accessor the gate
  // reads off `usesCurrentUser`.  If the op has no `requires`, or any predicate
  // touches `this.<field>`/params (not client-evaluable — `tryRenderGate`
  // returns null), the button stays ungated; the backend 403 still enforces.
  if (ctx.authUi) {
    const gates = op.statements.filter((s) => s.kind === "requires").map((s) => s.expr);
    if (gates.length > 0) {
      const parts = gates.map((g) => tryRenderGate(g, "currentUser"));
      if (parts.every((p) => p !== null)) {
        ctx.usesCurrentUser = true;
        return ctx.target.renderConditionalChild(
          parts.map((p) => `(${p})`).join(" && "),
          button,
          "null",
          depth,
        );
      }
    }
  }
  return button;
}
