// ---------------------------------------------------------------------------
// Walker stdlib registry — names that are admissible as BuilderCall types
// in body / component-body position without resolving to a user-declared
// type.  Lives in `language/` (not `generator/`) so both the validator
// and the per-platform body-walkers can consume it without violating the
// one-directional layering rule (`language/` knows nothing about
// `generator/`).
//
// Two sets:
//   WALKER_LAYOUT_PRIMITIVES — top-level layout / formatter primitives
//     (`Stack`, `Form`, `Heading`, `Money` as a UI formatter, …).
//   WALKER_SUB_PRIMITIVES    — sub-elements that only appear nested inside
//     a parent (`Tab` inside `Tabs`, `Column` inside `Table`).
//
// Adding a primitive here makes it `Name { … }`-admissible in source.
// The per-platform walker still owns its own dispatch (the registry is
// declarative, not behavioural) — keep these in sync when a new
// primitive lands.
// ---------------------------------------------------------------------------

export const WALKER_LAYOUT_PRIMITIVES: ReadonlySet<string> = new Set([
  "Stack",
  "Group",
  "Grid",
  "Container",
  "Tabs",
  "Toolbar",
  "Empty",
  "Field",
  "NumberField",
  "PasswordField",
  "Toggle",
  "Loader",
  "Anchor",
  "Image",
  "Avatar",
  "Slot",
  "Heading",
  "Text",
  "Button",
  "Card",
  "Stat",
  "Badge",
  "Divider",
  "Table",
  "Money",
  "DateDisplay",
  "EnumBadge",
  "IdLink",
  "Form",
  "Breadcrumbs",
  "Paper",
  "Skeleton",
  "Alert",
  "QueryView",
  "KeyValueRow",
  "Modal",
  // Archetypes — scaffolded by the IR scaffold-expander, callable in
  // explicit page bodies too (`body: List { of: Order }`).
  "List",
  "Detail",
  "MasterDetail",
  // Action primitive — single-button operation invocation.
  "Action",
  // SelectField / MultilineField / Switch — input variants surfaced
  // alongside Field.
  "SelectField",
  "MultilineField",
  "Switch",
  // For-comprehension — list rendering with an item lambda.
  "For",
]);

export const WALKER_SUB_PRIMITIVES: ReadonlySet<string> = new Set([
  "Tab",
  "Column",
]);

/** True when `name` is admissible as a v2 BuilderCall type without
 *  resolving to a user-declared type (VO, EntityPart, Component). */
export function isWalkerPrimitive(name: string): boolean {
  return WALKER_LAYOUT_PRIMITIVES.has(name) || WALKER_SUB_PRIMITIVES.has(name);
}
