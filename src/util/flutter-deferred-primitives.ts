// ---------------------------------------------------------------------------
// Flutter DEFERRED-primitive set — the single source of truth shared by the
// pack required-primitives manifest and the IR validator gate.
//
// The Flutter walking-skeleton pack renders the display / layout primitives but
// DEFERS the whole interactive input / form family (Material `TextFormField` /
// `Switch` / `DefaultTabController` work not yet done).  Two consumers read this
// set:
//
//   1. `src/generator/_packs/required-primitives.ts` SUBTRACTS it from the
//      `flutter` required surface, so the pack isn't forced to ship templates it
//      hasn't written.
//   2. `src/ir/validate/checks/system-checks.ts` (`validateFlutterPrimitiveSupport`)
//      REJECTS a page that uses one of these while targeting a `platform:
//      flutter` deployable — `loom.flutter-primitive-unsupported`.  Without the
//      gate a deferred primitive type-checks (frontends validate against the
//      target-AGNOSTIC walker-stdlib) and the Flutter walker emits a `// flutter
//      pack: no renderer` comment where the widget should be, so the UI element
//      silently vanishes.
//
// Homed in `src/util/` — the layer BOTH the generator (`src/generator/_packs`)
// and the IR validator (`src/ir/validate`) can import without inverting the
// pipeline (`util → *` is never a backward edge, unlike a validator reaching
// UPWARD into `generator/`).  Mirrors how `walker-primitive-names.ts` is shared.
//
// When a primitive later gets a real Flutter renderer, remove its `primitive-*`
// id here and BOTH the required-surface subtraction and the validator gate
// auto-update — the gate auto-closes with no second edit.
// ---------------------------------------------------------------------------

/** Pack primitive-template ids the Flutter pack renders INLINE via the walker
 *  seams or DEFERS to full parity — never as a `flutter` pack template. */
export const FLUTTER_INLINE_OR_DEFERRED: ReadonlySet<string> = new Set([
  "primitive-form-of",
  "primitive-modal",
  // FileUpload (M-T1.2 slice 4b) is a JSX/web primitive (multipart POST +
  // bind); the Flutter mobile pack defers it alongside the other inputs.
  "primitive-file-upload",
  "primitive-field",
  "primitive-multiline-field",
  "primitive-number-field",
  "primitive-password-field",
  "primitive-select-field",
  "primitive-toggle",
  "primitive-tabs",
]);

// Maps each deferred pack-template id to the walker builder-call NAME(s) that
// emit through it — the PascalCase names that appear in a page body (`Toggle`,
// `Field`, …).  `primitive-form-of` fans out to the whole named-form family
// (a single shared form shell backs CreateForm/OperationForm/WorkflowForm/
// DestroyForm).  Every id in FLUTTER_INLINE_OR_DEFERRED MUST have an entry here;
// `flutter-deferred-primitives.test.ts` pins that so a newly-deferred id can't
// slip through the gate unmapped.
const DEFERRED_ID_TO_BUILDER_NAMES: ReadonlyMap<string, readonly string[]> = new Map([
  ["primitive-form-of", ["CreateForm", "OperationForm", "WorkflowForm", "DestroyForm"]],
  ["primitive-modal", ["Modal"]],
  ["primitive-file-upload", ["FileUpload"]],
  ["primitive-field", ["Field"]],
  ["primitive-multiline-field", ["MultilineField"]],
  ["primitive-number-field", ["NumberField"]],
  ["primitive-password-field", ["PasswordField"]],
  ["primitive-select-field", ["SelectField"]],
  ["primitive-toggle", ["Toggle"]],
  ["primitive-tabs", ["Tabs"]],
]);

/** The flat set of walker builder-call NAMES the validator gates on a
 *  `platform: flutter` target — DERIVED from {@link FLUTTER_INLINE_OR_DEFERRED}
 *  via {@link DEFERRED_ID_TO_BUILDER_NAMES}.  Remove a primitive from
 *  FLUTTER_INLINE_OR_DEFERRED (once it gets a real Flutter renderer) and its
 *  builder name drops out of the gate automatically. */
export const FLUTTER_DEFERRED_BUILDER_NAMES: ReadonlySet<string> = new Set(
  [...FLUTTER_INLINE_OR_DEFERRED].flatMap((id) => DEFERRED_ID_TO_BUILDER_NAMES.get(id) ?? []),
);

/** The `primitive-*` ids in {@link FLUTTER_INLINE_OR_DEFERRED} that lack a
 *  {@link DEFERRED_ID_TO_BUILDER_NAMES} entry — non-empty means a deferred id
 *  would escape the validator gate.  Consumed only by the completeness test. */
export const UNMAPPED_DEFERRED_IDS: readonly string[] = [...FLUTTER_INLINE_OR_DEFERRED].filter(
  (id) => !DEFERRED_ID_TO_BUILDER_NAMES.has(id),
);
