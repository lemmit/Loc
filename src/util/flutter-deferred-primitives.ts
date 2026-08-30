// ---------------------------------------------------------------------------
// Flutter primitive-coverage sets — the single source of truth shared by the
// pack required-primitives manifest and the IR validator gate.
//
// Two DISTINCT concerns, deliberately two sets:
//
//   1. FLUTTER_INLINE_OR_DEFERRED — primitives the flutter pack does NOT ship as
//      a pack template.  `required-primitives.ts` SUBTRACTS these from the
//      `flutter` required surface.  Today this is exactly the walker-SEAM-
//      rendered pair (the whole form family `primitive-form-of` →
//      CreateForm/OperationForm/WorkflowForm/DestroyForm, and `Modal`): they
//      render, just not through a pack template — PLUS `primitive-data-grid`,
//      which is a deliberate non-goal on Flutter (see the set's own doc).
//
//   2. FLUTTER_UNRENDERED_PRIMITIVES — primitives with NO Flutter renderer at
//      all: a page using one would emit a `// flutter pack: no renderer` comment
//      where the widget should be and the UI element would silently VANISH.
//      `system-checks.ts` (`validateFlutterPrimitiveSupport`) REJECTS these on a
//      `platform: flutter` target — `loom.flutter-primitive-unsupported`.  This
//      is a STRICT SUBSET of set 1.  **It is currently EMPTY** — every page
//      primitive renders on Flutter (the controlled inputs Field /
//      MultilineField / PasswordField / NumberField / Toggle / SelectField and
//      the standalone FileUpload via the pack `RENDERERS`; Tabs as a container;
//      the form family + Modal via the walker seams).  The gate is retained as a
//      dormant safety net: adding any primitive back here (a future closed
//      primitive that Flutter can't yet render) re-arms it with no other edit.
//
// Homed in `src/util/` — the layer BOTH the generator (`src/generator/_packs`)
// and the IR validator (`src/ir/validate`) import without inverting the
// pipeline.  Mirrors how `walker-primitive-names.ts` is shared.
//
// Give a primitive a real Flutter renderer → remove it from BOTH sets in one
// edit: the pack required-surface picks it up (the pack must now ship it) and
// the validator gate stops rejecting it.  Field / … / NumberField / Tabs /
// FileUpload all landed this way, so they are absent from both sets below.
// ---------------------------------------------------------------------------

/** Pack primitive-template ids the flutter pack does NOT ship as a template.
 *  Subtracted from the `flutter` required surface by `required-primitives.ts`.
 *
 *  Two reasons appear here, and they are not the same:
 *
 *    - the walker-SEAM-rendered form family + Modal, which WORK — just not via
 *      a pack template;
 *    - `primitive-data-grid`, which does NOT work on Flutter and — this is a
 *      settled DECISION, not a backlog item (M-T1.1, 2026-07-31) — is not going
 *      to.  `DataGrid` is a TanStack row model, so a target can host it only if
 *      it can host TANSTACK; there is no Dart adapter and no Dart port.
 *      Hand-rolling multi-column sort + per-column filters + a row model in
 *      Flutter would fork the grid's BEHAVIOUR from every other frontend, which
 *      is exactly what the shared `renderDataGridChild` seam exists to prevent.
 *      Flutter's `PaginatedDataTable`/`DataTable` make this tempting and are the
 *      trap: they give you *a* grid, not *the same* grid.
 *
 *      The contrast with Feliz is what makes this principled rather than
 *      arbitrary.  Feliz DID get a real DataGrid precisely because
 *      Fable compiles F# to JavaScript, so it binds `@tanstack/table-core` — the
 *      genuine row model — through ordinary interop.  Flutter has no such route:
 *      `dart:js_interop` exists on Flutter WEB only, while the shipping target
 *      (and `generated-flutter-build.yml`) builds a native APK with no JS
 *      runtime at all.  A web-only primitive that compiles on one Flutter target
 *      and not the other is worse than an honest gap.
 *
 *      `Table` remains the portable answer on Flutter — it carries column sort,
 *      pagination and filtering on every frontend — and that is what
 *      `loom.datagrid-unsupported-target` points authors at.
 *
 *      It is NOT in {@link FLUTTER_UNRENDERED_PRIMITIVES} because it
 *      already has a dedicated, better-worded gate —
 *      `loom.datagrid-unsupported-target` names `Table` as the portable
 *      alternative — and two gates for one condition is one too many. */
export const FLUTTER_INLINE_OR_DEFERRED: ReadonlySet<string> = new Set([
  "primitive-form-of",
  "primitive-modal",
  "primitive-data-grid",
]);

/** Pack primitive-template ids with NO Flutter renderer at all — a page using
 *  one would silently drop the widget, so the validator gate rejects it on a
 *  `platform: flutter` target.  STRICT SUBSET of {@link FLUTTER_INLINE_OR_DEFERRED}.
 *  Currently EMPTY (every page primitive renders); kept as a dormant safety net
 *  the gate re-arms from the moment any primitive is added back. */
export const FLUTTER_UNRENDERED_PRIMITIVES: ReadonlySet<string> = new Set<string>([]);

// Maps each UNRENDERED pack-template id to the walker builder-call NAME(s) that
// emit through it — the PascalCase names that appear in a page body.  Every id
// in FLUTTER_UNRENDERED_PRIMITIVES MUST have an entry;
// `flutter-primitive-support.test.ts` pins that so a re-armed deferred id can't
// slip through the gate unmapped.  (Empty today; a template for re-arming: e.g.
// `["primitive-file-upload", ["FileUpload"]]`.)
const UNRENDERED_ID_TO_BUILDER_NAMES: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([]);

/** The flat set of walker builder-call NAMES the validator gates on a
 *  `platform: flutter` target — DERIVED from {@link FLUTTER_UNRENDERED_PRIMITIVES}
 *  via {@link UNRENDERED_ID_TO_BUILDER_NAMES}.  Empty today (nothing is gated);
 *  a primitive added back to the unrendered set re-appears here automatically. */
export const FLUTTER_DEFERRED_BUILDER_NAMES: ReadonlySet<string> = new Set(
  [...FLUTTER_UNRENDERED_PRIMITIVES].flatMap((id) => UNRENDERED_ID_TO_BUILDER_NAMES.get(id) ?? []),
);

/** The `primitive-*` ids in {@link FLUTTER_UNRENDERED_PRIMITIVES} that lack an
 *  {@link UNRENDERED_ID_TO_BUILDER_NAMES} entry — non-empty means a deferred id
 *  would escape the validator gate.  Consumed only by the completeness test. */
export const UNMAPPED_DEFERRED_IDS: readonly string[] = [...FLUTTER_UNRENDERED_PRIMITIVES].filter(
  (id) => !UNRENDERED_ID_TO_BUILDER_NAMES.has(id),
);
