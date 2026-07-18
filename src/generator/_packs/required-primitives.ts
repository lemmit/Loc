// ---------------------------------------------------------------------------
// Required-primitives manifest — the minimum template surface a built-in
// pack must declare to load.  Validated at `compilePack` time so a pack
// missing `primitive-button` fails at load, not at the first call to
// `pack.render("primitive-button", ctx)` from deep inside the React or
// LiveView walker.
//
// Why this lives in a separate file
// ---------------------------------
// `loader.ts` is format-agnostic.  The required-set is paradigm-specific
// — TSX packs MUST emit field-input-* / form-* (the React form pipeline),
// HEEx packs MUST NOT (Phoenix uses `AshPhoenix.Form` which generates
// inputs from the resource at compile time, so no Loom-side field-input
// templates exist).  Splitting the manifest from the loader lets the
// loader stay one switch-on-format below.
//
// Policy: how to add a primitive
// ------------------------------
// 1. Ship it in `mantine/v9` first (the lead pack).
// 2. Backfill the other three TSX packs: `shadcn/v4`, `mui/v7`, `chakra/v3`.
// 3. Add to `REQUIRED_PRIMITIVES.tsx.core` here.
// 4. (Optional) Backfill `coreComponents/v3` if the primitive makes sense in
//    LiveView; if you do, move it from TSX-only to both formats.
//
// Why staged: a primitive in this list is a hard load-time failure if
// ANY pack misses it.  Landing it in only one pack first lets snapshot
// + matrix tests prove the new template before the gate flips.
//
// Pack-private extras (`tailwind-config`, `lib-utils`, `components-ui-*`,
// chakra's `toaster`) stay in `shellFiles` / `shellGlobs` — they're not
// part of the required surface because not every pack needs them.
// ---------------------------------------------------------------------------

import type { PackFormat } from "./loader.js";

export interface RequiredSet {
  /** Primitive templates the walker dispatches into per design pack.
   *  Both TSX and HEEx packs must emit the cross-format common set;
   *  each format may extend its own list. */
  core: readonly string[];
  /** Shell-level templates that scaffold the per-deployable output
   *  (entry point, package config, theme tokens, build config).
   *  Shared between formats. */
  shell: readonly string[];
  /** Form-field templates per FieldIR type.  TSX only — LiveView's
   *  `AshPhoenix.Form` generates inputs from the Ash resource at
   *  compile time, so no Loom-side templates participate. */
  fieldInput?: readonly string[];
  /** Form-level templates (form-of-decls, op-decls, etc.).  TSX only,
   *  same reason as `fieldInput`. */
  form?: readonly string[];
}

// Primitives common to BOTH formats.  Adding here means every pack
// (TSX × 4 + HEEx) must implement.  TSX-only primitives go in
// `TSX_ONLY_PRIMITIVES` below.
const SHARED_PRIMITIVES: readonly string[] = [
  "primitive-alert",
  "primitive-anchor",
  "primitive-avatar",
  "primitive-badge",
  "primitive-bold",
  "primitive-breadcrumbs",
  "primitive-button",
  "primitive-card",
  "primitive-container",
  "primitive-date-display",
  "primitive-divider",
  "primitive-empty",
  "primitive-enum-badge",
  "primitive-field",
  "primitive-form-of",
  "primitive-grid",
  "primitive-group",
  "primitive-heading",
  "primitive-id-link",
  "primitive-image",
  "primitive-inline-code",
  "primitive-italic",
  "primitive-key-value-row",
  "primitive-loader",
  "primitive-money",
  "primitive-multiline-field",
  "primitive-number-field",
  "primitive-paper",
  "primitive-password-field",
  "primitive-query-view",
  "primitive-select-field",
  "primitive-skeleton",
  "primitive-stack",
  "primitive-stat",
  "primitive-table",
  "primitive-tabs",
  "primitive-text",
  "primitive-toggle",
  "primitive-toolbar",
];

// Primitives required only in the JSX-family packs (TSX / Svelte / Vue /
// Angular — every format whose required set spreads this list).  Each is in
// the closed primitive library and the validator accepts it on ANY target,
// so a JSX pack that omits the template crashes codegen at the `pack.render`
// call site rather than failing validation — these MUST be required.  HEEx is
// exempt only because its walker emits them INLINE (no pack template):
//   - `primitive-code-block`  — not in the HEEx pack; emitted inline by
//                                `heex-walker.ts:renderCodeBlock`.
//   - `primitive-icon`        — not in the HEEx pack; emitted inline by
//                                `heex-walker.ts:renderIcon`.
//   - `primitive-modal`       — emitted inline by `heex-walker.ts:renderModal`
//                                as a `<.button phx-click={show_modal(id)}>`
//                                trigger + `<.modal id=…>` body hosting a
//                                `<.simple_form>`.  HEEx body primitives are
//                                walker-inline by design (one CoreComponents
//                                convention vs TSX's competing libraries) — no
//                                pack template is needed and the gate is
//                                deliberately not extended to HEEx for these.
//   - `primitive-section`     — plain `<section>` semantic anchor wrapper;
//                                HEEx renders it inline via `renderSectionHeex`.
//   - `primitive-sticky`      — `position: sticky` wrapper; HEEx renders it
//                                inline via `renderStickyHeex`.
const TSX_ONLY_PRIMITIVES: readonly string[] = [
  "primitive-code-block",
  "primitive-icon",
  "primitive-modal",
  "primitive-section",
  "primitive-sticky",
];

// Primitives the Flutter walking-skeleton pack renders INLINE via the walker
// seams (Track B/D) or DEFERS to full parity — never as a `flutter` pack
// template.  Subtracted from the shared + TSX-only lists to form the
// `flutter` required surface (the display / layout primitives only).  Mirrors
// how `angular` drops `primitive-form-of` / `primitive-modal`; Flutter drops
// the whole interactive-input family too (`Field*` / `Toggle` / `Tabs` are
// deferred Material `TextFormField` / `Switch` / `DefaultTabController` work).
const FLUTTER_INLINE_OR_DEFERRED: ReadonlySet<string> = new Set([
  "primitive-form-of",
  "primitive-modal",
  "primitive-field",
  "primitive-multiline-field",
  "primitive-number-field",
  "primitive-password-field",
  "primitive-select-field",
  "primitive-toggle",
  "primitive-tabs",
]);

// Shell-level templates every pack must emit, regardless of format.
const SHARED_SHELL: readonly string[] = [
  "app-shell",
  "format-helpers",
  "main",
  "package-json",
  "theme",
  "tsconfig",
  "vite-config",
];

const TSX_FIELD_INPUT: readonly string[] = [
  "field-input-array",
  "field-input-bool",
  "field-input-datetime",
  "field-input-decimal",
  "field-input-enum-select",
  "field-input-id-select",
  "field-input-id-text",
  "field-input-int",
  "field-input-money",
  "field-input-string",
  "field-input-valueobject",
];

const TSX_FORM: readonly string[] = [
  "form-default-onsubmit",
  "form-of-decls",
  "form-op-decls",
  "form-op-module",
  "form-runs-decls",
  // The one-statement toast a `on <channel>.<Event>` live-event handler
  // renders into RealtimeHandlers.tsx (channels.md Part I).  An optional
  // sibling `realtime-toast-setup` (chakra v2's `const toast = useToast()`)
  // stays pack-private — only the call template is required.
  "realtime-toast",
];

// `flutter` is keyed alongside the `PackFormat` union here (rather than in
// `PackFormat` itself) because the format is registered by the Flutter-target
// integrator in `src/util/builtin-formats.ts`; the required-set only needs the
// key.  When that registration lands, `PackFormat | "flutter"` collapses to
// `PackFormat` with no change here.
export const REQUIRED_PRIMITIVES: Record<PackFormat | "flutter", RequiredSet> = {
  tsx: {
    core: [...SHARED_PRIMITIVES, ...TSX_ONLY_PRIMITIVES],
    shell: SHARED_SHELL,
    fieldInput: TSX_FIELD_INPUT,
    form: TSX_FORM,
  },
  heex: {
    core: SHARED_PRIMITIVES,
    shell: SHARED_SHELL,
  },
  // Svelte packs own forms + field inputs exactly the way TSX packs do
  // (hand-rolled runes + zod form helper; no AshPhoenix.Form analogue),
  // so the required surface mirrors TSX.  The one delta: SvelteKit
  // projects need a `svelte-config` shell template (svelte.config.js)
  // that the TSX/Vite world has no counterpart for.
  svelte: {
    core: [...SHARED_PRIMITIVES, ...TSX_ONLY_PRIMITIVES],
    shell: [...SHARED_SHELL, "svelte-config"],
    fieldInput: TSX_FIELD_INPUT,
    form: TSX_FORM,
  },
  // Vue packs own forms + field inputs the way TSX packs do
  // (hand-rolled reactive() + zod form helper), so the required
  // surface mirrors TSX exactly — the Vite+vue-router SPA shape needs
  // no shell template beyond the shared set (vite config / theme /
  // app shell are all covered by SHARED_SHELL names).
  vue: {
    core: [...SHARED_PRIMITIVES, ...TSX_ONLY_PRIMITIVES],
    shell: SHARED_SHELL,
    fieldInput: TSX_FIELD_INPUT,
    // Vue packs additionally own the operation-dialog wrapper the
    // page shell renders around op-form fields (v-dialog on vuetify,
    // the ui Dialog components on shadcnVue).
    form: [...TSX_FORM, "op-dialog"],
  },
  // Angular's form path DIVERGES from the TSX/Vue packs: every form
  // primitive (`CreateForm` / `OperationForm` / `Modal` / `WorkflowForm` /
  // `DestroyForm`) renders as INLINE typed Reactive Forms via the Angular
  // walker seams (`src/generator/angular/*-form.ts`), never dispatching the
  // `primitive-form-of` shell, the `primitive-modal` template, or the
  // `field-input-*` / `form-*` templates.  The required surface is therefore
  // the display / layout / input primitives ONLY — minus `form-of` + `modal`
  // from the shared lists, and no `fieldInput` / `form` sets.  Shell delta:
  // Angular emits an `angular-json` (CLI workspace) instead of `vite-config`.
  angular: {
    core: [
      ...SHARED_PRIMITIVES.filter((p) => p !== "primitive-form-of"),
      ...TSX_ONLY_PRIMITIVES.filter((p) => p !== "primitive-modal"),
    ],
    shell: [
      "app-shell",
      "format-helpers",
      "main",
      "package-json",
      "theme",
      "tsconfig",
      "angular-json",
    ],
  },
  // Flutter (flutter-mobile-implementation.md Track C — WALKING SKELETON).
  // Flutter is a Feliz clone: a non-JSX widget-tree target rendered by a
  // PROCEDURAL pack (`src/generator/flutter/pack.ts`, Material widgets), not a
  // `designs/` Handlebars tree.  Like `angular`, its form/modal/input family
  // renders INLINE via the walker seams (or is deferred to full parity), so the
  // required surface is the DISPLAY / layout primitives ONLY: the shared set
  // minus the interactive `FLUTTER_INLINE_OR_DEFERRED` names, plus the TSX-only
  // display primitives (`code-block` / `icon` / `section` / `sticky`) minus
  // `modal`.  No `fieldInput` / `form` sets.  Shell delta: a single Dart
  // `pubspec` in place of the Vite world's `package-json` + `vite-config` +
  // `tsconfig` (Flutter builds via `flutter build`, not npm/tsc).
  flutter: {
    core: [
      ...SHARED_PRIMITIVES.filter((p) => !FLUTTER_INLINE_OR_DEFERRED.has(p)),
      ...TSX_ONLY_PRIMITIVES.filter((p) => !FLUTTER_INLINE_OR_DEFERRED.has(p)),
    ],
    shell: ["pubspec"],
  },
};

/** Flatten a `RequiredSet` to a single list — every name a pack must
 *  satisfy via `emits` or `sharedSources`.  Order is stable for
 *  reproducible error messages. */
export function flattenRequired(set: RequiredSet): readonly string[] {
  return [...set.core, ...set.shell, ...(set.fieldInput ?? []), ...(set.form ?? [])];
}
