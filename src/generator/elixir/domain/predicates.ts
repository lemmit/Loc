// -------------------------------------------------------------------------
// Domain-emit predicates — pure usage probes over the expr/stmt IR, consumed
// by the context / domain-core / controller emitters to decide whether an
// operation references a given `param` or the request `currentUser`.  Leaf
// module: the renderers depend on this, never the reverse.
// -------------------------------------------------------------------------

import { type ExprIR, exprUsesCurrentUser, type StmtIR } from "../../../ir/types/loom-ir.js";

/** True when statement `s` references `currentUser` anywhere in its expr(s) —
 *  e.g. a `requires currentUser.role == "admin"` guard or a `field :=
 *  currentUser.id` assign.  The context function then threads `current_user`
 *  in (mirroring the auditable/stamp principal path) and the controller passes
 *  `conn.assigns[:current_user]`. */
export function stmtUsesCurrentUser(s: StmtIR): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return exprUsesCurrentUser(s.expr);
    case "assign":
    case "add":
    case "remove":
    case "return":
      return exprUsesCurrentUser(s.value);
    case "emit":
      return s.fields.some((f) => exprUsesCurrentUser(f.value));
    case "call":
      return s.args.some(exprUsesCurrentUser);
  }
}

/** True when any statement in the operation body references `currentUser`. */
export function opUsesCurrentUser(op: { statements: readonly StmtIR[] }): boolean {
  return op.statements.some(stmtUsesCurrentUser);
}

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
