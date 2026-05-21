import type { CallArg, Expression } from "../../../../src/language/generated/ast.js";
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
export type PropKind = "string" | "int" | "ref" | "expr";

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
}

/** Normalise positional specs (bare string → `string`-kind prop). */
function posSpecs(spec: PrimitiveSpec): PropSpec[] {
  return (spec.positional ?? []).map((p) => (typeof p === "string" ? { key: p, kind: "string" as const } : p));
}

// The closed set the canvas understands.  Containers hold children (and may
// also carry leading scalar props, e.g. a `Card` title); leaves carry only
// string/int/ref props.  Everything else round-trips as Opaque.
const SPECS = {
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
  Heading: { kind: "leaf", positional: ["text"], named: [{ key: "level", kind: "int" }] },
  Text: { kind: "leaf", positional: ["text"] },
  Button: { kind: "leaf", positional: ["label"], named: [{ key: "to", kind: "string" }] },
  Anchor: { kind: "leaf", positional: ["text"], named: [{ key: "to", kind: "string" }] },
  Badge: { kind: "leaf", positional: [{ key: "value", kind: "expr" }], named: [{ key: "color", kind: "string" }] },
  Alert: { kind: "leaf", positional: ["message"], named: [{ key: "color", kind: "string" }] },
  Empty: { kind: "leaf", positional: ["message"] },
  Divider: { kind: "leaf" },
  List: { kind: "leaf", named: [{ key: "of", kind: "ref", options: "aggregate" }, { key: "testid", kind: "string" }] },
  Form: { kind: "leaf", named: [{ key: "of", kind: "ref", options: "aggregate" }, { key: "creates", kind: "ref", options: "aggregate" }, { key: "testid", kind: "string" }] },
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
  // Form inputs — a label plus a `bind:` expression (usually a state var).
  Field: { kind: "leaf", positional: [{ key: "label", kind: "string" }], named: [{ key: "bind", kind: "expr" }] },
  NumberField: { kind: "leaf", positional: [{ key: "label", kind: "string" }], named: [{ key: "bind", kind: "expr" }] },
  PasswordField: { kind: "leaf", positional: [{ key: "label", kind: "string" }], named: [{ key: "bind", kind: "expr" }] },
  Toggle: { kind: "leaf", positional: [{ key: "label", kind: "string" }], named: [{ key: "bind", kind: "expr" }] },
  // Table holds Column children (sub-primitive) plus a `rows:` source.  A
  // Column carries a header then an accessor lambda child.  (Tables that also
  // pass callback lambdas — `onRowClick:` / `rowTestid:` — still round-trip as
  // Opaque, since named-arg child slots aren't modelled yet.)
  Table: { kind: "container", named: [{ key: "rows", kind: "expr" }] },
  Column: { kind: "container", positional: ["header"] },
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
} satisfies Record<string, { container: boolean; fields: PropSpec[] }>;
type SyntheticName = keyof typeof SYNTHETIC;
const isSynthetic = (name: string): name is SyntheticName => name in SYNTHETIC;

export type PrimitiveName = keyof typeof SPECS | SyntheticName | "Opaque";
export const PRIMITIVES = Object.keys(SPECS) as (keyof typeof SPECS)[];

// Sub-primitives that only make sense nested inside a specific parent (a Tab
// inside Tabs, a Column inside Table); excluded from the top-level palette but
// still resolvable on the canvas and editable when seeded from source.
const SUB_PRIMITIVES = new Set<string>(["Tab", "Column"]);
export const PALETTE_PRIMITIVES = PRIMITIVES.filter((p) => !SUB_PRIMITIVES.has(p));

// `satisfies` narrows each entry to its literal shape; widen on read so
// optional positional/named are uniformly accessible.
const specOf = (name: keyof typeof SPECS): PrimitiveSpec => SPECS[name];

export function isContainer(name: PrimitiveName): boolean {
  if (isSynthetic(name)) return SYNTHETIC[name].container;
  return name !== "Opaque" && specOf(name).kind === "container";
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
    else if (p.kind === "expr") props[p.key] = JSON.stringify(base);
  });
  return { name, props, children: [] };
}

function opaque(expr: Expression): BuilderNode {
  return { name: "Opaque", props: { raw: printExpr(expr) }, children: [] };
}

function asString(e: Expression): string | null {
  return e.$type === "StringLit" ? e.value : null;
}

/** Read one arg into a typed prop value by kind; null if the arg doesn't match
 *  (caller falls back to opaque).  `expr` accepts any expression except the
 *  structured slots (`Lambda`/`MatchExpr`) and stores its printed text. */
function readProp(kind: PropKind, e: Expression): string | number | null {
  if (kind === "string") return asString(e);
  if (kind === "int") return e.$type === "IntLit" ? e.value : null;
  // Only a bare identifier is modelled; qualified refs (`Sales.Order`) fall
  // back to opaque.
  if (kind === "ref") return e.$type === "NameRef" ? e.name : null;
  if (e.$type === "Lambda" || e.$type === "MatchExpr") return null;
  return printExpr(e);
}

/** Read declared `name: value` args into typed props; null if any arg is
 *  unknown or mistyped (caller falls back to opaque). */
function readNamed(named: Map<string, Expression>, spec: PropSpec[] | undefined): Record<string, string | number> | null {
  const namedSpec = new Map((spec ?? []).map((n) => [n.key, n.kind] as const));
  const out: Record<string, string | number> = {};
  for (const [k, v] of named) {
    const kind = namedSpec.get(k);
    if (!kind) return null;
    const value = readProp(kind, v);
    if (value === null) return null;
    out[k] = value;
  }
  return out;
}

function partition(args: CallArg[]): { positional: Expression[]; named: Map<string, Expression>; canonical: boolean } {
  const positional: Expression[] = [];
  const named = new Map<string, Expression>();
  let seenNamed = false;
  let canonical = true;
  for (const a of args) {
    if (a.name) {
      seenNamed = true;
      named.set(a.name, a.value);
    } else {
      if (seenNamed) canonical = false; // positional after named — can't re-emit faithfully
      positional.push(a.value);
    }
  }
  return { positional, named, canonical };
}

export function seedFromBody(expr: Expression): BuilderNode {
  // Lambda — only single-expression bodies are modelled (the body becomes the
  // one child canvas); block-statement bodies (`x => { … }`) stay verbatim.
  if (expr.$type === "Lambda") {
    if (expr.body === undefined) return opaque(expr);
    return { name: "Lambda", props: { param: expr.param }, children: [seedFromBody(expr.body)] };
  }
  // match — predicate arms (cond + value child) plus an optional else child.
  if (expr.$type === "MatchExpr") {
    const children: BuilderNode[] = expr.arms.map((arm) => ({
      name: "MatchArm" as const,
      props: { cond: printExpr(arm.cond) },
      children: [seedFromBody(arm.value)],
    }));
    if (expr.elseExpr) children.push({ name: "MatchElse", props: {}, children: [seedFromBody(expr.elseExpr)] });
    return { name: "Match", props: {}, children };
  }
  if (expr.$type !== "CallExpr" || expr.callee.$type !== "NameRef") return opaque(expr);
  const name = expr.callee.name;
  if (!(name in SPECS)) return opaque(expr);
  const spec = specOf(name as keyof typeof SPECS);
  const { positional, named, canonical } = partition(expr.args);
  if (!canonical) return opaque(expr);

  const posKeys = posSpecs(spec);

  if (spec.kind === "container") {
    // Pure container (no declared props): every positional is a child; any
    // named arg is unmodelled → opaque.
    if (posKeys.length === 0 && (spec.named ?? []).length === 0) {
      if (named.size > 0) return opaque(expr);
      return { name: name as PrimitiveName, props: {}, children: positional.map(seedFromBody) };
    }
    // Container with props: greedily peel leading *literal* positionals into
    // the declared scalar props (each optional — the first non-literal begins
    // the children, mirroring the walker's title-vs-content heuristic), then
    // recurse the remaining positionals as children.
    const props: Record<string, string | number> = {};
    let childStart = 0;
    for (let i = 0; i < posKeys.length && i < positional.length; i++) {
      const s = asString(positional[i]);
      if (s === null) break;
      props[posKeys[i].key] = s;
      childStart = i + 1;
    }
    const namedProps = readNamed(named, spec.named);
    if (namedProps === null) return opaque(expr);
    return {
      name: name as PrimitiveName,
      props: { ...props, ...namedProps },
      children: positional.slice(childStart).map(seedFromBody),
    };
  }

  // leaf — positional args must match exactly by kind; named must be known + typed.
  if (positional.length !== posKeys.length) return opaque(expr);
  const props: Record<string, string | number> = {};
  for (let i = 0; i < posKeys.length; i++) {
    const v = readProp(posKeys[i].kind, positional[i]);
    if (v === null) return opaque(expr);
    props[posKeys[i].key] = v;
  }
  const namedProps = readNamed(named, spec.named);
  if (namedProps === null) return opaque(expr);
  return { name: name as PrimitiveName, props: { ...props, ...namedProps }, children: [] };
}

/** Render one prop value by kind.  `string` re-quotes (the STRING terminal
 *  strips delimiters); `int` numifies; `ref`/`expr` emit verbatim. */
function emitProp(kind: PropKind, v: string | number): string {
  if (kind === "int") return String(Number(v));
  if (kind === "ref" || kind === "expr") return String(v);
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

export function emitBody(node: BuilderNode): string {
  if (node.name === "Opaque") return String(node.props.raw ?? "");
  // Synthetic nodes reconstruct their bespoke syntax from structure.
  if (node.name === "Lambda") return `${node.props.param ?? "x"} => ${emitBody(node.children[0])}`;
  if (node.name === "MatchArm") return `${node.props.cond ?? "true"} => ${emitBody(node.children[0])}`;
  if (node.name === "MatchElse") return `else => ${emitBody(node.children[0])}`;
  if (node.name === "Match") return `match {\n  ${node.children.map(emitBody).join(",\n  ")}\n}`;
  const spec = specOf(node.name);
  if (spec.kind === "container") {
    // All positionals (declared scalar props, then children) precede named
    // args, so the emitted call stays canonical (positional-before-named).
    const parts: string[] = [];
    for (const p of posSpecs(spec)) {
      const v = node.props[p.key];
      if (v === undefined || v === "") continue;
      parts.push(emitProp(p.kind, v));
    }
    for (const c of node.children) parts.push(emitBody(c));
    parts.push(...emitNamed(node, spec.named));
    return `${node.name}(${parts.join(", ")})`;
  }
  const parts: string[] = [];
  for (const p of posSpecs(spec)) parts.push(emitProp(p.kind, node.props[p.key] ?? ""));
  parts.push(...emitNamed(node, spec.named));
  return `${node.name}(${parts.join(", ")})`;
}
