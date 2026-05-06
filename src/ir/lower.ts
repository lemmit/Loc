import type {
  Aggregate,
  BoundedContext,
  EntityPart,
  EnumDecl,
  EventDecl,
  Expression,
  FunctionDecl,
  Model,
  Operation,
  Property,
  Repository,
  Statement,
  ValueObject,
  Workflow,
} from "../language/generated/ast.js";
import {
  isAggregate,
  isAssignOrCallStmt,
  isBoundedContext,
  isContainment,
  isDeployable,
  isDerivedProp,
  isEmitStmt,
  isEntityPart,
  isEnumDecl,
  isEventDecl,
  isExpectStmt,
  isExpectThrowsStmt,
  isFunctionDecl,
  isInvariant,
  isLetStmt,
  isMemberAccess,
  isModule,
  isNameRef,
  isObjectLit,
  isOperation,
  isPreconditionStmt,
  isProperty,
  isRepository,
  isSystem,
  isTestBlock,
  isTestE2E,
  isValueObject,
  isWorkflow,
} from "../language/generated/ast.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ContainmentIR,
  DeployableIR,
  DerivedIR,
  EntityPartIR,
  EnumIR,
  EventIR,
  ExprIR,
  FieldIR,
  FunctionIR,
  IdValueType,
  InvariantIR,
  LoomModel,
  ModuleIR,
  OperationIR,
  ParamIR,
  Platform,
  RepositoryIR,
  StmtIR,
  SystemIR,
  TestIR,
  TestStmtIR,
  TypeIR,
  ValueObjectIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "./loom-ir.js";
import {
  cstText,
  inAggregate,
  inPart,
  inValueObject,
  inferExprType,
  lowerExpr,
  lowerStatement,
  lowerType,
  newEnv,
  withLocal,
  type Env,
} from "./lower-expr.js";

// ---------------------------------------------------------------------------
// Lowering — structure layer.
//
// Walks the AST top-down (Model → System → Module → Context →
// Aggregate / Part / VO / Event / Repository → members) producing
// IR shapes.  Expression / statement / type-inference machinery
// lives in `lower-expr.ts`; this file only deals with the
// hierarchical IR built around those expressions.
// ---------------------------------------------------------------------------

export function lowerModel(model: Model): LoomModel {
  const systems: SystemIR[] = [];
  const looseContexts: BoundedContextIR[] = [];
  for (const m of model.members) {
    if (isSystem(m)) systems.push(lowerSystem(m));
    else if (isBoundedContext(m)) looseContexts.push(lowerContext(m));
  }
  return { systems, contexts: looseContexts };
}

function lowerSystem(sys: import("../language/generated/ast.js").System): SystemIR {
  const modules: ModuleIR[] = [];
  const deployables: DeployableIR[] = [];
  const e2eBlocks: import("../language/generated/ast.js").TestE2E[] = [];
  // Bare `context` declarations directly under a `system` block live in
  // an implicit anonymous module so we can index them like any other.
  const looseContexts: BoundedContextIR[] = [];
  for (const m of sys.members) {
    if (isModule(m)) {
      modules.push({
        name: m.name,
        contexts: m.contexts.map(lowerContext),
      });
    } else if (isBoundedContext(m)) {
      looseContexts.push(lowerContext(m));
    } else if (isDeployable(m)) {
      deployables.push(lowerDeployable(m));
    } else if (isTestE2E(m)) {
      e2eBlocks.push(m);
    }
  }
  if (looseContexts.length > 0) {
    modules.push({ name: "_default", contexts: looseContexts });
  }
  // React deployable's `moduleNames` inheritance from `targets:` is
  // an enrichment, not a structural lowering — see
  // `src/ir/enrichments.ts`.
  // E2E test bodies reference the magic `api.<aggregate>.<method>(…)`
  // chain; resolution happens at render time against the target
  // deployable's IR.  The lowering env is minimal — bare-name lookups
  // would mostly be `unknown` anyway because e2e tests don't sit
  // inside a bounded context.
  const e2eEnv: Env = { locals: new Map() };
  // Test kind comes from the target deployable's platform: react →
  // UI test (Playwright spec via page objects), anything else →
  // api test (vitest+fetch).  This avoids reserving a `'ui'` keyword
  // that would shadow the body's `ui.X.Y(...)` identifiers.
  const e2eTests = e2eBlocks.map((b) => {
    const targetName = b.deployable?.ref?.name ?? "";
    const target = deployables.find((d) => d.name === targetName);
    const kind: "api" | "ui" = target?.platform === "react" ? "ui" : "api";
    return lowerE2E(b, e2eEnv, kind);
  });
  return { name: sys.name, modules, deployables, e2eTests };
}

function lowerE2E(
  block: import("../language/generated/ast.js").TestE2E,
  env: Env,
  kind: "api" | "ui",
): import("./loom-ir.js").TestE2EIR {
  const inner = block.body;
  let curEnv = env;
  const statements: TestStmtIR[] = [];
  for (const s of inner) {
    if (isExpectStmt(s)) {
      statements.push({
        kind: "expect",
        expr: lowerExpr(s.expr, curEnv),
        source: cstText(s.expr),
      });
    } else if (isExpectThrowsStmt(s)) {
      statements.push({
        kind: "expect-throws",
        expr: lowerExpr(s.expr, curEnv),
        source: cstText(s.expr),
      });
    } else {
      // `expect` / `expectThrows` are filtered above; the remaining
      // shapes are exactly `Statement`.
      const r = lowerStatement(s as Statement, curEnv);
      statements.push(r.stmt);
      curEnv = r.envAfter;
    }
  }
  return {
    name: block.name,
    kind,
    deployableName: block.deployable?.ref?.name ?? "",
    statements,
  };
}

function lowerDeployable(
  d: import("../language/generated/ast.js").Deployable,
): DeployableIR {
  const platform = (d.platform ?? "hono") as Platform;
  return {
    name: d.name,
    platform,
    moduleNames: d.modules.map((ref) => ref.ref?.name ?? "").filter(Boolean),
    port: d.port ?? defaultPort(platform),
    targetName: d.targets?.ref?.name,
  };
}

function defaultPort(platform: Platform | undefined): number {
  if (platform === "dotnet") return 8080;
  if (platform === "react") return 3001;
  return 3000;
}

function lowerContext(ctx: BoundedContext): BoundedContextIR {
  // Lowering produces a faithful AST projection only.  Auto-included
  // `findAll`, react `moduleNames` inheritance, and wire-shape
  // derivation all live in `enrichLoomModel` (src/ir/enrichments.ts)
  // which runs after lowering.
  const env = newEnv(ctx);
  const enums: EnumIR[] = [];
  const valueObjects: ValueObjectIR[] = [];
  const events: EventIR[] = [];
  const aggregates: AggregateIR[] = [];
  const repositories: RepositoryIR[] = [];
  const workflows: WorkflowIR[] = [];
  for (const m of ctx.members) {
    if (isEnumDecl(m)) enums.push(lowerEnum(m));
    else if (isValueObject(m)) valueObjects.push(lowerValueObject(m, env));
    else if (isEventDecl(m)) events.push(lowerEvent(m));
    else if (isAggregate(m)) aggregates.push(lowerAggregate(m, env));
    else if (isRepository(m)) repositories.push(lowerRepository(m));
    else if (isWorkflow(m)) workflows.push(lowerWorkflow(m, env, ctx));
  }
  return {
    name: ctx.name,
    enums,
    valueObjects,
    events,
    aggregates,
    repositories,
    workflows,
  };
}

function lowerEnum(e: EnumDecl): EnumIR {
  return { name: e.name, values: e.values.map((v) => v.name) };
}

function lowerValueObject(vo: ValueObject, env: Env): ValueObjectIR {
  const inner = inValueObject(env, vo);
  return {
    name: vo.name,
    fields: vo.members.filter(isProperty).map((p) => lowerField(p)),
    derived: vo.members.filter(isDerivedProp).map((d) =>
      lowerDerived(d, inner),
    ),
    invariants: vo.members.filter(isInvariant).map((i) => lowerInvariant(i, inner)),
    functions: vo.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner)),
  };
}

function lowerEvent(e: EventDecl): EventIR {
  return {
    name: e.name,
    fields: e.fields.map((f) => lowerField(f)),
  };
}

function lowerAggregate(agg: Aggregate, env: Env): AggregateIR {
  const idValueType = (agg.idKind ?? "guid") as IdValueType;
  const inner = inAggregate(env, agg);
  const props = agg.members.filter(isProperty) as Property[];
  const containments = agg.members.filter(isContainment).map(lowerContainment);
  const parts: EntityPartIR[] = [];
  for (const m of agg.members) {
    if (isEntityPart(m)) parts.push(lowerEntityPart(m, agg, inner));
  }
  const derived = agg.members.filter(isDerivedProp).map((d) => lowerDerived(d, inner));
  const invariants = agg.members.filter(isInvariant).map((i) => lowerInvariant(i, inner));
  const functions = agg.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner));
  const operations = (agg.members.filter(isOperation) as Operation[]).map((op) =>
    lowerOperation(op, inner),
  );
  const tests: TestIR[] = [];
  for (const m of agg.members) {
    if (isTestBlock(m)) tests.push(lowerTest(m, inner));
  }
  return {
    name: agg.name,
    idValueType,
    fields: props.map(lowerField),
    contains: containments,
    derived,
    invariants,
    functions,
    operations,
    parts,
    tests,
  };
}

function lowerTest(
  block: import("../language/generated/ast.js").TestBlock,
  env: Env,
): TestIR {
  let inner = env;
  const statements: TestStmtIR[] = [];
  for (const s of block.body) {
    if (isExpectStmt(s)) {
      statements.push({
        kind: "expect",
        expr: lowerExpr(s.expr, inner),
        source: cstText(s.expr),
      });
    } else if (isExpectThrowsStmt(s)) {
      statements.push({
        kind: "expect-throws",
        expr: lowerExpr(s.expr, inner),
        source: cstText(s.expr),
      });
    } else {
      const r = lowerStatement(s as Statement, inner);
      statements.push(r.stmt);
      inner = r.envAfter;
    }
  }
  return { name: block.name, statements };
}

function lowerEntityPart(
  part: EntityPart,
  agg: Aggregate,
  outer: Env,
): EntityPartIR {
  const inner = inPart(outer, agg, part);
  const props = part.members.filter(isProperty) as Property[];
  return {
    name: part.name,
    parentName: agg.name,
    parentIdValueType: (agg.idKind ?? "guid") as IdValueType,
    fields: props.map(lowerField),
    contains: part.members.filter(isContainment).map(lowerContainment),
    derived: part.members.filter(isDerivedProp).map((d) => lowerDerived(d, inner)),
    invariants: part.members.filter(isInvariant).map((i) => lowerInvariant(i, inner)),
    functions: part.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner)),
  };
}

function lowerRepository(repo: Repository): RepositoryIR {
  return {
    name: repo.name,
    aggregateName: repo.aggregate?.ref?.name ?? "Unknown",
    finds: repo.finds.map((f) => {
      const aggRoot = repo.aggregate?.ref;
      // Build env: each find param + the aggregate's properties as
      // `this`-rooted refs so the filter can reference them by name.
      let env = newEnv(repo.$container as BoundedContext);
      if (aggRoot) env = inAggregate(env, aggRoot);
      for (const p of f.params) {
        env = withLocal(env, p.name, "param", lowerType(p.type));
      }
      return {
        name: f.name,
        params: f.params.map((p) => ({ name: p.name, type: lowerType(p.type) })),
        returnType: lowerType(f.returnType),
        filter: f.filter ? lowerExpr(f.filter, env) : undefined,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Member lowerings
// ---------------------------------------------------------------------------

function lowerField(p: Property): FieldIR {
  return {
    name: p.name,
    type: lowerType(p.type),
    optional: !!p.type?.optional,
    display: !!p.display,
  };
}

function lowerContainment(
  c: import("../language/generated/ast.js").Containment,
): ContainmentIR {
  return {
    name: c.name,
    partName: c.partType?.ref?.name ?? "Unknown",
    collection: !!c.collection,
  };
}

function lowerDerived(
  d: import("../language/generated/ast.js").DerivedProp,
  env: Env,
): DerivedIR {
  return {
    name: d.name,
    type: lowerType(d.type),
    expr: lowerExpr(d.expr, env),
  };
}

function lowerInvariant(
  i: import("../language/generated/ast.js").Invariant,
  env: Env,
): InvariantIR {
  return {
    expr: lowerExpr(i.expr, env),
    guard: i.guard ? lowerExpr(i.guard, env) : undefined,
    source: cstText(i.expr),
  };
}

function lowerFunction(f: FunctionDecl, env: Env): FunctionIR {
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of f.params) {
    const t = lowerType(p.type);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  return {
    name: f.name,
    params,
    returnType: lowerType(f.returnType),
    body: lowerExpr(f.body, inner),
  };
}

function lowerOperation(op: Operation, env: Env): OperationIR {
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of op.params) {
    const t = lowerType(p.type);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  const stmts: StmtIR[] = [];
  for (const s of op.body) {
    const result = lowerStatement(s, inner);
    stmts.push(result.stmt);
    inner = result.envAfter;
  }
  return {
    name: op.name,
    visibility: op.private ? "private" : "public",
    params,
    statements: stmts,
    extern: !!op.extern,
  };
}

// ---------------------------------------------------------------------------
// Workflow lowering
//
// Body statements are parsed using the operation-body Statement rules
// (precondition, let, emit, AssignOrCallStmt) but the workflow surface
// is a strict subset:
//   - LetStmt RHS may be `Agg.create({...})` (factory-let),
//     `Repo.method(args)` (repo-let), or any other Expression
//     (expr-let).
//   - AssignOrCallStmt is allowed only in its bare-call form
//     `name.op(args)` — mutation forms (`:=`, `+=`, `-=`) belong to
//     aggregate operations and surface as validator errors.
//   - precondition / emit lower identically to operation bodies.
//
// `savesAtExit` is computed after the walk: every factory-let always
// saves; a repo-let saves only when a later `op-call` targets it.
// ---------------------------------------------------------------------------

function lowerWorkflow(
  wf: Workflow,
  env: Env,
  ctx: BoundedContext,
): WorkflowIR {
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of wf.params) {
    const t = lowerType(p.type);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  const aggsByName = new Map<string, Aggregate>();
  const reposByName = new Map<string, Repository>();
  const repoForAgg = new Map<string, string>(); // aggName -> repoName
  for (const m of ctx.members) {
    if (isAggregate(m)) aggsByName.set(m.name, m);
    else if (isRepository(m)) {
      reposByName.set(m.name, m);
      const target = m.aggregate?.ref;
      if (target?.name) repoForAgg.set(target.name, m.name);
    }
  }
  const letAggs = new Map<string, { aggName: string; repoName: string }>();
  const statements: WorkflowStmtIR[] = [];
  for (const s of wf.body) {
    const lowered = lowerWorkflowStatement(
      s,
      inner,
      aggsByName,
      reposByName,
      repoForAgg,
    );
    statements.push(lowered.stmt);
    inner = lowered.envAfter;
    if (lowered.binding) letAggs.set(lowered.binding.name, lowered.binding);
  }
  // savesAtExit: factory-lets always; repo-lets only when targeted
  // by a later op-call (validator already restricts which statement
  // shapes can mutate).
  const opCallTargets = new Set<string>();
  for (const st of statements) {
    if (st.kind === "op-call") opCallTargets.add(st.target);
  }
  const savesAtExit: WorkflowIR["savesAtExit"] = [];
  for (const st of statements) {
    if (st.kind === "factory-let") {
      const repoName = repoForAgg.get(st.aggName) ?? plural(st.aggName);
      savesAtExit.push({ name: st.name, aggName: st.aggName, repoName });
    } else if (st.kind === "repo-let" && opCallTargets.has(st.name)) {
      savesAtExit.push({
        name: st.name,
        aggName: st.aggName,
        repoName: st.repoName,
      });
    }
  }
  return {
    name: wf.name,
    params,
    transactional: !!wf.transactional,
    statements,
    savesAtExit,
  };
}

function plural(s: string): string {
  if (s.endsWith("y") && !/[aeiou]y$/.test(s)) return s.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(s)) return s + "es";
  return s + "s";
}

interface LoweredWorkflowStmt {
  stmt: WorkflowStmtIR;
  envAfter: Env;
  binding?: { name: string; aggName: string; repoName: string };
}

function lowerWorkflowStatement(
  stmt: Statement,
  env: Env,
  aggsByName: Map<string, Aggregate>,
  reposByName: Map<string, Repository>,
  repoForAgg: Map<string, string>,
): LoweredWorkflowStmt {
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
  if (isLetStmt(stmt)) {
    const expr = stmt.expr;
    // factory-let: `Agg.create({fields})`
    const factory = matchFactoryCall(expr, aggsByName);
    if (factory) {
      const repoName =
        repoForAgg.get(factory.aggName) ?? plural(factory.aggName);
      const fields = factory.fields.map((f) => ({
        name: f.name,
        value: lowerExpr(f.value, env),
      }));
      const aggType: TypeIR = { kind: "entity", name: factory.aggName };
      return {
        stmt: {
          kind: "factory-let",
          name: stmt.name,
          aggName: factory.aggName,
          fields,
        },
        envAfter: withLocal(env, stmt.name, "let", aggType),
        binding: { name: stmt.name, aggName: factory.aggName, repoName },
      };
    }
    // repo-let: `Repo.method(args)`
    const repoCall = matchRepoCall(expr, reposByName);
    if (repoCall) {
      const args = repoCall.args.map((a) => lowerExpr(a, env));
      // Resolve the find's declared return type (or for getById:
      // single non-null aggregate of the repo's target).
      const repo = repoCall.repo;
      const aggName = repo.aggregate?.ref?.name ?? "Unknown";
      let returnType: TypeIR = { kind: "entity", name: aggName };
      if (repoCall.method !== "getById") {
        const find = repo.finds.find((f) => f.name === repoCall.method);
        if (find) returnType = lowerType(find.returnType);
      }
      // The let binding's local type is the unwrapped aggregate
      // (validator rejects array/optional repo-lets).  Use the
      // declared return type so the validator can flag misuse.
      const localType: TypeIR =
        returnType.kind === "entity" ? returnType : returnType;
      return {
        stmt: {
          kind: "repo-let",
          name: stmt.name,
          repoName: repo.name,
          aggName,
          method: repoCall.method,
          args,
          returnType,
        },
        envAfter: withLocal(env, stmt.name, "let", localType),
        binding: { name: stmt.name, aggName, repoName: repo.name },
      };
    }
    // expr-let: scalar / generic expression
    const exprIR = lowerExpr(stmt.expr, env);
    const t = inferExprType(stmt.expr, env);
    return {
      stmt: { kind: "expr-let", name: stmt.name, type: t, expr: exprIR },
      envAfter: withLocal(env, stmt.name, "let", t),
    };
  }
  if (isAssignOrCallStmt(stmt)) {
    const lv = stmt.target;
    if (!stmt.op && lv.call && lv.tail.length === 1) {
      // `name.op(args)` — op-call on a let binding.
      const aggName = aggNameForLocal(env, lv.head);
      const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
      return {
        stmt: {
          kind: "op-call",
          target: lv.head,
          aggName: aggName ?? "Unknown",
          op: lv.tail[0]!,
          args,
        },
        envAfter: env,
      };
    }
    // Anything else (mutation forms, bare calls, deep paths) becomes
    // an expr-let with no name — represented as an expr-let with a
    // synthetic placeholder so the validator can flag it.
    const placeholder: ExprIR = {
      kind: "ref",
      name: lv.head,
      refKind: "unknown",
    };
    return {
      stmt: {
        kind: "expr-let",
        name: "__bad__",
        type: { kind: "primitive", name: "string" },
        expr: placeholder,
      },
      envAfter: env,
    };
  }
  // Fallback — shouldn't hit, but stay safe.
  return {
    stmt: {
      kind: "expr-let",
      name: "__bad__",
      type: { kind: "primitive", name: "string" },
      expr: { kind: "ref", name: "unknown", refKind: "unknown" },
    },
    envAfter: env,
  };
}

/** Look up the let-binding's bound aggregate name from its local
 *  type.  Returns undefined when the binding doesn't resolve to an
 *  entity. */
function aggNameForLocal(env: Env, name: string): string | undefined {
  const local = env.locals.get(name);
  if (!local) return undefined;
  if (local.type.kind === "entity") return local.type.name;
  return undefined;
}

interface FactoryMatch {
  aggName: string;
  fields: { name: string; value: Expression }[];
}

function matchFactoryCall(
  expr: Expression | undefined,
  aggsByName: Map<string, Aggregate>,
): FactoryMatch | undefined {
  if (!expr || !isMemberAccess(expr) || !expr.call) return undefined;
  if (expr.member !== "create") return undefined;
  const recv = expr.receiver;
  if (!isNameRef(recv)) return undefined;
  if (!aggsByName.has(recv.name)) return undefined;
  if (expr.args.length !== 1) return undefined;
  const arg = expr.args[0];
  if (!arg || !isObjectLit(arg)) return undefined;
  return {
    aggName: recv.name,
    fields: arg.fields.map((f) => ({ name: f.name, value: f.value })),
  };
}

interface RepoMatch {
  repo: Repository;
  method: string;
  args: Expression[];
}

function matchRepoCall(
  expr: Expression | undefined,
  reposByName: Map<string, Repository>,
): RepoMatch | undefined {
  if (!expr || !isMemberAccess(expr) || !expr.call) return undefined;
  const recv = expr.receiver;
  if (!isNameRef(recv)) return undefined;
  const repo = reposByName.get(recv.name);
  if (!repo) return undefined;
  return {
    repo,
    method: expr.member,
    args: expr.args ?? [],
  };
}
