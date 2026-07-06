import { forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedBoundedContextIR,
  ExprIR,
  FieldIR,
  IsolationLevel,
  SystemIR,
  TypeIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../../ir/types/loom-ir.js";
import {
  exprUsesCurrentUser,
  operationUsesCurrentUser,
  workflowEmitsCommandRoute,
} from "../../../ir/types/loom-ir.js";
import { readPortsForOperation } from "../../../ir/util/domain-service-read-ports.js";
import { resolveWorkflowIsolation } from "../../../ir/util/resolve-datasource.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst, workflowFnCamel } from "../../../util/naming.js";
import { statementSubRegions } from "../../_trace/sourcemap.js";
import {
  collectUnionFindLets,
  renderWorkflowStmtChunks,
  type WorkflowStmtTarget,
} from "../../_workflow/stmt-target.js";
import {
  collectJavaExprImports,
  type JavaRenderContext,
  renderJavaExpr,
  renderJavaType,
} from "../render-expr.js";
import { renderJavaStatements } from "../render-stmt.js";
import type { OpFragment } from "./entity.js";
import {
  collectWireImports,
  collectWireToDomainImports,
  referencedValueObjects,
  wireJavaType,
  wireToDomain,
} from "./wire.js";
import { setterName } from "./workflow-state.js";

/** Render a variant-`match` whose scrutinee is a UNION-FIND binding: the
 *  repository returns the bare success aggregate (null on absence — no union
 *  carrier records exist for finds), so the absence/error variant is
 *  `case null` and the success variant is a total type pattern (which must
 *  come last; Java 21 pattern switch, exhaustive without `default`). */
function renderJavaOptionalTwinMatch(
  m: Extract<ExprIR, { kind: "match" }>,
  renderCtx: JavaRenderContext,
): string {
  const subject = renderJavaExpr(m.subject!, renderCtx);
  const success = m.variantArms.find((a) => !a.isError);
  const error = m.variantArms.find((a) => a.isError);
  const absent = error
    ? renderJavaExpr(error.value, renderCtx)
    : m.otherwise
      ? renderJavaExpr(m.otherwise, renderCtx)
      : "null";
  const arms: string[] = [`      case null -> ${absent};`];
  if (success) {
    const t = success.varType;
    const typeName = t.kind === "entity" || t.kind === "valueobject" ? t.name : "Object";
    const binder = success.binding ?? `__${typeName.toLowerCase()}`;
    arms.push(`      case ${typeName} ${binder} -> ${renderJavaExpr(success.value, renderCtx)};`);
  } else if (m.otherwise) {
    arms.push(`      default -> ${renderJavaExpr(m.otherwise, renderCtx)};`);
  }
  return `switch (${subject}) {\n${arms.join("\n")}\n    }`;
}

/** Spring `Isolation` enum member for a DSL isolation level. */
function javaIsolation(level: IsolationLevel): string {
  switch (level) {
    case "readUncommitted":
      return "READ_UNCOMMITTED";
    case "readCommitted":
      return "READ_COMMITTED";
    case "repeatableRead":
      return "REPEATABLE_READ";
    case "serializable":
      return "SERIALIZABLE";
  }
}

// ---------------------------------------------------------------------------
// Workflows — cross-aggregate orchestration.  One `<Context>Workflows`
// @Service with a method per workflow (the layered analog of the .NET
// per-workflow Command/Handler pair) and one `<Context>WorkflowsController`
// exposing `POST /workflows/<snake(name)>` → 204 (the cross-backend route
// contract).  Bodies render the WorkflowStmtIR shapes: requires /
// precondition gates, factory-lets through the target aggregate's
// `create(...)` (missing create-inputs filled with null), repo-lets,
// op-calls, and the at-exit saves.
// ---------------------------------------------------------------------------

export interface WorkflowCtx {
  basePkg: string;
  /** Package of the workflow service + request records. */
  pkg: string;
  /** Route prefix ("/api" in fullstack mode). */
  routePrefix?: string;
  /** resourceName → client class, for `resource-op` calls (Phase 4c). */
  resourceClasses?: Map<string, string>;
  /** Package the resource client classes live in. */
  resourcesPkg?: string;
  /** category-resolved package lookups for cross-package imports. */
  entityPkgOf: (aggName: string) => string;
  repoPkgOf: (aggName: string) => string;
  /** Package the `<Vo>Request` / `<Vo>Response` records for a value object
   *  live in — they're emitted into the application (service) package of an
   *  aggregate that references the VO (`dto.ts`).  A VO-typed workflow param
   *  (`workflow X { create(amount: Money) }`) yields a `MoneyRequest`
   *  component in the workflow Request record, which sits in a DIFFERENT
   *  package, so it must be imported explicitly (the aggregate-create
   *  Request DTO gets it for free by co-location).  Returns null when no
   *  aggregate references the VO (shouldn't happen for a param-reachable VO). */
  voRequestPkgOf?: (voName: string) => string | null;
  /** Package the `domainService` beans live in — a `reading`-tier service a
   *  workflow calls is constructor-injected (`@Service` bean), imported from
   *  here (domain-services.md rev. 4, Slice 1).  Optional; absent ⇒ no reading
   *  service is injected (pure-only / legacy callers). */
  domainServicePkg?: string;
}

const baseRenderCtx = { thisName: "this" };

function workflowUsesCurrentUser(wf: WorkflowIR): boolean {
  const exprs: (ExprIR | undefined)[] = [];
  const visit = (s: WorkflowStmtIR): void => {
    switch (s.kind) {
      case "precondition":
      case "requires":
        exprs.push(s.expr);
        break;
      case "emit":
      case "factory-let":
        for (const f of s.fields) exprs.push(f.value);
        break;
      case "repo-let":
      case "op-call":
        for (const a of s.args) exprs.push(a);
        break;
      case "expr-let":
        exprs.push(s.expr);
        break;
      case "repo-run":
        break;
      case "for-each":
        exprs.push(s.iterable);
        for (const b of s.body) visit(b);
        break;
      case "resource-call":
        exprs.push(s.call);
        break;
    }
  };
  for (const s of wf.statements) visit(s);
  return exprs.some((e) => exprUsesCurrentUser(e));
}

/** Repositories a workflow touches (repo-lets, factory-lets, saves). */
export function reposUsed(wf: WorkflowIR, ctx: EnrichedBoundedContextIR): string[] {
  const aggs = new Set<string>();
  const visit = (s: WorkflowStmtIR): void => {
    if (s.kind === "factory-let") aggs.add(s.aggName);
    if (s.kind === "repo-let") aggs.add(s.aggName);
    if (s.kind === "repo-run") aggs.add(s.aggName);
    if (s.kind === "for-each") {
      for (const save of s.savesPerIteration) aggs.add(save.aggName);
      for (const b of s.body) visit(b);
    }
  };
  for (const s of wf.statements) visit(s);
  for (const save of wf.savesAtExit) aggs.add(save.aggName);
  return [...aggs].filter((a) => ctx.aggregates.some((x) => x.name === a)).sort();
}

// The Java leaf table for the shared workflow statement spine
// (`_workflow/stmt-target.ts`). Built per render call so it captures the
// `ctx`, the `imports` accumulator (each arm side-effects it via
// `collectJavaExprImports`), and the `renderCtx`. The dispatch + `for-each`
// recursion live in the spine; the base indent (8 spaces) is threaded in by
// the driver and `for-each` bodies step +`indentUnit` (4 spaces), matching
// the pre-seam hand-indentation exactly.
export function javaWorkflowStmtTarget(
  ctx: EnrichedBoundedContextIR,
  imports: Set<string>,
  renderCtx: JavaRenderContext = baseRenderCtx,
  /** When set, `emit` appends the constructed event to this list var (the
   *  saga dispatcher re-publishes it after saves) instead of logging it
   *  (the command-workflow facade behaviour).  Omitted ⇒ log, byte-identical. */
  emitSink?: string,
  /** Let-bound names whose RHS was a UNION-returning find.  The Java
   *  repository emits such a find returning the bare success aggregate
   *  (nullable on absence) and NO `<Union>_<Tag>` carrier records — so a
   *  variant-`match` over one of these bindings renders a null-check switch,
   *  not the carrier-pattern switch `matchVariant` emits for operation
   *  unions (whose carriers DO exist). */
  unionFindLets: ReadonlySet<string> = new Set(),
): WorkflowStmtTarget {
  return {
    indentUnit: "    ",
    precondition: (s, indent) => {
      collectJavaExprImports(s.expr, imports);
      return [
        `${indent}if (!(${renderJavaExpr(s.expr, renderCtx)})) throw new DomainException(${JSON.stringify(`Precondition failed: ${s.source}`)});`,
      ];
    },
    requires: (s, indent) => {
      collectJavaExprImports(s.expr, imports);
      return [
        `${indent}if (!(${renderJavaExpr(s.expr, renderCtx)})) throw new ForbiddenException(${JSON.stringify(`Forbidden: ${s.source}`)});`,
      ];
    },
    factoryLet: (s, indent) => {
      // Positional create over the target aggregate's create-input list;
      // fields the workflow doesn't supply are filled with null (the
      // .NET handler passes named nulls the same way).
      const agg = ctx.aggregates.find((a) => a.name === s.aggName);
      if (!agg) throw new Error(`workflow factory-let: unknown aggregate '${s.aggName}'`);
      const byName = new Map(s.fields.map((f) => [f.name, f.value]));
      const args = forCreateInput(agg.fields).map((f) => {
        const v = byName.get(f.name);
        if (!v) return "null";
        collectJavaExprImports(v, imports);
        return renderJavaExpr(v, renderCtx);
      });
      return [`${indent}var ${s.name} = ${s.aggName}.create(${args.join(", ")});`];
    },
    repoLet: (s, indent) => {
      for (const a of s.args) collectJavaExprImports(a, imports);
      const args = s.args.map((a) => renderJavaExpr(a, renderCtx)).join(", ");
      const method = s.method === "byId" ? "getById" : s.method;
      const wrap = s.method === "byId" ? `new ${s.aggName}Id(${args})` : args;
      return [`${indent}var ${s.name} = ${repoField(s.aggName)}.${method}(${wrap});`];
    },
    exprLet: (s, indent) => {
      collectJavaExprImports(s.expr, imports);
      // A variant-`match` over a UNION-FIND binding matches the nullable
      // success aggregate — render `case null` + a total type pattern
      // instead of the (non-existent) union carrier patterns.
      if (
        s.expr.kind === "match" &&
        s.expr.subject?.kind === "ref" &&
        unionFindLets.has(s.expr.subject.name)
      ) {
        return [`${indent}var ${s.name} = ${renderJavaOptionalTwinMatch(s.expr, renderCtx)};`];
      }
      return [`${indent}var ${s.name} = ${renderJavaExpr(s.expr, renderCtx)};`];
    },
    // `field := value` — own-state mutation.  The persisted correlation row's
    // fields are package-private, so the cross-package dispatcher writes through
    // the public JavaBean setter (`state.setAttempts(1)`); `repo.save(state)`
    // at handler exit flushes it.
    assign: (s, indent) => {
      collectJavaExprImports(s.value, imports);
      return [
        `${indent}${renderCtx.thisName}.${setterName(s.target.segments[0]!)}(${renderJavaExpr(s.value, renderCtx)});`,
      ];
    },
    opCall: (s, indent) => {
      for (const a of s.args) collectJavaExprImports(a, imports);
      const rendered = s.args.map((a) => renderJavaExpr(a, renderCtx));
      // Aggregate ops that reference currentUser take it as a trailing
      // parameter (the entity emitter appends it) — thread it through.
      const targetOp = ctx.aggregates
        .find((a) => a.name === s.aggName)
        ?.operations.find((o) => o.name === s.op);
      if (targetOp && operationUsesCurrentUser(targetOp)) rendered.push("currentUser");
      return [`${indent}${s.target}.${s.op}(${rendered.join(", ")});`];
    },
    emit: (s, indent) => {
      // Workflow-level emission has no aggregate stream to ride: the
      // event record is constructed (so its shape stays compile-checked)
      // and logged with the same `domain_event` envelope the per-aggregate
      // publishEvents uses.  Java events are positional records — order
      // the emit site's `name: value` pairs by the declared field order.
      for (const f of s.fields) collectJavaExprImports(f.value, imports);
      const declared = ctx.events.find((e) => e.name === s.eventName);
      const rendered = new Map(s.fields.map((f) => [f.name, renderJavaExpr(f.value, renderCtx)]));
      const args = declared
        ? declared.fields.map((f) => rendered.get(f.name) ?? "null").join(", ")
        : [...rendered.values()].join(", ");
      return emitSink
        ? [`${indent}${emitSink}.add(new ${s.eventName}(${args}));`]
        : [
            `${indent}{ var __ev = new ${s.eventName}(${args}); CatalogLog.event("event_dispatched", "info", "event_type", __ev.getClass().getSimpleName()); }`,
          ];
    },
    repoRun: (s, indent) => {
      for (const a of s.retrievalArgs) collectJavaExprImports(a, imports);
      const args = s.retrievalArgs.map((a) => renderJavaExpr(a, renderCtx));
      // Call-site page rides the `(…, Integer offset, Integer limit)`
      // port overload; absent halves pass null (no skip / no cap).
      if (s.page) {
        if (s.page.offset) collectJavaExprImports(s.page.offset, imports);
        if (s.page.limit) collectJavaExprImports(s.page.limit, imports);
        args.push(
          s.page.offset ? renderJavaExpr(s.page.offset, renderCtx) : "null",
          s.page.limit ? renderJavaExpr(s.page.limit, renderCtx) : "null",
        );
      }
      return [
        `${indent}var ${s.name} = ${repoField(s.aggName)}.run${upperFirst(s.retrievalName)}(${args.join(", ")});`,
      ];
    },
    forEach: (s, indent, body) => {
      collectJavaExprImports(s.iterable, imports);
      // The spine renders `body` at `indent + indentUnit`; per-iteration
      // saves sit at the same depth.
      const inner = `${indent}    `;
      const saves = s.savesPerIteration.map(
        (save) => `${inner}${repoField(save.aggName)}.save(${save.name});`,
      );
      return [
        `${indent}for (var ${s.var} : ${renderJavaExpr(s.iterable, renderCtx)}) {`,
        ...body,
        ...saves,
        `${indent}}`,
      ];
    },
    ifLet: (s, indent, thenLines, elseLines) => {
      // `if let o = Repo.find(<Criterion>) { … } else { … }` → run the shared
      // `findAllBy<Criterion>` retrieval with the `(…, offset, limit)` overload
      // capped at 1, take the first row via `stream().findFirst().orElse(null)`,
      // and branch.  Each branch's dirty bindings save inside it.
      for (const a of s.retrievalArgs) collectJavaExprImports(a, imports);
      const args = s.retrievalArgs.map((a) => renderJavaExpr(a, renderCtx));
      args.push("null", "1"); // offset null, limit 1 — single result
      const inner = `${indent}    `;
      const thenSaves = s.savesInThen.map(
        (sv) => `${inner}${repoField(sv.aggName)}.save(${sv.name});`,
      );
      const elseSaves = s.savesInElse.map(
        (sv) => `${inner}${repoField(sv.aggName)}.save(${sv.name});`,
      );
      const out = [
        `${indent}var ${s.var} = ${repoField(s.aggName)}.run${upperFirst(s.retrievalName)}(${args.join(", ")}).stream().findFirst().orElse(null);`,
        `${indent}if (${s.var} != null) {`,
        ...thenLines,
        ...thenSaves,
      ];
      if (elseLines.length > 0 || elseSaves.length > 0) {
        out.push(`${indent}} else {`, ...elseLines, ...elseSaves, `${indent}}`);
      } else {
        out.push(`${indent}}`);
      }
      return out;
    },
    // Bare resource-op statement (`files.put(k, v)`) — the expression
    // renderer's `resource-op` arm dispatches through resourceClasses.
    resourceCall: (s, indent) => {
      collectJavaExprImports(s.call, imports);
      return [`${indent}${renderJavaExpr(s.call, renderCtx)};`];
    },
    // Bare `Transfer.run(src, dst, amount)` domain-service call
    // (domain-services.md rev. 4, the `mutating` tier).  `renderJavaExpr` emits
    // a static `Transfer.run(...)` (pure/mutating) or instance bean call
    // (reading).  The mutated args are JPA-managed entities → dirty-checking
    // flushes them at the `@Transactional` boundary (plus the explicit
    // exit-`save` the workflow emits for new aggregates).
    domainServiceCall: (s, indent) => {
      collectJavaExprImports(s.call, imports);
      return [`${indent}${renderJavaExpr(s.call, renderCtx)};`];
    },
  };
}

export function repoField(aggName: string): string {
  return `${lowerFirst(plural(aggName))}Repository`;
}

/** Normalise the optional flag into the type (mirrors `dto.ts` / `service.ts`'s
 *  `eff`) so the wire helpers see one canonical shape. */
function effType(t: TypeIR, optional: boolean): TypeIR {
  return optional && t.kind !== "optional" ? { kind: "optional", inner: t } : t;
}

/** `private static <Vo> to<Vo>(<Vo>Request request)` mappers for every value
 *  object reachable (transitively) from a command-workflow's params — the
 *  workflow-service twin of `service.ts`'s per-aggregate VO mappers, which a
 *  VO-typed param's `wireToDomain` (`to<Vo>(request.x())`) call needs.  Returns
 *  the body lines and accumulates the inbound-conversion imports. */
function workflowVoMappers(
  ctx: EnrichedBoundedContextIR,
  workflows: readonly WorkflowIR[],
  imports: Set<string>,
): string[] {
  const voLookup = new Map(ctx.valueObjects.map((v) => [v.name, v.fields] as const));
  const collect = (t: TypeIR, into: Set<string>): void => {
    if (t.kind === "valueobject") into.add(t.name);
    else if (t.kind === "array") collect(t.element, into);
    else if (t.kind === "optional") collect(t.inner, into);
  };
  const voNames = new Set<string>();
  for (const wf of workflows) for (const p of wf.params) collect(p.type, voNames);
  // Transitive closure — a VO field may itself be a VO.
  const queue = [...voNames];
  while (queue.length > 0) {
    const vo = queue.pop()!;
    for (const f of voLookup.get(vo) ?? []) {
      const before = voNames.size;
      collect(f.type, voNames);
      if (voNames.size > before) for (const v of voNames) if (!queue.includes(v)) queue.push(v);
    }
  }
  return [...voNames].sort().flatMap((vo) => {
    const fields: readonly FieldIR[] = voLookup.get(vo) ?? [];
    const args = fields
      .map((f) => wireToDomain(effType(f.type, !!f.optional), `request.${f.name}()`))
      .join(", ");
    for (const f of fields) collectWireToDomainImports(f.type, imports);
    return [
      `    private static ${vo} to${vo}(${vo}Request request) {`,
      `        return new ${vo}(${args});`,
      `    }`,
      ``,
    ];
  });
}

function renderCtxFor(ctx: EnrichedBoundedContextIR, wctx: WorkflowCtx): JavaRenderContext {
  // `serviceReading` makes a `domain-service` call render as an INSTANCE call
  // against the injected bean field when the called op is reading-tier
  // (domain-services.md rev. 4) — a pure-service call resolves to `false` and
  // stays a static call, byte-identical.
  const serviceReading = (service: string, op: string): boolean => {
    const svc = ctx.domainServices.find((s) => s.name === service);
    const operation = svc?.operations.find((o) => o.name === op);
    return operation ? readPortsForOperation(operation).length > 0 : false;
  };
  return wctx.resourceClasses?.size
    ? { ...baseRenderCtx, serviceReading, resourceClasses: wctx.resourceClasses }
    : { ...baseRenderCtx, serviceReading };
}

/** The reading-tier domain services a workflow calls in its body — each is a
 *  `@Service` bean the workflow constructor-injects (domain-services.md rev. 4,
 *  Slice 1).  De-duplicated by service name, in first-call order; a PURE service
 *  call is a static call (no injection), so it never appears here. */
function readingServicesCalled(wf: WorkflowIR, ctx: EnrichedBoundedContextIR): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (e: ExprIR | undefined): void => {
    if (!e) return;
    if (e.kind === "call" && e.callKind === "domain-service" && e.serviceRef) {
      const svc = ctx.domainServices.find((s) => s.name === e.serviceRef!.service);
      const op = svc?.operations.find((o) => o.name === e.serviceRef!.op);
      if (svc && op && readPortsForOperation(op).length > 0 && !seen.has(svc.name)) {
        seen.add(svc.name);
        order.push(svc.name);
      }
    }
    for (const c of exprChildren(e)) visit(c);
  };
  const walk = (stmts: WorkflowStmtIR[]): void => {
    for (const s of stmts) {
      for (const e of workflowStmtExprs(s)) visit(e);
      if (s.kind === "for-each") walk(s.body);
    }
  };
  walk(wf.statements);
  return order;
}

/** The STATIC (pure / mutating) domain services a workflow calls — a
 *  `callKind: "domain-service"` whose op declares NO read ports
 *  (domain-services.md rev. 4).  Rendered as a static `Service.op(...)` call, so
 *  the workflow file must import the service class (unlike a reading-tier call,
 *  which is an injected bean).  De-duplicated by service name, first-call order. */
function staticServicesCalled(wf: WorkflowIR, ctx: EnrichedBoundedContextIR): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (e: ExprIR | undefined): void => {
    if (!e) return;
    if (e.kind === "call" && e.callKind === "domain-service" && e.serviceRef) {
      const svc = ctx.domainServices.find((s) => s.name === e.serviceRef!.service);
      const op = svc?.operations.find((o) => o.name === e.serviceRef!.op);
      if (svc && op && readPortsForOperation(op).length === 0 && !seen.has(svc.name)) {
        seen.add(svc.name);
        order.push(svc.name);
      }
    }
    for (const c of exprChildren(e)) visit(c);
  };
  const walk = (stmts: WorkflowStmtIR[]): void => {
    for (const s of stmts) {
      for (const e of workflowStmtExprs(s)) visit(e);
      if (s.kind === "for-each") walk(s.body);
    }
  };
  walk(wf.statements);
  return order;
}

/** Sub-expressions of a workflow statement that may contain a domain-service
 *  call (mirrors `workflowUsesCurrentUser`'s per-kind expr extraction). */
function workflowStmtExprs(s: WorkflowStmtIR): (ExprIR | undefined)[] {
  switch (s.kind) {
    case "precondition":
    case "requires":
      return [s.expr];
    case "emit":
    case "factory-let":
      return s.fields.map((f) => f.value);
    case "repo-let":
    case "op-call":
      return s.args;
    case "expr-let":
      return [s.expr];
    case "for-each":
      return [s.iterable];
    case "resource-call":
    case "domain-service-call":
      return [s.call];
    default:
      return [];
  }
}

/** Direct sub-expressions of an ExprIR (for the domain-service-call walk). */
function exprChildren(e: ExprIR): (ExprIR | undefined)[] {
  switch (e.kind) {
    case "method-call":
      return [e.receiver, ...e.args];
    case "member":
      return [e.receiver];
    case "binary":
      return [e.left, e.right];
    case "ternary":
      return [e.cond, e.then, e.otherwise];
    case "unary":
      return [e.operand];
    case "paren":
      return [e.inner];
    case "call":
      return e.args;
    case "new":
    case "object":
      return e.fields.map((f) => f.value);
    case "lambda":
      return [e.body];
    default:
      return [];
  }
}

export function renderJavaWorkflows(
  ctx: EnrichedBoundedContextIR,
  wctx: WorkflowCtx,
  authed: boolean,
  sys?: SystemIR,
  /** Source-map Milestone 11 (workflow-body statement regions) — allocated by
   *  the caller (`src/generator/java/index.ts`) ONLY when a recorder is
   *  present.  The merged `<Ctx>Workflows.java` service deliberately gets no
   *  whole-file region (a multi-workflow pool — see the call site's comment),
   *  so these fragment-only statement regions, one per workflow method body,
   *  are the only mapping that file gets. */
  opFragments?: OpFragment[],
): Map<string, { category: "service" | "controller" | "request-dto"; content: string }> | null {
  // Only command-surfaced workflows get a service method + POST route.  An
  // event-triggered (saga) workflow is invoked by the in-process dispatcher,
  // never an inbound call, so emitting a Request/route with an event-typed
  // param is bogus — `workflowEmitsCommandRoute` is the shared facade rule
  // every other backend already honours (channels.md).  A reactor-only
  // context emits no workflow files.
  const cmdWorkflows = ctx.workflows.filter(workflowEmitsCommandRoute);
  if (cmdWorkflows.length === 0) return null;
  const out = new Map<
    string,
    { category: "service" | "controller" | "request-dto"; content: string }
  >();
  const imports = new Set<string>();
  // True when any workflow pins a SERIALIZABLE/etc. isolation level — drives
  // the `import …Isolation;` and the per-method `@Transactional(isolation = …)`.
  let usesIsolation = false;
  const repoAggs = new Set<string>();
  // Reading-tier domain services any command-workflow calls — injected as
  // `@Service` beans (domain-services.md rev. 4, Slice 1).  First-call order,
  // deduped across workflows.
  const readingSvcs = new Set<string>();
  // STATIC (pure / mutating) domain services any command-workflow calls — a
  // static `Service.op(...)` call whose CLASS the workflow file must import
  // (domain-services.md rev. 4; the reading tier injects a bean instead).
  const staticSvcs = new Set<string>();
  const methods: string[] = [];

  for (const wf of cmdWorkflows) {
    const usesUser = workflowUsesCurrentUser(wf);
    for (const agg of reposUsed(wf, ctx)) repoAggs.add(agg);
    for (const s of readingServicesCalled(wf, ctx)) readingSvcs.add(s);
    for (const s of staticServicesCalled(wf, ctx)) staticSvcs.add(s);
    const reqType = `${upperFirst(wf.name)}Request`;
    // Request record over the workflow params (wire types in, parsed here).
    if (wf.params.length > 0) {
      const reqImports = new Set<string>();
      const components = wf.params.map((p) => {
        collectWireImports(p.type, reqImports);
        return `${wireJavaType(p.type, "Request")} ${p.name}`;
      });
      // A VO-typed param's `<Vo>Request` record lives in an aggregate's
      // application package, not `domain.valueobjects.*` — import it
      // explicitly (the aggregate-create Request DTO is co-located with its
      // VO records, so it never needed this).  Dedup by import line.
      const voNames = referencedValueObjects(
        wf.params.map((p) => p.type),
        new Set<string>(),
      );
      for (const vo of [...voNames].sort()) {
        const voPkg = wctx.voRequestPkgOf?.(vo);
        if (voPkg && voPkg !== wctx.pkg) reqImports.add(`${voPkg}.${vo}Request`);
      }
      out.set(`${reqType}.java`, {
        category: "request-dto",
        content: lines(
          `package ${wctx.pkg};`,
          ``,
          ...[...reqImports].sort().map((i) => `import ${i};`),
          reqImports.size > 0 ? `` : null,
          `import ${wctx.basePkg}.domain.enums.*;`,
          `import ${wctx.basePkg}.domain.ids.*;`,
          `import ${wctx.basePkg}.domain.valueobjects.*;`,
          ``,
          `public record ${reqType}(${components.join(", ")}) {`,
          `}`,
          ``,
        ),
      });
    }
    const paramLets = wf.params.map((p) => {
      collectWireToDomainImports(p.type, imports);
      return `            var ${p.name} = ${wireToDomain(p.type, `request.${p.name}()`)};`;
    });
    // Chunked (one lines-array per top-level statement) rather than the
    // pre-flattened `renderWorkflowStmts` — byte-identical either way
    // (`renderWorkflowStmts` IS `chunks.flat()` by construction), but the
    // per-chunk list lets us surface per-statement sub-regions to the caller
    // that owns the recorder + this file's final content (source-map
    // Milestone 11).  No re-indent transform sits between here and the final
    // file, so the chunk texts collected here are already the exact text
    // that lands in `<Ctx>Workflows.java`.
    const bodyChunks = renderWorkflowStmtChunks(
      wf.statements,
      javaWorkflowStmtTarget(
        ctx,
        imports,
        renderCtxFor(ctx, wctx),
        undefined,
        collectUnionFindLets(wf.statements),
      ),
      "            ",
    );
    const bodyLines = bodyChunks.flat();
    if (opFragments) {
      const chunkTexts = bodyChunks.map((ls) => ls.join("\n"));
      if (chunkTexts.length > 0) {
        opFragments.push({
          fragmentText: chunkTexts.join("\n"),
          subRegions: statementSubRegions(wf.statements, chunkTexts, `${ctx.name}.${wf.name}`),
        });
      }
    }
    const saves = wf.savesAtExit.map((s) => `            ${repoField(s.aggName)}.save(${s.name});`);
    // The service carries a class-level `@Transactional`; a workflow that pins
    // an isolation level (`transactional(<level>)`, or its state dataSource's
    // `isolationLevel:`) overrides it per-method — parity with the .NET
    // BeginTransactionAsync(IsolationLevel.X) path.
    const isolation = sys ? resolveWorkflowIsolation(wf, ctx, sys) : wf.isolation;
    if (isolation) usesIsolation = true;
    methods.push(
      ...(isolation
        ? [`    @Transactional(isolation = Isolation.${javaIsolation(isolation)})`]
        : []),
      `    public void ${lowerFirst(wf.name)}(${wf.params.length > 0 ? `${reqType} request` : ""}) {`,
      // A workflow is a per-dispatch boundary: run it in a child execution frame
      // (fresh scope_id, parent_id ← the request's root scope) so its audit /
      // provenance rows record their call-structure position.
      `        try (var __frame = RequestContext.openChild()) {`,
      ...(usesUser && authed ? [`            var currentUser = currentUserAccessor.user();`] : []),
      // Workflow narrative — `workflow_started` at method entry; shared catalog
      // identity (field `workflow`) across every backend.
      `            CatalogLog.event("workflow_started", "info", "workflow", ${JSON.stringify(wf.name)});`,
      ...paramLets,
      ...bodyLines,
      ...saves,
      // `workflow_completed` on the success tail — a thrown guard / domain
      // exception short-circuits before reaching here.
      `            CatalogLog.event("workflow_completed", "info", "workflow", ${JSON.stringify(wf.name)});`,
      `        }`,
      `    }`,
      ``,
    );
    // Workflow `function` helpers — `private` methods on this shared
    // `<Ctx>Workflows` bean, scoped by workflow (two workflows share the class).
    // Pure over params (validator-guaranteed), so the body renders with the
    // ordinary workflow render context.  Both the expression form and the pure
    // block form (domain-services.md rev. 4) are supported.
    for (const fn of wf.functions ?? []) {
      const params = fn.params.map((p) => `${renderJavaType(p.type)} ${p.name}`).join(", ");
      const name = workflowFnCamel(wf.name, fn.name);
      const bodyLine =
        "expr" in fn.body
          ? `        return ${renderJavaExpr(fn.body.expr, renderCtxFor(ctx, wctx))};`
          : renderJavaStatements(fn.body.stmts, renderCtxFor(ctx, wctx));
      methods.push(
        `    private ${renderJavaType(fn.returnType)} ${name}(${params}) {`,
        bodyLine,
        `    }`,
        ``,
      );
    }
  }
  while (methods[methods.length - 1] === "") methods.pop();

  // `to<Vo>(...)` mappers for VO-typed params (parity with the per-aggregate
  // service).  Their `<Vo>Request` parameter type lives in an aggregate's
  // application package → import it the same way the Request DTO does.
  const voMappers = workflowVoMappers(ctx, cmdWorkflows, imports);
  while (voMappers[voMappers.length - 1] === "") voMappers.pop();
  const voReqNames = new Set<string>();
  for (const wf of cmdWorkflows) {
    referencedValueObjects(
      wf.params.map((p) => p.type),
      voReqNames,
    );
  }
  for (const vo of [...voReqNames].sort()) {
    const voPkg = wctx.voRequestPkgOf?.(vo);
    if (voPkg && voPkg !== wctx.pkg) imports.add(`${voPkg}.${vo}Request`);
  }

  const repoFields = [...repoAggs].sort();
  const anyUser = authed && cmdWorkflows.some(workflowUsesCurrentUser);
  const hasEmit = cmdWorkflows.some((wf) => {
    const walk = (ss: WorkflowStmtIR[]): boolean =>
      ss.some((s) => s.kind === "emit" || (s.kind === "for-each" && walk(s.body)));
    return walk(wf.statements);
  });
  const serviceName = `${ctx.name}Workflows`;
  // Injected reading-tier service beans (domain-services.md rev. 4): field name
  // `lowerFirst(service)` — the SAME var the `domain-service` call arm renders
  // an instance call against (`registration.isEmailAvailable(...)`).
  const readingServices = [...readingSvcs].sort();
  const ctorParams = [
    ...repoFields.map((a) => `${a}Repository ${repoField(a)}`),
    ...readingServices.map((s) => `${s} ${lowerFirst(s)}`),
    ...(anyUser ? [`CurrentUserAccessor currentUserAccessor`] : []),
  ].join(", ");
  out.set(`${serviceName}.java`, {
    category: "service",
    content: lines(
      `package ${wctx.pkg};`,
      ``,
      ...[...imports].sort().map((i) => `import ${i};`),
      imports.size > 0 ? `` : null,
      `import org.springframework.stereotype.Service;`,
      `import org.springframework.transaction.annotation.Transactional;`,
      usesIsolation ? `import org.springframework.transaction.annotation.Isolation;` : null,
      ``,
      ...repoFields.flatMap((a) => {
        const entityPkg = wctx.entityPkgOf(a);
        const repoPkg = wctx.repoPkgOf(a);
        return [
          entityPkg !== wctx.pkg ? `import ${entityPkg}.${a};` : null,
          repoPkg !== wctx.pkg ? `import ${repoPkg}.${a}Repository;` : null,
        ].filter((l): l is string => l !== null);
      }),
      anyUser ? `import ${wctx.basePkg}.auth.CurrentUserAccessor;` : null,
      anyUser ? `import ${wctx.basePkg}.auth.User;` : null,
      wctx.resourceClasses?.size && wctx.resourcesPkg && wctx.resourcesPkg !== wctx.pkg
        ? `import ${wctx.resourcesPkg}.*;`
        : null,
      hasEmit ? `import ${wctx.basePkg}.domain.events.*;` : null,
      // Reading-tier domain-service beans the workflow injects (rev. 4) — import
      // from the domain-services package when it differs from this one.
      ...(wctx.domainServicePkg && wctx.domainServicePkg !== wctx.pkg
        ? readingServices.map((s) => `import ${wctx.domainServicePkg}.${s};`)
        : []),
      // Static (pure / mutating) domain-service classes the workflow calls
      // (`Transfer.run(...)`) — imported by class so the static reference
      // resolves (domain-services.md rev. 4, the `mutating` tier).
      ...(wctx.domainServicePkg && wctx.domainServicePkg !== wctx.pkg
        ? [...staticSvcs].sort().map((s) => `import ${wctx.domainServicePkg}.${s};`)
        : []),
      // CatalogLog is always referenced now (workflow_started/completed on every
      // command-workflow method), not only when the body emits a domain event.
      `import ${wctx.basePkg}.config.CatalogLog;`,
      // RequestContext.openChild() opens the per-dispatch child frame on every
      // command-workflow method.
      `import ${wctx.basePkg}.config.RequestContext;`,
      `import ${wctx.basePkg}.domain.common.*;`,
      `import ${wctx.basePkg}.domain.enums.*;`,
      `import ${wctx.basePkg}.domain.ids.*;`,
      `import ${wctx.basePkg}.domain.valueobjects.*;`,
      ``,
      `@Service`,
      `@Transactional`,
      `public class ${serviceName} {`,
      ...repoFields.map((a) => `    private final ${a}Repository ${repoField(a)};`),
      ...readingServices.map((s) => `    private final ${s} ${lowerFirst(s)};`),
      anyUser ? `    private final CurrentUserAccessor currentUserAccessor;` : null,
      ``,
      `    public ${serviceName}(${ctorParams}) {`,
      ...repoFields.map((a) => `        this.${repoField(a)} = ${repoField(a)};`),
      ...readingServices.map((s) => `        this.${lowerFirst(s)} = ${lowerFirst(s)};`),
      anyUser ? `        this.currentUserAccessor = currentUserAccessor;` : null,
      `    }`,
      ``,
      ...methods,
      ...(voMappers.length > 0 ? [``, ...voMappers] : []),
      `}`,
      ``,
    ),
  });

  const routes = cmdWorkflows.flatMap((wf) => [
    `    @PostMapping("/${snake(wf.name)}")`,
    `    @ResponseStatus(HttpStatus.NO_CONTENT)`,
    wf.params.length > 0
      ? `    public void ${lowerFirst(wf.name)}(@RequestBody ${upperFirst(wf.name)}Request request) {`
      : `    public void ${lowerFirst(wf.name)}() {`,
    `        workflows.${lowerFirst(wf.name)}(${wf.params.length > 0 ? "request" : ""});`,
    `    }`,
    ``,
  ]);
  while (routes[routes.length - 1] === "") routes.pop();
  out.set(`${ctx.name}WorkflowsController.java`, {
    category: "controller",
    content: lines(
      `package ${wctx.basePkg}.api;`,
      ``,
      `import org.springframework.http.HttpStatus;`,
      `import org.springframework.web.bind.annotation.*;`,
      ``,
      `import ${wctx.pkg}.*;`,
      ``,
      `@RestController`,
      `@RequestMapping("${wctx.routePrefix ?? ""}/workflows")`,
      `public class ${ctx.name}WorkflowsController {`,
      `    private final ${serviceName} workflows;`,
      ``,
      `    public ${ctx.name}WorkflowsController(${serviceName} workflows) {`,
      `        this.workflows = workflows;`,
      `    }`,
      ``,
      ...routes,
      `}`,
      ``,
    ),
  });

  return out;
}
