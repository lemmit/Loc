import type { ExprIR, OperationIR } from "../../ir/types/loom-ir.js";
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { namedArgValue, positionalArgs, stringNamed } from "../_walker/shared/args.js";
import { emitExpr, type WalkContext } from "../_walker/walker-core.js";
import {
  type AngularFieldArraySpec,
  type AngularFieldGroupSpec,
  type AngularFormControlSpec,
  type AngularIdTargetSpec,
  addNg,
  formButton,
  formStyle,
  partitionAngularFields,
} from "./form-fields.js";
import { angularSink } from "./walker/sink.js";

// ---------------------------------------------------------------------------
// Angular `Modal { OperationForm(…), trigger: Button(…) }` renderer — the
// operation-dialog form, forked from the shared RHF path via the `renderModal`
// walker seam.
//
// Rendered as a SIGNAL-TOGGLED inline form (not a MatDialog component): a
// trigger button flips an `<op>Open` signal; an `@if (<op>Open())` block holds
// the typed Reactive `FormGroup` over the operation's params.  The record id is
// captured into an `<op>Id` signal BY THE TRIGGER (`set(<idExpr>)`) at click
// time — so the submit method reads it via the signal (`this.<op>Id()`) without
// having to `this`-prefix a template-scope id expression.  Submit calls the
// id-at-mutate `use<Op><Agg>()` factory, then closes.
// ---------------------------------------------------------------------------

/** Everything the page-shell needs to wire one operation-dialog form. */
export interface AngularModalSpec {
  openSig: string;
  idSig: string;
  formVar: string;
  mutationVar: string;
  mutationFn: string;
  importFrom: string;
  submitMethod: string;
  controls: AngularFormControlSpec[];
  /** `useAll<X>()` queries the page-shell hoists for the form's `X id` Select
   *  fields (empty when no field renders as a reference Select). */
  idTargets: AngularIdTargetSpec[];
  /** Dynamic-row (`X[]` of value-object) fields — page-shell adds a `FormArray`
   *  control + the add/remove methods per entry. */
  fieldArrays?: AngularFieldArraySpec[];
  /** Single-value-object (`price: Money`) params — page-shell adds a nested
   *  `FormGroup` control per entry. */
  fieldGroups?: AngularFieldGroupSpec[];
  /** True when the form has ≥1 `File` param — page-shell emits the shared
   *  `onFileUpload` method once per component. */
  hasFile?: boolean;
}

/** Resolve the operation a Modal's `OperationForm` child targets, plus the
 *  template-scope id expression to mutate. */
function resolveOpForm(
  formChild: ExprIR & { kind: "call" },
  ctx: WalkContext,
): { aggName: string; op: OperationIR; idExpr: string } | undefined {
  // Flat form: `OperationForm(of: <Agg>, op: <opName>)` — the scaffold shape;
  // targets the route `id`.
  const ofArg = namedArgValue(formChild, "of");
  const opArg = namedArgValue(formChild, "op");
  if (ofArg?.kind === "ref" && opArg?.kind === "ref") {
    const agg = ctx.aggregatesByName.get(ofArg.name);
    const op = agg?.operations.find((o) => o.name === opArg.name && o.visibility === "public");
    if (!agg || !op) return undefined;
    ctx.usedParams.add("id"); // the route id the mutate targets
    // The angular page-shell binds `readonly id = …paramMap.get("id") ?? ""`
    // (already non-null `string`), so the bare ref suffices — no `?? ""`
    // (which would trip NG8102 "nullish coalescing can be removed").
    return { aggName: agg.name, op, idExpr: "id" };
  }
  // Instance form: `OperationForm(<inst>.<op>)` — targets the in-scope record.
  const ref = positionalArgs(formChild)[0];
  if (ref?.kind === "member" && ref.receiver.kind === "ref") {
    const aggName = ctx.paramTypes?.get(ref.receiver.name);
    const agg = aggName ? ctx.aggregatesByName.get(aggName) : undefined;
    const op = agg?.operations.find((o) => o.name === ref.member && o.visibility === "public");
    if (!agg || !op) return undefined;
    return { aggName: agg.name, op, idExpr: `${emitExpr(ref.receiver, ctx)}.id` };
  }
  return undefined;
}

export function renderAngularModal(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string | null {
  if (call.kind !== "call") return null;
  const formChild = positionalArgs(call).find(
    (a): a is ExprIR & { kind: "call" } => a.kind === "call" && a.name === "OperationForm",
  );
  if (!formChild) {
    return ctx.target.renderComment("Modal: expected an OperationForm child");
  }
  const resolved = resolveOpForm(formChild, ctx);
  if (!resolved) {
    return ctx.target.renderComment("Modal: could not resolve the OperationForm operation");
  }
  const { aggName, op, idExpr } = resolved;

  const opKey = `${lowerFirst(op.name)}${aggName}`;
  const openSig = `${opKey}Open`;
  const idSig = `${opKey}Id`;
  const formVar = `${opKey}Form`;
  const mutationVar = opKey;
  const mutationFn = `use${upperFirst(op.name)}${aggName}`;
  const importFrom = `../../api/${lowerFirst(aggName)}`;
  const submitMethod = `submit${upperFirst(op.name)}${aggName}`;
  const ns = stringNamed(formChild, "testid") ?? `${snake(plural(aggName))}-op-${op.name}`;

  const trigger = namedArgValue(call, "trigger");
  const triggerPositional = trigger?.kind === "call" ? positionalArgs(trigger)[0] : undefined;
  const triggerLabel =
    triggerPositional?.kind === "literal" && triggerPositional.lit === "string"
      ? triggerPositional.value
      : humanize(op.name);
  const emphasis =
    trigger?.kind === "call" ? (stringNamed(trigger, "emphasis") ?? "primary") : "primary";
  const style = formStyle(ctx);
  const triggerBtn =
    style === "material"
      ? emphasis === "primary"
        ? "mat-raised-button"
        : "mat-stroked-button"
      : style === "primeng"
        ? emphasis === "primary"
          ? 'pButton type="button"'
          : 'pButton type="button" [outlined]="true"'
        : emphasis === "primary"
          ? 'class="loom-button loom-button-primary"'
          : 'class="loom-button loom-button-secondary"';
  const cancelBtn =
    style === "material"
      ? 'mat-button type="button"'
      : style === "primeng"
        ? 'pButton type="button" [text]="true"'
        : 'class="loom-button loom-button-ghost" type="button"';

  const bc = ctx.bcByAggregate?.get(aggName);
  addNg(ctx, "@angular/forms", "FormControl", "FormGroup", "ReactiveFormsModule");
  if (style === "material") addNg(ctx, "@angular/material/button", "MatButtonModule");
  else if (style === "primeng") addNg(ctx, "primeng/button", "ButtonModule");
  addNg(ctx, importFrom, mutationFn);

  const parts = bc
    ? partitionAngularFields(op.params, bc, ns, ctx, formVar)
    : {
        flatControls: [],
        flatMarkup: [],
        flatNames: [],
        idTargets: [],
        fieldArrays: [],
        arrayMarkup: [],
        fieldGroups: [],
        groupMarkup: [],
        hasFileField: false,
      };
  const fieldMarkup = parts.flatMarkup;

  ctx.collectedTestids.add(ns);
  ctx.collectedTestids.add(`${ns}-form`);
  ctx.collectedTestids.add(`${ns}-submit`);

  const spec: AngularModalSpec = {
    openSig,
    idSig,
    formVar,
    mutationVar,
    mutationFn,
    importFrom,
    submitMethod,
    controls: parts.flatControls,
    idTargets: parts.idTargets,
    fieldArrays: parts.fieldArrays,
    fieldGroups: parts.fieldGroups,
    hasFile: parts.hasFileField,
  };
  angularSink(ctx).modals.push(spec);

  const inner = "  ".repeat(depth + 1);
  const deep = "  ".repeat(depth + 2);
  const close = "  ".repeat(depth);
  const label = humanize(op.name);
  return [
    `<div class="loom-modal">`,
    `${inner}<button ${triggerBtn} (click)='${idSig}.set(${idExpr}); ${openSig}.set(true)' data-testid="${ns}">${triggerLabel}</button>`,
    `${inner}@if (${openSig}()) {`,
    `${deep}<form [formGroup]="${formVar}" (ngSubmit)="${submitMethod}()" data-testid="${ns}-form">`,
    ...[...fieldMarkup, ...parts.groupMarkup, ...parts.arrayMarkup].map((m) => `${deep}  ${m}`),
    `${deep}  ${formButton(ctx, { type: "submit", emphasis: "primary", label, attrs: ` [disabled]="${mutationVar}.isPending()" data-testid="${ns}-submit"` })}`,
    `${deep}  <button ${cancelBtn} (click)='${openSig}.set(false)'>Cancel</button>`,
    `${deep}</form>`,
    `${inner}}`,
    `${close}</div>`,
  ].join("\n");
}
