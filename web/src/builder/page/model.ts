import type { BuilderEntry, CallArg, Expression, Page, StateBlock, Statement } from "../../../../src/language/generated/ast.js";
import { printExpr } from "../../../../src/language/print/index.js";

// ---------------------------------------------------------------------------
// Page-builder data model: a craft-agnostic tree mediating between a parsed
// page `body:` expression and `.ddd` source, driven by a primitive registry so
// seeding, emission, the palette, and settings stay in lock-step.
//
// Recognize-or-opaque: a call whose shape exactly matches a registered
// primitive becomes an editable typed node; anything else (unmodelled calls,
// `match`, lambdas, args we don't model, non-canonical arg order) becomes an
// `Opaque` node carrying its printed source verbatim, so the body always
// round-trips.  Combined with regenerate-and-splice at the body's CST range,
// nothing outside is touched.
// ---------------------------------------------------------------------------

// `expr` is the permissive data-binding kind: it accepts any expression
// (member access, calls, literals, refs) except the structured slots
// (`Lambda`/`MatchExpr`, modelled as their own nodes).  It stores the
// sub-expression's printed text verbatim and re-emits it unquoted, so
// data-bound args (`Stat("Total", order.total)`) stop collapsing the whole
// call to Opaque.
//
// `text` is content that is *usually* a string literal but may be any
// expression (`Text("Hello, " + name)`).  It stores/emits exactly like `expr`
// (verbatim printed text); the difference is purely the settings UI, which
// shows a plain text box for a bare string literal and the raw expression
// otherwise.
//
// `color` is a string-valued prop (stored/emitted exactly like `string`) shown
// as a palette dropdown.
export type PropKind = "string" | "int" | "ref" | "expr" | "text" | "color";

interface PropSpec {
  key: string;
  kind: PropKind;
  /** For `ref` props: which option set populates the dropdown (e.g. "aggregate"). */
  options?: string;
}

/** A positional arg spec; a bare string is shorthand for a `string`-kind prop. */
type PositionalSpec = string | PropSpec;

interface PrimitiveSpec {
  kind: "container" | "leaf";
  /** Leading positional args, in order.  Leaves carry only these; containers
   *  may also declare them (string-kind only) — they precede the child args. */
  positional?: PositionalSpec[];
  /** Optional `name: value` args. */
  named?: PropSpec[];
  /** Named args whose value is itself a node (a primitive call or a lambda),
   *  edited as a nested canvas rather than a scalar field — e.g. QueryView's
   *  `data:`/`loading:` branches.  Each seeded child carries `slot: <key>`.
   *  Implies a container (a node with children must be a craft canvas). */
  namedChildren?: string[];
}

/** Normalise positional specs (bare string → `string`-kind prop). */
function posSpecs(spec: PrimitiveSpec): PropSpec[] {
  return (spec.positional ?? []).map((p) => (typeof p === "string" ? { key: p, kind: "string" as const } : p));
}

// The closed set the canvas understands.  Containers hold children (and may
// also carry leading scalar props, e.g. a `Card` title); leaves carry only
// string/int/ref props.  Everything else round-trips as Opaque.
//
// Pinned against the language stdlib by
// `test/playground/page-builder/spec-completeness.test.ts` — every name in
// `src/util/walker-primitive-names.ts` needs an entry here (or a pinned
// exception), so a new primitive can't silently regress to an opaque blob.
export const SPECS = {
  Stack: { kind: "container" },
  Group: { kind: "container" },
  Grid: { kind: "container" },
  Toolbar: { kind: "container" },
  // Tabs holds Tab children; a Tab carries a leading title then its body
  // children (same container-with-title shape as Card).  Tab is a sub-primitive
  // — addable only inside a Tabs, never at top level (see PALETTE_PRIMITIVES).
  Tabs: { kind: "container" },
  Tab: { kind: "container", positional: ["label"] },
  // Containers with props: leading positional title / named modifiers, then
  // children.  Recognising them makes their nested elements editable instead
  // of collapsing the whole call into one Opaque blob.
  Card: { kind: "container", positional: ["title"] },
  Container: { kind: "container", named: [{ key: "size", kind: "string" }] },
  Paper: { kind: "container", named: [{ key: "padding", kind: "string" }] },
  // Semantic-anchor / sticky-position wrappers: `Section`'s `id:` lands as the
  // `<section id>` an `Anchor { to: "#…" }` jumps to; `Sticky`'s `top:` is the
  // CSS offset.  Both hold their body as positional children.
  Section: { kind: "container", named: [{ key: "id", kind: "string" }] },
  Sticky: { kind: "container", named: [{ key: "top", kind: "string" }] },
  Heading: { kind: "leaf", positional: [{ key: "text", kind: "text" }], named: [{ key: "level", kind: "int" }] },
  Text: { kind: "leaf", positional: [{ key: "text", kind: "text" }] },
  // Inline-emphasis spans — same one-positional-content shape as Text.
  Bold: { kind: "leaf", positional: [{ key: "text", kind: "text" }] },
  Italic: { kind: "leaf", positional: [{ key: "text", kind: "text" }] },
  InlineCode: { kind: "leaf", positional: [{ key: "text", kind: "text" }] },
  Button: { kind: "leaf", positional: [{ key: "label", kind: "text" }], named: [{ key: "to", kind: "string" }] },
  // `Action(<operation>, then: <effect>)` — a button bound to an aggregate
  // operation, with an optional follow-up effect (`navigate(...)`/`toast(...)`).
  // The operation is a positional ref (a contextual dropdown like Form's `op:`);
  // `then:` is any expression, kept verbatim and edited as an expr field.  Leaf,
  // not container: the operation is a `ref` positional, which only leaves read
  // (containers peel string-literal positionals only).
  Action: { kind: "leaf", positional: [{ key: "operation", kind: "ref", options: "operation" }], named: [{ key: "then", kind: "expr" }] },
  Anchor: { kind: "leaf", positional: [{ key: "text", kind: "text" }], named: [{ key: "to", kind: "string" }] },
  Badge: { kind: "leaf", positional: [{ key: "value", kind: "expr" }], named: [{ key: "color", kind: "color" }] },
  Alert: { kind: "leaf", positional: [{ key: "message", kind: "text" }], named: [{ key: "color", kind: "color" }] },
  Empty: { kind: "leaf", positional: [{ key: "message", kind: "text" }] },
  Divider: { kind: "leaf" },
  // Named-leaf form primitives — one entry per shape, no
  // argument-introspection dispatch:
  //   * CreateForm(of:)       — create-form for the aggregate
  //   * OperationForm(of:,op:) or OperationForm(<inst>.<op>) — op form
  //   * WorkflowForm(runs:)   — workflow-run form
  //   * DestroyForm(of:)      — confirm-only delete of the routed record
  CreateForm: { kind: "leaf", named: [{ key: "of", kind: "ref", options: "aggregate" }, { key: "testid", kind: "string" }] },
  OperationForm: { kind: "leaf", positional: [{ key: "operation", kind: "ref", options: "operation" }], named: [{ key: "of", kind: "ref", options: "aggregate" }, { key: "op", kind: "ref", options: "operation" }, { key: "testid", kind: "string" }] },
  WorkflowForm: { kind: "leaf", named: [{ key: "runs", kind: "ref", options: "workflow" }, { key: "testid", kind: "string" }] },
  DestroyForm: { kind: "leaf", named: [{ key: "of", kind: "ref", options: "aggregate" }, { key: "then", kind: "expr" }, { key: "testid", kind: "string" }] },
  // Layout / no-arg primitives.
  Breadcrumbs: { kind: "container" },
  KeyValueRow: { kind: "container", positional: ["label"] },
  Skeleton: { kind: "leaf", named: [{ key: "count", kind: "int" }] },
  Loader: { kind: "leaf" },
  Slot: { kind: "leaf" },
  Image: { kind: "leaf", named: [{ key: "src", kind: "string" }, { key: "alt", kind: "string" }] },
  Avatar: { kind: "leaf", named: [{ key: "src", kind: "string" }, { key: "alt", kind: "string" }] },
  // Data-bound display primitives — value/id args are expressions.
  Stat: { kind: "leaf", positional: [{ key: "label", kind: "string" }, { key: "value", kind: "expr" }] },
  Money: { kind: "leaf", positional: [{ key: "value", kind: "expr" }] },
  DateDisplay: { kind: "leaf", positional: [{ key: "value", kind: "expr" }] },
  EnumBadge: { kind: "leaf", positional: [{ key: "value", kind: "expr" }] },
  IdLink: { kind: "leaf", positional: [{ key: "id", kind: "expr" }], named: [{ key: "of", kind: "ref", options: "aggregate" }] },
  // A download anchor over a `File`-typed expression — same positional-value
  // shape as the other formatters (Money / DateDisplay / EnumBadge).
  FileLink: { kind: "leaf", positional: [{ key: "value", kind: "expr" }] },
  // The "?" lineage disclosure over a `provenanced` field: the record
  // expression plus the field name it reads `<field>_provenance` from.
  ProvenanceInfo: { kind: "leaf", named: [{ key: "of", kind: "expr" }, { key: "field", kind: "string" }] },
  // The entity audit trail (docs/audit.md) — one `of:` expression bound to the
  // `AuditEntry[]` a backend serves at `GET /<agg>/{id}/history`.  A leaf: it
  // renders its own `<ol>`/`<li>` markup and takes no children.
  Timeline: { kind: "leaf", named: [{ key: "of", kind: "expr" }] },
  // Syntax-highlighted code.  Two admissible shapes (like OperationForm): a
  // positional source literal (`CodeBlock { "const x = 1" }`) or the named
  // `source:` arg — distinct prop keys so each re-emits in the shape it was
  // written, rather than one normalising into the other.
  CodeBlock: { kind: "leaf", positional: [{ key: "code", kind: "text" }], named: [{ key: "source", kind: "text" }, { key: "language", kind: "string" }, { key: "title", kind: "string" }] },
  // An inline SVG icon — a builtin registry `name:` (any expression, so a
  // component param like `name: iconName` stays editable) or a custom `svg:`
  // literal, plus the a11y knobs the emitter reads.
  Icon: { kind: "leaf", named: [{ key: "name", kind: "text" }, { key: "svg", kind: "string" }, { key: "size", kind: "string" }, { key: "label", kind: "string" }, { key: "decorative", kind: "expr" }] },
  // Form inputs — a label plus a `bind:` expression (usually a state var).
  Field: { kind: "leaf", positional: [{ key: "label", kind: "string" }], named: [{ key: "bind", kind: "expr" }] },
  NumberField: { kind: "leaf", positional: [{ key: "label", kind: "string" }], named: [{ key: "bind", kind: "expr" }] },
  PasswordField: { kind: "leaf", positional: [{ key: "label", kind: "string" }], named: [{ key: "bind", kind: "expr" }] },
  Toggle: { kind: "leaf", positional: [{ key: "label", kind: "string" }], named: [{ key: "bind", kind: "expr" }] },
  MultilineField: { kind: "leaf", positional: [{ key: "label", kind: "string" }], named: [{ key: "bind", kind: "expr" }] },
  // A controlled single-select: same bind shape plus the `options:` string-array
  // expression (a list literal, a state field, or any `string[]` expression).
  SelectField: { kind: "leaf", positional: [{ key: "label", kind: "string" }], named: [{ key: "bind", kind: "expr" }, { key: "options", kind: "expr" }] },
  // A standalone upload input bound to a `File`-typed state field.
  FileUpload: { kind: "leaf", positional: [{ key: "label", kind: "string" }], named: [{ key: "bind", kind: "expr" }] },
  // Table holds Column children (sub-primitive) plus a `rows:` source and
  // optional callback lambdas (`onRowClick:` / `rowTestid:`) as named-arg child
  // slots.  A Column carries a header then an accessor lambda child.
  Table: { kind: "container", named: [{ key: "rows", kind: "expr" }], namedChildren: ["onRowClick", "rowTestid"] },
  // DataGrid is Table's shape — `rows:` plus positional `Column` children — so
  // it rides the same container spec.  Its extra knobs (`multiSort:`,
  // `columnVisibility:`, `pageSize:`) are scalar named args the generic
  // named-arg editor already handles; it has no lambda slots of its own (the
  // per-column accessors ride the `Column` children, as with Table).
  DataGrid: { kind: "container", named: [{ key: "rows", kind: "expr" }] },
  // Chart binds a grouped projection (`of:`) with x/y accessor lambdas and a
  // literal kind — all four are expression-shaped named args, no children
  // (M-T1.3 Phase 4; react + mantine v9, gated elsewhere).
  Chart: {
    kind: "leaf",
    named: [
      { key: "kind", kind: "expr" },
      { key: "of", kind: "expr" },
      { key: "x", kind: "expr" },
      { key: "y", kind: "expr" },
    ],
  },
  Column: { kind: "container", positional: ["header"] },
  // QueryView wraps a `of:` query expression and renders one of its
  // loading/error/empty/data branches — each a nested node (data: is often a
  // `rows => …` lambda).  Modal pairs a `trigger:` node with its body child.
  QueryView: { kind: "container", named: [{ key: "of", kind: "expr" }], namedChildren: ["loading", "error", "empty", "data"] },
  Modal: { kind: "container", namedChildren: ["trigger"] },
  // `For { each: <coll>, <item> => <markup>, empty?: <markup> }` — the item
  // renderer is a positional lambda, so it rides the ordinary positional-child
  // path (a `Lambda` node holding its body); `empty:` is a markup slot child.
  For: { kind: "container", named: [{ key: "each", kind: "expr" }], namedChildren: ["empty"] },
} satisfies Record<string, PrimitiveSpec>;

// Synthetic nodes model expression-syntax constructs that aren't CallExpr-
// shaped — a lambda (`x => …`) and a `match { … }`.  They never appear in the
// palette, are emitted with bespoke syntax (not `Name(...)`), and hold their
// parts as ordinary positional children so the existing serialize / craft
// machinery applies unchanged: a `Match` holds `MatchArm`/`MatchElse` children,
// each of those holds its one value child, and a `Lambda` holds its body child.
const SYNTHETIC = {
  Lambda: { container: true, fields: [{ key: "param", kind: "string" }] },
  Match: { container: true, fields: [] },
  MatchArm: { container: true, fields: [{ key: "cond", kind: "expr" }] },
  MatchElse: { container: true, fields: [] },
  // A statement inside a block-bodied lambda (`r => { … }`); its source is kept
  // verbatim and edited as a raw line, so a handler body is a list of editable
  // statement rows rather than one Opaque blob.
  Stmt: { container: false, fields: [] },
} satisfies Record<string, { container: boolean; fields: PropSpec[] }>;
type SyntheticName = keyof typeof SYNTHETIC;
const isSynthetic = (name: string): name is SyntheticName => name in SYNTHETIC;

// Single-child slots (a lambda body, a match arm/else value) hold exactly one
// child; the canvas must not let a second be added.
export const SINGLE_CHILD_NODES = new Set<string>(["Lambda", "MatchArm", "MatchElse"]);

/** Default props for a freshly-added synthetic node (so the canvas can build a
 *  fresh match arm / else).  `cond` defaults to `true` — a bare identifier
 *  would be misparsed as a lambda. */
export function syntheticDefaultProps(name: string): Record<string, string> {
  if (name === "MatchArm") return { cond: "true" };
  if (name === "Lambda") return { param: "x" };
  return {};
}

/** Default item-lambda subtree for the "+ item" control a palette-added `For`
 *  needs (PageBuilder.tsx, the For twin of Match's "+ arm"/addArm) — a
 *  positional `Lambda` (binder `item`, a fresh name against the empty scope a
 *  just-added `For` has) holding the same `Text` placeholder body a fresh
 *  match-arm value gets, so the control emits something parseable
 *  immediately.  Exported so tests can assert against the exact shape the
 *  control builds without driving craft.js. */
export function defaultForItemLambda(): BuilderNode {
  return { name: "Lambda", props: { param: "item" }, children: [defaultNode("Text")] };
}

export type PrimitiveName = keyof typeof SPECS | SyntheticName | "Opaque";
export const PRIMITIVES = Object.keys(SPECS) as (keyof typeof SPECS)[];

// Primitives kept out of the top-level palette — sub-primitives that only nest
// inside a specific parent (Tab in Tabs, Column in Table), and the named-child
// containers (QueryView/Modal) whose required slots the click-add palette can't
// populate.  All stay resolvable on the canvas and editable when seeded.
const SUB_PRIMITIVES = new Set<string>(["Tab", "Column", "QueryView", "Modal"]);
export const PALETTE_PRIMITIVES = PRIMITIVES.filter((p) => !SUB_PRIMITIVES.has(p));

// `satisfies` narrows each entry to its literal shape; widen on read so
// optional positional/named are uniformly accessible.
const specOf = (name: keyof typeof SPECS): PrimitiveSpec => SPECS[name];

export function isContainer(name: PrimitiveName): boolean {
  if (isSynthetic(name)) return SYNTHETIC[name].container;
  // Unknown names (user-defined `component` calls) are container-like: their
  // positional args are modelled as children.
  if (name === "Opaque") return false;
  if (!(name in SPECS)) return true;
  return specOf(name).kind === "container";
}

/** Settings/seed field descriptors for a primitive (drives the panel UI).
 *  Unknown names (e.g. the synthetic `Root`) have no editable fields. */
export function propFields(name: string): PropSpec[] {
  if (name === "Opaque") return [{ key: "raw", kind: "expr" }];
  if (isSynthetic(name)) return SYNTHETIC[name].fields;
  if (!(name in SPECS)) return [];
  const spec = specOf(name as keyof typeof SPECS);
  return [...posSpecs(spec), ...(spec.named ?? [])];
}

export interface BuilderNode {
  name: PrimitiveName;
  props: Record<string, string | number | undefined>;
  children: BuilderNode[];
  /** When this node fills a parent's named-arg child slot (e.g. QueryView
   *  `data:`), the arg name; positional children leave it undefined. */
  slot?: string;
  /** Recorded source arg order, so the exact positional/named interleaving
   *  round-trips on emit.  Each token is a prop key or `CHILD_TOKEN` ("the next
   *  child").  Absent on fresh palette nodes, which emit in canonical order. */
  order?: string[];
}

export function defaultNode(name: keyof typeof SPECS): BuilderNode {
  const props: Record<string, string | number> = {};
  // First positional placeholder is the primitive name (a fresh Button reads
  // "Button"); further positionals fall back to their capitalised key.  Named
  // props are optional and left unset so a fresh node emits its minimal form.
  // `expr` placeholders are stored quoted so a fresh node emits a string
  // literal (verbatim emit would otherwise produce a bare identifier).
  posSpecs(specOf(name)).forEach((p, i) => {
    const base = i === 0 ? name : p.key.charAt(0).toUpperCase() + p.key.slice(1);
    if (p.kind === "string") props[p.key] = base;
    // `expr`/`text` placeholders are stored quoted so a fresh node emits a
    // string literal (verbatim emit would otherwise produce a bare identifier).
    else if (p.kind === "expr" || p.kind === "text") props[p.key] = JSON.stringify(base);
  });
  return { name, props, children: [] };
}

// ---------------------------------------------------------------------------
// Recovered-AST safety.  The builders re-parse on every keystroke, so they
// routinely see a *partially recovered* AST: Langium's error recovery keeps the
// enclosing node but leaves the sub-node it couldn't parse `undefined`
// (`body:` with no expression, `state { x: }` with no type, a match arm with no
// value, …).  Every deref below therefore treats any child as possibly absent
// and degrades to an empty/Opaque node instead of throwing in render.
// ---------------------------------------------------------------------------

/** Stand-in for a sub-expression error recovery left undefined. */
function missing(): BuilderNode {
  return { name: "Opaque", props: { raw: "" }, children: [] };
}

/** `printExpr` dereferences sub-nodes unconditionally, so it throws on a
 *  half-parsed expression — fall back to the verbatim CST text. */
function safePrint(e: Expression | undefined): string {
  if (!e) return "";
  try {
    return printExpr(e);
  } catch {
    return e.$cstNode?.text ?? "";
  }
}

function opaque(expr: Expression | undefined): BuilderNode {
  return { name: "Opaque", props: { raw: safePrint(expr) }, children: [] };
}

function asString(e: Expression | undefined): string | null {
  return e?.$type === "StringLit" ? e.value : null;
}

/** Read one arg into a typed prop value by kind; null if the arg doesn't match
 *  (caller falls back to opaque).  `expr` accepts any expression except the
 *  structured slots (`Lambda`/`MatchExpr`) and stores its printed text. */
function readProp(kind: PropKind, e: Expression | undefined): string | number | null {
  if (!e) return null;
  if (kind === "string" || kind === "color") return asString(e);
  if (kind === "int") return e.$type === "IntLit" ? e.value : null;
  // A bare identifier (`Order`) or a qualified ref (`Sales.Order`); both emit
  // verbatim, and the latter shows up as the current value in the dropdown.
  // Post grammar-flatten, `Sales.Order` parses as a PostfixChain whose first
  // suffix is a MemberSuffix; we accept that shape for the ref kind.
  if (kind === "ref") {
    if (e.$type === "NameRef") return e.name;
    if (e.$type === "PostfixChain") return safePrint(e);
    return null;
  }
  if (e.$type === "Lambda" || e.$type === "MatchExpr") return null;
  return safePrint(e);
}

/** An `order` token is either a prop key (positional or named scalar) or this
 *  sentinel meaning "the next child, in array order". */
const CHILD_TOKEN = "";

// Seed a recognised call into a node, walking args in source order so the exact
// positional/named interleaving can be replayed on emit (this is what lets
// non-canonical orderings — a positional after a named arg — round-trip instead
// of falling back to Opaque).  Returns null if the call doesn't match the spec
// (caller falls back to Opaque).
function seedCall(name: string, spec: PrimitiveSpec, args: ReadonlyArray<CallArg | BuilderEntry> | undefined, components: ReadonlyMap<string, readonly string[]>): BuilderNode | null {
  const posKeys = posSpecs(spec);
  const namedSpec = new Map((spec.named ?? []).map((n) => [n.key, n] as const));
  const namedChildren = new Set(spec.namedChildren ?? []);
  const isContainerKind = spec.kind === "container";

  const props: Record<string, string | number> = {};
  const children: BuilderNode[] = [];
  const order: string[] = [];
  let posOrdinal = 0;
  // Containers peel leading *literal* positionals into declared scalar props;
  // the first non-literal (or one past the declared props) begins the children.
  let peeling = isContainerKind && posKeys.length > 0;

  for (const a of args ?? []) {
    if (!a) continue;
    if (a.name) {
      const ns = namedSpec.get(a.name);
      if (ns) {
        const v = readProp(ns.kind, a.value);
        if (v === null) return null;
        props[a.name] = v;
        order.push(a.name);
      } else if (namedChildren.has(a.name)) {
        const child = seedFromBody(a.value, components);
        child.slot = a.name;
        children.push(child);
        order.push(CHILD_TOKEN);
      } else if (a.value?.$type === "Lambda" || a.value?.$type === "MatchExpr") {
        // An unknown named arg whose value is a lambda/match (e.g. an event
        // handler `onClick: e => { … }`) becomes a slot child — an editable
        // Lambda/Match node (with the statement-row editor for block bodies) —
        // rather than a raw passthrough string.
        const child = seedFromBody(a.value, components);
        child.slot = a.name;
        children.push(child);
        order.push(CHILD_TOKEN);
      } else {
        // Any other unknown named arg → keep it as a passthrough prop (preserved
        // verbatim, editable as a generic expr field) rather than collapsing the
        // whole node to Opaque.  Lets the many optional modifiers a primitive
        // accepts (`testid:`, `striped:`, `gap:`, …) round-trip.
        props[a.name] = safePrint(a.value);
        order.push(a.name);
      }
      continue;
    }
    // Positional arg.
    if (!isContainerKind) {
      if (posOrdinal >= posKeys.length) return null; // too many positionals
      const pk = posKeys[posOrdinal++];
      const v = readProp(pk.kind, a.value);
      if (v === null) return null;
      props[pk.key] = v;
      order.push(pk.key);
      continue;
    }
    if (peeling && posOrdinal < posKeys.length) {
      const s = asString(a.value);
      if (s !== null) {
        props[posKeys[posOrdinal].key] = s;
        order.push(posKeys[posOrdinal].key);
        posOrdinal++;
        continue;
      }
      peeling = false;
    }
    children.push(seedFromBody(a.value, components));
    order.push(CHILD_TOKEN);
  }
  // Declared leaf positionals are optional from the right: a call may supply
  // fewer (e.g. `Empty()`), but not more — the in-loop guard rejects extras.
  return { name: name as PrimitiveName, props, children, order };
}

/** A node's source range, stashed so diagnostics can be mapped back to the node
 *  they came from.  Encoded `startLine,startChar,endLine,endChar`. */
function rangeStr(node: { $cstNode?: { range: { start: { line: number; character: number }; end: { line: number; character: number } } } }): string | undefined {
  const r = node.$cstNode?.range;
  return r ? `${r.start.line},${r.start.character},${r.end.line},${r.end.character}` : undefined;
}

/** Seed a page-body expression into a builder node.  `components` is the set of
 *  user-defined `component` names in scope; a call to one is recognised as a
 *  node (its positional args become children) rather than falling to Opaque.
 *  Records each node's source range (`__range`) for diagnostic mapping. */
export function seedFromBody(expr: Expression | undefined, components: ReadonlyMap<string, readonly string[]> = EMPTY_COMPONENTS): BuilderNode {
  // Error recovery can hand us `undefined` for any body / sub-expression while
  // the user is mid-keystroke (`body:` with nothing after it).
  if (!expr) return missing();
  const node = seedNode(expr, components);
  const range = rangeStr(expr);
  if (range) node.props.__range = range;
  return node;
}

// Seed one statement of a block-bodied lambda.  An assignment (`target op
// value`) is modelled with structured target/op/value fields so it edits as
// three controls; every other statement keeps its source verbatim in `src`.
function seedStmt(s: Statement | undefined): BuilderNode {
  if (!s) return { name: "Stmt", props: { src: "" }, children: [] };
  const range = rangeStr(s);
  const ext = range ? { __range: range } : {};
  if (s.$type === "AssignOrCallStmt" && s.op && s.value) {
    return { name: "Stmt", props: { kind: "assign", target: s.target?.$cstNode?.text?.trim() ?? "", op: s.op, value: s.value.$cstNode?.text?.trim() ?? "", ...ext }, children: [] };
  }
  if (s.$type === "LetStmt") {
    return { name: "Stmt", props: { kind: "let", name: s.name, value: s.expr?.$cstNode?.text?.trim() ?? "", ...ext }, children: [] };
  }
  // `navigate(<page>, <params?>)` — a bare call to the UI navigation
  // primitive: structure it into a target-page picker + an optional positional
  // params expression so the page is editable from a dropdown rather than a
  // verbatim row.  Loom's `navigate` takes a NameRef for its page argument; a
  // non-NameRef first arg (very rare) falls through to the verbatim bare row so
  // we don't risk a structural mismatch on round-trip.  Object-literal params
  // (`{ id: order.id }`) don't parse in page-expression position — only domain
  // bodies admit object literals — so params is one positional expression; users
  // who want object-literal params hand-write the bare statement.
  if (s.$type === "AssignOrCallStmt" && !s.op && s.target?.call && s.target.head === "navigate" && s.target.tail?.length === 0) {
    const to = s.target.args?.[0];
    if (to && to.$type === "NameRef") {
      return {
        name: "Stmt",
        props: {
          kind: "navigate",
          to: to.name,
          params: s.target.args?.[1] ? safePrint(s.target.args[1]) : "",
          ...ext,
        },
        children: [],
      };
    }
  }
  return { name: "Stmt", props: { src: s.$cstNode?.text?.trim() ?? "", ...ext }, children: [] };
}

function seedNode(expr: Expression, components: ReadonlyMap<string, readonly string[]>): BuilderNode {
  // Lambda — an expression body becomes the one child canvas; a block body
  // (`x => { … }`) becomes a list of editable `Stmt` rows (each statement's
  // source kept verbatim).
  if (expr.$type === "Lambda") {
    if (expr.body !== undefined) return { name: "Lambda", props: { param: expr.param }, children: [seedFromBody(expr.body, components)] };
    return {
      name: "Lambda",
      props: { param: expr.param, __block: "1" },
      children: (expr.stmts ?? []).map(seedStmt),
    };
  }
  // match — predicate arms (cond + value child) plus an optional else child.
  if (expr.$type === "MatchExpr") {
    const children: BuilderNode[] = (expr.arms ?? []).map((arm) => ({
      name: "MatchArm" as const,
      props: { cond: safePrint(arm?.cond) },
      children: [seedFromBody(arm?.value, components)],
    }));
    if (expr.elseExpr) children.push({ name: "MatchElse", props: {}, children: [seedFromBody(expr.elseExpr, components)] });
    return { name: "Match", props: {}, children };
  }
  // v2: BuilderCall (`Name { slot: value, ... }`) is the canonical surface for
  // walker primitives and user components.  Legacy `Name(args)` (post grammar
  // flatten: a PostfixChain with NameRef head + single CallSuffix) is still
  // accepted so older fragments keep parsing.
  let name: string;
  let args: ReadonlyArray<CallArg | BuilderEntry> | undefined;
  if (expr.$type === "BuilderCall") {
    name = expr.type;
    args = expr.entries;
  } else if (
    expr.$type === "PostfixChain" &&
    expr.suffixes?.length === 1 &&
    expr.suffixes[0]?.$type === "CallSuffix" &&
    expr.head?.$type === "NameRef"
  ) {
    name = expr.head.name;
    args = (expr.suffixes[0] as { args?: CallArg[] }).args;
  } else {
    return opaque(expr);
  }
  if (name in SPECS) return seedCall(name, specOf(name as keyof typeof SPECS), args, components) ?? opaque(expr);
  // A user-defined `component` call: model its positional args as props keyed by
  // the declared param names (so they edit as labelled fields), with `__params`
  // recording which keys emit positionally.
  const params = components.get(name);
  if (!params) return opaque(expr);
  const spec: PrimitiveSpec = { kind: "leaf", positional: params.map((p) => ({ key: p, kind: "text" as const })) };
  const node = seedCall(name, spec, args, components);
  if (!node) return opaque(expr);
  node.props.__params = JSON.stringify(params);
  return node;
}

const EMPTY_COMPONENTS: ReadonlyMap<string, readonly string[]> = new Map();

/** Render one prop value by kind.  `string` re-quotes (the STRING terminal
 *  strips delimiters); `int` numifies; `ref`/`expr` emit verbatim. */
function emitProp(kind: PropKind, v: string | number): string {
  if (kind === "int") return String(Number(v));
  // `ref`/`expr`/`text` are stored as already-printed source — emit verbatim.
  if (kind === "ref" || kind === "expr" || kind === "text") return String(v);
  return JSON.stringify(String(v));
}

function emitNamed(node: BuilderNode, named: PropSpec[] | undefined): string[] {
  const parts: string[] = [];
  for (const n of named ?? []) {
    const v = node.props[n.key];
    if (v === undefined || v === "") continue;
    parts.push(`${n.key}: ${emitProp(n.kind, v)}`);
  }
  return parts;
}

const emitChild = (c: BuilderNode): string => (c.slot !== undefined ? `${c.slot}: ${emitBody(c)}` : emitBody(c));

export function emitBody(node: BuilderNode): string {
  if (node.name === "Opaque") return String(node.props.raw ?? "");
  // Synthetic nodes reconstruct their bespoke syntax from structure.  An
  // as-yet-unfilled single-child slot emits an `Empty()` placeholder so the
  // source stays parseable while it's being built up in the canvas.
  const body = (n: BuilderNode): string => (n.children[0] ? emitBody(n.children[0]) : "Empty {}");
  if (node.name === "Stmt") {
    if (node.props.kind === "assign") return `${node.props.target ?? ""} ${node.props.op ?? ":="} ${node.props.value ?? ""}`;
    if (node.props.kind === "let") return `let ${node.props.name ?? "x"} = ${node.props.value ?? ""}`;
    if (node.props.kind === "navigate") {
      const to = String(node.props.to ?? "");
      const params = node.props.params ? String(node.props.params) : "";
      return params ? `navigate(${to}, ${params})` : `navigate(${to})`;
    }
    return String(node.props.src ?? "");
  }
  if (node.name === "Lambda") {
    if (node.props.__block) {
      const stmts = node.children.map(emitBody).filter((s) => s.trim() !== "");
      return `${node.props.param ?? "x"} => {\n  ${stmts.join("\n  ")}\n}`;
    }
    return `${node.props.param ?? "x"} => ${body(node)}`;
  }
  if (node.name === "MatchArm") return `${node.props.cond ?? "true"} => ${body(node)}`;
  if (node.name === "MatchElse") return `else => ${body(node)}`;
  if (node.name === "Match") {
    // `else` must come last; keep at most one (the grammar allows a single else).
    const arms = node.children.filter((c) => c.name !== "MatchElse");
    const els = node.children.filter((c) => c.name === "MatchElse").slice(0, 1);
    return `match {\n  ${[...arms, ...els].map(emitBody).join(",\n  ")}\n}`;
  }
  // SPECS primitive, or a user-defined component call (positional args are
  // param-keyed props recorded in `__params`).
  const spec: PrimitiveSpec = node.name in SPECS ? specOf(node.name as keyof typeof SPECS) : { kind: "container" };
  const posKindOf = new Map(posSpecs(spec).map((p) => [p.key, p.kind] as const));
  const namedSpec = new Map((spec.named ?? []).map((n) => [n.key, n] as const));
  const params: ReadonlySet<string> = node.props.__params ? new Set(JSON.parse(String(node.props.__params)) as string[]) : new Set();
  const emitKey = (key: string): string | null => {
    const v = node.props[key];
    if (v === undefined || v === "") return null;
    const pos = posKindOf.get(key);
    if (pos) return emitProp(pos, v); // positional scalar prop
    if (params.has(key)) return String(v); // component positional param — bare
    const ns = namedSpec.get(key);
    if (ns) return `${key}: ${emitProp(ns.kind, v)}`;
    // Passthrough named prop (an unmodelled modifier kept verbatim).
    return `${key}: ${String(v)}`;
  };

  const parts: string[] = [];
  if (node.order) {
    // Replay the recorded source order; pull children in array order at each
    // CHILD_TOKEN, then append anything added after seed (extra children, newly
    // set named props) so live edits still emit validly.
    let cursor = 0;
    const emitted = new Set<string>();
    for (const tok of node.order) {
      if (tok === CHILD_TOKEN) {
        if (cursor < node.children.length) parts.push(emitChild(node.children[cursor++]));
      } else {
        const part = emitKey(tok);
        if (part !== null) parts.push(part);
        emitted.add(tok);
      }
    }
    for (; cursor < node.children.length; cursor++) parts.push(emitChild(node.children[cursor]));
    for (const n of spec.named ?? []) {
      if (emitted.has(n.key)) continue;
      const v = node.props[n.key];
      if (v !== undefined && v !== "") parts.push(`${n.key}: ${emitProp(n.kind, v)}`);
    }
  } else {
    // Fallback canonical order for nodes built without a recorded order (fresh
    // palette nodes): positional props, positional children, named, named slots.
    for (const p of posSpecs(spec)) {
      const v = node.props[p.key];
      if (v !== undefined && v !== "") parts.push(emitProp(p.kind, v));
    }
    for (const c of node.children) if (c.slot === undefined) parts.push(emitBody(c));
    parts.push(...emitNamed(node, spec.named));
    for (const c of node.children) if (c.slot !== undefined) parts.push(`${c.slot}: ${emitBody(c)}`);
  }
  // v2: walker primitives and user-component invocations both emit as
  // builder-calls `Name { entries }`.  Empty-slot placeholder is `Name {}`.
  return parts.length === 0 ? `${node.name} {}` : `${node.name} { ${parts.join(", ")} }`;
}

// ---------------------------------------------------------------------------
// Per-position type inference (kept narrow on purpose).
//
// The page builder offers enum-case dropdowns for state-field *defaults* (the
// State panel). The next-tightest enum-typed position is a handler-block
// assignment value: `state { status: OrderStatus }` + `status := ⟨value⟩`.
//
// Inference is *local* — no full type system. A statement-row's structured
// `target` is consulted: if it's a bare identifier matching a declared state
// field whose declared base type is an enum present in the enums map, the
// settings panel renders a dropdown of that enum's cases. Anything else
// (member-access targets like `draft.status`, non-state-field idents, or
// non-enum-typed fields) falls through to the existing free-text input — no
// regression on existing flows. Dropdowns always keep the current value
// selectable, so a hand-written expression like `someFn()` isn't clobbered
// when the picker is shown.
// ---------------------------------------------------------------------------

/** Map each enum-typed state field of a page to its declared enum name. Bare
 *  state-field names (the only shape inference handles) consult this map.
 *  Skips fields whose declared base isn't a named type (primitives, ids) and
 *  fields whose named base isn't present in the supplied `enums` map. */
export function enumStateFields(page: Page, enums: ReadonlyMap<string, readonly string[]>): Map<string, string> {
  const out = new Map<string, string>();
  const sb = page.props?.find((p): p is StateBlock => p.$type === "StateBlock");
  if (!sb) return out;
  for (const f of sb.fields ?? []) {
    // A `NamedType` base carries a cross-reference (`target.$refText` is the
    // declared identifier); consult its name without needing the linker, then
    // intersect with the supplied enums map. PrimitiveType/IdType are ignored.
    // `type` (and its `base`) is undefined on a half-typed `state { x: }` —
    // Langium error recovery keeps the field but drops the unparsed type.
    const base = f?.type?.base;
    if (base?.$type !== "NamedType") continue;
    const name = base.target?.$refText;
    if (typeof name === "string" && enums.has(name)) out.set(f.name, name);
  }
  return out;
}

/** For a structured `Stmt` row with `kind: "assign"`, return the expected enum
 *  name when the target is a bare identifier of an enum-typed state field;
 *  null otherwise. Member-access targets (`draft.status`) deliberately fall
 *  through — inferring a nested field's type would need a full type pass. */
export function expectedAssignEnum(target: string, enumFields: ReadonlyMap<string, string>): string | null {
  // A bare ident is letter/underscore-led and contains no whitespace, dot,
  // bracket, or call paren. Conservatively reject anything else.
  const t = target.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return null;
  return enumFields.get(t) ?? null;
}
