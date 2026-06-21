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

/** The inline Reactive-Form rendering flavour the active Angular pack uses.
 *  - `material` (`angularMaterial`) — `mat-form-field` / `matInput` / `Mat*Module`.
 *  - `primeng` — idiomatic PrimeNG inputs (`pInputText` / `p-inputnumber` /
 *    `p-select` / `p-checkbox` / `p-password` / `pButton`) + `primeng/*` modules.
 *  - `plain` (`spartanNg`) — plain styled elements + the pack's `.loom-*`
 *    classes; no component-library modules to register.
 *  The `material` branch must stay byte-identical (it's frozen by the
 *  generator tests); PrimeNG and `spartanNg` never register `Mat*Module`
 *  (those symbols don't resolve and the standalone `imports: []` would fail
 *  `ng build`). */
export type AngularFormStyle = "material" | "primeng" | "plain";

export function formStyle(ctx: WalkContext): AngularFormStyle {
  const name = ctx.pack.manifest.name;
  if (name === "primeng") return "primeng";
  if (name === "angularMaterial") return "material";
  return "plain";
}

/** True only for the Angular Material pack — the seams that fork Material-vs.
 *  other markup branch on this; PrimeNG and `spartanNg` both answer `false`
 *  and branch on {@link formStyle} for their own markup. */
export function isMaterialPack(ctx: WalkContext): boolean {
  return formStyle(ctx) === "material";
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
  const style = formStyle(ctx);
  if (style === "material") {
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
  if (style === "primeng") {
    addNg(ctx, "primeng/button", "ButtonModule");
    const pAttr =
      emphasis === "secondary"
        ? ' [outlined]="true"'
        : emphasis === "warn"
          ? ' severity="danger"'
          : "";
    return `<button pButton type="${type}"${pAttr}${attrs}>${label}</button>`;
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
  const style = formStyle(ctx);
  if (t.kind === "enum") {
    const en = bc.enums.find((e) => e.name === t.name);
    if (style === "material") {
      addNg(ctx, "@angular/material/form-field", "MatFormFieldModule");
      addNg(ctx, "@angular/material/select", "MatSelectModule");
      const opts = (en?.values ?? [])
        .map((v) => `<mat-option value=${JSON.stringify(v)}>${v}</mat-option>`)
        .join("");
      return `<mat-form-field class="loom-field"><mat-label>${label}</mat-label><mat-select formControlName=${cn}${testid}>${opts}</mat-select></mat-form-field>`;
    }
    if (style === "primeng") {
      addNg(ctx, "primeng/select", "SelectModule");
      const opts = JSON.stringify((en?.values ?? []).map((v) => ({ label: v, value: v })));
      return `<label class="loom-field"><span class="loom-label">${label}</span><p-select [options]='${opts}' optionLabel="label" optionValue="value" styleClass="loom-input" formControlName=${cn}${testid}></p-select></label>`;
    }
    const opts = (en?.values ?? [])
      .map((v) => `<option value=${JSON.stringify(v)}>${v}</option>`)
      .join("");
    return `<label class="loom-field"><span class="loom-label">${label}</span><select class="loom-input" formControlName=${cn}${testid}>${opts}</select></label>`;
  }
  if (t.kind === "primitive" && t.name === "bool") {
    if (style === "material") {
      addNg(ctx, "@angular/material/checkbox", "MatCheckboxModule");
      return `<mat-checkbox formControlName=${cn}${testid}>${label}</mat-checkbox>`;
    }
    if (style === "primeng") {
      addNg(ctx, "primeng/checkbox", "CheckboxModule");
      return `<label class="loom-toggle"><p-checkbox [binary]="true" formControlName=${cn}${testid}></p-checkbox><span>${label}</span></label>`;
    }
    return `<label class="loom-toggle"><input type="checkbox" formControlName=${cn}${testid} />${label}</label>`;
  }
  const isNumeric =
    t.kind === "primitive" &&
    (t.name === "int" || t.name === "long" || t.name === "decimal" || t.name === "money");
  if (style === "primeng") {
    if (isNumeric) {
      addNg(ctx, "primeng/inputnumber", "InputNumberModule");
      return `<label class="loom-field"><span class="loom-label">${label}</span><p-inputnumber styleClass="loom-input" formControlName=${cn}${testid}></p-inputnumber></label>`;
    }
    addNg(ctx, "primeng/inputtext", "InputTextModule");
    const inputType =
      t.kind === "primitive" && t.name === "datetime" ? ' type="datetime-local"' : "";
    return `<label class="loom-field"><span class="loom-label">${label}</span><input pInputText class="loom-input"${inputType} formControlName=${cn}${testid} /></label>`;
  }
  let inputType = "";
  if (t.kind === "primitive") {
    if (isNumeric) {
      inputType = ' type="number"';
    } else if (t.name === "datetime") {
      inputType = ' type="datetime-local"';
    }
  }
  if (style === "material") {
    addNg(ctx, "@angular/material/form-field", "MatFormFieldModule");
    addNg(ctx, "@angular/material/input", "MatInputModule");
    return `<mat-form-field class="loom-field"><mat-label>${label}</mat-label><input matInput${inputType} formControlName=${cn}${testid}></mat-form-field>`;
  }
  return `<label class="loom-field"><span class="loom-label">${label}</span><input class="loom-input"${inputType} formControlName=${cn}${testid} /></label>`;
}
