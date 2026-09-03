// Import-accumulation and primitive-render helpers shared by the body
// walker core and the per-primitive emitter modules.
//
// These touch the walk context's import sink (and, for the render
// helpers, the active design pack). Kept here so primitive modules can
// reuse them without dragging the rest of the walker.

import type { ImportSpec } from "../_packs/loader.js";
import { PACK_CHROME_T_CALL } from "../_packs/pack-chrome.js";
import type { FormFieldVM } from "../react/templating/view-models.js";
import type { ImportMap, WalkContext } from "./walker-core.js";

export type { ImportMap };

/** Import specifier for the generated translation helper. Written with the
 *  default one-hop `../` shape; `renderImportLines` rewrites it to the page's
 *  real depth (`../../i18n` for a `src/pages/orders/list.tsx`), and the
 *  non-React targets rewrite it to their own alias (`$lib/i18n`). */
export const I18N_MODULE = "../i18n";

/** The arbitrary-precision decimal runtime a `money` binding resolves against.
 *  Written as a bare package specifier, so no depth rewrite applies. */
export const DECIMAL_MODULE = "decimal.js";

/** Drain the `decimal.js` entry from a page's import map, reporting whether the
 *  active pack had declared it.
 *
 *  TWO owners want to put `Decimal` in the same emitted file.  Every React and
 *  Svelte pack declares `imports."field-input-money" = [{from: "decimal.js",
 *  named: ["Decimal"]}]`, which `registerFormFieldImports` merges into this map
 *  and the import-line renderers serialize as `import { Decimal } from
 *  "decimal.js";`.  The page shell independently emits its own `import Decimal
 *  from "decimal.js";` — decided by scanning the assembled body, because a
 *  `Decimal` binding has three producers (a money `state {}` field, an
 *  `exprConvert` cast, the `Decimal.min`/`.max`/`.ROUND_*` intrinsics) and only
 *  the rendered text knows about all three.  A money FORM FIELD triggers both:
 *  the pack template contains `new Decimal(…)`, so the shell's scan fires on
 *  exactly the page the pack declaration also lands in, and the file gets two
 *  `Decimal` bindings — `TS2300: Duplicate identifier` (svelte-check calls it
 *  `Identifier 'Decimal' has already been declared`).  The generated app does
 *  not build.
 *
 *  Same defect, and same remedy, as `takeReactSpecifiers`
 *  (`react/walker/import-lines.ts`), which drains `"react"`: the shell
 *  drains what the pack declared and stays the SINGLE emitter.  Draining rather
 *  than deleting the pack entries keeps an out-of-tree pack correct — it goes on
 *  declaring what its template needs and the shell absorbs the declaration —
 *  and keeps the shell honest for the producers no pack knows about.
 *
 *  The returned boolean is the second half of that absorption: a pack that
 *  declares the module but whose template the body scan cannot see (a `.hbs`
 *  reaching `Decimal` some other way) must still get the binding, so callers OR
 *  this into their own decimal-import fallback.
 *
 *  Both import forms are legal against decimal.js's typings — it declares
 *  `export declare class Decimal` AND `export default Decimal` — so absorbing a
 *  named import into the shell's default import loses nothing. */
export function takeDecimalImport(imports: ImportMap): boolean {
  return imports.delete(DECIMAL_MODULE);
}

/** Register the `t` import on the page's import map.  Chrome rendered straight
 *  INTO THE PAGE resolves `t` against the page's own import block and must ask
 *  for it; the hoisted-child helpers in `i18n-emit.ts` deliberately do not. */
export function registerI18nImport(ctx: WalkContext): void {
  addImport(ctx, I18N_MODULE, "t");
}

/** True when `rendered` carries a PACK-DECLARED chrome binding, i.e. the file
 *  it lands in has to resolve `t`.  The map-level twin of
 *  {@link wirePackChromeImport}, for a page-shell that assembles a pack
 *  fragment (an operation-form module) outside the walk and therefore holds an
 *  import map rather than a walk context. */
export function needsPackChromeT(rendered: string): boolean {
  return rendered.includes(PACK_CHROME_T_CALL);
}

/** Add a named import straight to an import MAP — for the same page-shell
 *  callers that have no walk context. */
export function addImportToMap(imports: ImportMap, from: string, ...names: string[]): void {
  let s = imports.get(from);
  if (!s) {
    s = new Set();
    imports.set(from, s);
  }
  for (const n of names) s.add(n);
}

/** Wire `t` into the page for PACK-DECLARED chrome (`pack.json`'s `chrome`
 *  map), by asking the RENDERED output whether any binding was emitted.
 *
 *  Nothing in the walk can answer that question up front: the string lives in a
 *  `.hbs`, behind the pack's own conditionals — a `{{#if rowFields}}` branch, a
 *  pack that renders no empty-picker option at all.  So this greps for the
 *  binding's literal prefix, the same honest question the hoisted-`DataGrid`-
 *  child renderers ask of their own bodies with `CHROME_T_CALL`.
 *
 *  Returns `rendered` unchanged so a call site can wrap an expression. */
export function wirePackChromeImport(ctx: WalkContext, rendered: string): string {
  if (rendered.includes(PACK_CHROME_T_CALL)) registerI18nImport(ctx);
  return rendered;
}

/** Append a named-import to the walker's per-source import map.
 *  Idempotent — duplicate names dedupe inside the Set per source. */
export function addImport(ctx: WalkContext, from: string, ...names: string[]): void {
  addImportToMap(ctx.imports, from, ...names);
}

/** Register a TYPE-ONLY named import: the map stores the inline
 *  `type X` import SPECIFIER, so every frontend's import-line renderer
 *  emits `import { type X, ... }` with no renderer change.  Required
 *  for a name that exists only in the type layer (the `<Action>FormState`
 *  aliases): SvelteKit's generated tsconfig turns `verbatimModuleSyntax`
 *  on, and under it a plain value import of a type is a hard
 *  svelte-check error (TS1484).  The inline form is what
 *  `verbatimModuleSyntax` prescribes, and is byte-inert everywhere a
 *  plain import already type-checked. */
export function addTypeImport(ctx: WalkContext, from: string, name: string): void {
  addImport(ctx, from, `type ${name}`);
}

/** Convenience for the (still many) emit functions that haven't been
 *  ported to the pack contract yet — they all want named imports
 *  from `@mantine/core`.  Keeps call sites compact and grep-able
 *  while the migration finishes. */
export function addMantineImport(ctx: WalkContext, ...names: string[]): void {
  addImport(ctx, "@mantine/core", ...names);
}

/** Register the imports a non-rendered primitive needs.  Used by
 *  `CreateForm(of:)` / `WorkflowForm(runs:)` emission: the form-
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
