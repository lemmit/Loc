// Import-accumulation and primitive-render helpers shared by the body
// walker core and the per-primitive emitter modules.
//
// These touch the walk context's import sink (and, for the render
// helpers, the active design pack). Kept here so primitive modules can
// reuse them without dragging the rest of the walker.

import type { FormFieldVM } from "../_frontend/view-models.js";
import type { ImportSpec } from "../_packs/loader.js";
import type { ImportMap, WalkContext } from "./walker-core.js";

export type { ImportMap };

/** Append a named-import to the walker's per-source import map.
 *  Idempotent — duplicate names dedupe inside the Set per source. */
export function addImport(ctx: WalkContext, from: string, ...names: string[]): void {
  let s = ctx.imports.get(from);
  if (!s) {
    s = new Set();
    ctx.imports.set(from, s);
  }
  for (const n of names) s.add(n);
}

/** Convenience for the (still many) emit functions that haven't been
 *  ported to the pack contract yet — they all want named imports
 *  from `@mantine/core`.  Keeps call sites compact and grep-able
 *  while the migration finishes. */
export function addMantineImport(ctx: WalkContext, ...names: string[]): void {
  addImport(ctx, "@mantine/core", ...names);
}

/** Register the imports a non-rendered primitive needs.  Used by
 *  `Form(of:)` / `Form(runs:)` emission: the form-
 *  shell JSX uses `<Stack>` / `<Button>` / `<Group>` (Mantine) /
 *  `<div className="...">` / `<Button>` (shadcn) etc., but the
 *  walker emits them as literal JSX (not via `renderPrimitive`),
 *  so the pack's `imports.primitive-X` declarations don't auto-
 *  add.  This helper looks them up and registers them. */
export function addImportsForPrimitive(ctx: WalkContext, name: string): void {
  const specs: ImportSpec[] = ctx.pack.manifest.imports?.[name] ?? [];
  for (const spec of specs) addImport(ctx, spec.from, ...spec.named);
}

/** Walk a `FormFieldVM` tree and register each
 *  child template's imports via `imports.field-input-*` on the
 *  pack manifest.  This replaces the previous Mantine-component-
 *  name → primitive mapping: each field-input-* template is its
 *  own pack contract surface, so packs declare imports per
 *  template directly (e.g. shadcn's `field-input-id-select`
 *  imports `Select`, `SelectTrigger`, … from
 *  `@/components/ui/select`). */
export function registerFormFieldImports(ctx: WalkContext, vm: FormFieldVM): void {
  addImportsForPrimitive(ctx, vm.template);
  if (vm.children) {
    for (const c of vm.children) registerFormFieldImports(ctx, c);
  }
}

/** Render a primitive through the pack and merge its declared
 *  imports into the context.  Each primitive's `imports` entry in
 *  pack.json drives the `<from>` and `<named>` set added to the
 *  page's import block.  When the pack manifest doesn't list a
 *  primitive in `imports`, we render anyway and rely on the
 *  template emitting whatever module-free JSX it wants
 *  (e.g. shadcn's primitives that emit only `<div className=…>`
 *  need no imports). */
export function renderPrimitive(ctx: WalkContext, name: string, templateCtx: unknown): string {
  const specs: ImportSpec[] = ctx.pack.manifest.imports?.[name] ?? [];
  for (const spec of specs) addImport(ctx, spec.from, ...spec.named);
  return ctx.pack.render(name, templateCtx);
}
