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
  // Phase 6 — semantic anchor target + sticky-position wrapper.
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
