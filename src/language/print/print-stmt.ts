import type { LValue, Statement } from "../generated/ast.js";
import {
  indentBlock,
  printExpr,
  printTypeAtomLite,
  registerStatementPrinter,
  withIndent,
  wrapArgList,
  wrapBraced,
} from "./print-expr.js";

// ---------------------------------------------------------------------------
// AST → `.ddd` source printer for statements (lambda block bodies;
// operation / workflow bodies route through the same printer when
// needed).  See `print-expr.ts` for the round-trip rationale.
//
// Every nested block routes through `indentBlock` (the shared `indent()` from
// print-expr.ts), NOT a first-line `"  " + …` prefix: prefixing only shifts a
// child's FIRST line, so a multi-line child (a nested `for`, an `if let`, a
// wrapped call) leaves its continuation lines and closing brace at the parent's
// depth.  A statement body is a block, so it indents as a block.
// ---------------------------------------------------------------------------

/** `<head> {\n  <stmts>\n}` — the canonical statement-block shape.  `{}` when
 *  the body is empty (the grammar accepts an empty block everywhere); an empty
 *  `head` yields the bare `{ … }` form a match arm needs. */
function stmtBlock(head: string, stmts: Statement[]): string {
  const prefix = head ? `${head} ` : "";
  if (stmts.length === 0) return `${prefix}{}`;
  const body = withIndent(() => stmts.map((s) => printStmt(s)).join("\n"));
  return `${prefix}{\n${indentBlock(body)}\n}`;
}

export function printStmt(node: Statement): string {
  switch (node.$type) {
    case "PreconditionStmt":
      return `precondition ${printExpr(node.expr)}${node.message ? ` message ${JSON.stringify(node.message)}` : ""}`;
    case "RequiresStmt":
      return `requires ${printExpr(node.expr)}`;
    case "LetStmt":
      return `let ${node.name} = ${printExpr(node.expr)}`;
    case "EmitStmt": {
      const fields = withIndent(() => node.fields.map((f) => `${f.name}: ${printExpr(f.value)}`));
      return wrapBraced(`emit ${node.event.$refText} `, fields);
    }
    case "AssignOrCallStmt": {
      const target = printLValue(node.target);
      return node.op && node.value ? `${target} ${node.op} ${printExpr(node.value)}` : target;
    }
    case "ForStmt":
      return stmtBlock(`for ${node.var} in ${printExpr(node.iterable)}`, node.body);
    case "IfLetStmt": {
      const head = stmtBlock(`if let ${node.var} = ${printExpr(node.source)}`, node.thenBody);
      if ((node.elseBody ?? []).length === 0) return head;
      return stmtBlock(`${head} else`, node.elseBody);
    }
    case "ReturnStmt":
      return `return ${printExpr(node.value)}`;
    case "MatchStmt": {
      // Effect-form match statement (Stage 2).  Subject prints via the
      // expression printer (an `await <call>` subject renders `await …`).
      //
      // An arm body is a BLOCK of statements — `VariantStmtArm` in the grammar
      // is `'{' body+=Statement* '}'`, and the statement grammar has no `;`
      // separator, so a multi-statement arm must span lines.  Only a
      // single-statement arm keeps the compact `{ stmt }` form.
      const armText = (stmts: Statement[]): string => {
        if (stmts.length === 1) {
          const only = printStmt(stmts[0]!);
          // A single-line statement keeps the compact form; one that already
          // spans lines (a nested loop / match) would otherwise strand the
          // arm's closing brace beside the inner one.
          if (!only.includes("\n")) return `{ ${only} }`;
        }
        return stmtBlock("", stmts);
      };
      const parts = withIndent(() => {
        const rows = node.varArms.map(
          (a) =>
            `${printTypeAtomLite(a.varType)}${a.binding ? ` ${a.binding}` : ""} => ${armText(a.body)}`,
        );
        if (node.elseBody.length > 0) rows.push(`else => ${armText(node.elseBody)}`);
        return rows;
      });
      return `match ${printExpr(node.subject)} {\n${indentBlock(parts.join("\n"))}\n}`;
    }
    default: {
      const exhaustive: never = node;
      throw new Error(`printStmt: unhandled node ${(exhaustive as { $type: string }).$type}`);
    }
  }
}

function printLValue(lv: LValue): string {
  const path = [lv.head, ...lv.tail].join(".");
  return lv.call
    ? wrapArgList(
        path,
        "(",
        ")",
        withIndent(() => lv.args.map((a) => printExpr(a))),
      )
    : path;
}

// Break the expr↔stmt cycle: print-expr calls back here for lambda blocks.
registerStatementPrinter((stmt) => printStmt(stmt as Statement));
