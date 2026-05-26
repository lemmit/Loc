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
// 4. (Optional) Backfill `ashPhoenix/v3` if the primitive makes sense in
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
  "primitive-number-field",
  "primitive-paper",
  "primitive-password-field",
  "primitive-query-view",
  "primitive-skeleton",
  "primitive-stack",
  "primitive-stat",
  "primitive-table",
  "primitive-tabs",
  "primitive-text",
  "primitive-toggle",
  "primitive-toolbar",
];

// Primitives required only in TSX packs.  Three slots `ashPhoenix/v3`
// doesn't ship:
//   - `primitive-code-block`  — not in the HEEx pack.
//   - `primitive-icon`        — not in the HEEx pack.
//   - `primitive-modal`       — `heex-walker.ts` renders a placeholder;
//                                promoting this to the HEEx required
//                                set requires backfilling ashPhoenix v3.
const TSX_ONLY_PRIMITIVES: readonly string[] = [
  "primitive-code-block",
  "primitive-icon",
  "primitive-modal",
];

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
];

export const REQUIRED_PRIMITIVES: Record<PackFormat, RequiredSet> = {
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
};

/** Flatten a `RequiredSet` to a single list — every name a pack must
 *  satisfy via `emits` or `sharedSources`.  Order is stable for
 *  reproducible error messages. */
export function flattenRequired(set: RequiredSet): readonly string[] {
  return [...set.core, ...set.shell, ...(set.fieldInput ?? []), ...(set.form ?? [])];
}
