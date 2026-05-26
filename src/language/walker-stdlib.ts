// ---------------------------------------------------------------------------
// Walker stdlib registry — names that are admissible as BuilderCall types
// in body / component-body position without resolving to a user-declared
// type.  Lives in `language/` (not `generator/`) so the validator
// can consume it without violating the one-directional layering rule
// (`language/` knows nothing about `generator/`).
//
// Three sets:
//   WALKER_LAYOUT_PRIMITIVES — top-level layout / formatter primitives
//     (`Stack`, `Heading`, `Money` as a UI formatter, …) + the named-leaf
//     form variants (`CreateForm`, `OperationForm`, `WorkflowForm`) +
//     scaffold-archetype names that lower to `custom` page origins on
//     post-#515 main (`List`, `Detail`, `MasterDetail`).
//   WALKER_SUB_PRIMITIVES    — sub-elements that only appear nested inside
//     a parent (`Tab` inside `Tabs`, `Column` inside `Table`).
//   WALKER_SCAFFOLD_PRIMITIVES — `scaffoldList`/`scaffoldDetails`/…
//     and the singleton sentinels (`Home`/`WorkflowsIndex`/`ViewsIndex`)
//     recognised by `inferPageOrigin`.
//
// These three sets are DERIVED — the single source of truth is the
// typed dispatch table at src/generator/_walker/registry.ts, which
// holds the renderer functions for each target (React/TSX and
// Phoenix/HEEx).  The layering rule forbids `language/` from
// importing `generator/`, so the names below are hand-listed; a
// completeness test (`test/language/walker-stdlib-completeness.test.ts`)
// pins them mechanically against the registry, so drift surfaces as a
// test failure rather than a runtime gap.  Adding a primitive: edit
// the registry first, then add the name here when the test prompts.
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
  // Inputs.
  "Field",
  "NumberField",
  "PasswordField",
  "Toggle",
  "Switch",
  "MultilineField",
  "SelectField",
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
  "Money",
  "DateDisplay",
  "EnumBadge",
  "IdLink",
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
  // Legacy archetype names — admissible in user pages, lower as
  // `custom` page origins post-#515.
  "List",
  "Detail",
  "MasterDetail",
  // Action primitive — single-button operation invocation.
  "Action",
  // For-comprehension — list rendering with an item lambda.
  "For",
]);

export const WALKER_SUB_PRIMITIVES: ReadonlySet<string> = new Set(["Tab", "Column"]);

/** Scaffold-internal primitive names recognised by `inferPageOrigin`.
 *  Admissible as BuilderCall types so hand-written canonical bodies
 *  (`body: Stack { scaffoldDetails { of: X }, scaffoldOperations { of: X } }`)
 *  validate. */
export const WALKER_SCAFFOLD_PRIMITIVES: ReadonlySet<string> = new Set([
  "scaffoldList",
  "scaffoldDetails",
  "scaffoldOperations",
  "scaffoldNewForm",
  "scaffoldWorkflowForm",
  "scaffoldViewList",
  // Singleton sentinels.
  "Home",
  "WorkflowsIndex",
  "ViewsIndex",
]);

/** True when `name` is admissible as a v2 BuilderCall type without
 *  resolving to a user-declared type (VO, EntityPart, Component). */
export function isWalkerPrimitive(name: string): boolean {
  return (
    WALKER_LAYOUT_PRIMITIVES.has(name) ||
    WALKER_SUB_PRIMITIVES.has(name) ||
    WALKER_SCAFFOLD_PRIMITIVES.has(name)
  );
}
