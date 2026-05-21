import type { CallArg, Expression } from "../../../../src/language/generated/ast.js";
import { printExpr } from "../../../../src/language/print/index.js";

// ---------------------------------------------------------------------------
// Page-builder data model: a craft-agnostic tree mediating between a parsed
// page `body:` expression and `.ddd` source.
//
// Recognize-or-opaque: a node whose shape the builder fully understands
// becomes an editable typed node; anything else (named args we don't model,
// `match`, member access, unknown calls, lambdas, …) becomes an `Opaque` node
// carrying its printed source verbatim.  This guarantees the body round-trips
// even when the canvas can't render part of it — combined with
// regenerate-and-splice at the body's CST range, nothing outside is touched.
// ---------------------------------------------------------------------------

export type PrimitiveName = "Stack" | "Group" | "Heading" | "Text" | "Button" | "Opaque";

export interface BuilderNode {
  name: PrimitiveName;
  props: Record<string, string | number | undefined>;
  children: BuilderNode[];
}

const CONTAINERS = new Set<PrimitiveName>(["Stack", "Group"]);
export const isContainer = (name: PrimitiveName): boolean => CONTAINERS.has(name);

function opaque(expr: Expression): BuilderNode {
  return { name: "Opaque", props: { raw: printExpr(expr) }, children: [] };
}

function asString(e: Expression): string | null {
  return e.$type === "StringLit" ? e.value : null;
}

// Split call args into positional values and a name→value map.
function partition(args: CallArg[]): {
  positional: Expression[];
  named: Map<string, Expression>;
} {
  const positional: Expression[] = [];
  const named = new Map<string, Expression>();
  for (const a of args) {
    if (a.name) named.set(a.name, a.value);
    else positional.push(a.value);
  }
  return { positional, named };
}

/** Build the editable tree from a parsed page `body:` expression. */
export function seedFromBody(expr: Expression): BuilderNode {
  if (expr.$type !== "CallExpr" || expr.callee.$type !== "NameRef") return opaque(expr);
  const name = expr.callee.name;
  const { positional, named } = partition(expr.args);

  switch (name) {
    case "Stack":
    case "Group":
      // Containers we model carry only children; any named arg (e.g. testid)
      // we can't round-trip editably, so fall back to opaque.
      if (named.size > 0) return opaque(expr);
      return { name, props: {}, children: positional.map(seedFromBody) };

    case "Heading": {
      const text = positional.length === 1 ? asString(positional[0]) : null;
      const levelExpr = named.get("level");
      const okNamed = [...named.keys()].every((k) => k === "level");
      const level = levelExpr?.$type === "IntLit" ? levelExpr.value : undefined;
      if (text === null || !okNamed || (levelExpr && level === undefined)) return opaque(expr);
      return { name: "Heading", props: { text, level }, children: [] };
    }

    case "Text": {
      const text = positional.length === 1 && named.size === 0 ? asString(positional[0]) : null;
      if (text === null) return opaque(expr);
      return { name: "Text", props: { text }, children: [] };
    }

    case "Button": {
      const label = positional.length === 1 ? asString(positional[0]) : null;
      const toExpr = named.get("to");
      const okNamed = [...named.keys()].every((k) => k === "to");
      const to = toExpr ? asString(toExpr) : undefined;
      if (label === null || !okNamed || (toExpr && to === null)) return opaque(expr);
      return { name: "Button", props: { label, to: to ?? undefined }, children: [] };
    }

    default:
      return opaque(expr);
  }
}

/** Emit `.ddd` source for the body tree. */
export function emitBody(node: BuilderNode): string {
  switch (node.name) {
    case "Opaque":
      return String(node.props.raw ?? "");
    case "Stack":
    case "Group":
      return `${node.name}(${node.children.map(emitBody).join(", ")})`;
    case "Heading": {
      const level = node.props.level;
      return `Heading(${JSON.stringify(node.props.text ?? "")}${level !== undefined ? `, level: ${level}` : ""})`;
    }
    case "Text":
      return `Text(${JSON.stringify(node.props.text ?? "")})`;
    case "Button": {
      const to = node.props.to;
      return `Button(${JSON.stringify(node.props.label ?? "")}${to !== undefined ? `, to: ${JSON.stringify(to)}` : ""})`;
    }
  }
}
