// Controlled input primitives: Field, Toggle, NumberField,
// PasswordField. Each binds to a state field via `bind:` and renders
// the per-pack input. The label/bind helpers are private to this
// module.

import type { ExprIR } from "../../../../ir/loom-ir.js";
import type { WalkContext } from "../../body-walker.js";
import { firstPositionalContent, testidAttr } from "../../body-walker.js";
import { renderPrimitive } from "../context.js";
import { unwrapAsAttr, unwrapTextLiteral } from "../shared/args.js";

function inputLabelForms(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
): { labelAttr: string; labelText: string } {
  const raw = firstPositionalContent(call, ctx) ?? '""';
  return {
    labelAttr: unwrapAsAttr(raw),
    labelText: unwrapTextLiteral(raw),
  };
}

/** Slice 11.14 — read a `bind:` named arg as a state-field name.
 *  Returns the field name when the arg is a `ref` to a known
 *  state field (and marks `usesState` on the context); otherwise
 *  undefined.  Drives controlled-input wiring in Field / Toggle. */
function stateBindArg(
  call: ExprIR & { kind: "call" },
  name: string,
  ctx: WalkContext,
): string | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "ref" && ctx.stateNames.has(a.name)) {
      ctx.usesState = true;
      return a.name;
    }
  }
  return undefined;
}

export function emitField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Field("Label", bind: <state-field>) — controlled text input
  // bound to a state field.  `bind:` required; without it the
  // input falls back to a label-only stub.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

export function emitToggle(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Toggle("Label", bind: <bool state>) — controlled bool input.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-toggle", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

export function emitNumberField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // NumberField("Label", bind: <int|decimal state>) — controlled
  // number input.  Setter is wrapped with `typeof v === "number"
  // ? v : 0` so binding stays type-safe across the
  // string-or-number onChange union.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-number-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

export function emitPasswordField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // PasswordField("Label", bind: <string state>) — visibility-
  // toggle text input.  Same bind-shape as Field.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-password-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}
