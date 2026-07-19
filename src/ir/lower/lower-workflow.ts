import type {
  Aggregate,
  BoundedContext,
  CommandHandler,
  Expression,
  HandleDecl,
  LoadPath,
  OnDecl,
  QueryHandler,
  Repository,
  Statement,
  Workflow,
  WorkflowCreateDecl,
} from "../../language/generated/ast.js";
import {
  isAggregate,
  isApply,
  isAssignOrCallStmt,
  isEmitStmt,
  isForStmt,
  isFunctionDecl,
  isHandleDecl,
  isIfLetStmt,
  isLetStmt,
  isMemberSuffix,
  isNameRef,
  isObjectLit,
  isOnDecl,
  isPostfixChain,
  isPreconditionStmt,
  isProperty,
  isRepository,
  isRequiresStmt,
  isReturnStmt,
  isWorkflowCreateDecl,
} from "../../language/generated/ast.js";
import { upperFirst } from "../../util/naming.js";
import { findVerb } from "../resource-verbs.js";
import type {
  AggregateIR,
  ApplyIR,
  CommandHandlerIR,
  CreateIR,
  DomainServiceIR,
  DomainServiceOperationIR,
  ExprIR,
  FieldIR,
  FunctionIR,
  HandleIR,
  LoadPlanIR,
  LoadSegmentIR,
  OnIR,
  ParamIR,
  PathIR,
  QueryHandlerIR,
  SortTermIR,
  TypeIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../types/loom-ir.js";
import { aggregateOpResolver, type SaveResolver } from "../util/domain-service-tier.js";
import { isWriteMethod } from "../util/repo-methods.js";
import { resolveBypass } from "./lower-capabilities.js";
import {
  inferExprType,
  lowerEmitFields,
  lowerExpr,
  lowerExprInContext,
  pathType,
} from "./lower-expr.js";
import { computeSaves, lowerApply, lowerField, lowerFunction, plural } from "./lower-members.js";
import {
  cstText,
  type Env,
  findDomainServiceByName,
  inWorkflow,
  lowerType,
  withLocal,
} from "./lower-types.js";
import { originFor } from "./origin.js";
import {
  matchFindAllCall,
  matchFindCall,
  matchRepoCall,
  matchRetrievalRunCall,
  runCriterionMatcher,
} from "./repo-read.js";

export function lowerWorkflow(
  wf: Workflow,
  env: Env,
  ctx: BoundedContext,
  lowered?: { aggregates: AggregateIR[]; domainServices: DomainServiceIR[] },
): WorkflowIR {
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
  // Save-resolver (domain-services.md rev. 4, the `mutating` tier): lets
  // `computeSaves` see WHICH aggregate args a called `mutating` service writes,
  // so those args persist at workflow exit.  Built from the context's already-
  // lowered aggregates + domain services (second-pass workflow lowering); absent
  // for legacy callers (single-context generate paths that don't pass `lowered`)
  // — then a domain-service call simply contributes no extra saves.
  const saveResolver: SaveResolver | undefined = lowered
    ? {
        resolveAggOp: aggregateOpResolver({ aggregates: lowered.aggregates }),
        resolveServiceOp: serviceOpResolver(lowered.domainServices),
      }
    : undefined;
  // A workflow is a state-bearing entity (workflow-and-applier.md A2-S5f): bind
  // `this` to it so every member body (create / handle / on / apply) resolves
  // bare names / `this.field` against the workflow's `Property` state fields.
  // The body is members-only — no header params, no free statements.
  const paramEnv = inWorkflow(env, wf);
  const subscriptions: OnIR[] = [];
  const handlers: HandleIR[] = [];
  const creates: CreateIR[] = [];
  // Workflow state fields (`Property` members) — the correlation field +
  // saga state (A2-S2).  Lowered with the same `lowerField` aggregates use.
  const stateFields: FieldIR[] = wf.members.filter(isProperty).map((p) => lowerField(p, paramEnv));
  // Appliers fold emitted events into workflow state (A2-S5b).
  const appliers: ApplyIR[] = wf.members.filter(isApply).map((a) => lowerApply(a, paramEnv));
  // Private pure helpers (`function f(...): T = expr`) — the aggregate-parity
  // member.  Lowered with the same `lowerFunction` aggregates use; each backend
  // emits them as per-workflow-scoped module helpers.
  const functions: FunctionIR[] = wf.members
    .filter(isFunctionDecl)
    .map((f) => lowerFunction(f, paramEnv));
  for (const m of wf.members) {
    if (isWorkflowCreateDecl(m)) {
      creates.push(
        lowerWorkflowCreate(m, paramEnv, aggsByName, reposByName, repoForAgg, saveResolver),
      );
    } else if (isOnDecl(m)) {
      subscriptions.push(lowerOn(m, paramEnv, aggsByName, reposByName, repoForAgg, saveResolver));
    } else if (isHandleDecl(m)) {
      handlers.push(lowerHandle(m, paramEnv, aggsByName, reposByName, repoForAgg, saveResolver));
    }
    // Property / Apply handled above.
  }
  // Correlation field inference: the single id-shaped state field is the one
  // the runtime routes inbound events to.  Ambiguity / absence → IR validator.
  const idFields = stateFields.filter((f) => f.type.kind === "id");
  const correlationField = idFields.length === 1 ? idFields[0].name : undefined;
  // Facade over the primary (unnamed, command-triggered) create so the backend
  // emitters keep reading `params`/`statements`/`savesAtExit` unchanged (A2-S5f).
  const primary = creates.find((c) => c.name === null && c.triggerKind === "command") ?? creates[0];
  return {
    name: wf.name,
    params: primary?.params ?? [],
    transactional: !!wf.transactional,
    isolation: wf.isolation as
      | "readUncommitted"
      | "readCommitted"
      | "repeatableRead"
      | "serializable"
      | undefined,
    statements: primary?.statements ?? [],
    savesAtExit: primary?.savesAtExit ?? [],
    creates,
    eventSourced: !!wf.eventSourced,
    ...(subscriptions.length > 0 ? { subscriptions } : {}),
    ...(stateFields.length > 0 ? { stateFields } : {}),
    ...(correlationField ? { correlationField } : {}),
    ...(appliers.length > 0 ? { appliers } : {}),
    ...(handlers.length > 0 ? { handlers } : {}),
    ...(functions.length > 0 ? { functions } : {}),
    origin: originFor(wf),
  };
}

/** Build a `(service, op) → DomainServiceOperationIR` resolver over a context's
 *  lowered domain services. */
function serviceOpResolver(
  services: readonly DomainServiceIR[],
): (service: string, op: string) => DomainServiceOperationIR | undefined {
  const byName = new Map(services.map((s) => [s.name, s]));
  return (service, op) => byName.get(service)?.operations.find((o) => o.name === op);
}

// Lower a `create [name](params) [by <expr>] { … }` workflow starter
// (workflow-and-applier.md A2-S5f).  Mirrors `lowerHandle`: params bind as
// locals on the workflow `this`-env, the body lowers via
// `lowerWorkflowStatement`.  Trigger kind is discriminated from the shape — a
// `by` clause (and a sole event-typed param) marks an event-triggered starter.
function lowerWorkflowCreate(
  c: WorkflowCreateDecl,
  baseEnv: Env,
  aggsByName: Map<string, Aggregate>,
  reposByName: Map<string, Repository>,
  repoForAgg: Map<string, string>,
  saveResolver?: SaveResolver,
): CreateIR {
  let inner = baseEnv;
  const params: ParamIR[] = [];
  for (const p of c.params) {
    const t = lowerType(p.type, baseEnv);
    const def = p.default ? lowerExprInContext(p.default, t, baseEnv) : undefined;
    params.push({ name: p.name, type: t, ...(def ? { default: def } : {}) });
    inner = withLocal(inner, p.name, "param", t);
  }
  const correlation = c.correlation ? lowerExpr(c.correlation, inner) : undefined;
  // Event-triggered when routed by a `by` clause; capture the sole event param.
  const triggerKind: "event" | "command" = correlation ? "event" : "command";
  let eventBinding: string | undefined;
  let eventRef: string | undefined;
  if (triggerKind === "event" && c.params.length === 1) {
    const t = lowerType(c.params[0].type, baseEnv);
    eventBinding = c.params[0].name;
    eventRef = t.kind === "entity" ? t.name : undefined;
  }
  const statements: WorkflowStmtIR[] = [];
  for (const s of c.body) {
    const lowered = lowerWorkflowStatement(
      s,
      inner,
      aggsByName,
      reposByName,
      repoForAgg,
      saveResolver,
    );
    statements.push(lowered.stmt);
    inner = lowered.envAfter;
  }
  return {
    name: c.name ?? null,
    triggerKind,
    params,
    ...(correlation ? { correlation } : {}),
    statements,
    savesAtExit: computeSaves(statements, repoForAgg, undefined, saveResolver),
    ...(eventBinding ? { eventBinding } : {}),
    ...(eventRef ? { eventRef } : {}),
  };
}

// Lower a `handle name(params) { … }` command handler (workflow-and-applier.md
// A2-S5c).  Structurally the legacy paren-form workflow body: params bind as
// locals on top of the workflow `this`-env, the body lowers through
// `lowerWorkflowStatement`, and exit-saves are derived the same way.
function lowerHandle(
  h: HandleDecl,
  baseEnv: Env,
  aggsByName: Map<string, Aggregate>,
  reposByName: Map<string, Repository>,
  repoForAgg: Map<string, string>,
  saveResolver?: SaveResolver,
): HandleIR {
  let inner = baseEnv;
  const params: ParamIR[] = [];
  for (const p of h.params) {
    const t = lowerType(p.type, baseEnv);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  const statements: WorkflowStmtIR[] = [];
  for (const s of h.body) {
    const lowered = lowerWorkflowStatement(
      s,
      inner,
      aggsByName,
      reposByName,
      repoForAgg,
      saveResolver,
    );
    statements.push(lowered.stmt);
    inner = lowered.envAfter;
  }
  return {
    name: h.name,
    params,
    statements,
    savesAtExit: computeSaves(statements, repoForAgg, undefined, saveResolver),
  };
}

/** Build the `(aggregate | repository)` lookup maps a workflow / handler body
 *  needs to resolve loads, saves, and repo calls within its context.  Mirrors
 *  the inline pass at the top of `lowerWorkflow`. */
function ctxAggRepoMaps(ctx: BoundedContext): {
  aggsByName: Map<string, Aggregate>;
  reposByName: Map<string, Repository>;
  repoForAgg: Map<string, string>;
} {
  const aggsByName = new Map<string, Aggregate>();
  const reposByName = new Map<string, Repository>();
  const repoForAgg = new Map<string, string>();
  for (const m of ctx.members) {
    if (isAggregate(m)) aggsByName.set(m.name, m);
    else if (isRepository(m)) {
      reposByName.set(m.name, m);
      const target = m.aggregate?.ref;
      if (target?.name) repoForAgg.set(target.name, m.name);
    }
  }
  return { aggsByName, reposByName, repoForAgg };
}

function saveResolverFor(lowered?: SecondPassLowered): SaveResolver | undefined {
  return lowered
    ? {
        resolveAggOp: aggregateOpResolver({ aggregates: lowered.aggregates }),
        resolveServiceOp: serviceOpResolver(lowered.domainServices),
      }
    : undefined;
}

type SecondPassLowered = { aggregates: AggregateIR[]; domainServices: DomainServiceIR[] };

/** Lower a top-level `commandHandler name(params): T { … }` application-layer
 *  member (unfoldable-api-derivation.md, Layer 3).  Structurally a workflow
 *  `handle` lifted to the context — params bind as `refKind: "param"` locals on
 *  the context env (no workflow `this`), the body lowers through
 *  `lowerWorkflowStatement`, and exit-saves derive the same way.  `returnType`
 *  is optional. */
export function lowerCommandHandler(
  h: CommandHandler,
  env: Env,
  ctx: BoundedContext,
  lowered?: SecondPassLowered,
): CommandHandlerIR {
  const { aggsByName, reposByName, repoForAgg } = ctxAggRepoMaps(ctx);
  const saveResolver = saveResolverFor(lowered);
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of h.params) {
    const t = lowerType(p.type, env);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  // Extern handler (`extern commandHandler … ;`): BODYLESS.  There is no DSL
  // body to lower — statements / savesAtExit / returnValue stay empty, and only
  // the signature (params + optional returnType) survives.  The generated
  // dispatch calls a scaffold-once user impl instead of an emitted body.
  if (h.extern) {
    return {
      name: h.name,
      params,
      extern: true,
      ...(h.returnType ? { returnType: lowerType(h.returnType, env) } : {}),
      statements: [],
      savesAtExit: [],
    };
  }
  // A handler `return <expr>` is captured separately as `returnValue`, NOT as a
  // body statement: body statements are `WorkflowStmtIR` and the shared workflow
  // statement renderer has no `return` arm (workflow handles never return a
  // value), so a return left in `statements` lowers to the `__bad__` sentinel.
  const { statements, returnValue } = lowerHandlerBody(
    h.body,
    inner,
    aggsByName,
    reposByName,
    repoForAgg,
    saveResolver,
  );
  return {
    name: h.name,
    params,
    ...(h.returnType ? { returnType: lowerType(h.returnType, env) } : {}),
    statements,
    savesAtExit: computeSaves(statements, repoForAgg, undefined, saveResolver),
    ...(returnValue ? { returnValue } : {}),
  };
}

/** Lower a top-level `queryHandler name(params): T { … }` application-layer
 *  member (unfoldable-api-derivation.md, Layer 3).  Like `lowerCommandHandler`
 *  but `returnType` is required (a query always produces a response); the
 *  no-mutation contract is enforced by the IR validator, not here. */
export function lowerQueryHandler(
  h: QueryHandler,
  env: Env,
  ctx: BoundedContext,
  lowered?: SecondPassLowered,
): QueryHandlerIR {
  const { aggsByName, reposByName, repoForAgg } = ctxAggRepoMaps(ctx);
  const saveResolver = saveResolverFor(lowered);
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of h.params) {
    const t = lowerType(p.type, env);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  // Extern queryHandler (`extern queryHandler … ;`): BODYLESS — see
  // `lowerCommandHandler`.  The required `returnType` is preserved (the user
  // impl file's return contract); statements / savesAtExit stay empty.
  if (h.extern) {
    return {
      name: h.name,
      params,
      extern: true,
      returnType: lowerType(h.returnType, env),
      statements: [],
      savesAtExit: [],
    };
  }
  const { statements, returnValue } = lowerHandlerBody(
    h.body,
    inner,
    aggsByName,
    reposByName,
    repoForAgg,
    saveResolver,
  );
  return {
    name: h.name,
    params,
    returnType: lowerType(h.returnType, env),
    statements,
    savesAtExit: computeSaves(statements, repoForAgg, undefined, saveResolver),
    ...(returnValue ? { returnValue } : {}),
  };
}

/** Lower a `commandHandler` / `queryHandler` body: every non-return statement
 *  through the shared workflow-statement lowerer, and the terminal `return
 *  <expr>` as a distinct `returnValue` (the workflow statement vocabulary has
 *  no return form).  A return may only appear as the LAST statement — the
 *  validator/grammar don't yet forbid a mid-body return, so a defensive guard
 *  keeps the last-return semantics (an earlier return would be dead code). */
function lowerHandlerBody(
  body: readonly Statement[],
  env: Env,
  aggsByName: Map<string, Aggregate>,
  reposByName: Map<string, Repository>,
  repoForAgg: Map<string, string>,
  saveResolver?: SaveResolver,
): { statements: WorkflowStmtIR[]; returnValue?: ExprIR } {
  const statements: WorkflowStmtIR[] = [];
  let returnValue: ExprIR | undefined;
  let inner = env;
  for (const s of body) {
    if (isReturnStmt(s)) {
      returnValue = lowerExpr(s.value, inner);
      continue;
    }
    const l = lowerWorkflowStatement(s, inner, aggsByName, reposByName, repoForAgg, saveResolver);
    statements.push(l.stmt);
    inner = l.envAfter;
  }
  return { statements, ...(returnValue ? { returnValue } : {}) };
}

// Lower an `on(e: Event) { … }` reactor member to its IR (workflow-and-applier.md
// Phase A2, surface slice).  Mirrors `lowerApply`: the event instance binds as a
// `refKind: "param"` local typed as the event entity, so `e.field` accesses
// resolve through the same machinery.  The body reuses `lowerWorkflowStatement`
// (a reactor is a workflow continuation and may load/save aggregates and emit).
// The `by <expr>` routing clause (A2-S3) is lowered in the event-binding scope;
// its type-check against the workflow's correlation field lives in the validator.
function lowerOn(
  o: OnDecl,
  baseEnv: Env,
  aggsByName: Map<string, Aggregate>,
  reposByName: Map<string, Repository>,
  repoForAgg: Map<string, string>,
  saveResolver?: SaveResolver,
): OnIR {
  const eventName = o.event.ref?.name ?? o.event.$refText;
  const inner = withLocal(baseEnv, o.param, "param", { kind: "entity", name: eventName });
  const correlation = o.correlation ? lowerExpr(o.correlation, inner) : undefined;
  const statements: WorkflowStmtIR[] = [];
  let bodyEnv = inner;
  for (const s of o.body) {
    const lowered = lowerWorkflowStatement(
      s,
      bodyEnv,
      aggsByName,
      reposByName,
      repoForAgg,
      saveResolver,
    );
    statements.push(lowered.stmt);
    bodyEnv = lowered.envAfter;
  }
  return {
    event: eventName,
    param: o.param,
    ...(correlation ? { correlation } : {}),
    statements,
    savesAtExit: computeSaves(statements, repoForAgg, undefined, saveResolver),
  };
}

interface LoweredWorkflowStmt {
  stmt: WorkflowStmtIR;
  envAfter: Env;
  binding?: { name: string; aggName: string; repoName: string };
}

/** Lower one workflow statement, then stamp its `.ddd` (or macro-call)
 *  origin onto the result — the chokepoint every workflow statement passes
 *  through, including nested `for-each`/`if-let` bodies (they recurse back
 *  through `lowerWorkflowStatement`, not the inner function, so they're
 *  stamped too).  An already-set `origin` wins over the derived one. */
function lowerWorkflowStatement(
  stmt: Statement,
  env: Env,
  aggsByName: Map<string, Aggregate>,
  reposByName: Map<string, Repository>,
  repoForAgg: Map<string, string>,
  saveResolver?: SaveResolver,
): LoweredWorkflowStmt {
  const lowered = lowerWorkflowStatementInner(
    stmt,
    env,
    aggsByName,
    reposByName,
    repoForAgg,
    saveResolver,
  );
  return {
    ...lowered,
    stmt: { ...lowered.stmt, origin: lowered.stmt.origin ?? originFor(stmt) },
  };
}

function lowerWorkflowStatementInner(
  stmt: Statement,
  env: Env,
  aggsByName: Map<string, Aggregate>,
  reposByName: Map<string, Repository>,
  repoForAgg: Map<string, string>,
  saveResolver?: SaveResolver,
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
  if (isRequiresStmt(stmt)) {
    return {
      stmt: {
        kind: "requires",
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
        fields: lowerEmitFields(stmt.event?.ref, stmt.fields, env),
      },
      envAfter: env,
    };
  }
  if (isForStmt(stmt)) {
    // `for <var> in <iterable> { body }` — bind the loop var to the
    // iterable's element aggregate type, lower the body in that extended
    // scope, then compute the per-iteration saves over the body.
    const iterable = lowerExpr(stmt.iterable, env);
    const iterableType = inferExprType(stmt.iterable, env);
    const elementType = iterableType.kind === "array" ? iterableType.element : undefined;
    const varAggName = elementType?.kind === "entity" ? elementType.name : "Unknown";
    const repoName = repoForAgg.get(varAggName) ?? plural(varAggName);
    // Bind the loop var to the element type so body op-calls resolve `o`'s
    // aggregate; fall back to the (possibly Unknown) entity type when the
    // iterable didn't infer to an array (the validator surfaces that).
    const varType: TypeIR = elementType ?? { kind: "entity", name: varAggName };
    const bodyEnv = withLocal(env, stmt.var, "let", varType);
    const body: WorkflowStmtIR[] = [];
    let walkEnv = bodyEnv;
    for (const s of stmt.body) {
      const lowered = lowerWorkflowStatement(
        s,
        walkEnv,
        aggsByName,
        reposByName,
        repoForAgg,
        saveResolver,
      );
      body.push(lowered.stmt);
      walkEnv = lowered.envAfter;
    }
    const savesPerIteration = computeSaves(
      body,
      repoForAgg,
      {
        name: stmt.var,
        aggName: varAggName,
        repoName,
      },
      saveResolver,
    );
    return {
      stmt: {
        kind: "for-each",
        var: stmt.var,
        varAggName,
        iterable,
        body,
        savesPerIteration,
      },
      envAfter: env,
    };
  }
  if (isIfLetStmt(stmt)) {
    // `if let <var> = Repo.find(<Criterion>) { then } else { else }`
    // (criterion.md, use site 3).  The source must be `Repo.find(<Criterion>)`
    // (the only optional producer this release); a non-matching source leaves
    // `synthCriterion.name` empty for the validator (`loom.iflet-bad-source`).
    // The criterion args lower in the OUTER env; `var` (the unwrapped match)
    // is in scope only in `thenBody`, never in `elseBody`.
    const findCall = matchFindCall(stmt.source, reposByName);
    const repo = findCall?.repo;
    const aggName = repo?.aggregate?.ref?.name ?? "Unknown";
    const repoName = repo?.name ?? "";
    const saveRepoName = repoForAgg.get(aggName) ?? plural(aggName);
    const varType: TypeIR = { kind: "entity", name: aggName };
    const thenBody: WorkflowStmtIR[] = [];
    let thenEnv = withLocal(env, stmt.var, "let", varType);
    for (const s of stmt.thenBody) {
      const lowered = lowerWorkflowStatement(
        s,
        thenEnv,
        aggsByName,
        reposByName,
        repoForAgg,
        saveResolver,
      );
      thenBody.push(lowered.stmt);
      thenEnv = lowered.envAfter;
    }
    const elseBody: WorkflowStmtIR[] = [];
    let elseEnv = env;
    for (const s of stmt.elseBody ?? []) {
      const lowered = lowerWorkflowStatement(
        s,
        elseEnv,
        aggsByName,
        reposByName,
        repoForAgg,
        saveResolver,
      );
      elseBody.push(lowered.stmt);
      elseEnv = lowered.envAfter;
    }
    const savesInThen = computeSaves(
      thenBody,
      repoForAgg,
      {
        name: stmt.var,
        aggName,
        repoName: saveRepoName,
      },
      saveResolver,
    );
    const savesInElse = computeSaves(elseBody, repoForAgg, undefined, saveResolver);
    return {
      stmt: {
        kind: "if-let",
        var: stmt.var,
        repoName,
        aggName,
        retrievalName: findCall ? `findAllBy${findCall.criterionName}` : "",
        retrievalArgs: (findCall?.criterionArgs ?? []).map((a) => lowerExpr(a, env)),
        synthCriterion: { name: findCall?.criterionName ?? "" },
        thenBody,
        ...(elseBody.length > 0 ? { elseBody } : {}),
        savesInThen,
        savesInElse,
      },
      envAfter: env,
    };
  }
  if (isLetStmt(stmt)) {
    const expr = stmt.expr;
    // `ignoring` filter-bypass clause (named-filter-bypass.md §11) — only a
    // postfix chain (`Repo.findAll(...) ignoring …`) carries it; resolve it
    // once so the two `repo-run` arms below can spread it into the IR.
    const bypass = isPostfixChain(expr) ? resolveBypass(expr) : {};
    // factory-let: `Agg.create({fields})`
    const factory = matchFactoryCall(expr, aggsByName);
    if (factory) {
      const repoName = repoForAgg.get(factory.aggName) ?? plural(factory.aggName);
      // Per-field target type, so a bare numeric literal flowing into a
      // money/decimal/long-typed create input is promoted to the precise
      // typed literal (`threshold: 0` → `lit("decimal", "0")`) — the same
      // contextual promotion the aggregate-create service and own-state
      // `:=` paths already apply.  Without it Java emits a raw `int 0`
      // into a `BigDecimal` create-input position and fails to compile.
      const targetAgg = aggsByName.get(factory.aggName);
      const fieldTypeOf = new Map<string, TypeIR>();
      if (targetAgg) {
        for (const m of targetAgg.members) {
          if (isProperty(m)) fieldTypeOf.set(m.name, lowerType(m.type, env));
        }
      }
      const fields = factory.fields.map((f) => {
        const target = fieldTypeOf.get(f.name);
        return {
          name: f.name,
          value: target ? lowerExprInContext(f.value, target, env) : lowerExpr(f.value, env),
        };
      });
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
    // repo-run: `Repo.run(<Retrieval>(args), page?)` — binds the
    // retrieval's result array.  Checked before the generic repo-let so
    // `run` doesn't fall through to the find-method path.
    const runCall = matchRetrievalRunCall(expr, reposByName, runCriterionMatcher(env.ctx));
    if (runCall) {
      const aggName = runCall.repo.aggregate?.ref?.name ?? "Unknown";
      const repoName = runCall.repo.name;
      const elementType: TypeIR = { kind: "entity", name: aggName };
      const arrayType: TypeIR = { kind: "array", element: elementType };
      const pageClause =
        runCall.pageOffset || runCall.pageLimit
          ? {
              page: {
                ...(runCall.pageOffset ? { offset: lowerExpr(runCall.pageOffset, env) } : {}),
                ...(runCall.pageLimit ? { limit: lowerExpr(runCall.pageLimit, env) } : {}),
              },
            }
          : {};
      // Anonymous retrieval (`run(retrieval { where: <Criterion> sort: … loads:
      // … })`): desugar to a `synthCriterion` repo-run + shaping, materialised
      // into a synthetic retrieval by enrich (same path as `findAll`).  The
      // shape signature in the name keeps distinct shapes distinct.
      const anon = runCall.anon;
      const sortTerms: SortTermIR[] = (anon?.sort ?? []).map((si) => ({
        path: loadPathSegments(si.path),
        direction: (si.direction ?? "asc") as "asc" | "desc",
      }));
      const loadPaths = (anon?.loads ?? []).map(loadPathSegments);
      const hasShaping = sortTerms.length > 0 || loadPaths.length > 0;
      const loadPlan: LoadPlanIR =
        loadPaths.length > 0 ? { kind: "explicit", paths: loadPaths } : { kind: "whole" };
      const retrievalName = anon
        ? `findAllBy${anon.criterionName}${hasShaping ? shapeSuffix(sortTerms, loadPaths) : ""}`
        : runCall.retrievalName;
      const retrievalArgs = anon ? anon.criterionArgs : runCall.retrievalArgs;
      return {
        stmt: {
          kind: "repo-run",
          name: stmt.name,
          repoName,
          aggName,
          retrievalName,
          retrievalArgs: retrievalArgs.map((a) => lowerExpr(a, env)),
          ...pageClause,
          ...(anon
            ? {
                synthCriterion: { name: anon.criterionName },
                ...(hasShaping ? { synthSort: sortTerms, synthLoadPlan: loadPlan } : {}),
              }
            : {}),
          ...bypass,
          returnType: arrayType,
        },
        envAfter: withLocal(env, stmt.name, "let", arrayType),
      };
    }
    // repo-findall: `Repo.findAll(<Criterion>, page?)` (criterion.md, use
    // site 3).  Desugars to a `repo-run` of a synthetic retrieval (named
    // `findAllBy<Criterion>`) that the enrich pass materialises from the
    // context's criteria — so it rides the existing retrieval pipeline on
    // every backend.  Checked before the generic repo-let so `findAll`
    // doesn't fall through to the find-method path.
    const findAllCall = matchFindAllCall(expr, reposByName);
    if (findAllCall) {
      const aggName = findAllCall.repo.aggregate?.ref?.name ?? "Unknown";
      const repoName = findAllCall.repo.name;
      const arrayType: TypeIR = {
        kind: "array",
        element: { kind: "entity", name: aggName },
      };
      return {
        stmt: {
          kind: "repo-run",
          name: stmt.name,
          repoName,
          aggName,
          retrievalName: `findAllBy${findAllCall.criterionName}`,
          retrievalArgs: findAllCall.criterionArgs.map((a) => lowerExpr(a, env)),
          ...(findAllCall.pageOffset || findAllCall.pageLimit
            ? {
                page: {
                  ...(findAllCall.pageOffset
                    ? { offset: lowerExpr(findAllCall.pageOffset, env) }
                    : {}),
                  ...(findAllCall.pageLimit
                    ? { limit: lowerExpr(findAllCall.pageLimit, env) }
                    : {}),
                },
              }
            : {}),
          synthCriterion: { name: findAllCall.criterionName },
          ...bypass,
          returnType: arrayType,
        },
        envAfter: withLocal(env, stmt.name, "let", arrayType),
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
      const localType: TypeIR = returnType;
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
        // A union-returning find is validator-constrained to the absence
        // shape (payloads.md §Union finds): its runtime value is the bare
        // aggregate-or-absent, never the tagged wire.  Mark the local so a
        // variant-`match` over it lowers to a presence check.
        envAfter: withLocal(env, stmt.name, "let", localType, {
          absenceUnion: returnType.kind === "union",
        }),
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
      // `files.put(args)` — a bare resource-op call (Phase 4).  When the
      // head is an ambient resource handle, lower to a `resource-call`
      // statement; otherwise it's an op-call on a let binding.
      const resourceKind = env.resources?.get(lv.head);
      if (resourceKind) {
        const verb = lv.tail[0]!;
        const verbDef = findVerb(resourceKind, verb);
        const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
        return {
          stmt: {
            kind: "resource-call",
            call: {
              kind: "call",
              callKind: "resource-op",
              name: verb,
              args,
              resourceOp: {
                resourceName: lv.head,
                resourceKind,
                verb,
                capability: verbDef?.capability ?? "",
                ...(verbDef?.interfaceOverride ? { interface: verbDef.interfaceOverride } : {}),
              },
            },
          },
          envAfter: env,
        };
      }
      // `Transfer.run(args)` — a bare orchestrator call into a `domainService`
      // operation (domain-services.md rev. 4, the `mutating` tier).  Checked
      // before the generic op-call path so a service name (not an in-scope
      // local) isn't mistaken for an aggregate let-binding receiver.  Lowers to
      // a `domain-service-call` carrying a render-ready `callKind:
      // "domain-service"` Call (rides each backend's `render-expr`); the
      // aggregate args a `mutating` service writes become exit-save targets,
      // derived in `computeSaves`.  Mirrors the operation-body arm in
      // `lower-stmt.ts`.
      if (!env.locals.has(lv.head)) {
        const svc = findDomainServiceByName(env, lv.head);
        if (svc) {
          const callArgs = (lv.args ?? []).map((a) => lowerExpr(a, env));
          const op = lv.tail[0]!;
          return {
            stmt: {
              kind: "domain-service-call",
              service: svc.name,
              op,
              call: {
                kind: "call",
                callKind: "domain-service",
                name: op,
                args: callArgs,
                serviceRef: { service: svc.name, op },
              },
            },
            envAfter: env,
          };
        }
      }
      // `<Repo>.delete(o)` / `<Repo>.remove(o)` — a repository DELETE
      // (destroy) call written as a bare handler statement.  Recognised BEFORE
      // the generic op-call fallback so a repo head naming a write verb isn't
      // mistaken for an aggregate op-call on a let-binding (which would stamp
      // `aggName: "Unknown"` and re-save the just-deleted entity at exit).
      // Lowers to a `repo-delete` WorkflowStmtIR carrying the target repo +
      // aggregate and the single lowered entity operand.  `computeSaves` never
      // registers a `repo-delete` as a mutation target, so the removed entity
      // is not persisted again on the way out.
      {
        const deleteRepo = reposByName.get(lv.head);
        const method = lv.tail[0]!;
        const deleteArg = (lv.args ?? [])[0];
        if (deleteRepo && isWriteMethod(method) && deleteArg) {
          const aggName = deleteRepo.aggregate?.ref?.name ?? "Unknown";
          const entity = lowerExpr(deleteArg, env);
          return {
            stmt: {
              kind: "repo-delete",
              repoName: deleteRepo.name,
              aggName,
              entity,
            },
            envAfter: env,
          };
        }
      }
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
    // `field := value` / `field += value` / `field -= value` — own-state
    // mutation (workflow.md, "handle = own-state mutation").  Allowed onto one
    // of the workflow's OWN state `Property` members (a single-segment path
    // resolving to `this`).  Cross-aggregate writes (`order.status := …`) and
    // deep paths stay on the `__bad__` path below and are rejected at
    // IR-validate.  Mirrors the aggregate-op `:=` lowering in lower-stmt.ts.
    //
    // The compound forms (`+=`/`-=`) are SCALAR arithmetic on the saga state:
    // they lower to the SAME `assign` IR node, with `value` rewritten to a
    // synthetic `binary` (`<this-prop field> <+|-> <rhs>`).  This rides the
    // shared expression seam — every backend's binary renderer already emits
    // the type-correct form (int `state.x + v`, Java `state.getX().add(v)`,
    // Phoenix `Decimal.add(state.x, v)`, …) — so no new WorkflowStmtIR kind,
    // seam arm, or per-backend emitter is needed: the existing `assign` arm,
    // which renders `state.<field> = <value>` off the expression renderer,
    // carries it for free.  A COLLECTION own-state field (`X id[]`) is OUT OF
    // SCOPE for `+=`/`-=` — it stays `__bad__` (saga-state collection
    // append-mutation isn't supported yet), so the diagnostic still fires.
    if (
      (stmt.op === ":=" || stmt.op === "+=" || stmt.op === "-=") &&
      !lv.call &&
      lv.tail.length === 0 &&
      env.workflow?.members.some((m) => isProperty(m) && m.name === lv.head)
    ) {
      const path: PathIR = { segments: [lv.head] };
      const targetType = pathType(path, env);
      const compound = stmt.op === "+=" || stmt.op === "-=";
      // Collection own-state `+=`/`-=` is out of scope — fall through to
      // `__bad__` (a saga-state list append isn't a recognised form yet).
      if (!(compound && targetType.kind === "array")) {
        // Element-type context so a numeric literal into a money/decimal field
        // elaborates to the precise typed literal — same as the aggregate
        // compound lowering in lower-stmt.ts.
        const rhs = lowerExprInContext(stmt.value, targetType, env);
        const value: ExprIR = compound
          ? {
              kind: "binary",
              op: stmt.op === "+=" ? "+" : "-",
              // The current persisted value of the own-state field — a
              // `this-prop` read, rendered as `state.<field>` (thisName
              // redirect) on every backend.
              left: { kind: "ref", name: lv.head, refKind: "this-prop", type: targetType },
              right: rhs,
              // The field type drives money/decimal operator dispatch in the
              // binary renderer; the compound result type is the field type
              // (int += int → int, money += money → money).
              leftType: targetType,
              resultType: targetType,
            }
          : rhs;
        return {
          stmt: { kind: "assign", target: path, value, targetType },
          envAfter: env,
        };
      }
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
  // Unwrap optional/array wrappers: a CUSTOM-find repo-let binds the find's
  // declared return type (`byLabel(): Item?` → `optional<Item>`), but the
  // with-chain unwraps the `{:ok, i}` so the body receiver is the bare
  // aggregate.  Without unwrapping, `i.markFound()` resolves to "Unknown" and
  // the op-call emits a call to a non-existent `mark_found_unknown` context fn
  // (getById already binds a bare entity, so only custom finds were affected).
  let t: TypeIR = local.type;
  while (t.kind === "optional" || t.kind === "array") {
    t = t.kind === "optional" ? t.inner : t.element;
  }
  return t.kind === "entity" ? t.name : undefined;
}

interface FactoryMatch {
  aggName: string;
  fields: { name: string; value: Expression }[];
}

function matchFactoryCall(
  expr: Expression | undefined,
  aggsByName: Map<string, Aggregate>,
): FactoryMatch | undefined {
  if (!expr || !isPostfixChain(expr)) return undefined;
  // Factory shape: `<NameRef>.create({...})` — exactly one
  // MemberSuffix with member==="create" and a call payload.
  if (expr.suffixes.length !== 1) return undefined;
  const s = expr.suffixes[0]!;
  if (!isMemberSuffix(s) || !s.call) return undefined;
  if (s.member !== "create") return undefined;
  const recv = expr.head;
  if (!isNameRef(recv)) return undefined;
  if (!aggsByName.has(recv.name)) return undefined;
  if (s.args.length !== 1) return undefined;
  const argWrap = s.args[0];
  // Factory calls take a single object literal positional
  // arg.  Reject the named-arg form here; the caller falls through
  // to a generic call lowering rather than the factory shape.
  if (!argWrap || argWrap.name) return undefined;
  const arg = argWrap.value;
  if (!isObjectLit(arg)) return undefined;
  return {
    aggName: recv.name,
    fields: arg.fields.map((f) => ({ name: f.name, value: f.value })),
  };
}

/** Lower a structural `LoadPath` AST node (`lines[].product`) to its
 *  candidate-rooted segment list (a leading `this` is already stripped by the
 *  grammar) — the workflow-side twin of `lowerLoadPath` in lower.ts. */
function loadPathSegments(p: LoadPath): LoadSegmentIR[] {
  return p.segments.map((seg) => ({ name: seg.name, collection: !!seg.collection }));
}

/** A readable, deterministic suffix rendering an anonymous retrieval's
 *  `sort:` / `loads:` shaping — folded into the synthetic retrieval name so
 *  distinct shapes over one criterion get distinct retrievals while identical
 *  shapes dedupe.  Readable ON PURPOSE (S8, `generated-code-ddd-review-2026-07`):
 *  this name becomes a PUBLIC domain-surface method on every backend
 *  (`runFindAllByActiveNamedBySequenceDesc` on Hono, the `…Spec` in the .NET
 *  Domain namespace, the snake_cased Phoenix context fn), so the previous
 *  structural hash (`Shaped1g7wy98`) leaked compiler internals into the
 *  ubiquitous language.  The rendering is a canonical function of the shape
 *  content — sort terms as `By<Path><Asc|Desc>` joined with `Then`, load
 *  paths as `Loading<Path>` joined with `And` — so the
 *  distinct-shapes-stay-distinct / identical-shapes-dedupe property the hash
 *  provided is preserved (enrichment's dedup-by-name in
 *  `synthesizeFindAllRetrievals` is untouched). */
function shapeSuffix(sort: SortTermIR[], loads: LoadSegmentIR[][]): string {
  const pathName = (segs: readonly LoadSegmentIR[]): string =>
    segs.map((s) => upperFirst(s.name)).join("");
  const sortPart =
    sort.length > 0
      ? `By${sort
          .map((t) => `${pathName(t.path)}${t.direction === "desc" ? "Desc" : "Asc"}`)
          .join("Then")}`
      : "";
  const loadsPart = loads.length > 0 ? `Loading${loads.map(pathName).join("And")}` : "";
  return `${sortPart}${loadsPart}`;
}
