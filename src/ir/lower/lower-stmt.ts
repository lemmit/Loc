import type { LValue, Statement } from "../../language/generated/ast.js";
import {
  isAssignOrCallStmt,
  isEmitStmt,
  isLetStmt,
  isMatchStmt,
  isPreconditionStmt,
  isRequiresStmt,
  isReturnStmt,
} from "../../language/generated/ast.js";
import { typeKey, variantTag as unionVariantTag } from "../stdlib/unions.js";
import type { ExprIR, PathIR, StmtIR, TypeIR } from "../types/loom-ir.js";
import {
  inferExprType,
  isErrorVariantTag,
  lowerEmitFields,
  lowerExpr,
  lowerExprInContext,
  pathType,
  provSiteFor,
} from "./lower-expr.js";
import {
  cstText,
  type Env,
  findDomainServiceByName,
  findFunctionInEnv,
  findOperationInEnv,
  lowerAtom,
  withLocal,
} from "./lower-types.js";
import { originFor } from "./origin.js";

/** Lower a block of statements, threading the env so a `let` binds for the
 *  statements after it.  Used for match-arm / else bodies (Stage 2); the
 *  post-block env is discarded (a block scope doesn't leak outward). */
export function lowerStatements(stmts: readonly Statement[], env: Env): StmtIR[] {
  const out: StmtIR[] = [];
  let scope = env;
  for (const s of stmts) {
    const lowered = lowerStatement(s, scope);
    out.push(lowered.stmt);
    scope = lowered.envAfter;
  }
  return out;
}

/** Lower one statement, then stamp its `.ddd` (or macro-call) origin onto
 *  the result — the single chokepoint every statement passes through,
 *  including nested statements reached via recursive `variant-match` /
 *  match-arm bodies (they recurse back through `lowerStatement`, not
 *  `lowerStatementInner`, so they get stamped too).  An already-set
 *  `origin` (none today, but future-proofed) wins over the derived one. */
export function lowerStatement(stmt: Statement, env: Env): { stmt: StmtIR; envAfter: Env } {
  const lowered = lowerStatementInner(stmt, env);
  return {
    ...lowered,
    stmt: { ...lowered.stmt, origin: lowered.stmt.origin ?? originFor(stmt) },
  };
}

function lowerStatementInner(stmt: Statement, env: Env): { stmt: StmtIR; envAfter: Env } {
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
  if (isMatchStmt(stmt)) {
    // Effect-form variant match (async-actions-and-effects.md Stage 2).  Lower
    // the subject once (an `await <call>` becomes a call ExprIR with
    // `awaited: true`); resolve its `or`-union type for the variant set; lower
    // each arm's statement block, binding the (optional) narrowed variant value
    // as a real local (`match-binding`) so member reads inside the arm resolve.
    const subject = lowerExpr(stmt.subject, env);
    const subjectType = subject.kind === "ref" ? subject.type : inferExprType(stmt.subject, env);
    const arms = stmt.varArms.map((arm) => {
      const varType = lowerAtom(arm.varType, env);
      const armEnv = arm.binding ? withLocal(env, arm.binding, "match-binding", varType) : env;
      return {
        varType,
        binding: arm.binding,
        body: lowerStatements(arm.body, armEnv),
        isError: isErrorVariantTag(unionVariantTag(varType), env),
      };
    });
    return {
      stmt: {
        kind: "variant-match",
        subject,
        subjectType,
        arms,
        ...(stmt.elseBody.length > 0 ? { elseBody: lowerStatements(stmt.elseBody, env) } : {}),
      },
      envAfter: env,
    };
  }
  if (isReturnStmt(stmt)) {
    const value = lowerExpr(stmt.value, env);
    // In a union-returning operation, tag the return with the variant whose
    // structural key matches the returned value's type (producer).
    let variantTag: string | undefined;
    let variantShape: "record" | "scalar" | "none" | undefined;
    if (env.returnVariants) {
      const vt = inferExprType(stmt.value, env);
      const match = env.returnVariants.find((v) => typeKey(v) === typeKey(vt));
      if (match) {
        variantTag = unionVariantTag(match);
        variantShape =
          match.kind === "none"
            ? "none"
            : match.kind === "entity" || match.kind === "valueobject"
              ? "record"
              : "scalar";
      }
    }
    return {
      stmt: { kind: "return", value, variantTag, variantShape },
      envAfter: env,
    };
  }
  if (isEmitStmt(stmt)) {
    return {
      stmt: {
        kind: "emit",
        eventName: stmt.event?.ref?.name ?? "Unknown",
        fields: lowerEmitFields(stmt.event?.ref, stmt.fields, env),
      },
      envAfter: env,
    };
  }
  if (isAssignOrCallStmt(stmt)) {
    const lv: LValue = stmt.target;
    if (!stmt.op) {
      // `name(args)` — sibling action, local function, or private operation.
      if (lv.call && lv.tail.length === 0) {
        const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
        // A bare call inside a page/component action body that names a SIBLING
        // action on the same surface lowers to a `target: "action"` call so the
        // frontend walkers invoke the callee's handler (and mark it used) rather
        // than treating it as a backend private-operation (Proposal A Stage 1).
        if (env.actions?.has(lv.head)) {
          return {
            stmt: { kind: "call", target: "action", name: lv.head, args },
            envAfter: env,
          };
        }
        const fn = findFunctionInEnv(env, lv.head);
        const target: "function" | "private-operation" = fn ? "function" : "private-operation";
        // Carry the target operation's resolved privacy (see the IR `call`
        // node's `targetPrivate`) so backends render the self-call against the
        // right def-site name.
        const targetPrivate =
          target === "private-operation"
            ? (findOperationInEnv(env, lv.head)?.private ?? false)
            : undefined;
        return {
          stmt: {
            kind: "call",
            target,
            name: lv.head,
            args,
            ...(targetPrivate ? { targetPrivate } : {}),
          },
          envAfter: env,
        };
      }
      // `<Store>.<action>(args)` — a store-action call from a page/store
      // action body (Stage 5).  Lowers to a `target: "store-action"` call
      // carrying the resolved store, so frontends bind + invoke the store
      // action (and a store→store call stays acyclic, gated by the validator)
      // rather than treating the dotted form as an arbitrary host call.
      if (lv.call && lv.tail.length === 1 && env.stores?.has(lv.head)) {
        const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
        return {
          stmt: { kind: "call", target: "store-action", name: lv.tail[0]!, store: lv.head, args },
          envAfter: env,
        };
      }
      // `Pricing.quote(args)` — a domain-service member call written as a
      // STATEMENT (`Penalty.charge(this, amount)`).  Mirrors the expression-path
      // domain-service arm so it lowers to a `call` with `callKind:
      // "domain-service"` + the structured `serviceRef` — backends emit a real
      // call without re-resolving, and the `infra-call-from-aggregate` validator
      // gate (which scans for `callKind === "domain-service"`) can see a
      // reading/mutating service reached from inside an aggregate body.  Checked
      // before the generic chained-call path so a service name isn't mistaken
      // for an aggregate-local receiver.
      if (lv.call && lv.tail.length === 1 && !env.locals.has(lv.head)) {
        const svc = findDomainServiceByName(env, lv.head);
        if (svc) {
          const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
          const expr: ExprIR = {
            kind: "call",
            callKind: "domain-service",
            name: lv.tail[0]!,
            args,
            serviceRef: { service: svc.name, op: lv.tail[0]! },
          };
          return { stmt: { kind: "expression", expr }, envAfter: env };
        }
      }
      // `a.b.c(args)` — chained call.  Two shapes share this path:
      //   - an e2e body chain (`api.orders.addLine(...)`) whose head is not an
      //     in-scope local — receiver stays an `unknown` ref / string types, as
      //     before;
      //   - a `param.op(args)` call on an in-scope aggregate-typed LOCAL
      //     (`src.withdraw(amount)` — the domain-services.md rev. 4 mutating
      //     tier).  When the head names a local, RESOLVE it so the receiver
      //     carries its real `refKind` (`param`/`let`) and entity type — the IR
      //     stays fully resolved (architecture invariant: backends never
      //     re-resolve), and the domain-service tier classifier can see that the
      //     call targets a mutating op on a passed-in aggregate.
      if (lv.call && lv.tail.length > 0) {
        const headLocal = env.locals.get(lv.head);
        const stringType: TypeIR = { kind: "primitive", name: "string" };
        let recv: ExprIR = headLocal
          ? { kind: "ref", name: lv.head, refKind: headLocal.kind, type: headLocal.type }
          : { kind: "ref", name: lv.head, refKind: "unknown" };
        // The receiver type entering the final call: the head local's type when
        // the call is directly on the head (`src.withdraw(...)` — the common
        // `param.op()` shape, single tail); intermediate members in a longer
        // chain (e2e `api.orders.addLine`) stay string-typed as before.
        let recvType: TypeIR = headLocal?.type ?? stringType;
        for (let i = 0; i < lv.tail.length - 1; i++) {
          recv = {
            kind: "member",
            receiver: recv,
            member: lv.tail[i]!,
            receiverType: recvType,
            memberType: stringType,
          };
          recvType = stringType;
        }
        const lastMember = lv.tail[lv.tail.length - 1]!;
        const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
        const expr: ExprIR = {
          kind: "method-call",
          receiver: recv,
          member: lastMember,
          args,
          receiverType: recvType,
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
      const collection = targetType.kind === "array";
      const elementType = collection ? targetType.element : targetType;
      // Element-type context applies for both array push (`+=`) and
      // remove (`-=`) — same numeric-literal-into-money elaboration.
      const value = lowerExprInContext(stmt.value, elementType, env);
      return {
        stmt: {
          kind: stmt.op === "+=" ? "add" : "remove",
          target: path,
          value,
          elementType,
          // True when the target is a collection (`xs += item` →
          // append / `xs -= item` → remove); false for scalar compound
          // assignment (`count += 1` → arithmetic).  Domain `add`/`remove`
          // are always collection mutations; page handlers overload the
          // kinds for scalar counters, so the walker needs the signal.
          collection,
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
