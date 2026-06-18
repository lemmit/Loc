// Form-field template dispatch — shared by the walker's form
// primitives across frontends.  Moved here from
// react/templating/render.ts when the body walker became the shared
// core: the function is pack-driven (each design pack supplies the
// `field-input-*` templates), so it carries no framework specifics.

import type { FormFieldVM } from "../_frontend/view-models.js";
import type { LoadedPack } from "../_packs/loader.js";

/** Render one form-field input through its per-pack
 *  `field-input-*` template.  Used by the walker's `CreateForm(of:)` /
 *  `WorkflowForm(runs:)` emission to produce one markup block per field.
 *  Value-object fields recursively render their children and pass
 *  the joined HTML as `innerHtml` (the template variable the
 *  `field-input-valueobject.hbs` Fieldset reads). */
export function renderFormField(vm: FormFieldVM, pack: LoadedPack): string {
  if (vm.template === "field-input-valueobject") {
    const innerHtml = (vm.children ?? []).map((child) => renderFormField(child, pack)).join("\n");
    return pack.render(vm.template, { ...vm, innerHtml });
  }
  return pack.render(vm.template, vm);
}
