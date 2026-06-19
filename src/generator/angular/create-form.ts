import { createInputFields } from "../../ir/enrich/wire-projection.js";
import type { BoundedContextIR, ExprIR, TypeIR } from "../../ir/types/loom-ir.js";
import { humanize, lowerFirst, plural, snake } from "../../util/naming.js";
import type { WalkContext } from "../_walker/walker-core.js";

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

/** A single `FormControl` the page-shell declares in the `FormGroup`. */
export interface AngularFormControlSpec {
  name: string;
  /** JS literal for the control's initial value (`""`, `0`, `false`, …). */
  init: string;
}

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
}

function addNg(ctx: WalkContext, from: string, ...names: string[]): void {
  let set = ctx.imports.get(from);
  if (!set) {
    set = new Set<string>();
    ctx.imports.set(from, set);
  }
  for (const n of names) set.add(n);
}

/** FormControl initial value per field type (kept in sync with the request
 *  field type so the nonNullable control stays assignable). */
function controlInit(t: TypeIR): string {
  if (t.kind === "primitive") {
    if (t.name === "bool") return "false";
    if (t.name === "int" || t.name === "long" || t.name === "decimal" || t.name === "money") {
      return "0";
    }
    return '""';
  }
  if (t.kind === "enum") return '""';
  return "null";
}

/** Render one field's control markup, registering the Material module it needs. */
function fieldInput(
  name: string,
  t: TypeIR,
  bc: BoundedContextIR,
  ns: string,
  ctx: WalkContext,
): string {
  const label = humanize(name);
  const testid = ` data-testid="${ns}-input-${name}"`;
  const cn = JSON.stringify(name);
  if (t.kind === "enum") {
    addNg(ctx, "@angular/material/form-field", "MatFormFieldModule");
    addNg(ctx, "@angular/material/select", "MatSelectModule");
    const en = bc.enums.find((e) => e.name === t.name);
    const opts = (en?.values ?? [])
      .map((v) => `<mat-option value=${JSON.stringify(v)}>${v}</mat-option>`)
      .join("");
    return `<mat-form-field class="loom-field"><mat-label>${label}</mat-label><mat-select formControlName=${cn}${testid}>${opts}</mat-select></mat-form-field>`;
  }
  if (t.kind === "primitive" && t.name === "bool") {
    addNg(ctx, "@angular/material/checkbox", "MatCheckboxModule");
    return `<mat-checkbox formControlName=${cn}${testid}>${label}</mat-checkbox>`;
  }
  addNg(ctx, "@angular/material/form-field", "MatFormFieldModule");
  addNg(ctx, "@angular/material/input", "MatInputModule");
  let inputType = "";
  if (t.kind === "primitive") {
    if (t.name === "int" || t.name === "long" || t.name === "decimal" || t.name === "money") {
      inputType = ' type="number"';
    } else if (t.name === "datetime") {
      inputType = ' type="datetime-local"';
    }
  }
  return `<mat-form-field class="loom-field"><mat-label>${label}</mat-label><input matInput${inputType} formControlName=${cn}${testid}></mat-form-field>`;
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
  addNg(ctx, "@angular/material/button", "MatButtonModule");
  addNg(ctx, importFrom, mutationFn, requestType);
  ctx.usesNavigate = true; // hoists inject(Router) for the redirect

  const inner = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  const fieldMarkup = fields.map((f) => fieldInput(f.name, f.type, bc, ns, ctx));
  const submit = `<button mat-raised-button type="submit" [disabled]="${mutationVar}.isPending()" data-testid="${ns}-submit">Create</button>`;

  ctx.collectedTestids.add(`${ns}-submit`);
  for (const f of fields) ctx.collectedTestids.add(`${ns}-input-${f.name}`);

  const spec: AngularCreateFormSpec = {
    formVar,
    mutationVar,
    mutationFn,
    requestType,
    importFrom,
    submitMethod,
    redirectSlug: snake(plural(agg.name)),
    controls: fields.map((f) => ({ name: f.name, init: controlInit(f.type) })),
  };
  ctx.angularForms ??= [];
  ctx.angularForms.push(spec);

  return [
    `<form [formGroup]="${formVar}" (ngSubmit)="${submitMethod}()" data-testid="${ns}">`,
    ...[...fieldMarkup, submit].map((m) => `${inner}${m}`),
    `${close}</form>`,
  ].join("\n");
}
