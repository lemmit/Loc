import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../ir/loom-ir.js";
import { camel, snake } from "../../util/naming.js";
import { renderTsExpr } from "./render-expr.js";
import { wireToDomainExpr, zodFor } from "./routes-builder.js";

// ---------------------------------------------------------------------------
// Hono workflow emission.
//
// Per context with at least one workflow, emits `http/workflows.ts`:
//   - one `app.openapi(createRoute({...}), async (c) => { ... })`
//     per workflow, mounted at POST `/<snake_workflow>` (the /workflows
//     prefix is added by `http/index.ts:createApp` via `app.route`).
//   - the handler:
//       * validates body via the per-workflow Zod request schema
//       * runs preconditions → DomainError
//       * loads / creates aggregates, invokes ops in declaration order
//       * collects workflow events into a local list
//       * for non-transactional: instantiates repos on `db`, awaits
//         each save in declaration order, then dispatches events
//       * for transactional: wraps body+saves in
//         `db.transaction(async (tx) => {...})`, dispatches events
//         after the callback returns successfully (so rollbacks
//         discard them)
//
// Repositories are constructed inline (`new XRepository(db, events)`)
// rather than passed in — keeps the route function self-contained
// and matches how aggregate-routes wire their own repos.
// ---------------------------------------------------------------------------

export function buildWorkflowsFile(
  ctx: BoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
): string {
  if (ctx.workflows.length === 0) return "";
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  lines.push(`import * as Ids from "../domain/ids.js";`);
  lines.push(
    `import { DomainError, AggregateNotFoundError, ForbiddenError, ExternHandlerError } from "../domain/errors.js";`,
  );
  lines.push(
    `import { type DomainEventDispatcher } from "../domain/events.js";`,
  );
  lines.push(`import type * as Events from "../domain/events.js";`);
  lines.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  lines.push(`import type * as schema from "../db/schema.js";`);
  // Aggregate + repo imports — every aggregate the workflows touch.
  const aggsTouched = new Set<string>();
  for (const wf of ctx.workflows) {
    for (const st of wf.statements) {
      if (st.kind === "factory-let" || st.kind === "repo-let") {
        aggsTouched.add(st.aggName);
      }
    }
  }
  for (const aggName of aggsTouched) {
    lines.push(
      `import { ${aggName} } from "../domain/${camel(aggName)}.js";`,
    );
    lines.push(
      `import { ${aggName}Repository } from "../db/repositories/${camel(aggName)}-repository.js";`,
    );
  }
  // Per-aggregate extern handler registry import — only when at least
  // one workflow op-call targets an extern op on this aggregate.
  const externAggs = new Set<string>();
  for (const wf of ctx.workflows) {
    for (const st of wf.statements) {
      if (st.kind !== "op-call") continue;
      const op = lookupOp(ctx, st.aggName, st.op);
      if (op?.extern) externAggs.add(st.aggName);
    }
  }
  for (const aggName of externAggs) {
    lines.push(
      `import { externHandlers as ${camel(aggName)}ExternHandlers } from "../domain/${camel(aggName)}-extern.js";`,
    );
  }
  // Value object + enum imports.  Enums are runtime-imported so
  // expressions like `OrderStatus.Draft` inside factory-let payloads
  // resolve; VOs need their constructor in scope for VO literals.
  const usedVOs = ctx.valueObjects.map((v) => v.name);
  const usedEnums = ctx.enums.map((e) => e.name);
  const valueObjectImport = [...usedVOs, ...usedEnums];
  if (valueObjectImport.length > 0) {
    lines.push(
      `import { ${valueObjectImport.join(", ")} } from "../domain/value-objects.js";`,
    );
  }
  lines.push("");

  // Per-workflow request schema.
  for (const wf of ctx.workflows) {
    lines.push(
      `const ${capitalize(wf.name)}Request = z.object({`,
    );
    for (const p of wf.params) {
      lines.push(`  ${p.name}: ${zodFor(p.type)},`);
    }
    lines.push(`}).openapi("${capitalize(wf.name)}Request");`);
  }
  lines.push("");

  lines.push(
    `export function workflowsRoutes(`,
  );
  lines.push(`  db: NodePgDatabase<typeof schema>,`);
  lines.push(`  events: DomainEventDispatcher,`);
  lines.push(`): OpenAPIHono {`);
  lines.push(`  const app = new OpenAPIHono();`);
  lines.push("");

  for (const wf of ctx.workflows) {
    lines.push(...emitWorkflowRoute(wf, ctx, aggsByName).map((l) => `  ${l}`));
    lines.push("");
  }

  lines.push(`  app.onError((err, c) => {`);
  lines.push(
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
  );
  lines.push(
    `    if (err instanceof ForbiddenError) return c.json({ error: err.message, trace_id }, 403);`,
  );
  lines.push(
    `    if (err instanceof DomainError) return c.json({ error: err.message, trace_id }, 400);`,
  );
  lines.push(
    `    if (err instanceof AggregateNotFoundError) return c.json({ error: err.message, trace_id }, 404);`,
  );
  lines.push(
    `    if (err instanceof ExternHandlerError) { console.error(err); return c.json({ error: err.message, trace_id }, 500); }`,
  );
  lines.push(`    console.error(err);`);
  lines.push(`    return c.json({ error: "internal", trace_id }, 500);`);
  lines.push(`  });`);
  lines.push("");
  lines.push(`  return app;`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

function emitWorkflowRoute(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
): string[] {
  void aggsByName;
  const reqName = `${capitalize(wf.name)}Request`;
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "post",`);
  out.push(`    path: "/${snake(wf.name)}",`);
  out.push(`    tags: ["workflows"],`);
  out.push(`    operationId: "${camel(wf.name)}Workflow",`);
  out.push(`    request: {`);
  out.push(
    `      body: { content: { "application/json": { schema: ${reqName} } } },`,
  );
  out.push(`    },`);
  out.push(`    responses: {`);
  out.push(`      204: { description: "No content" },`);
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  out.push(`    const body = httpCtx.req.valid("json");`);
  // Param-name → domain expression; precomputed so factory/repo/op-call
  // and emit references all resolve to the wire-converted body field.
  const paramExprs = new Map<string, string>();
  for (const p of wf.params) {
    paramExprs.set(p.name, wireToDomainExpr(`body.${p.name}`, p.type, ctx));
  }
  // Map param names to local consts at the top of the route handler.
  // Avoids re-computing brand conversions on every reference.
  for (const p of wf.params) {
    out.push(`    const ${p.name} = ${paramExprs.get(p.name)};`);
  }
  // Repos used by this workflow.  Construct on the request `db` for
  // non-transactional; deferred construction inside the tx callback
  // for transactional.
  const reposNeeded = collectReposForWorkflow(wf);
  const hasEmit = wf.statements.some((st) => st.kind === "emit");
  if (hasEmit) {
    out.push(`    const workflowEvents: Events.DomainEvent[] = [];`);
  }
  if (wf.transactional) {
    const txOpts = wf.isolation
      ? `, { isolationLevel: "${pgIsolationLevel(wf.isolation)}" }`
      : ``;
    out.push(`    await db.transaction(async (tx) => {${""}`);
    for (const r of reposNeeded) {
      out.push(`      const ${camel(r.repoName)} = new ${r.aggName}Repository(tx, events);`);
    }
    for (const st of wf.statements) {
      out.push(...renderStmt(st, paramExprs, "      ", ctx));
    }
    for (const save of wf.savesAtExit) {
      out.push(`      await ${camel(save.repoName)}.save(${save.name});`);
    }
    out.push(`    }${txOpts});`);
  } else {
    for (const r of reposNeeded) {
      out.push(`    const ${camel(r.repoName)} = new ${r.aggName}Repository(db, events);`);
    }
    for (const st of wf.statements) {
      out.push(...renderStmt(st, paramExprs, "    ", ctx));
    }
    for (const save of wf.savesAtExit) {
      out.push(`    await ${camel(save.repoName)}.save(${save.name});`);
    }
  }
  if (hasEmit) {
    out.push(`    for (const ev of workflowEvents) await events.dispatch(ev);`);
  }
  out.push(`    return httpCtx.body(null, 204);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

function renderStmt(
  st: WorkflowStmtIR,
  paramExprs: Map<string, string>,
  indent: string,
  ctx: BoundedContextIR,
): string[] {
  const renderArg = (e: ExprIR): string => renderExprWithParams(e, paramExprs);
  switch (st.kind) {
    case "precondition":
      return [
        `${indent}if (!(${renderArg(st.expr)})) throw new DomainError(${JSON.stringify(`Precondition failed: ${st.source}`)});`,
      ];
    case "requires":
      return [
        `${indent}if (!(${renderArg(st.expr)})) throw new ForbiddenError(${JSON.stringify(`Forbidden: ${st.source}`)});`,
      ];
    case "emit": {
      const fieldList = [
        `type: "${st.eventName}"`,
        ...st.fields.map((f) => `${f.name}: ${renderArg(f.value)}`),
      ].join(", ");
      return [`${indent}workflowEvents.push({ ${fieldList} });`];
    }
    case "factory-let": {
      const fields = st.fields
        .map((f) => `${f.name}: ${renderArg(f.value)}`)
        .join(", ");
      return [`${indent}const ${st.name} = ${st.aggName}.create({ ${fields} });`];
    }
    case "repo-let": {
      const args = st.args.map(renderArg).join(", ");
      return [
        `${indent}const ${st.name} = await ${camel(st.repoName)}.${st.method}(${args});`,
      ];
    }
    case "op-call": {
      const args = st.args.map(renderArg).join(", ");
      const op = lookupOp(ctx, st.aggName, st.op);
      if (op?.extern) {
        // Workflows can call extern ops — emit the same dance the
        // auto Hono route does, but with the request constructed
        // from the workflow's domain args (parameterless externs
        // get a `Record<string, never>`; parameterized externs get
        // a per-param object literal that matches the user
        // handler's typed request shape).  The handler call is
        // wrapped so any non-domain throw becomes an
        // ExternHandlerError; domain errors raised by the user
        // handler bubble unchanged.
        const handlerKey = `${camel(st.op)}${st.aggName}`;
        const checkName = `check${cap(st.op)}`;
        const externAlias = `${camel(st.aggName)}ExternHandlers`;
        const reqLiteral =
          op.params.length === 0
            ? `{} as Record<string, never>`
            : `{ ${op.params.map((p, i) => `${p.name}: ${renderArg(st.args[i]!)}`).join(", ")} }`;
        return [
          `${indent}${st.target}.${checkName}(${args});`,
          `${indent}{`,
          `${indent}  const __handler = ${externAlias}.${handlerKey};`,
          `${indent}  if (!__handler) throw new Error("Missing extern handler for ${handlerKey}.  Register one before app.listen().");`,
          `${indent}  try {`,
          `${indent}    await __handler(${st.target}, ${reqLiteral});`,
          `${indent}  } catch (err) {`,
          `${indent}    if (err instanceof DomainError) throw err;`,
          `${indent}    if (err instanceof ForbiddenError) throw err;`,
          `${indent}    if (err instanceof AggregateNotFoundError) throw err;`,
          `${indent}    throw new ExternHandlerError("${st.op}", "${st.aggName}", err);`,
          `${indent}  }`,
          `${indent}}`,
          `${indent}${st.target}.assertInvariants();`,
        ];
      }
      return [`${indent}${st.target}.${camel(st.op)}(${args});`];
    }
    case "expr-let":
      return [`${indent}const ${st.name} = ${renderArg(st.expr)};`];
  }
}

function lookupOp(
  ctx: BoundedContextIR,
  aggName: string,
  opName: string,
): import("../../ir/loom-ir.js").OperationIR | undefined {
  return ctx.aggregates
    .find((a) => a.name === aggName)
    ?.operations.find((o) => o.name === opName);
}

const cap = (s: string): string =>
  s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);

function renderExprWithParams(
  e: ExprIR,
  paramExprs: Map<string, string>,
): string {
  // Workflow params are local consts now; ExprIR `ref` nodes for them
  // already carry refKind="param" and the bare name.  renderTsExpr
  // emits bare names for params, which match the local consts we
  // just declared.  So a plain renderTsExpr is correct.
  void paramExprs;
  return renderTsExpr(e);
}

function collectReposForWorkflow(wf: WorkflowIR): {
  repoName: string;
  aggName: string;
}[] {
  const seen = new Map<string, string>();
  for (const st of wf.statements) {
    if (st.kind === "repo-let") seen.set(st.repoName, st.aggName);
  }
  for (const save of wf.savesAtExit) seen.set(save.repoName, save.aggName);
  return [...seen.entries()].map(([repoName, aggName]) => ({
    repoName,
    aggName,
  }));
}

/** Drizzle-postgres `isolationLevel` enum values are space-cased
 *  lowercase strings.  Map DSL camelCase tokens onto them. */
function pgIsolationLevel(
  level: import("../../ir/loom-ir.js").IsolationLevel,
): string {
  switch (level) {
    case "readUncommitted":
      return "read uncommitted";
    case "readCommitted":
      return "read committed";
    case "repeatableRead":
      return "repeatable read";
    case "serializable":
      return "serializable";
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
