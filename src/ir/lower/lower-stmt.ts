import type { LValue, Statement } from "../../language/generated/ast.js";
import {
  isAssignOrCallStmt,
  isEmitStmt,
  isLetStmt,
  isPreconditionStmt,
  isRequiresStmt,
  isReturnStmt,
} from "../../language/generated/ast.js";
import type { ExprIR, PathIR, StmtIR } from "../types/loom-ir.js";
import {
  inferExprType,
  lowerExpr,
  lowerExprInContext,
  pathType,
  provSiteFor,
} from "./lower-expr.js";
import { cstText, type Env, findFunctionInEnv, withLocal } from "./lower-types.js";

export function lowerStatement(stmt: Statement, env: Env): { stmt: StmtIR; envAfter: Env } {
  if (isPreconditionStmt(stmt)) {
    return {
      stmt: {
        kind: "precondition",
        expr: lowerExpr(stmt.expr, env),
        source: cstText(stmt.expr),
      },
      envAfter: env,
    };
  }
  if (isRequiresStmt(stmt)) {
    // `requires` lowers like `precondition` but with a different
    // statement kind so the renderer can throw a 403-mapping
    // exception instead of the 400-mapping DomainException.
    return {
      stmt: {
        kind: "requires",
        expr: lowerExpr(stmt.expr, env),
        source: cstText(stmt.expr),
      },
      envAfter: env,
    };
  }
  if (isLetStmt(stmt)) {
    const expr = lowerExpr(stmt.expr, env);
    const t = inferExprType(stmt.expr, env);
    const next = withLocal(env, stmt.name, "let", t);
    return {
      stmt: { kind: "let", name: stmt.name, expr, type: t },
      envAfter: next,
    };
  }
  if (isReturnStmt(stmt)) {
    return {
      stmt: { kind: "return", value: lowerExpr(stmt.value, env) },
      envAfter: env,
    };
  }
  if (isEmitStmt(stmt)) {
    return {
      stmt: {
        kind: "emit",
        eventName: stmt.event?.ref?.name ?? "Unknown",
        fields: stmt.fields.map((f) => ({
          name: f.name,
          value: lowerExpr(f.value, env),
        })),
      },
      envAfter: env,
    };
  }
  if (isAssignOrCallStmt(stmt)) {
    const lv: LValue = stmt.target;
    if (!stmt.op) {
      // `name(args)` — local function or private operation.
      if (lv.call && lv.tail.length === 0) {
        const fn = findFunctionInEnv(env, lv.head);
        const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
        const target: "function" | "private-operation" = fn ? "function" : "private-operation";
        return {
          stmt: { kind: "call", target, name: lv.head, args },
          envAfter: env,
        };
      }
      // `a.b.c(args)` — chained call (e.g. `api.orders.addLine(...)`
      // in an e2e body).  Synthesise a method-call expression and
      // wrap as an expression-statement.
      if (lv.call && lv.tail.length > 0) {
        let recv: ExprIR = { kind: "ref", name: lv.head, refKind: "unknown" };
        for (let i = 0; i < lv.tail.length - 1; i++) {
          recv = {
            kind: "member",
            receiver: recv,
            member: lv.tail[i]!,
            receiverType: { kind: "primitive", name: "string" },
            memberType: { kind: "primitive", name: "string" },
          };
        }
        const lastMember = lv.tail[lv.tail.length - 1]!;
        const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
        const expr: ExprIR = {
          kind: "method-call",
          receiver: recv,
          member: lastMember,
          args,
          receiverType: { kind: "primitive", name: "string" },
          isCollectionOp: false,
        };
        return { stmt: { kind: "expression", expr }, envAfter: env };
      }
      return {
        stmt: { kind: "call", target: "function", name: lv.head, args: [] },
        envAfter: env,
      };
    }
    const path: PathIR = { segments: [lv.head, ...lv.tail] };
    const prov = provSiteFor(path, stmt.value, stmt, env);
    if (stmt.op === ":=") {
      // Contextual lowering: a numeric literal flowing into a
      // money-typed target lowers as money — `subtotal := 0.50`
      // becomes `lit("money", "0.50")` so the backend emits the
      // precise constructor.
      const targetType = pathType(path, env);
      const value = lowerExprInContext(stmt.value, targetType, env);
      return {
        stmt: { kind: "assign", target: path, value, targetType, prov },
        envAfter: env,
      };
    }
    if (stmt.op === "+=" || stmt.op === "-=") {
      const targetType = pathType(path, env);
      const elementType = targetType.kind === "array" ? targetType.element : targetType;
      // Element-type context applies for both array push (`+=`) and
      // remove (`-=`) — same numeric-literal-into-money elaboration.
      const value = lowerExprInContext(stmt.value, elementType, env);
      return {
        stmt: {
          kind: stmt.op === "+=" ? "add" : "remove",
          target: path,
          value,
          elementType,
          prov,
        },
        envAfter: env,
      };
    }
  }
  // Fallback no-op
  return {
    stmt: { kind: "call", target: "function", name: "<unknown>", args: [] },
    envAfter: env,
  };
}
