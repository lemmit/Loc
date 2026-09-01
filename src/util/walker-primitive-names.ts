// ---------------------------------------------------------------------------
// Walker primitive NAME sets — the shared vocabulary of body/component-body
// primitives, admissible as BuilderCall types without resolving to a
// user-declared type.
//
// Homed in `src/util/` because BOTH the language validator (via the
// `src/language/walker-stdlib.ts` mirror) AND the generator body-walker
// (`src/generator/_walker/walker-core.ts`) consume it — a shared name set
// belongs at the layer its consumers live at, never imported "upward"
// against the pipeline.  Previously it lived in `language/`, which made
// `walker-core.ts`'s import a `generator → language` value edge (caught by
// the hardened layering gate).
//
// Two sets:
//   WALKER_LAYOUT_PRIMITIVES — top-level layout / formatter primitives
//     (`Stack`, `Heading`, `Money` as a UI formatter, …) + the named-leaf
//     form variants (`CreateForm`, `OperationForm`, `WorkflowForm`).
//   WALKER_SUB_PRIMITIVES    — sub-elements that only appear nested inside
//     a parent (`Tab` inside `Tabs`, `Column` inside `Table`).
//
// These sets are DERIVED — the single source of truth is the typed
// dispatch table at src/generator/_walker/registry.ts, which holds the
// renderer functions for each target (React/TSX and Phoenix/HEEx).  The
// layering rule forbids `util/` (and `language/`) from importing
// `generator/`, so the names below are hand-listed; a completeness test
// (`test/language/type-system/walker-stdlib-completeness.test.ts`) pins them
// mechanically against the registry, so drift surfaces as a test failure
// rather than a runtime gap.  Adding a primitive: edit the registry first,
// then add the name here when the test prompts.
// ---------------------------------------------------------------------------

export const WALKER_LAYOUT_PRIMITIVES: ReadonlySet<string> = new Set([
  // Layout primitives.
  "Stack",
  "Group",
  "Grid",
  "Container",
  "Tabs",
  "Toolbar",
  "Empty",
  "Card",
  "Paper",
  "Breadcrumbs",
  "KeyValueRow",
  // Semantic anchor target + sticky-position wrapper.
  "Section",
  "Sticky",
  // Inputs.  (`Switch` is deliberately absent: page-metamodel.md removed it —
  // control-flow Switch is subsumed by `match`; the boolean input is Toggle.)
  "Field",
  "NumberField",
  "PasswordField",
  "Toggle",
  "MultilineField",
  "SelectField",
  "FileUpload",
  // Display.
  "Loader",
  "Anchor",
  "Image",
  "Avatar",
  "Slot",
  "Heading",
  "Text",
  "Bold",
  "Italic",
  "InlineCode",
  "Button",
  "Stat",
  "Badge",
  "Divider",
  "Table",
  "DataGrid",
  "Chart",
  "Money",
  "DateDisplay",
  "EnumBadge",
  "IdLink",
  "FileLink",
  "ProvenanceInfo",
  "Timeline",
  "Skeleton",
  "Alert",
  "QueryView",
  "Modal",
  // Code rendering — syntax-highlighted via highlight.js CDN at runtime.
  "CodeBlock",
  // SVG icon — either a builtin name or a custom `svg:` literal.
  "Icon",
  // Named-leaf form variants (post-#512).
  "CreateForm",
  "OperationForm",
  "WorkflowForm",
  "DestroyForm",
  // Action primitive — single-button operation invocation.
  "Action",
  // For-comprehension — list rendering with an item lambda.
  "For",
]);

export const WALKER_SUB_PRIMITIVES: ReadonlySet<string> = new Set(["Tab", "Column"]);

/** The PLACEMENT contract of each sub-primitive: the parent primitive(s) whose
 *  positional children it may appear among.
 *
 *  A `group: "sub"` primitive has no top-level renderer of its own — its parent
 *  consumes it inline (`emitTabs` scans its args for `Tab(...)`; `emitTable` /
 *  `emitDataGrid` scan theirs for `Column(...)`).  Spelled anywhere else it
 *  reaches the walker's own dispatch, which has no `tsx` entry for it, and
 *  DEGRADES to a comment — a `Tab: not supported by the walker yet` JSX
 *  comment, or `<%!-- Tab: … --%>` on HEEx.  The element silently disappears
 *  from the rendered page.
 *
 *  Derived, like the sets above, from the registry's `a11y.owns` (`Tabs` owns
 *  `Tab`; `Table` and `DataGrid` own `Column`) and pinned against it by
 *  `walker-stdlib-completeness.test.ts`, so a new sub-primitive cannot land
 *  without declaring where it belongs. */
export const WALKER_SUB_PRIMITIVE_PARENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Tab", new Set(["Tabs"])],
  ["Column", new Set(["Table", "DataGrid"])],
]);

/** True when `name` is admissible as a v2 BuilderCall type without
 *  resolving to a user-declared type (VO, EntityPart, Component). */
export function isWalkerPrimitive(name: string): boolean {
  return WALKER_LAYOUT_PRIMITIVES.has(name) || WALKER_SUB_PRIMITIVES.has(name);
}

// ---------------------------------------------------------------------------
// The POSITIONAL SLOT COUNT of each primitive — how many positional arguments
// any target actually renders.
//
// A container (`Stack`, `Card`, `Tab`, `Toolbar`, `Section`, `Modal`'s
// state-controlled shape, …) renders EVERY positional as a child and has no
// entry here.  Everything else is a fixed SLOT shape: its pack templates
// interpolate a known number of positions and have nowhere to put an extra one,
// so a positional past the count is read by NOBODY — the content vanishes from
// every frontend while a string literal inside it still lands in
// `.loom/messages.en.json`, handing translators a key nothing renders.
//
// This is the MEMBERSHIP the `loom.page-primitive-extra-children` gate reads
// (`src/ir/validate/checks/ui-checks.ts`).  It used to be hand-listed inside
// that check at exactly `Stat` / `KeyValueRow` / the op-form `Modal`, while
// every other fixed-arity read in the primitive table stayed unguarded:
// `EnumBadge { "x", "dropped" }` and `Image { "/a.png", "/dropped.png",
// alt: "a" }` both parsed `0 error(s)` and both emitted only positional 0.
// Declaring it per primitive, beside the name sets, is what makes a NEW
// primitive fail the completeness test rather than land silently outside the
// gate.
//
// Homed here for the same layering reason as the name sets: the IR validator
// reads it and `src/ir/` may not import `src/generator/`.  The NAMED-argument
// vocabulary is the sibling half and lives in `walker-primitive-args.ts`.
// ---------------------------------------------------------------------------

/** The rendered positional surface of one walker primitive. */
export interface WalkerPrimitiveSlots {
  /** How many positionals any target renders.  `0` means the primitive is
   *  configured entirely through its named arguments. */
  readonly max: number;
  /** Human-readable naming of the rendered slots, for the arity diagnostic
   *  ("label and value").  Omitted only when `max` is 0. */
  readonly slots?: string;
}

/** Primitive → its rendered positional slots.  ABSENT means "children
 *  container": every positional is walked, so there is no extra one. */
export const WALKER_PRIMITIVE_SLOTS: ReadonlyMap<string, WalkerPrimitiveSlots> = new Map<
  string,
  WalkerPrimitiveSlots
>([
  // --- Two-slot value shapes ----------------------------------------------
  ["Stat", { max: 2, slots: "label and value" }],
  ["KeyValueRow", { max: 2, slots: "label and value" }],
  // `Column(header, accessor)` — `emitColumn` reads `positionals[0]` as the
  // header and `positionals[1]` as the cell lambda, and nothing else.
  ["Column", { max: 2, slots: "header and cell accessor" }],
  // `For` takes the collection and the item lambda positionally (either order
  // — `emitFor` finds the lambda by kind).
  ["For", { max: 2, slots: "collection and item lambda" }],

  // --- One-slot value shapes ----------------------------------------------
  ["Text", { max: 1, slots: "text" }],
  ["Bold", { max: 1, slots: "text" }],
  ["Italic", { max: 1, slots: "text" }],
  ["InlineCode", { max: 1, slots: "text" }],
  ["Badge", { max: 1, slots: "label" }],
  ["Empty", { max: 1, slots: "message" }],
  ["Heading", { max: 1, slots: "text" }],
  ["Anchor", { max: 1, slots: "label" }],
  ["Money", { max: 1, slots: "value" }],
  ["DateDisplay", { max: 1, slots: "value" }],
  ["EnumBadge", { max: 1, slots: "value" }],
  ["FileLink", { max: 1, slots: "value" }],
  ["Image", { max: 1, slots: "src" }],
  ["Alert", { max: 1, slots: "message" }],
  ["CodeBlock", { max: 1, slots: "source" }],
  ["IdLink", { max: 1, slots: "id" }],
  ["Timeline", { max: 1, slots: "entries" }],
  ["ProvenanceInfo", { max: 1, slots: "record" }],
  ["Button", { max: 1, slots: "label" }],
  ["Action", { max: 1, slots: "the operation reference" }],
  ["CreateForm", { max: 1, slots: "the aggregate" }],
  ["OperationForm", { max: 1, slots: "the operation reference" }],
  ["WorkflowForm", { max: 1, slots: "the workflow" }],
  ["DestroyForm", { max: 1, slots: "the record" }],
  // The seven controlled inputs read positional 0 as the field LABEL.
  ["Field", { max: 1, slots: "label" }],
  ["NumberField", { max: 1, slots: "label" }],
  ["PasswordField", { max: 1, slots: "label" }],
  ["Toggle", { max: 1, slots: "label" }],
  ["MultilineField", { max: 1, slots: "label" }],
  ["SelectField", { max: 1, slots: "label" }],
  ["FileUpload", { max: 1, slots: "label" }],

  // --- Named-argument-only shapes -----------------------------------------
  ["Avatar", { max: 0 }],
  ["Loader", { max: 0 }],
  ["Divider", { max: 0 }],
  ["Skeleton", { max: 0 }],
  ["Slot", { max: 0 }],
  ["Icon", { max: 0 }],
  ["Chart", { max: 0 }],
  ["QueryView", { max: 0 }],
]);
