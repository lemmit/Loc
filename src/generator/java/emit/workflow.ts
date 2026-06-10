import { forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedBoundedContextIR,
  ExprIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { collectJavaExprImports, renderJavaExpr } from "../render-expr.js";
import {
  collectWireImports,
  collectWireToDomainImports,
  wireJavaType,
  wireToDomain,
} from "./wire.js";

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
  /** category-resolved package lookups for cross-package imports. */
  entityPkgOf: (aggName: string) => string;
  repoPkgOf: (aggName: string) => string;
}

const renderCtx = { thisName: "this" };

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
function reposUsed(wf: WorkflowIR, ctx: EnrichedBoundedContextIR): string[] {
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

function renderWorkflowStmt(
  s: WorkflowStmtIR,
  ctx: EnrichedBoundedContextIR,
  imports: Set<string>,
): string[] {
  switch (s.kind) {
    case "precondition":
      collectJavaExprImports(s.expr, imports);
      return [
        `        if (!(${renderJavaExpr(s.expr, renderCtx)})) throw new DomainException(${JSON.stringify(`Precondition failed: ${s.source}`)});`,
      ];
    case "requires":
      collectJavaExprImports(s.expr, imports);
      return [
        `        if (!(${renderJavaExpr(s.expr, renderCtx)})) throw new ForbiddenException(${JSON.stringify(`Forbidden: ${s.source}`)});`,
      ];
    case "factory-let": {
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
      return [`        var ${s.name} = ${s.aggName}.create(${args.join(", ")});`];
    }
    case "repo-let": {
      for (const a of s.args) collectJavaExprImports(a, imports);
      const args = s.args.map((a) => renderJavaExpr(a, renderCtx)).join(", ");
      const method = s.method === "byId" ? "getById" : s.method;
      const wrap = s.method === "byId" ? `new ${s.aggName}Id(${args})` : args;
      return [`        var ${s.name} = ${repoField(s.aggName)}.${method}(${wrap});`];
    }
    case "expr-let":
      collectJavaExprImports(s.expr, imports);
      return [`        var ${s.name} = ${renderJavaExpr(s.expr, renderCtx)};`];
    case "op-call": {
      for (const a of s.args) collectJavaExprImports(a, imports);
      const rendered = s.args.map((a) => renderJavaExpr(a, renderCtx));
      // Aggregate ops that reference currentUser take it as a trailing
      // parameter (the entity emitter appends it) — thread it through.
      const targetOp = ctx.aggregates
        .find((a) => a.name === s.aggName)
        ?.operations.find((o) => o.name === s.op);
      if (targetOp && operationUsesCurrentUser(targetOp)) rendered.push("currentUser");
      return [`        ${s.target}.${s.op}(${rendered.join(", ")});`];
    }
    case "emit":
      // Workflow-level event emission has no aggregate stream to ride —
      // tracked with the dispatch-delivery proposal; surface loudly.
      throw new Error(
        "java workflows: workflow-level `emit` is not yet implemented on the java backend.",
      );
    case "repo-run": {
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
        `        var ${s.name} = ${repoField(s.aggName)}.run${upperFirst(s.retrievalName)}(${args.join(", ")});`,
      ];
    }
    case "for-each": {
      collectJavaExprImports(s.iterable, imports);
      const body = s.body.flatMap((b) => renderWorkflowStmt(b, ctx, imports));
      const saves = s.savesPerIteration.map(
        (save) => `        ${repoField(save.aggName)}.save(${save.name});`,
      );
      return [
        `        for (var ${s.var} : ${renderJavaExpr(s.iterable, renderCtx)}) {`,
        ...[...body, ...saves].map((l) => `    ${l}`),
        `        }`,
      ];
    }
    case "resource-call":
      throw new Error(
        "java workflows: resource-op calls in workflows are not yet implemented on the java backend.",
      );
  }
}

function repoField(aggName: string): string {
  return `${lowerFirst(plural(aggName))}Repository`;
}

export function renderJavaWorkflows(
  ctx: EnrichedBoundedContextIR,
  wctx: WorkflowCtx,
  authed: boolean,
): Map<string, { category: "service" | "controller" | "request-dto"; content: string }> | null {
  if (ctx.workflows.length === 0) return null;
  const out = new Map<
    string,
    { category: "service" | "controller" | "request-dto"; content: string }
  >();
  const imports = new Set<string>();
  const repoAggs = new Set<string>();
  const methods: string[] = [];

  for (const wf of ctx.workflows) {
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
    const bodyLines = wf.statements.flatMap((s) => renderWorkflowStmt(s, ctx, imports));
    const saves = wf.savesAtExit.map((s) => `        ${repoField(s.aggName)}.save(${s.name});`);
    methods.push(
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
  const anyUser = authed && ctx.workflows.some(workflowUsesCurrentUser);
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

  const routes = ctx.workflows.flatMap((wf) => [
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
      `@RequestMapping("/workflows")`,
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
