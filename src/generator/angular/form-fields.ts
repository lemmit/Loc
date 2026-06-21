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

/** True when the active pack renders the inline Reactive Forms with Angular
 *  Material components (`mat-form-field` / `matInput` / `mat-raised-button`).
 *  `angularMaterial` and `primeng` both ship `@angular/material` as a dep and
 *  keep the Material form markup; `spartanNg` ships NO Material dep, so its
 *  forms render with plain styled elements + the pack's `.loom-*` classes —
 *  the form seams must NOT register `Mat*Module` there (those symbols don't
 *  resolve and the standalone-component `imports: []` array fails `ng build`). */
export function isMaterialPack(ctx: WalkContext): boolean {
  const name = ctx.pack.manifest.name;
  return name === "angularMaterial" || name === "primeng";
}

/** Render one form submit/cancel/action button, Material- or plain-styled per
 *  the active pack.  Material registers `MatButtonModule`; plain packs use the
 *  `.loom-button` classes from their theme (no module to register). */
export function formButton(
  ctx: WalkContext,
  opts: {
    type: "submit" | "button";
    emphasis: "primary" | "secondary" | "warn";
    label: string;
    attrs?: string;
  },
): string {
  const { type, emphasis, label, attrs = "" } = opts;
  if (isMaterialPack(ctx)) {
    addNg(ctx, "@angular/material/button", "MatButtonModule");
    const matAttr =
      emphasis === "secondary"
        ? "mat-stroked-button"
        : emphasis === "warn"
          ? 'mat-raised-button color="warn"'
          : type === "button"
            ? "mat-button"
            : "mat-raised-button";
    return `<button ${matAttr} type="${type}"${attrs}>${label}</button>`;
  }
  const cls =
    emphasis === "secondary"
      ? "loom-button loom-button-secondary"
      : emphasis === "warn"
        ? "loom-button loom-button-warn"
        : "loom-button loom-button-primary";
  return `<button class="${cls}" type="${type}"${attrs}>${label}</button>`;
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
  const material = isMaterialPack(ctx);
  if (t.kind === "enum") {
    const en = bc.enums.find((e) => e.name === t.name);
    if (material) {
      addNg(ctx, "@angular/material/form-field", "MatFormFieldModule");
      addNg(ctx, "@angular/material/select", "MatSelectModule");
      const opts = (en?.values ?? [])
        .map((v) => `<mat-option value=${JSON.stringify(v)}>${v}</mat-option>`)
        .join("");
      return `<mat-form-field class="loom-field"><mat-label>${label}</mat-label><mat-select formControlName=${cn}${testid}>${opts}</mat-select></mat-form-field>`;
    }
    const opts = (en?.values ?? [])
      .map((v) => `<option value=${JSON.stringify(v)}>${v}</option>`)
      .join("");
    return `<label class="loom-field"><span class="loom-label">${label}</span><select class="loom-input" formControlName=${cn}${testid}>${opts}</select></label>`;
  }
  if (t.kind === "primitive" && t.name === "bool") {
    if (material) {
      addNg(ctx, "@angular/material/checkbox", "MatCheckboxModule");
      return `<mat-checkbox formControlName=${cn}${testid}>${label}</mat-checkbox>`;
    }
    return `<label class="loom-toggle"><input type="checkbox" formControlName=${cn}${testid} />${label}</label>`;
  }
  let inputType = "";
  if (t.kind === "primitive") {
    if (t.name === "int" || t.name === "long" || t.name === "decimal" || t.name === "money") {
      inputType = ' type="number"';
    } else if (t.name === "datetime") {
      inputType = ' type="datetime-local"';
    }
  }
  if (material) {
    addNg(ctx, "@angular/material/form-field", "MatFormFieldModule");
    addNg(ctx, "@angular/material/input", "MatInputModule");
    return `<mat-form-field class="loom-field"><mat-label>${label}</mat-label><input matInput${inputType} formControlName=${cn}${testid}></mat-form-field>`;
  }
  return `<label class="loom-field"><span class="loom-label">${label}</span><input class="loom-input"${inputType} formControlName=${cn}${testid} /></label>`;
}
