import { createInputFields } from "../../ir/enrich/wire-projection.js";
import type { ExprIR } from "../../ir/types/loom-ir.js";
import { lowerFirst, plural, snake } from "../../util/naming.js";
import type { WalkContext } from "../_walker/walker-core.js";
import {
  type AngularFieldArraySpec,
  type AngularFieldGroupSpec,
  type AngularFormControlSpec,
  type AngularIdTargetSpec,
  addNg,
  formButton,
  partitionAngularFields,
} from "./form-fields.js";
import { applyAngularValidators } from "./form-validators.js";
import { angularSink } from "./walker/sink.js";

// ---------------------------------------------------------------------------
// Angular `CreateForm(of: <Agg>)` renderer (angular-frontend-plan.md Slice 4b).
//
// IDIOMATIC TYPED REACTIVE FORMS — a fork of the shared react-hook-form path
// (the `renderCreateForm` WalkerTarget seam routes here for Angular only).
// Emits a `[formGroup]` / `(ngSubmit)` `<form>`; the page-shell reads the
// recorded `AngularCreateFormSpec` to build the typed `FormGroup`, hoist the
// `useCreate<Agg>` mutation, and emit the submit handler (`mutate` → navigate).
//
// First sub-slice: primitive + enum create fields.  Value-object / array
// fields keep a control (so `getRawValue()` still matches the request type)
// but render a plain text input until their dedicated inputs land.
// ---------------------------------------------------------------------------

/** Everything the page-shell needs to wire one create form. */
export interface AngularCreateFormSpec {
  formVar: string;
  mutationVar: string;
  mutationFn: string;
  requestType: string;
  importFrom: string;
  submitMethod: string;
  redirectSlug: string;
  controls: AngularFormControlSpec[];
  /** `useAll<X>()` queries the page-shell hoists for the form's `X id` Select
   *  fields (empty when no field renders as a reference Select). */
  idTargets: AngularIdTargetSpec[];
  /** Dynamic-row (`X[]` of a value-object) fields — the page-shell declares a
   *  `FormArray` control + the add/remove methods per entry. */
  fieldArrays: AngularFieldArraySpec[];
  /** Single-value-object (`price: Money`) fields — the page-shell declares a
   *  nested `FormGroup` control per entry. */
  fieldGroups: AngularFieldGroupSpec[];
  /** True when the form has ≥1 `File` field — the page-shell emits the shared
   *  `onFileUpload` method once per component. */
  hasFile: boolean;
}

/** Resolve the `CreateForm(of: <Agg>)` aggregate ref. */
function aggNameOf(call: ExprIR & { kind: "call" }): string | undefined {
  const ofArg = (call.argNames ?? []).reduce<ExprIR | undefined>((acc, n, i) => {
    return n === "of" ? call.args[i] : acc;
  }, undefined);
  if (ofArg?.kind === "ref") return ofArg.name;
  if (ofArg?.kind === "literal" && ofArg.lit === "string") return ofArg.value;
  return undefined;
}

export function renderAngularCreateForm(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string | null {
  if (call.kind !== "call") return null;
  const aggName = aggNameOf(call);
  if (!aggName) return ctx.target.renderComment("CreateForm(of: …): missing 'of:' aggregate ref");
  const agg = ctx.aggregatesByName.get(aggName);
  const bc = ctx.bcByAggregate?.get(aggName);
  if (!agg || !bc) {
    return ctx.target.renderComment(
      `CreateForm(of: ${aggName}): aggregate not reachable from this UI`,
    );
  }

  const fields = createInputFields(agg);
  const ns = `${snake(plural(agg.name))}-new`;
  const importFrom = `../../api/${lowerFirst(agg.name)}`;
  const requestType = `Create${agg.name}Request`;
  const mutationFn = `useCreate${agg.name}`;
  const mutationVar = `${lowerFirst(agg.name)}Create`;
  const formVar = `${lowerFirst(agg.name)}Form`;
  const submitMethod = `onSubmit${agg.name}`;

  // Form-shell + per-field imports.
  addNg(ctx, "@angular/forms", "FormControl", "FormGroup", "ReactiveFormsModule");
  addNg(ctx, importFrom, mutationFn, requestType);
  ctx.usesNavigate = true; // hoists inject(Router) for the redirect

  const inner = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  // Split array-of-value-object inputs off — they render as a `FormArray` of
  // row groups; every other field stays a flat `FormControl`.
  const parts = partitionAngularFields(fields, bc, ns, ctx, formVar);

  // Fold the aggregate's wire-translatable invariants into per-field
  // `Validators.*` (the Angular twin of the other frontends' zod native chain),
  // over the create-input fields only — invariants over excluded (managed /
  // token) fields stay server-side, exactly as the zod `Create<Agg>Request`
  // gates them.  A field with a constraint also gets an inline error that
  // reveals once the field is touched (the submit handler marks all touched on
  // a blocked submit).
  const available = new Set(fields.map((f) => f.name));
  const fieldMarkup = applyAngularValidators(parts, agg.invariants, available, formVar, ns, ctx);
  const submit = formButton(ctx, {
    type: "submit",
    emphasis: "primary",
    label: "Create",
    attrs: ` [disabled]="${mutationVar}.isPending()" data-testid="${ns}-submit"`,
  });

  ctx.collectedTestids.add(`${ns}-submit`);
  for (const name of parts.flatNames) ctx.collectedTestids.add(`${ns}-input-${name}`);
  for (const g of parts.fieldGroups) ctx.collectedTestids.add(`${ns}-input-${g.fieldName}`);

  const spec: AngularCreateFormSpec = {
    formVar,
    mutationVar,
    mutationFn,
    requestType,
    importFrom,
    submitMethod,
    redirectSlug: snake(plural(agg.name)),
    controls: parts.flatControls,
    idTargets: parts.idTargets,
    fieldArrays: parts.fieldArrays,
    fieldGroups: parts.fieldGroups,
    hasFile: parts.hasFileField,
  };
  angularSink(ctx).forms.push(spec);

  return [
    `<form [formGroup]="${formVar}" (ngSubmit)="${submitMethod}()" data-testid="${ns}">`,
    ...[...fieldMarkup, ...parts.groupMarkup, ...parts.arrayMarkup, submit].map(
      (m) => `${inner}${m}`,
    ),
    `${close}</form>`,
  ].join("\n");
}
