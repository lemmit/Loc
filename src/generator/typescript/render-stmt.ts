import type { PathIR, StmtIR } from "../../ir/loom-ir.js";
import { renderTsExpr } from "./render-expr.js";

const INDENT = "    ";

export function renderTsStatements(stmts: StmtIR[]): string {
  return stmts.map(renderTsStatement).join("\n");
}

function renderTsStatement(s: StmtIR): string {
  switch (s.kind) {
    case "precondition":
      return `${INDENT}if (!(${renderTsExpr(s.expr)})) throw new DomainError(${JSON.stringify(`Precondition failed: ${s.source}`)});`;
    case "let":
      return `${INDENT}const ${s.name} = ${renderTsExpr(s.expr)};`;
    case "assign":
      return `${INDENT}${renderPath(s.target)} = ${renderTsExpr(s.value)};`;
    case "add":
      return `${INDENT}${renderPath(s.target)}.push(${renderTsExpr(s.value)});`;
    case "remove": {
      const path = renderPath(s.target);
      const value = renderTsExpr(s.value);
      return `${INDENT}{ const __idx = ${path}.findIndex((__e) => __e === (${value})); if (__idx >= 0) ${path}.splice(__idx, 1); }`;
    }
    case "emit": {
      const fields = s.fields.map((f) => `${f.name}: ${renderTsExpr(f.value)}`).join(", ");
      return `${INDENT}this._events.push({ type: ${JSON.stringify(s.eventName)}, ${fields} });`;
    }
    case "call": {
      const args = s.args.map((a) => renderTsExpr(a)).join(", ");
      return `${INDENT}this.${camelize(s.name)}(${args});`;
    }
    case "expression":
      return `${INDENT}${renderTsExpr(s.expr)};`;
  }
}

function renderPath(p: PathIR): string {
  if (p.segments.length === 0) return "this";
  const [head, ...tail] = p.segments;
  return `this._${head}${tail.map((t) => `.${t}`).join("")}`;
}

function camelize(name: string): string {
  return name[0]!.toLowerCase() + name.slice(1);
}
