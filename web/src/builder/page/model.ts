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

export type PropKind = "string" | "int";

interface NamedProp {
  key: string;
  kind: PropKind;
}

interface PrimitiveSpec {
  kind: "container" | "leaf";
  /** Leaf only: positional string args, in order. */
  positional?: string[];
  /** Leaf only: optional `name: value` args. */
  named?: NamedProp[];
}

// The closed set the canvas understands.  Containers hold children; leaves
// carry string/int props.  Everything else round-trips as Opaque.
const SPECS = {
  Stack: { kind: "container" },
  Group: { kind: "container" },
  Grid: { kind: "container" },
  Toolbar: { kind: "container" },
  Heading: { kind: "leaf", positional: ["text"], named: [{ key: "level", kind: "int" }] },
  Text: { kind: "leaf", positional: ["text"] },
  Button: { kind: "leaf", positional: ["label"], named: [{ key: "to", kind: "string" }] },
  Anchor: { kind: "leaf", positional: ["text"], named: [{ key: "to", kind: "string" }] },
  Badge: { kind: "leaf", positional: ["value"], named: [{ key: "color", kind: "string" }] },
  Alert: { kind: "leaf", positional: ["message"], named: [{ key: "color", kind: "string" }] },
  Empty: { kind: "leaf", positional: ["message"] },
  Divider: { kind: "leaf" },
} satisfies Record<string, PrimitiveSpec>;

export type PrimitiveName = keyof typeof SPECS | "Opaque";
export const PRIMITIVES = Object.keys(SPECS) as (keyof typeof SPECS)[];

// `satisfies` narrows each entry to its literal shape; widen on read so
// optional positional/named are uniformly accessible.
const specOf = (name: keyof typeof SPECS): PrimitiveSpec => SPECS[name];

export function isContainer(name: PrimitiveName): boolean {
  return name !== "Opaque" && specOf(name).kind === "container";
}

/** Settings/seed field descriptors for a primitive (drives the panel UI).
 *  Unknown names (e.g. the synthetic `Root`) have no editable fields. */
export function propFields(name: string): { key: string; kind: PropKind }[] {
  if (name === "Opaque") return [{ key: "raw", kind: "string" }];
  if (!(name in SPECS)) return [];
  const spec = specOf(name as keyof typeof SPECS);
  return [
    ...(spec.positional ?? []).map((key) => ({ key, kind: "string" as const })),
    ...(spec.named ?? []),
  ];
}

export interface BuilderNode {
  name: PrimitiveName;
  props: Record<string, string | number | undefined>;
  children: BuilderNode[];
}

export function defaultNode(name: keyof typeof SPECS): BuilderNode {
  const spec = specOf(name);
  const props: Record<string, string | number> = {};
  // First positional placeholder is the primitive name (a fresh Button reads
  // "Button"); further positionals fall back to their capitalised key.  Named
  // props are optional and left unset so a fresh node emits its minimal form.
  (spec.positional ?? []).forEach((key, i) => {
    props[key] = i === 0 ? name : key.charAt(0).toUpperCase() + key.slice(1);
  });
  return { name, props, children: [] };
}

function opaque(expr: Expression): BuilderNode {
  return { name: "Opaque", props: { raw: printExpr(expr) }, children: [] };
}

function asString(e: Expression): string | null {
  return e.$type === "StringLit" ? e.value : null;
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
  if (expr.$type !== "CallExpr" || expr.callee.$type !== "NameRef") return opaque(expr);
  const name = expr.callee.name;
  if (!(name in SPECS)) return opaque(expr);
  const spec = specOf(name as keyof typeof SPECS);
  const { positional, named, canonical } = partition(expr.args);
  if (!canonical) return opaque(expr);

  if (spec.kind === "container") {
    if (named.size > 0) return opaque(expr);
    return { name: name as PrimitiveName, props: {}, children: positional.map(seedFromBody) };
  }

  // leaf — positional strings must match exactly; named must be known + typed.
  const posKeys = spec.positional ?? [];
  if (positional.length !== posKeys.length) return opaque(expr);
  const props: Record<string, string | number> = {};
  for (let i = 0; i < posKeys.length; i++) {
    const v = asString(positional[i]);
    if (v === null) return opaque(expr);
    props[posKeys[i]] = v;
  }
  const namedSpec = new Map((spec.named ?? []).map((n) => [n.key, n.kind]));
  for (const [k, v] of named) {
    const kind = namedSpec.get(k);
    if (!kind) return opaque(expr);
    if (kind === "string") {
      const s = asString(v);
      if (s === null) return opaque(expr);
      props[k] = s;
    } else {
      if (v.$type !== "IntLit") return opaque(expr);
      props[k] = v.value;
    }
  }
  return { name: name as PrimitiveName, props, children: [] };
}

export function emitBody(node: BuilderNode): string {
  if (node.name === "Opaque") return String(node.props.raw ?? "");
  const spec = specOf(node.name);
  if (spec.kind === "container") {
    return `${node.name}(${node.children.map(emitBody).join(", ")})`;
  }
  const parts: string[] = [];
  for (const key of spec.positional ?? []) parts.push(JSON.stringify(String(node.props[key] ?? "")));
  for (const n of spec.named ?? []) {
    const v = node.props[n.key];
    if (v === undefined || v === "") continue;
    parts.push(`${n.key}: ${n.kind === "int" ? Number(v) : JSON.stringify(String(v))}`);
  }
  return `${node.name}(${parts.join(", ")})`;
}
