import { forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedBoundedContextIR,
  ExprIR,
  IsolationLevel,
  SystemIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../../ir/types/loom-ir.js";
import {
  exprUsesCurrentUser,
  operationUsesCurrentUser,
  workflowEmitsCommandRoute,
} from "../../../ir/types/loom-ir.js";
import { resolveWorkflowIsolation } from "../../../ir/util/resolve-datasource.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { renderWorkflowStmts, type WorkflowStmtTarget } from "../../_workflow/stmt-target.js";
import { collectJavaExprImports, renderJavaExpr } from "../render-expr.js";
import {
  collectWireImports,
  collectWireToDomainImports,
  wireJavaType,
  wireToDomain,
} from "./wire.js";

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
  renderCtx: typeof baseRenderCtx & { resourceClasses?: Map<string, string> } = baseRenderCtx,
  /** When set, `emit` appends the constructed event to this list var (the
   *  saga dispatcher re-publishes it after saves) instead of logging it
   *  (the command-workflow facade behaviour).  Omitted ⇒ log, byte-identical. */
  emitSink?: string,
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
      return [`${indent}var ${s.name} = ${renderJavaExpr(s.expr, renderCtx)};`];
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
  };
}

export function repoField(aggName: string): string {
  return `${lowerFirst(plural(aggName))}Repository`;
}

function renderCtxFor(
  wctx: WorkflowCtx,
): typeof baseRenderCtx & { resourceClasses?: Map<string, string> } {
  return wctx.resourceClasses?.size
    ? { ...baseRenderCtx, resourceClasses: wctx.resourceClasses }
    : baseRenderCtx;
}

export function renderJavaWorkflows(
  ctx: EnrichedBoundedContextIR,
  wctx: WorkflowCtx,
  authed: boolean,
  sys?: SystemIR,
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
  const methods: string[] = [];

  for (const wf of cmdWorkflows) {
    const usesUser = workflowUsesCurrentUser(wf);
    for (const agg of reposUsed(wf, ctx)) repoAggs.add(agg);
    const reqType = `${upperFirst(wf.name)}Request`;
    // Request record over the workflow params (wire types in, parsed here).
    if (wf.params.length > 0) {
      const reqImports = new Set<string>();
      const components = wf.params.map((p) => {
        collectWireImports(p.type, reqImports);
        return `${wireJavaType(p.type, "Request")} ${p.name}`;
      });
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
      return `        var ${p.name} = ${wireToDomain(p.type, `request.${p.name}()`)};`;
    });
    const bodyLines = renderWorkflowStmts(
      wf.statements,
      javaWorkflowStmtTarget(ctx, imports, renderCtxFor(wctx)),
      "        ",
    );
    const saves = wf.savesAtExit.map((s) => `        ${repoField(s.aggName)}.save(${s.name});`);
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
      ...(usesUser && authed ? [`        var currentUser = currentUserAccessor.user();`] : []),
      ...paramLets,
      ...bodyLines,
      ...saves,
      `    }`,
      ``,
    );
  }
  while (methods[methods.length - 1] === "") methods.pop();

  const repoFields = [...repoAggs].sort();
  const anyUser = authed && cmdWorkflows.some(workflowUsesCurrentUser);
  const hasEmit = cmdWorkflows.some((wf) => {
    const walk = (ss: WorkflowStmtIR[]): boolean =>
      ss.some((s) => s.kind === "emit" || (s.kind === "for-each" && walk(s.body)));
    return walk(wf.statements);
  });
  const serviceName = `${ctx.name}Workflows`;
  const ctorParams = [
    ...repoFields.map((a) => `${a}Repository ${repoField(a)}`),
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
      hasEmit ? `import ${wctx.basePkg}.config.CatalogLog;` : null,
      `import ${wctx.basePkg}.domain.common.*;`,
      `import ${wctx.basePkg}.domain.enums.*;`,
      `import ${wctx.basePkg}.domain.ids.*;`,
      `import ${wctx.basePkg}.domain.valueobjects.*;`,
      ``,
      `@Service`,
      `@Transactional`,
      `public class ${serviceName} {`,
      ...repoFields.map((a) => `    private final ${a}Repository ${repoField(a)};`),
      anyUser ? `    private final CurrentUserAccessor currentUserAccessor;` : null,
      ``,
      `    public ${serviceName}(${ctorParams}) {`,
      ...repoFields.map((a) => `        this.${repoField(a)} = ${repoField(a)};`),
      anyUser ? `        this.currentUserAccessor = currentUserAccessor;` : null,
      `    }`,
      ``,
      ...methods,
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
