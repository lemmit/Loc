// Controlled input primitives: Field, Toggle, NumberField,
// PasswordField, MultilineField, SelectField. Each binds to a state
// field via `bind:` and renders the per-pack input. The label/bind
// helpers are private to this module.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { renderPrimitive } from "../render-primitive.js";
import { namedArgValue, unwrapAsAttr, unwrapTextLiteral } from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { emitExpr, firstPositionalContent, testidAttr } from "../walker-core.js";

function inputLabelForms(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
): { labelAttr: string; labelText: string } {
  const raw = firstPositionalContent(call, ctx) ?? '""';
  return {
    labelAttr: unwrapAsAttr(raw),
    labelText: unwrapTextLiteral(raw, ctx.target.escapeText),
  };
}

/** Read an optional `error:` named arg as a rendered expression string.
 *  The expression is walked in the page/component scope, so it can read
 *  `state` / `derived` (`error: passwordsMatch ? "" : "Passwords must
 *  match"`) — the inline validation message the pack renders in its
 *  native error slot.  Returns undefined when no `error:` was given.
 *  This is the ergonomic seam that lets a `state`-composed form show a
 *  dependent-validation message inline, instead of a sibling `Text`
 *  gated by `match`. */
function inputErrorExpr(call: ExprIR & { kind: "call" }, ctx: WalkContext): string | undefined {
  const arg = namedArgValue(call, "error");
  if (!arg) return undefined;
  return emitExpr(arg, ctx);
}

/** Read a `bind:` named arg as a state-field name.
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
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  return renderPrimitive(ctx, "primitive-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    error,
    hasError: error !== undefined,
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
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  return renderPrimitive(ctx, "primitive-toggle", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    error,
    hasError: error !== undefined,
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
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  return renderPrimitive(ctx, "primitive-number-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    error,
    hasError: error !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

export function emitMultilineField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // MultilineField("Label", bind: <string state>) — controlled
  // multi-line text input (textarea).  Same bind-shape as Field.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  return renderPrimitive(ctx, "primitive-multiline-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    error,
    hasError: error !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

export function emitSelectField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // SelectField("Label", bind: <string state>, options: [...]) —
  // controlled single-select over a string-array `options:`
  // expression (a list literal, a state field, or any expression
  // rendering to `string[]`).  Same bind-shape as Field.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  const optionsArg = namedArgValue(call, "options");
  const optionsExpr = optionsArg ? emitExpr(optionsArg, ctx) : "[]";
  return renderPrimitive(ctx, "primitive-select-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    error,
    hasError: error !== undefined,
    optionsExpr,
    testidAttr: testidAttr(call, ctx),
  });
}

export function emitFileUpload(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // FileUpload("Label", bind: <File state>) — standalone file-upload
  // input bound to a `File`-typed state field.  On select it POSTs the
  // file to `/files` (multipart via `api.upload`) and writes the returned
  // `FileRef` back through the setter.  Mirrors `emitField`'s bind shape.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  return renderPrimitive(ctx, "primitive-file-upload", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    error,
    hasError: error !== undefined,
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
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  return renderPrimitive(ctx, "primitive-password-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
    error,
    hasError: error !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}
