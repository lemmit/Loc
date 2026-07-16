import type { LValue, Statement } from "../generated/ast.js";
import { printExpr, printTypeAtomLite, registerStatementPrinter } from "./print-expr.js";

// ---------------------------------------------------------------------------
// AST → `.ddd` source printer for statements (lambda block bodies;
// operation / workflow bodies route through the same printer when
// needed).  See `print-expr.ts` for the round-trip rationale.
// ---------------------------------------------------------------------------

export function printStmt(node: Statement): string {
  switch (node.$type) {
    case "PreconditionStmt":
      return `precondition ${printExpr(node.expr)}${node.message ? ` message ${JSON.stringify(node.message)}` : ""}`;
    case "RequiresStmt":
      return `requires ${printExpr(node.expr)}`;
    case "LetStmt":
      return `let ${node.name} = ${printExpr(node.expr)}`;
    case "EmitStmt": {
      const fields = node.fields.map((f) => `${f.name}: ${printExpr(f.value)}`).join(", ");
      return `emit ${node.event.$refText} {${fields.length > 0 ? ` ${fields} ` : ""}}`;
    }
    case "AssignOrCallStmt": {
      const target = printLValue(node.target);
      return node.op && node.value ? `${target} ${node.op} ${printExpr(node.value)}` : target;
    }
    case "ForStmt": {
      const body = node.body.map((s) => `  ${printStmt(s)}`).join("\n");
      return `for ${node.var} in ${printExpr(node.iterable)} {\n${body}\n}`;
    }
    case "IfLetStmt": {
      const thenBody = node.thenBody.map((s) => `  ${printStmt(s)}`).join("\n");
      const head = `if let ${node.var} = ${printExpr(node.source)} {\n${thenBody}\n}`;
      if ((node.elseBody ?? []).length === 0) return head;
      const elseBody = node.elseBody.map((s) => `  ${printStmt(s)}`).join("\n");
      return `${head} else {\n${elseBody}\n}`;
    }
    case "ReturnStmt":
      return `return ${printExpr(node.value)}`;
    case "MatchStmt": {
      // Effect-form match statement (Stage 2).  Subject prints via the
      // expression printer (an `await <call>` subject renders `await …`); each
      // arm's statement body prints as an inline `{ … }` block.
      const armText = (stmts: Statement[]): string =>
        `{ ${stmts.map((s) => printStmt(s)).join("; ")} }`;
      const arms = node.varArms.map(
        (a) =>
          `${printTypeAtomLite(a.varType)}${a.binding ? ` ${a.binding}` : ""} => ${armText(a.body)}`,
      );
      const parts = [...arms];
      if (node.elseBody.length > 0) parts.push(`else => ${armText(node.elseBody)}`);
      return `match ${printExpr(node.subject)} {\n${parts.map((p) => `  ${p}`).join("\n")}\n}`;
    }
    default: {
      const exhaustive: never = node;
      throw new Error(`printStmt: unhandled node ${(exhaustive as { $type: string }).$type}`);
    }
  }
}

function printLValue(lv: LValue): string {
  const path = [lv.head, ...lv.tail].join(".");
  return lv.call ? `${path}(${lv.args.map(printExpr).join(", ")})` : path;
}

// Break the expr↔stmt cycle: print-expr calls back here for lambda blocks.
registerStatementPrinter((stmt) => printStmt(stmt as Statement));
