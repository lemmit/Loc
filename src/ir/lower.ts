import type {
  Aggregate,
  BoundedContext,
  EntityPart,
  EnumDecl,
  EventDecl,
  FunctionDecl,
  Model,
  Operation,
  Property,
  Repository,
  Statement,
  ValueObject,
} from "../language/generated/ast.js";
import {
  isAggregate,
  isBoundedContext,
  isContainment,
  isDeployable,
  isDerivedProp,
  isEntityPart,
  isEnumDecl,
  isEventDecl,
  isExpectStmt,
  isExpectThrowsStmt,
  isFunctionDecl,
  isInvariant,
  isModule,
  isOperation,
  isProperty,
  isRepository,
  isSystem,
  isTestBlock,
  isTestE2E,
  isValueObject,
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
  ValueObjectIR,
} from "./loom-ir.js";
import {
  cstText,
  inAggregate,
  inPart,
  inValueObject,
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
  for (const m of ctx.members) {
    if (isEnumDecl(m)) enums.push(lowerEnum(m));
    else if (isValueObject(m)) valueObjects.push(lowerValueObject(m, env));
    else if (isEventDecl(m)) events.push(lowerEvent(m));
    else if (isAggregate(m)) aggregates.push(lowerAggregate(m, env));
    else if (isRepository(m)) repositories.push(lowerRepository(m));
  }
  return {
    name: ctx.name,
    enums,
    valueObjects,
    events,
    aggregates,
    repositories,
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
  };
}
