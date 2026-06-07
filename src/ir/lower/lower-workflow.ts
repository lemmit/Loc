import type {
  Aggregate,
  BoundedContext,
  Expression,
  HandleDecl,
  OnDecl,
  Repository,
  Statement,
  Workflow,
  WorkflowCreateDecl,
} from "../../language/generated/ast.js";
import {
  isAggregate,
  isApply,
  isAssignOrCallStmt,
  isCallSuffix,
  isEmitStmt,
  isForStmt,
  isHandleDecl,
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
  isWorkflowCreateDecl,
} from "../../language/generated/ast.js";
import { findVerb } from "../resource-verbs.js";
import type {
  ApplyIR,
  CreateIR,
  ExprIR,
  FieldIR,
  HandleIR,
  OnIR,
  ParamIR,
  TypeIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../types/loom-ir.js";
import { inferExprType, lowerExpr } from "./lower-expr.js";
import { computeSaves, lowerApply, lowerField, plural } from "./lower-members.js";
import { cstText, type Env, inWorkflow, lowerType, withLocal } from "./lower-types.js";

export function lowerWorkflow(wf: Workflow, env: Env, ctx: BoundedContext): WorkflowIR {
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
  for (const m of wf.members) {
    if (isWorkflowCreateDecl(m)) {
      creates.push(lowerWorkflowCreate(m, paramEnv, aggsByName, reposByName, repoForAgg));
    } else if (isOnDecl(m)) {
      subscriptions.push(lowerOn(m, paramEnv, aggsByName, reposByName, repoForAgg));
    } else if (isHandleDecl(m)) {
      handlers.push(lowerHandle(m, paramEnv, aggsByName, reposByName, repoForAgg));
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
  };
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
): CreateIR {
  let inner = baseEnv;
  const params: ParamIR[] = [];
  for (const p of c.params) {
    const t = lowerType(p.type, baseEnv);
    params.push({ name: p.name, type: t });
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
    const lowered = lowerWorkflowStatement(s, inner, aggsByName, reposByName, repoForAgg);
    statements.push(lowered.stmt);
    inner = lowered.envAfter;
  }
  return {
    name: c.name ?? null,
    triggerKind,
    params,
    ...(correlation ? { correlation } : {}),
    statements,
    savesAtExit: computeSaves(statements, repoForAgg),
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
    const lowered = lowerWorkflowStatement(s, inner, aggsByName, reposByName, repoForAgg);
    statements.push(lowered.stmt);
    inner = lowered.envAfter;
  }
  return { name: h.name, params, statements, savesAtExit: computeSaves(statements, repoForAgg) };
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
): OnIR {
  const eventName = o.event.ref?.name ?? o.event.$refText;
  const inner = withLocal(baseEnv, o.param, "param", { kind: "entity", name: eventName });
  const correlation = o.correlation ? lowerExpr(o.correlation, inner) : undefined;
  const statements: WorkflowStmtIR[] = [];
  let bodyEnv = inner;
  for (const s of o.body) {
    const lowered = lowerWorkflowStatement(s, bodyEnv, aggsByName, reposByName, repoForAgg);
    statements.push(lowered.stmt);
    bodyEnv = lowered.envAfter;
  }
  return {
    event: eventName,
    param: o.param,
    ...(correlation ? { correlation } : {}),
    statements,
    savesAtExit: computeSaves(statements, repoForAgg),
  };
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
        fields: stmt.fields.map((f) => ({
          name: f.name,
          value: lowerExpr(f.value, env),
        })),
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
      const lowered = lowerWorkflowStatement(s, walkEnv, aggsByName, reposByName, repoForAgg);
      body.push(lowered.stmt);
      walkEnv = lowered.envAfter;
    }
    const savesPerIteration = computeSaves(body, repoForAgg, {
      name: stmt.var,
      aggName: varAggName,
      repoName,
    });
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
  if (isLetStmt(stmt)) {
    const expr = stmt.expr;
    // factory-let: `Agg.create({fields})`
    const factory = matchFactoryCall(expr, aggsByName);
    if (factory) {
      const repoName = repoForAgg.get(factory.aggName) ?? plural(factory.aggName);
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
    // repo-run: `Repo.run(<Retrieval>(args), page?)` — binds the
    // retrieval's result array.  Checked before the generic repo-let so
    // `run` doesn't fall through to the find-method path.
    const runCall = matchRetrievalRunCall(expr, reposByName);
    if (runCall) {
      const aggName = runCall.repo.aggregate?.ref?.name ?? "Unknown";
      const repoName = runCall.repo.name;
      const elementType: TypeIR = { kind: "entity", name: aggName };
      const arrayType: TypeIR = { kind: "array", element: elementType };
      return {
        stmt: {
          kind: "repo-run",
          name: stmt.name,
          repoName,
          aggName,
          retrievalName: runCall.retrievalName,
          retrievalArgs: runCall.retrievalArgs.map((a) => lowerExpr(a, env)),
          ...(runCall.pageOffset || runCall.pageLimit
            ? {
                page: {
                  ...(runCall.pageOffset ? { offset: lowerExpr(runCall.pageOffset, env) } : {}),
                  ...(runCall.pageLimit ? { limit: lowerExpr(runCall.pageLimit, env) } : {}),
                },
              }
            : {}),
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

interface RepoMatch {
  repo: Repository;
  method: string;
  args: Expression[];
}

function matchRepoCall(
  expr: Expression | undefined,
  reposByName: Map<string, Repository>,
): RepoMatch | undefined {
  if (!expr || !isPostfixChain(expr)) return undefined;
  // Repo-call shape: `<NameRef>.<method>(args)` — exactly one
  // MemberSuffix with a call payload.
  if (expr.suffixes.length !== 1) return undefined;
  const s = expr.suffixes[0]!;
  if (!isMemberSuffix(s) || !s.call) return undefined;
  const recv = expr.head;
  if (!isNameRef(recv)) return undefined;
  const repo = reposByName.get(recv.name);
  if (!repo) return undefined;
  // Peel CallArg wrappers — repo finds are positional.
  return {
    repo,
    method: s.member,
    args: (s.args ?? []).map((a) => a.value),
  };
}

interface RetrievalRunMatch {
  repo: Repository;
  retrievalName: string;
  retrievalArgs: Expression[];
  /** The `page:` object-literal argument's fields, if supplied. */
  pageOffset?: Expression;
  pageLimit?: Expression;
}

/** Recognise `<Repo>.run(<RetrievalRef>(args), page?)`.  The first
 *  positional arg is itself a call (the retrieval reference); an optional
 *  named `page:` arg carries an object literal `{ offset?, limit? }`. */
function matchRetrievalRunCall(
  expr: Expression | undefined,
  reposByName: Map<string, Repository>,
): RetrievalRunMatch | undefined {
  if (!expr || !isPostfixChain(expr)) return undefined;
  if (expr.suffixes.length !== 1) return undefined;
  const s = expr.suffixes[0]!;
  if (!isMemberSuffix(s) || !s.call || s.member !== "run") return undefined;
  const recv = expr.head;
  if (!isNameRef(recv)) return undefined;
  const repo = reposByName.get(recv.name);
  if (!repo) return undefined;
  const callArgs = s.args ?? [];
  // First positional arg = the retrieval reference `Name(args)`.
  const refArg = callArgs.find((a) => !a.name);
  if (!refArg) return undefined;
  const ref = refArg.value;
  // Bare `Name` (parameterless retrieval).
  if (isNameRef(ref)) {
    return { repo, retrievalName: ref.name, retrievalArgs: [] };
  }
  // `Name(args)` — a NameRef head + a single CallSuffix.
  if (!isPostfixChain(ref) || !isNameRef(ref.head) || ref.suffixes.length !== 1) {
    return undefined;
  }
  const rs = ref.suffixes[0]!;
  if (!isCallSuffix(rs)) return undefined;
  const retrievalName = ref.head.name;
  const retrievalArgs: Expression[] = (rs.args ?? []).map((a) => a.value);
  // Optional `page:` named arg — an object literal with offset / limit.
  const pageArg = callArgs.find((a) => a.name === "page");
  let pageOffset: Expression | undefined;
  let pageLimit: Expression | undefined;
  if (pageArg && isObjectLit(pageArg.value)) {
    for (const f of pageArg.value.fields) {
      if (f.name === "offset") pageOffset = f.value;
      else if (f.name === "limit") pageLimit = f.value;
    }
  }
  return { repo, retrievalName, retrievalArgs, pageOffset, pageLimit };
}
