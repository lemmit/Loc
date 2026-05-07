import type { PathIR, StmtIR } from "../../ir/loom-ir.js";
import { pascal } from "../../util/naming.js";
import { renderCsExpr } from "./render-expr.js";

const INDENT = "        ";

export function renderCsStatements(stmts: StmtIR[]): string {
  return stmts.map(renderCsStatement).join("\n");
}

function renderCsStatement(s: StmtIR): string {
  switch (s.kind) {
    case "precondition":
      return `${INDENT}if (!(${renderCsExpr(s.expr)})) throw new DomainException(${JSON.stringify(`Precondition failed: ${s.source}`)});`;
    case "requires":
      // Authorization gate — surfaces as 403 (handled by
      // DomainExceptionFilter mapping ForbiddenException → 403).
      return `${INDENT}if (!(${renderCsExpr(s.expr)})) throw new ForbiddenException(${JSON.stringify(`Forbidden: ${s.source}`)});`;
    case "let":
      return `${INDENT}var ${s.name} = ${renderCsExpr(s.expr)};`;
    case "assign":
      return `${INDENT}${renderPath(s.target)} = ${renderCsExpr(s.value)};`;
    case "add":
      return `${INDENT}${renderPrivatePath(s.target)}.Add(${renderCsExpr(s.value)});`;
    case "remove":
      return `${INDENT}${renderPrivatePath(s.target)}.Remove(${renderCsExpr(s.value)});`;
    case "emit": {
      const args = s.fields
        .map((f) => `${pascal(f.name)}: ${renderCsExpr(f.value)}`)
        .join(", ");
      return `${INDENT}_domainEvents.Add(new ${s.eventName}(${args}));`;
    }
    case "call": {
      const args = s.args.map((a) => renderCsExpr(a)).join(", ");
      return `${INDENT}this.${pascal(s.name)}(${args});`;
    }
    case "expression":
      return `${INDENT}${renderCsExpr(s.expr)};`;
  }
}

function renderPath(p: PathIR): string {
  return p.segments.map((s) => pascal(s)).join(".");
}

// For collection mutation we go via the private backing field.
function renderPrivatePath(p: PathIR): string {
  if (p.segments.length === 0) return "this";
  const [head, ...tail] = p.segments;
  return `_${head}${tail.map((t) => `.${pascal(t)}`).join("")}`;
}
