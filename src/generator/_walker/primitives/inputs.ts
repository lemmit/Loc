// Controlled input primitives: Field, Toggle, NumberField,
// PasswordField, MultilineField, SelectField. Each binds to a state
// field via `bind:` and renders the per-pack input. The label/bind
// helpers are private to this module.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import {
  localizedChromeAttr,
  localizedPositionalAttr,
  localizedPositionalTranslation,
  localizedText,
  registerI18nImport,
} from "../i18n-emit.js";
import { renderPrimitive } from "../render-primitive.js";
import { namedArgValue, positionalArgs } from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { emitExpr, testidAttr } from "../walker-core.js";

/** The three spellings of an input's LABEL — the most-read authored prose in
 *  any generated form, and until M-T1.11's `inputLabel` slot the only one that
 *  reached no catalog at all (the `Select…` placeholder beside it did).
 *
 *  The packs split three ways on how they render it, so all three forms come
 *  from the SAME `messageKey()` and the same translation decision:
 *
 *    `labelText`  — the text/children token, for `<Label>{{{labelText}}}</Label>`;
 *    `labelAttr`  — the complete bound attribute, for `<TextInput{{{labelAttr}}}>`
 *                   (` label="Email"` off, ` label={t(…)}` / ` :label="t(…)"` on);
 *    `labelValue` — the bare translation EXPRESSION, `undefined` when there is
 *                   nothing to translate, for the two packs that splice the
 *                   label into their own string syntax (Feliz's `prop.text "…"`,
 *                   Flutter's `InputDecoration(labelText: '…')`).  They keep
 *                   their raw spelling as the fallback, so i18n-off output is
 *                   byte-identical by construction.
 *
 *  A missing label keeps its pre-i18n ` label=""` rather than dropping the
 *  attribute — the degenerate case is not what this slot is about. */
function inputLabelForms(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
): { labelAttr: string; labelText: string; labelValue: string | undefined } {
  const labelArg = positionalArgs(call)[0];
  return {
    labelAttr: labelArg ? localizedPositionalAttr(call, ctx, "inputLabel", "label") : ' label=""',
    labelText: localizedText(call, ctx, "inputLabel", '""'),
    labelValue: localizedPositionalTranslation(call, ctx, "inputLabel"),
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
  const { labelAttr, labelText, labelValue } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  // A11y ids (M-T1.12).  The packs that render a RAW `<input>` plus a sibling
  // error element — flowbite, shadcnSvelte, primeng, spartanNg,
  // angularMaterial — had no way to link the two: no id on the input, no id on
  // the message, so `aria-invalid` / `aria-describedby` were absent and a
  // screen reader announced a valid, unexplained field.  (The Mantine / MUI /
  // Chakra / shadcn packs never needed this: their component library owns the
  // wiring behind an `error` prop.)
  //
  // The id is derived, not counted: a `bind:` names a page-state field, which
  // is unique within the page/component scope, so `loom-field-<bind>` is too.
  // An UNBOUND field has no stable name to derive from, so it gets no id and
  // the templates fall back to their previous markup — a display-only stub
  // with no error slot is not the case this contract is about.
  const fieldId = bind !== undefined ? `loom-field-${bind}` : undefined;
  return renderPrimitive(ctx, "primitive-field", {
    fieldId,
    errorId: fieldId !== undefined ? `${fieldId}-error` : undefined,
    // Templates guard the aria attrs on this: an id alone is not enough,
    // `aria-describedby` must point at an element that EXISTS, and the error
    // element is itself conditional on `hasError`.
    hasA11yIds: fieldId !== undefined,
    labelAttr,
    labelText,
    labelValue,
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
  const { labelAttr, labelText, labelValue } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  return renderPrimitive(ctx, "primitive-toggle", {
    labelAttr,
    labelText,
    labelValue,
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
  const { labelAttr, labelText, labelValue } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  return renderPrimitive(ctx, "primitive-number-field", {
    labelAttr,
    labelText,
    labelValue,
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
  const { labelAttr, labelText, labelValue } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  return renderPrimitive(ctx, "primitive-multiline-field", {
    labelAttr,
    labelText,
    labelValue,
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
  const { labelAttr, labelText, labelValue } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  const optionsArg = namedArgValue(call, "options");
  const optionsExpr = optionsArg ? emitExpr(optionsArg, ctx) : "[]";
  return renderPrimitive(ctx, "primitive-select-field", {
    labelAttr,
    labelText,
    labelValue,
    bind,
    setter,
    hasBind: bind !== undefined,
    error,
    hasError: error !== undefined,
    optionsExpr,
    // The picker's empty-state text (M-T1.11).  Renders into the PAGE, so the
    // `t` it resolves against goes on the page's import map — unlike the
    // DataGrid chrome, whose markup lands in a hoisted child file.
    selectPlaceholderAttr: selectPlaceholderAttr(ctx),
    testidAttr: testidAttr(call, ctx),
  });
}

/** The picker's `placeholder="Select…"` fragment.  Under i18n it is the
 *  target's bound form keyed to `chrome.selectPlaceholder`; with i18n off it is
 *  the raw attribute, byte-identical to the pre-i18n pack template.
 *
 *  Registers the `t` import — unlike the DataGrid chrome, this markup renders
 *  into the PAGE, so `t` resolves against the page's own import block. */
export function selectPlaceholderAttr(ctx: WalkContext): string {
  if (ctx.i18nPrefix) registerI18nImport(ctx);
  return localizedChromeAttr(ctx, "placeholder", "selectPlaceholder");
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
  // Flag the walk so the Angular page-shell wires the `onFileUploadTo`
  // component method + its imports (unread on the other frontends).
  ctx.usesFileUpload = true;
  const { labelAttr, labelText, labelValue } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  return renderPrimitive(ctx, "primitive-file-upload", {
    labelAttr,
    labelText,
    labelValue,
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
  const { labelAttr, labelText, labelValue } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined ? "set" + bind[0]!.toUpperCase() + bind.slice(1) : undefined;
  const error = inputErrorExpr(call, ctx);
  return renderPrimitive(ctx, "primitive-password-field", {
    labelAttr,
    labelText,
    labelValue,
    bind,
    setter,
    hasBind: bind !== undefined,
    error,
    hasError: error !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}
