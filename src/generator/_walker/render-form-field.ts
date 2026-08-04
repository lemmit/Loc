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
export function renderFormField(
  vm: FormFieldVM,
  pack: LoadedPack,
  chrome: FormFieldChrome = {},
): string {
  if (vm.template === "field-input-valueobject") {
    const innerHtml = (vm.children ?? [])
      .map((child) => renderFormField(child, pack, chrome))
      .join("\n");
    return pack.render(vm.template, { ...vm, ...chrome, innerHtml });
  }
  return pack.render(vm.template, { ...vm, ...chrome });
}

/** Pack-chrome tokens the `field-input-*` templates share (M-T1.11).
 *
 *  Walker-built rather than VM data, because they carry the active frontend's
 *  binding syntax (`placeholder={t(…)}` vs `:placeholder='t(…)'`) — a
 *  `FormFieldVM` is pure framework-neutral data and deliberately cannot.
 *
 *  Threaded into a value-object's CHILDREN too: a nested `X id` or enum field
 *  renders the same picker a top-level one does, and dropping the token at the
 *  recursion boundary would leave those inputs with a Handlebars blank where
 *  their placeholder should be. */
export interface FormFieldChrome {
  /** `placeholder="Select…"`, or its bound `t(…)` form under i18n. */
  selectPlaceholderAttr?: string;
}
