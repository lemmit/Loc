import type { BoundedContextIR, TypeIR } from "../../ir/types/loom-ir.js";
import { humanize } from "../../util/naming.js";
import type { WalkContext } from "../_walker/walker-core.js";

// ---------------------------------------------------------------------------
// Shared Reactive-Forms field rendering for the Angular form forks
// (`CreateForm` and the operation/modal forms).  Both build a typed
// `FormGroup` of `nonNullable` `FormControl`s and render per-field Material
// inputs; this module owns the type → control-init + input-markup mapping so
// the two renderers stay byte-consistent.
// ---------------------------------------------------------------------------

/** A single `FormControl` the page-shell declares in the `FormGroup`. */
export interface AngularFormControlSpec {
  name: string;
  /** JS literal for the control's initial value (`""`, `0`, `false`, …). */
  init: string;
}

/** Register a `@angular/*` import on the walk's import map. */
export function addNg(ctx: WalkContext, from: string, ...names: string[]): void {
  let set = ctx.imports.get(from);
  if (!set) {
    set = new Set<string>();
    ctx.imports.set(from, set);
  }
  for (const n of names) set.add(n);
}

/** FormControl initial value per field type (kept in sync with the request
 *  field type so the nonNullable control stays assignable). */
export function controlInit(t: TypeIR): string {
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
export function fieldInput(
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
