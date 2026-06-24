// -------------------------------------------------------------------------
// Domain-emit predicates — a pure `param`-usage probe over the expr/stmt IR,
// consumed by the context / domain-core emitters to decide whether an
// operation argument is actually referenced in a body.  Leaf module: the
// renderers depend on this, never the reverse.
// -------------------------------------------------------------------------

import type { ExprIR, StmtIR } from "../../../ir/types/loom-ir.js";

function exprUsesParam(e: ExprIR | undefined, name: string): boolean {
  if (!e) return false;
  if (e.kind === "ref" && e.refKind === "param" && e.name === name) return true;
  return walkExpr(e, (sub) => exprUsesParam(sub, name));
}

export function stmtUsesParam(s: StmtIR, name: string): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return exprUsesParam(s.expr, name);
    case "assign":
    case "add":
    case "remove":
    case "return":
      return exprUsesParam(s.value, name);
    case "emit":
      return s.fields.some((f) => exprUsesParam(f.value, name));
    case "call":
      return s.args.some((a) => exprUsesParam(a, name));
  }
}

/** Walk one level into `e` and return true if `pred` matches any child. */
function walkExpr(e: ExprIR, pred: (sub: ExprIR | undefined) => boolean): boolean {
  switch (e.kind) {
    case "method-call":
      return pred(e.receiver) || e.args.some((a) => pred(a));
    case "member":
      return pred(e.receiver);
    case "binary":
      return pred(e.left) || pred(e.right);
    case "ternary":
      return pred(e.cond) || pred(e.then) || pred(e.otherwise);
    case "unary":
      return pred(e.operand);
    case "paren":
      return pred(e.inner);
    case "call":
      return e.args.some((a) => pred(a));
    case "lambda":
      return pred(e.body);
    case "new":
    case "object":
      return e.fields.some((f) => pred(f.value));
  }
  return false;
}
