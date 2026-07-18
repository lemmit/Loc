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
  partitionAngularFields,
} from "./form-fields.js";
import { angularSink } from "./walker/sink.js";

// ---------------------------------------------------------------------------
// Angular standalone `OperationForm(...)` renderer — the operation-command
// form NOT hosted inside a `Modal` (that path is `renderAngularModal`).  Forked
// from the shared react-hook-form path via the `renderOperationForm` walker
// seam.
//
// IDIOMATIC TYPED REACTIVE FORMS — sibling of `renderAngularCreateForm`.  Emits
// an always-visible `[formGroup]` / `(ngSubmit)` `<form>` over the operation's
// params; the page-shell reads the recorded `AngularOperationFormSpec` to build
// the typed `FormGroup`, hoist the `use<Op><Agg>()` mutation, and emit the
// submit handler (`mutateAsync({ id, input: getRawValue() })`).
//
// Two source shapes, exactly as the shared `emitOperationForm`:
//   - Flat:     `OperationForm(of: <Agg>, op: <opName>)` — targets the route
//               `id` (a detail page bound to `/.../:id`).
//   - Instance: `OperationForm(<inst>.<op>)` / `Form(<inst>.<op>)` — targets the
//               in-scope record's id (`<inst>.id` for a page param, the route
//               `id` for a render-lambda binding not in class-field scope).
// ---------------------------------------------------------------------------

/** Everything the page-shell needs to wire one standalone operation form. */
export interface AngularOperationFormSpec {
  formVar: string;
  mutationVar: string;
  mutationFn: string;
  importFrom: string;
  submitMethod: string;
  /** Template-scope id expression the submit method mutates against
   *  (`this.`-prefixed by the shell). */
  idExpr: string;
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

/** Resolve the operation the call targets, plus the template-scope id
 *  expression to mutate.  Handles the flat (`of:`/`op:`) and instance-member
 *  (`<inst>.<op>`) shapes. */
function resolveOpForm(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
): { aggName: string; op: OperationIR; idExpr: string } | undefined {
  // Flat form: `OperationForm(of: <Agg>, op: <opName>)` — targets the route id.
  const ofArg = namedArgValue(call, "of");
  const opArg = namedArgValue(call, "op");
  if (ofArg?.kind === "ref" && opArg?.kind === "ref") {
    const agg = ctx.aggregatesByName.get(ofArg.name);
    const op = agg?.operations.find((o) => o.name === opArg.name && o.visibility === "public");
    if (!agg || !op) return undefined;
    ctx.usedParams.add("id"); // the route id the mutate targets
    // The angular page-shell binds `readonly id = …paramMap.get("id") ?? ""`
    // (already non-null `string`), so the bare ref suffices.
    return { aggName: agg.name, op, idExpr: "id" };
  }
  // Instance form: `OperationForm(<inst>.<op>)` — targets the in-scope record.
  const ref = positionalArgs(call)[0];
  if (ref?.kind === "member" && ref.receiver.kind === "ref") {
    const instanceName = ref.receiver.name;
    const aggName = ctx.paramTypes?.get(instanceName);
    const agg = aggName ? ctx.aggregatesByName.get(aggName) : undefined;
    const op = agg?.operations.find((o) => o.name === ref.member && o.visibility === "public");
    if (!agg || !op) return undefined;
    // A function-top param (a component prop) is in class-field scope, so target
    // `<instance>.id`; a render-lambda binding (a Detail page's `data`) is not,
    // so fall back to the route `id`.
    if (ctx.paramNames.has(instanceName)) {
      return { aggName: agg.name, op, idExpr: `${emitExpr(ref.receiver, ctx)}.id` };
    }
    ctx.usedParams.add("id");
    return { aggName: agg.name, op, idExpr: "id" };
  }
  return undefined;
}

export function renderAngularOperationForm(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string | null {
  if (call.kind !== "call") return null;
  const resolved = resolveOpForm(call, ctx);
  if (!resolved) {
    return ctx.target.renderComment(
      "OperationForm: expected (of: <Agg>, op: <opName>) or (<instance>.<op>)",
    );
  }
  const { aggName, op, idExpr } = resolved;
  const bc = ctx.bcByAggregate?.get(aggName);

  const opKey = `${lowerFirst(op.name)}${aggName}`;
  const formVar = `${opKey}Form`;
  const mutationVar = opKey;
  const mutationFn = `use${upperFirst(op.name)}${aggName}`;
  const importFrom = `../../api/${lowerFirst(aggName)}`;
  const submitMethod = `submit${upperFirst(op.name)}${aggName}`;
  const ns = stringNamed(call, "testid") ?? `${snake(plural(aggName))}-op-${op.name}`;

  addNg(ctx, "@angular/forms", "FormControl", "FormGroup", "ReactiveFormsModule");
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
  ctx.collectedTestids.add(`${ns}-submit`);
  for (const name of parts.flatNames) ctx.collectedTestids.add(`${ns}-input-${name}`);
  for (const g of parts.fieldGroups) ctx.collectedTestids.add(`${ns}-input-${g.fieldName}`);

  const spec: AngularOperationFormSpec = {
    formVar,
    mutationVar,
    mutationFn,
    importFrom,
    submitMethod,
    idExpr,
    controls: parts.flatControls,
    idTargets: parts.idTargets,
    fieldArrays: parts.fieldArrays,
    fieldGroups: parts.fieldGroups,
    hasFile: parts.hasFileField,
  };
  angularSink(ctx).opForms.push(spec);

  const inner = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  const label = humanize(op.name);
  const submit = formButton(ctx, {
    type: "submit",
    emphasis: "primary",
    label,
    attrs: ` [disabled]="${mutationVar}.isPending()" data-testid="${ns}-submit"`,
  });
  return [
    `<form [formGroup]="${formVar}" (ngSubmit)="${submitMethod}()" data-testid="${ns}">`,
    ...[...fieldMarkup, ...parts.groupMarkup, ...parts.arrayMarkup, submit].map(
      (m) => `${inner}${m}`,
    ),
    `${close}</form>`,
  ].join("\n");
}
