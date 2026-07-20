// Domain-service lowering — `.ddd` AST → DomainServiceIR
// (domain-services.md, v1 Shape A, the pure-calculator floor).
//
// A `domainService` is a stateless, context-level container of
// NON-mutating operations.  Each operation body is lowered through the
// ordinary statement/expression path (`lowerStatement` / `lowerExpr`):
// parameters become `param` locals, a union return type threads its
// variants into the env so each `return <expr>` tags its value, exactly
// like an aggregate operation body — but there is no `this` binding
// (the service holds no aggregate identity; the no-infra contract is a
// phase-⑦ validator concern, not a lowering one).
//
// This is a leaf module: it never imports `lower.ts` (the graph is
// acyclic — the orchestrator imports this).
import type { DomainService, Repository } from "../../language/generated/ast.js";
import { isRepository } from "../../language/generated/ast.js";
import type {
  DomainServiceIR,
  DomainServiceOperationIR,
  ParamIR,
  StmtIR,
} from "../types/loom-ir.js";
import { lowerStatement } from "./lower-stmt.js";
import { collectSubjectTests } from "./lower-test.js";
import { type Env, lowerType, withLocal } from "./lower-types.js";

export function lowerDomainService(decl: DomainService, env: Env): DomainServiceIR {
  // Index the enclosing context's repositories so a recognised repository READ
  // in an operation body (`Accounts.byHolder(h)`) lowers to a resolved
  // `repo-read` Call — the `reading` tier (domain-services.md rev. 4).  Empty
  // when the context declares none; a write call then has nothing to resolve
  // against and the validator's repo-write gate handles it off the AST shape.
  const serviceRepos = new Map<string, Repository>();
  for (const m of env.ctx?.members ?? []) {
    if (isRepository(m)) serviceRepos.set(m.name, m);
  }
  const svcEnv: Env = { ...env, serviceRepos };
  return {
    name: decl.name,
    operations: decl.operations.map((op) => lowerDomainServiceOperation(op, svcEnv)),
    // Unit tests (nested `test` members + hoisted `test … for <Service>`) lower
    // against the same service env operation bodies resolve against, so a
    // `Pricing.quote(...)` call in a test resolves identically.
    tests: collectSubjectTests(decl.tests, decl, svcEnv),
  };
}

function lowerDomainServiceOperation(
  op: DomainService["operations"][number],
  env: Env,
): DomainServiceOperationIR {
  // Fresh local scope per operation — no `this`, no aggregate candidate.
  // `serviceRepos` is threaded from the service env (it's context-scoped, not
  // operation-scoped) so each operation body resolves repository reads.
  let inner: Env = { ...env, locals: new Map() };
  const params: ParamIR[] = [];
  for (const p of op.params) {
    const t = lowerType(p.type, env);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  const returnType = op.returnType ? lowerType(op.returnType, env) : undefined;
  // A union-returning operation threads its variants into the env so each
  // `return <expr>` can tag its value with the matching variant (producer).
  if (returnType?.kind === "union") {
    inner = { ...inner, returnVariants: returnType.variants };
  }
  const body: StmtIR[] = [];
  for (const s of op.stmts) {
    const result = lowerStatement(s, inner);
    body.push(result.stmt);
    inner = result.envAfter;
  }
  return {
    name: op.name,
    params,
    ...(returnType ? { returnType } : {}),
    body,
  };
}
