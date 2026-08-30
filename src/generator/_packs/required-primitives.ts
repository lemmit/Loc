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
// HEEx packs MUST NOT (the LiveView walker renders form inputs inline
// through the pack-emitted CoreComponents `<.input>`, so no Loom-side
// field-input templates exist).  Splitting the manifest from the loader
// lets the loader stay one switch-on-format below.
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

import { FLUTTER_INLINE_OR_DEFERRED } from "../../util/flutter-deferred-primitives.js";
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
  /** Form-field templates per FieldIR type.  Not used by HEEx: the Ash
   *  foundation (and its `AshPhoenix.Form`) was removed, and plain
   *  Ecto/Phoenix renders inputs through the pack's `core-components`
   *  shell template instead, so no per-field Loom-side templates
   *  participate on that format. */
  fieldInput?: readonly string[];
  /** Form-level templates (form-of-decls, op-decls, etc.).  Not used by
   *  HEEx, same reason as `fieldInput`. */
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
  // The standalone `FileUpload { bind: … }` input.  Required on every
  // JSX-family format (tsx / svelte / vue / angular — each spreads this list).
  // HEEx is exempt for a TEMPLATE reason, NOT a rendering gap: `FileUpload`
  // HAS a HEEx renderer (`renderFileUploadHeex`, wired in
  // `_walker/registry.ts`, using LiveView's native
  // `allow_upload`/`<.live_file_input>` flow), and `KNOWN_HEEX_GAPS` in
  // heex-parity.test.ts no longer lists it — `DataGrid` is the sole entry.
  // It is exempt because heex's required set is `SHARED_PRIMITIVES` only:
  // HEEx packs own no call-site primitive templates at all.
  "primitive-file-upload",
  "primitive-icon",
  "primitive-modal",
  "primitive-section",
  "primitive-sticky",
];

// `Modal { open: <state-bool> }` — the STATE-CONTROLLED dialog (distinct from
// the operation-form modal above).  `_walker/primitives/forms.ts:
// emitControlledModal` dispatches it behind a `templates.has(...)` probe and
// falls back to a stub when the pack ships no template, so a pack that omits
// it degrades SILENTLY — the page compiles, the dialog just never opens.  All
// 15 JSX-family packs ship the template today; requiring it turns the next
// pack that forgets into a load-time failure instead of a dead dialog.
//
// Kept OUT of `TSX_ONLY_PRIMITIVES` because that list is filtered per format
// for `primitive-modal`, and the controlled modal's format story is DIFFERENT
// from the op-dialog modal's on every format that diverges:
//   - angular DROPS `primitive-modal` (inline Reactive Forms) but KEEPS this
//     one: `renderAngularModal` forks only the op-dialog shape and returns null
//     for `open:`, so the walker falls through to the pack template.
//   - flutter DROPS `primitive-modal` (`FLUTTER_INLINE_OR_DEFERRED`) but ships a
//     real `primitiveModalControlled` (a `LoomModalHost`), and feliz ships one
//     too — both PROCEDURAL packs genuinely pack-dispatch it, so it belongs in
//     their required surface (enforced by the *-pack-groundwork tests rather
//     than the load-time gate, which procedural packs never reach).
//   - heex is the ONLY exemption: its walker emits the modal inline through
//     `renderModalHeex`, and a HEEx pack owns no call-site primitive templates
//     at all (`heex.core` is empty).
const CONTROLLED_MODAL_PRIMITIVES: readonly string[] = ["primitive-modal-controlled"];

// Primitives the Flutter walking-skeleton pack renders INLINE via the walker
// seams (Track B/D) or DEFERS to full parity — never as a `flutter` pack
// template.  Subtracted from the shared + TSX-only lists below to form the
// `flutter` required surface (the display / layout primitives only).  Mirrors
// how `angular` drops `primitive-form-of` / `primitive-modal`; Flutter drops
// the whole interactive-input family too (`Field*` / `Toggle` / `Tabs` are
// deferred Material `TextFormField` / `Switch` / `DefaultTabController` work).
//
// SINGLE SOURCE OF TRUTH — the set is homed in `src/util/` (a layer the IR
// validator can also import) so the `loom.flutter-primitive-unsupported` honest
// gate rejects the same primitives this manifest subtracts.  Remove a primitive
// there once it gets a real Flutter renderer and both this required-surface
// subtraction and the validator gate update together.

// Shell-level templates every JSX-family pack must emit.
const SHARED_SHELL: readonly string[] = [
  "app-shell",
  "format-helpers",
  "main",
  "package-json",
  "theme",
  "tsconfig",
  "vite-config",
];

// Shell surface of a HEEx pack — every name here is rendered by the elixir
// generator (vanilla/shell-emit.ts + vanilla/index.ts + sidebar-emit.ts), and
// nothing else is: a template absent from this list and from the generator's
// render calls does not belong in a HEEx pack.  Names shared with
// SHARED_SHELL keep their meaning by analogy (`main` = the root document,
// `app-shell` = the app chrome/layout, `theme` = the design-token stylesheet,
// `package-json` = the assets build manifest); the TSX-only build-config names
// (`tsconfig`/`vite-config`/`format-helpers`) have no Phoenix counterpart and
// are deliberately NOT required.
const HEEX_SHELL: readonly string[] = [
  "app-shell",
  "assets-css",
  "assets-js",
  "core-components",
  "main",
  "package-json",
  "sidebar",
  "sidebar-entry",
  "tailwind-config",
  "theme",
];

const TSX_FIELD_INPUT: readonly string[] = [
  "field-input-array",
  "field-input-bool",
  "field-input-datetime",
  "field-input-decimal",
  "field-input-enum-select",
  // In-form `File` field → file input + `api.upload` → FileRef.  Required on the
  // form-owning JSX formats (tsx / svelte / vue — each spreads this list).
  // Angular has no `fieldInput` set (its File field renders inline via the
  // `form-fields.ts` seam); HEEx has no field-input templates at all.
  "field-input-file",
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

// `flutter` and `feliz` are keyed alongside the `PackFormat` union here (rather
// than in `PackFormat` itself) because both ship PROCEDURAL packs (F#/Dart code,
// not `.hbs` templates) constructed directly — they never pass through
// `compilePack`, so the load-time gate (`loader.ts:346`) never runs for them and
// there is no `PackFormat` value to register.  Their required set is instead the
// contract a dedicated groundwork test enforces structurally
// (`flutter-pack-groundwork.test.ts` / `feliz-pack-groundwork.test.ts`): every
// `core` name must have a real renderer, not the missing-renderer sentinel.
// `DataGrid` — the TanStack-Table-backed interactive grid.  Deliberately NOT in
// `TSX_ONLY_PRIMITIVES`: that list is spread into the `flutter` core too, and
// Flutter has no TanStack adapter and is not getting one (its native target has
// no JS runtime at all — see `src/util/flutter-deferred-primitives.ts`).  Spread
// into exactly the formats that ship a `renderDataGridChild` seam: the four JSX
// ones plus `feliz`, whose procedural pack renders the same TanStack instance —
// Fable compiles F# to JavaScript, so it binds `@tanstack/table-core` directly
// instead of re-implementing a row model.  HEEx is out for a third reason: a
// CLIENT row model has no LiveView analogue, so `Table` is server-driven there.
// Flutter and HEEx stay honest gaps, rejected by
// `loom.datagrid-unsupported-target` rather than rendering a blank page region.
const DATA_GRID_PRIMITIVES: readonly string[] = ["primitive-data-grid"];

// `Chart` — the line/bar chart over a grouped projection's LIST response
// (M-T1.3 Phase 4).  Required of the TSX packs ONLY, and that is a statement
// about WHERE THE TEMPLATE LIVES, not about which frameworks can draw a chart.
//
// tsx is per-PACK because each tsx pack binds its own charting library
// (`@mantine/charts`, `@mui/x-charts`, recharts for shadcn/chakra) as a
// conditional dependency — eight packs, eight different components, so each
// must declare its own `primitive-chart`.
//
// Vue / Svelte / Angular need no per-pack entry because ONE shared template
// serves every pack of the format: `vue/primitive-chart.hbs`,
// `sveltekit/primitive-chart.hbs`, `angular/primitive-chart.hbs`.  `loader.ts`
// merges the repo-root shared layers into the same template map a pack renders
// from, so `pack.render("primitive-chart")` resolves on vuetify / shadcnVue /
// flowbite / shadcnSvelte / angularMaterial / primeng / spartanNg with no pack
// declaration.  Listing it in their `core` would demand a redundant per-pack
// copy of a file that already exists.
//
// Feliz and Flutter render it through `renderChartData` + their PROCEDURAL
// packs (inline SVG / a `CustomPainter`, no library); HEEx has its own
// `renderChartHeex` (the rows are already in a server assign, so the geometry
// is arithmetic).  Neither format has a `designs/` .hbs tree to require it in.
//
// So `Chart` reaches ALL SEVEN frameworks, which is why `CHART_FRAMEWORKS`
// (`src/ir/validate/checks/system-checks.ts`) lists all seven and
// `loom.chart-unsupported-target` no longer fires for anything that ships — it
// is the seam a NEW frontend gates on until it ports, not a live gap.  (This
// block used to say vue/svelte/angular "ship no chart template … so every one
// of those stays an honest gap"; both halves were false.)
const CHART_PRIMITIVES: readonly string[] = ["primitive-chart"];

export const REQUIRED_PRIMITIVES: Record<PackFormat | "flutter" | "feliz", RequiredSet> = {
  tsx: {
    core: [
      ...SHARED_PRIMITIVES,
      ...TSX_ONLY_PRIMITIVES,
      ...CONTROLLED_MODAL_PRIMITIVES,
      ...DATA_GRID_PRIMITIVES,
      ...CHART_PRIMITIVES,
    ],
    shell: SHARED_SHELL,
    fieldInput: TSX_FIELD_INPUT,
    form: TSX_FORM,
  },
  // HEEx packs own NO per-call-site primitive templates: LiveView has one
  // component convention (CoreComponents), so the walker emits design-neutral
  // markup + `<.button>`/`<.table>`/`<.input>`/`<.modal>`-style component
  // calls inline, and the ENTIRE design vocabulary lives in the pack-emitted
  // shell surface below — `core-components` (the function-component library
  // every page renders through), the layouts (`main` = root.html.heex,
  // `app-shell` = app.html.heex, `sidebar`(+`-entry`) = sidebar.ex), the
  // `theme` token CSS, and the assets pipeline (`assets-css`/`assets-js`/
  // `tailwind-config`/`package-json` → assets/, built into
  // priv/static/assets).  That is where `coreComponents` and `daisyui`
  // diverge; a HEEx pack with call-site primitive templates would be dead
  // weight (the walker never dispatches into them).
  heex: {
    core: [],
    shell: HEEX_SHELL,
  },
  // Svelte packs own forms + field inputs exactly the way TSX packs do
  // (hand-rolled runes + zod form helper; no AshPhoenix.Form analogue),
  // so the required surface mirrors TSX.  The one delta: SvelteKit
  // projects need a `svelte-config` shell template (svelte.config.js)
  // that the TSX/Vite world has no counterpart for.
  svelte: {
    core: [
      ...SHARED_PRIMITIVES,
      ...TSX_ONLY_PRIMITIVES,
      ...CONTROLLED_MODAL_PRIMITIVES,
      ...DATA_GRID_PRIMITIVES,
    ],
    shell: [...SHARED_SHELL, "svelte-config"],
    fieldInput: TSX_FIELD_INPUT,
    form: TSX_FORM,
  },
  // Vue packs own forms + field inputs the way TSX packs do
  // (vee-validate `useLoomForm` helper over the shared zod schema), so the required
  // surface mirrors TSX exactly — the Vite+vue-router SPA shape needs
  // no shell template beyond the shared set (vite config / theme /
  // app shell are all covered by SHARED_SHELL names).
  vue: {
    core: [
      ...SHARED_PRIMITIVES,
      ...TSX_ONLY_PRIMITIVES,
      ...CONTROLLED_MODAL_PRIMITIVES,
      ...DATA_GRID_PRIMITIVES,
    ],
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
      // The op-dialog `primitive-modal` is dropped (inline Reactive Forms), but
      // the STATE-CONTROLLED one is not: `renderAngularModal` returns null for
      // the `open:` shape, so the walker falls through to the pack template.
      ...CONTROLLED_MODAL_PRIMITIVES,
      ...DATA_GRID_PRIMITIVES,
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
    // The one-statement toast a `on <channel>.<Event>` live-event handler
    // renders into RealtimeHandlersComponent (channels.md Part I).  Each
    // Angular pack calls the generator-emitted `LoomToastService`; the
    // sibling `realtime-toast-setup` (the `inject(...)` line) stays
    // pack-private — only the call template is required.
    form: ["realtime-toast"],
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
      // Not subtracted with `primitive-modal`: the op-dialog modal renders
      // through the walker seam, but the STATE-CONTROLLED one has a real
      // `primitiveModalControlled` renderer in the flutter pack.
      ...CONTROLLED_MODAL_PRIMITIVES,
    ],
    shell: ["pubspec"],
  },
  // Feliz (fable-elmish-frontend.md §4 — F#/Fable/Elmish).  A second PROCEDURAL
  // pack (`src/generator/feliz/pack.ts`, daisyUI-classed `Html.div [ … ]` F#),
  // constructed directly in `feliz/index.ts` — so, like `flutter`, it never
  // passes through `compilePack` and this entry is enforced by the groundwork
  // test, not the load-time gate.  The required surface is the FULL JSX-family
  // display + input primitive set MINUS `primitive-form-of`: Feliz's forms
  // (Create/Op/Workflow/Destroy) render inline through the Elmish
  // `renderCreateForm`… seams (`feliz-target.ts`), so `primitive-form-of` never
  // pack-dispatches (same drop as `angular`).  Feliz DOES keep `primitive-modal`
  // (it ships a real `primitiveModal` renderer — unlike `angular`, which renders
  // the modal inline).  No `fieldInput` / `form` sets (the field-input-* / form-*
  // TSX form-pipeline templates have no procedural analogue), and no `shell` set:
  // the Feliz project shell (main / package.json / vite / fable config) is
  // emitted by `feliz/index.ts` directly, not by the pack.
  feliz: {
    core: [
      ...SHARED_PRIMITIVES.filter((p) => p !== "primitive-form-of"),
      ...TSX_ONLY_PRIMITIVES,
      ...CONTROLLED_MODAL_PRIMITIVES,
      ...DATA_GRID_PRIMITIVES,
    ],
    shell: [],
  },
};

/** Flatten a `RequiredSet` to a single list — every name a pack must
 *  satisfy via `emits` or `sharedSources`.  Order is stable for
 *  reproducible error messages. */
export function flattenRequired(set: RequiredSet): readonly string[] {
  return [...set.core, ...set.shell, ...(set.fieldInput ?? []), ...(set.form ?? [])];
}
