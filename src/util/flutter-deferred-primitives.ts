// ---------------------------------------------------------------------------
// Flutter primitive-coverage sets — the single source of truth shared by the
// pack required-primitives manifest and the IR validator gate.
//
// Two DISTINCT concerns, deliberately two sets:
//
//   1. FLUTTER_PACK_TEMPLATE_EXCLUDED — primitives the flutter pack does NOT
//      ship as a pack template.  `required-primitives.ts` SUBTRACTS these from
//      the `flutter` required surface.  It has two sub-reasons:
//        • rendered INLINE via the `flutterTarget` walker SEAMS, not a pack
//          template — the whole form family (`primitive-form-of` →
//          CreateForm/OperationForm/WorkflowForm/DestroyForm) and `Modal`.
//          These WORK; they just aren't pack templates.
//        • genuinely DEFERRED (see set 2).
//
//   2. FLUTTER_UNRENDERED_PRIMITIVES — primitives with NO Flutter renderer at
//      all: a page using one emits a `// flutter pack: no renderer` comment
//      where the widget should be and the UI element silently VANISHES.
//      `system-checks.ts` (`validateFlutterPrimitiveSupport`) REJECTS these on a
//      `platform: flutter` target — `loom.flutter-primitive-unsupported` — so
//      the gap fails fast at compile time instead of vanishing silently.  This
//      is a STRICT SUBSET of set 1 (a genuinely-unrendered primitive is also not
//      a pack template) — the seam-rendered forms/Modal are in set 1 but NOT
//      set 2, so the gate never rejects a working primitive.
//
// Homed in `src/util/` — the layer BOTH the generator (`src/generator/_packs`)
// and the IR validator (`src/ir/validate`) import without inverting the
// pipeline.  Mirrors how `walker-primitive-names.ts` is shared.
//
// Give a primitive a real Flutter renderer → remove it from BOTH sets in one
// edit: the pack required-surface picks it up (the pack must now ship it) and
// the validator gate stops rejecting it.  The controlled inputs Field /
// MultilineField / PasswordField / Toggle / SelectField were landed this way
// (flutter pack `RENDERERS`), so they are absent from both sets below.
// ---------------------------------------------------------------------------

/** Pack primitive-template ids the flutter pack does NOT ship as a template —
 *  seam-rendered (form family, Modal) OR genuinely deferred (set 2).  Subtracted
 *  from the `flutter` required surface by `required-primitives.ts`. */
export const FLUTTER_INLINE_OR_DEFERRED: ReadonlySet<string> = new Set([
  // Seam-rendered (walker SEAMS, not pack templates) — these WORK.
  "primitive-form-of",
  "primitive-modal",
  // Genuinely deferred — no renderer yet (kept in sync with set 2 below).
  "primitive-file-upload",
  "primitive-number-field",
  "primitive-tabs",
]);

/** Pack primitive-template ids with NO Flutter renderer at all — a page using
 *  one silently drops the widget.  The validator gate rejects these on a
 *  `platform: flutter` target.  STRICT SUBSET of {@link FLUTTER_INLINE_OR_DEFERRED}
 *  (excludes the seam-rendered form family + Modal). */
export const FLUTTER_UNRENDERED_PRIMITIVES: ReadonlySet<string> = new Set([
  // FileUpload — multipart POST to `/files`; folds into M-T1.2 slice 4.
  "primitive-file-upload",
  // NumberField — needs the bound field's int-vs-double type to parse the text
  // input; the shared input Ctx carries only the bind NAME.
  "primitive-number-field",
  // Tabs — `DefaultTabController` + per-tab child panes (a container, not a
  // leaf input).
  "primitive-tabs",
]);

// Maps each UNRENDERED pack-template id to the walker builder-call NAME(s) that
// emit through it — the PascalCase names that appear in a page body.  Every id
// in FLUTTER_UNRENDERED_PRIMITIVES MUST have an entry;
// `flutter-deferred-primitives.test.ts` pins that so a newly-deferred id can't
// slip through the gate unmapped.
const UNRENDERED_ID_TO_BUILDER_NAMES: ReadonlyMap<string, readonly string[]> = new Map([
  ["primitive-file-upload", ["FileUpload"]],
  ["primitive-number-field", ["NumberField"]],
  ["primitive-tabs", ["Tabs"]],
]);

/** The flat set of walker builder-call NAMES the validator gates on a
 *  `platform: flutter` target — DERIVED from {@link FLUTTER_UNRENDERED_PRIMITIVES}
 *  via {@link UNRENDERED_ID_TO_BUILDER_NAMES}.  Remove a primitive from that set
 *  (once it gets a real Flutter renderer) and its builder name drops out of the
 *  gate automatically. */
export const FLUTTER_DEFERRED_BUILDER_NAMES: ReadonlySet<string> = new Set(
  [...FLUTTER_UNRENDERED_PRIMITIVES].flatMap((id) => UNRENDERED_ID_TO_BUILDER_NAMES.get(id) ?? []),
);

/** The `primitive-*` ids in {@link FLUTTER_UNRENDERED_PRIMITIVES} that lack an
 *  {@link UNRENDERED_ID_TO_BUILDER_NAMES} entry — non-empty means a deferred id
 *  would escape the validator gate.  Consumed only by the completeness test. */
export const UNMAPPED_DEFERRED_IDS: readonly string[] = [...FLUTTER_UNRENDERED_PRIMITIVES].filter(
  (id) => !UNRENDERED_ID_TO_BUILDER_NAMES.has(id),
);
