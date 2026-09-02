// ---------------------------------------------------------------------------
// Walker primitive NAMED-ARGUMENT vocabulary — which `name:` arguments each
// page primitive actually understands.
//
// Homed in `src/util/` for the same reason as `walker-primitive-names.ts` and
// `user-visible-slots.ts`: both the IR validator (`loom.page-primitive-
// unknown-arg`, src/ir/validate/checks/ui-checks.ts) and the generator layer
// need it, and `util/` is the one layer both may import without an upward
// edge against the pipeline.
//
// WHY THIS EXISTS.  Every emitter reads its named args BY NAME —
// `stringNamed(call, "variant")`, `namedArgValue(call, "of")`, `lambdaArg(call,
// "onSubmit")`.  A name outside that vocabulary is read by nobody, so it — and
// whatever content it carries — is silently DROPPED from every frontend:
//
//     Card { title: "Bob's card", Text { "x" } }
//     Tabs { Tab  { title: "One", Text { "first" } } }
//
// both parse and generate with 0 diagnostics, and neither caption appears in
// the emitted TSX/HEEx or in `.loom/messages.en.json`.  `title:` is the natural
// spelling (pages use `title:`, and it IS a legal named arg on `Alert`,
// `Modal` and `CodeBlock`), so the mistake is easy to make and impossible to
// diagnose from the output.
//
// DERIVATION.  Like the name sets next door, the rows are hand-listed here and
// pinned MECHANICALLY against the generator by
// `test/language/type-system/walker-primitive-args-completeness.test.ts`:
//
//   1. one row per `WALKER_PRIMITIVES` key (a new primitive cannot land
//      without declaring its argument vocabulary);
//   2. every NAMED slot in `USER_VISIBLE_SLOTS` is listed for its primitive —
//      otherwise the gate would reject an argument the i18n extraction pass
//      still harvests, leaving translators an orphan catalog key for content
//      nothing renders;
//   3. every named argument the walker emitters actually READ (scanned out of
//      the emitter sources) appears in some row — so the gate can never
//      reject an argument an emitter honours.
//
// The reverse of (3) is deliberately NOT pinned: a row may list a name no
// emitter reads yet.  That direction is permissive (the gate stays quiet), and
// it is how a per-target divergence is recorded — `Button`'s `type:` reaches
// the Phoenix `<.button>` component and nothing else.
// ---------------------------------------------------------------------------

/** Named arguments EVERY walker primitive accepts.
 *
 *  `testid:` is read generically by the walker core (`testidAttr`), and
 *  `style:` never survives lowering as a named arg at all — `hoistStyleArg`
 *  (src/ir/lower/lower-expr.ts) lifts an object-literal `style: { … }` onto
 *  the call's `style` IR field.  It stays in the universal set so the gate's
 *  membership test matches the SOURCE vocabulary rather than an artefact of
 *  the lowering order; a non-object-literal `style:` is reported by its own
 *  message (`#style-not-object`). */
export const UNIVERSAL_PRIMITIVE_NAMED_ARGS: ReadonlySet<string> = new Set(["testid", "style"]);

/** primitive name → the named arguments it understands, BEYOND the universal
 *  ones above.  An empty array means "positional children only". */
export const WALKER_PRIMITIVE_NAMED_ARGS: Record<string, readonly string[]> = {
  // --- Layout / surface --------------------------------------------------
  Stack: [],
  Group: [],
  Grid: ["cols"],
  Container: ["size"],
  Tabs: [],
  Toolbar: ["label"],
  Empty: [],
  Card: ["variant", "shadow"],
  Paper: ["padding"],
  Breadcrumbs: [],
  KeyValueRow: [],
  Section: ["id"],
  Sticky: ["top"],
  // --- Inputs ------------------------------------------------------------
  // `bind:` names the `state` field the control reads/writes; `error:` is the
  // expression rendered in the pack's inline error slot (page-metamodel §8.2).
  Field: ["bind", "error"],
  NumberField: ["bind", "error"],
  PasswordField: ["bind", "error"],
  Toggle: ["bind", "error"],
  MultilineField: ["bind", "error"],
  SelectField: ["bind", "options", "error"],
  FileUpload: ["bind", "error"],
  // --- Display -----------------------------------------------------------
  Loader: ["size"],
  Anchor: ["to"],
  Image: ["src", "alt", "decorative"],
  Avatar: ["src", "alt", "decorative"],
  Slot: [],
  Heading: ["level", "size", "weight", "gradient"],
  Text: [],
  Bold: [],
  Italic: [],
  InlineCode: [],
  // `emphasis:`/`type:` are read where a Button is a Modal TRIGGER and by the
  // Phoenix `<.button>` component respectively.
  Button: [
    "label",
    "onClick",
    "to",
    "disabled",
    "loading",
    "variant",
    "icon",
    "iconSvg",
    "iconPosition",
    "emphasis",
    "type",
  ],
  Stat: [],
  Badge: [],
  Divider: ["label"],
  Table: [
    "rows",
    "keyExpr",
    "onRowClick",
    "rowTestid",
    "pageSize",
    "striped",
    "highlight",
    "sticky",
    "serverPaged",
    "totalPages",
    "sortKey",
    "sortDir",
    "page",
    "filter",
  ],
  DataGrid: ["rows", "multiSort", "columnVisibility", "pageSize", "selection"],
  Chart: ["of", "kind", "x", "y"],
  Money: ["value", "currency", "decimals"],
  DateDisplay: ["value"],
  EnumBadge: ["value", "color"],
  IdLink: ["of", "id"],
  FileLink: ["value"],
  ProvenanceInfo: ["of", "field"],
  Timeline: ["of"],
  Skeleton: ["count", "height"],
  Alert: ["title", "color"],
  QueryView: ["of", "loading", "error", "empty", "data", "single", "paged"],
  Modal: ["trigger", "title", "open"],
  CodeBlock: ["source", "language", "title"],
  Icon: ["name", "svg", "size", "label", "decorative"],
  // --- Forms / actions ---------------------------------------------------
  CreateForm: ["of", "onSubmit"],
  OperationForm: ["of", "op"],
  WorkflowForm: ["runs", "onSubmit"],
  DestroyForm: ["of", "then"],
  Action: ["then"],
  For: ["each", "empty", "render"],
  // --- Sub-primitives ----------------------------------------------------
  Tab: [],
  Column: ["field", "sortable", "filterable"],
};

/** The named arguments `name` accepts, universal ones included — or
 *  `undefined` when `name` is not a walker primitive (a user `component`, a
 *  value object, an `extern` function: those carry their own parameter lists
 *  and are checked elsewhere). */
export function walkerPrimitiveNamedArgs(name: string): ReadonlySet<string> | undefined {
  const own = WALKER_PRIMITIVE_NAMED_ARGS[name];
  if (own === undefined) return undefined;
  return new Set([...own, ...UNIVERSAL_PRIMITIVE_NAMED_ARGS]);
}
