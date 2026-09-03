// -------------------------------------------------------------------------
// Domain-emit predicates — pure usage probes over the expr/stmt IR, consumed
// by the context / domain-core / controller emitters to decide whether an
// operation references a given `param` or the request `currentUser`.  Leaf
// module: the renderers depend on this, never the reverse.
// -------------------------------------------------------------------------

import { type ExprIR, exprUsesCurrentUser, type StmtIR } from "../../../ir/types/loom-ir.js";
import { walkExprDeep } from "../../../ir/util/walk.js";

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
    case "variant-match":
      return (
        exprUsesCurrentUser(s.subject) ||
        s.arms.some((a) => a.body.some(stmtUsesCurrentUser)) ||
        (s.elseBody ?? []).some(stmtUsesCurrentUser)
      );
    default: {
      // Wave 2 packet 2.3 — every `StmtIR` kind is already listed above;
      // this turns that into a compile-time guarantee.
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

/** True when any statement in the operation body references `currentUser`. */
export function opUsesCurrentUser(op: { statements: readonly StmtIR[] }): boolean {
  return op.statements.some(stmtUsesCurrentUser);
}

/** True when `e` references param `name` anywhere in its reachable
 *  sub-expressions.
 *
 *  Rides `walkExprDeep` (M-T6.50 class, wave-2 packet 2.3): the hand-rolled
 *  ONE-LEVEL child walker this replaced (`walkExpr` below, now deleted) had
 *  no arm for `list`, `convert`, `match`, `i18nFormat` or `authz-filter`, and
 *  a block-body lambda's statements were never reached at all (`pred(e.body)`
 *  on an `undefined` body) — so a param reference nested in any of those
 *  (`[a, param.id]`, a `match` arm, …) was silently invisible, and the
 *  context function the emitter builds from this predicate would omit the
 *  parameter it needs, or the LiveView `assign` it depends on. */
export function exprUsesParam(e: ExprIR | undefined, name: string): boolean {
  if (!e) return false;
  let found = false;
  walkExprDeep(e, (x) => {
    if (x.kind === "ref" && x.refKind === "param" && x.name === name) found = true;
  });
  return found;
}

/** True when `e` references the aggregate receiver — a `this`/`this-prop`
 *  access, the `id` accessor, or a receiver-prefixed `function` /
 *  `private-operation` call (all of which render the `thisName` binding).
 *  The vanilla function emitter uses this to underscore-prefix an unused
 *  receiver, so a body that never touches the struct (e.g. `function noop()`)
 *  doesn't trip `mix compile --warnings-as-errors` on an unused `record`.
 *
 *  Rides `walkExprDeep` — same M-T6.50 class fix as `exprUsesParam` above
 *  (its former shared shallow walker had the identical gaps). */
export function exprUsesReceiver(e: ExprIR | undefined): boolean {
  if (!e) return false;
  let found = false;
  walkExprDeep(e, (x) => {
    if (x.kind === "this" || x.kind === "id") found = true;
    if (x.kind === "ref" && x.refKind === "this-prop") found = true;
    if (x.kind === "call" && (x.callKind === "function" || x.callKind === "private-operation"))
      found = true;
  });
  return found;
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
    case "variant-match":
      return (
        exprUsesParam(s.subject, name) ||
        s.arms.some((a) => a.body.some((st) => stmtUsesParam(st, name))) ||
        (s.elseBody ?? []).some((st) => stmtUsesParam(st, name))
      );
    default: {
      // Wave 2 packet 2.3 — every `StmtIR` kind is already listed above;
      // this turns that into a compile-time guarantee.
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}
