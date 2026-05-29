import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  TypeIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../../ir/types/loom-ir.js";
import { lowerFirst, snake, upperFirst } from "../../../util/naming.js";
import { camelId, opWorkflow } from "../../../ir/util/openapi-ids.js";
import { emitWireSchema, wireToDomainExpr, zodFor } from "./routes-builder.js";

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
  // Build the body first; imports are derived from what the body actually
  // references (keeps the generated import line free of dead names per the
  // generated-code Biome gate). Aggregate / repository / VO / enum imports
  // are all conditional on appearing in the body text.
  const aggsTouched = new Set<string>();
  for (const wf of ctx.workflows) {
    for (const st of wf.statements) {
      if (st.kind === "factory-let" || st.kind === "repo-let") {
        aggsTouched.add(st.aggName);
      }
    }
  }
  const externAggs = new Set<string>();
  for (const wf of ctx.workflows) {
    for (const st of wf.statements) {
      if (st.kind !== "op-call") continue;
      const op = lookupOp(ctx, st.aggName, st.op);
      if (op?.extern) externAggs.add(st.aggName);
    }
  }
  const usedVOs = ctx.valueObjects.map((v) => v.name);
  const usedEnums = ctx.enums.map((e) => e.name);
  const valueObjectImport = [...usedVOs, ...usedEnums];

  const body: string[] = [];

  // Wire-schema declarations for every VO / enum a workflow param
  // references.  Without these, `zodFor(p.type)` below emits a bare
  // `MoneySchema` reference that's not in scope — esbuild bundles
  // the file anyway (it doesn't fail on undefined identifiers) but
  // module evaluation throws `ReferenceError: MoneySchema is not
  // defined` at runtime Boot.  Each per-aggregate routes file emits
  // its own copies independently; the bundle ends up with renamed
  // duplicates (`MoneySchema`, `MoneySchema2`) which is fine —
  // they're scoped per emitted file.
  const workflowVOs = collectUsedValueObjects(ctx);
  const workflowEnumsUsed = collectUsedEnums(ctx);
  for (const e of workflowEnumsUsed) {
    const values = e.values.map((v) => `"${v}"`).join(", ");
    body.push(`const ${e.name}Schema = z.enum([${values}]).openapi("${e.name}");`);
  }
  for (const vo of workflowVOs) {
    body.push(
      ...emitWireSchema(
        `const ${vo.name}Schema`,
        `${vo.name}`,
        vo.fields.map((f) => ({ name: f.name, base: zodFor(f.type) })),
        vo.invariants,
        new Set(vo.fields.map((f) => f.name)),
      ),
    );
  }
  if (workflowVOs.length > 0 || workflowEnumsUsed.length > 0) {
    body.push("");
  }

  // Per-workflow request schema.
  for (const wf of ctx.workflows) {
    body.push(`const ${upperFirst(wf.name)}Request = z.object({`);
    for (const p of wf.params) {
      body.push(`  ${p.name}: ${zodFor(p.type)},`);
    }
    body.push(`}).openapi("${upperFirst(wf.name)}Request");`);
  }
  body.push("");

  body.push(`export function workflowsRoutes(`);
  body.push(`  db: NodePgDatabase<typeof schema>,`);
  body.push(`  events: DomainEventDispatcher,`);
  body.push(`): OpenAPIHono {`);
  body.push(`  const app = new OpenAPIHono();`);
  body.push("");

  for (const wf of ctx.workflows) {
    body.push(...emitWorkflowRoute(wf, ctx, aggsByName).map((l) => `  ${l}`));
    body.push("");
  }

  body.push(`  app.onError((err, c) => {`);
  body.push(
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
  );
  body.push(
    `    if (err instanceof ForbiddenError) return c.json({ error: err.message, trace_id }, 403);`,
  );
  body.push(
    `    if (err instanceof DomainError) return c.json({ error: err.message, trace_id }, 400);`,
  );
  body.push(
    `    if (err instanceof AggregateNotFoundError) return c.json({ error: err.message, trace_id }, 404);`,
  );
  body.push(
    `    if (err instanceof ExternHandlerError) { console.error(err); return c.json({ error: err.message, trace_id }, 500); }`,
  );
  body.push(`    console.error(err);`);
  body.push(`    return c.json({ error: "internal", trace_id }, 500);`);
  body.push(`  });`);
  body.push("");
  body.push(`  return app;`);
  body.push(`}`);
  // Now derive imports from what the body actually references.
  const rawBodyStr = body.join("\n");
  // Strip string contents before scanning so symbols mentioned only in
  // string literals (e.g. .openapi("Name")) don't count as references.
  const bodyStr = rawBodyStr
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const hasRef = (name: string): boolean => new RegExp(`\\b${name}\\b`).test(bodyStr);
  const errorClasses = [
    "DomainError",
    "AggregateNotFoundError",
    "ForbiddenError",
    "ExternHandlerError",
  ].filter(hasRef);
  const usesEvents = /\bEvents\.\w/.test(bodyStr);
  const usesIds = /\bIds\.\w/.test(bodyStr);
  const usesSchema = /\bschema\.\w/.test(bodyStr) || /\bNodePgDatabase\b/.test(bodyStr);
  const usesDb = /\bNodePgDatabase\b/.test(bodyStr);
  const usesDispatcher = /\bDomainEventDispatcher\b/.test(bodyStr);
  const aggsReferenced = [...aggsTouched].filter((n) =>
    new RegExp(`\\bnew\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyStr),
  );
  const reposReferenced = [...aggsTouched].filter((n) =>
    new RegExp(`\\bnew\\s+${n}Repository\\(`).test(bodyStr),
  );
  const externReferenced = [...externAggs].filter((n) =>
    new RegExp(`\\b${lowerFirst(n)}ExternHandlers\\b`).test(bodyStr),
  );
  const voEnumReferenced = valueObjectImport.filter(hasRef);

  const imports: string[] = [];
  imports.push("// Auto-generated.  Do not edit by hand.");
  imports.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  if (usesIds) imports.push(`import * as Ids from "../domain/ids";`);
  if (errorClasses.length > 0) {
    imports.push(`import { ${errorClasses.join(", ")} } from "../domain/errors";`);
  }
  if (usesDispatcher)
    imports.push(`import type { DomainEventDispatcher } from "../domain/events";`);
  if (usesEvents) imports.push(`import type * as Events from "../domain/events";`);
  if (usesDb) imports.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  if (usesSchema) imports.push(`import type * as schema from "../db/schema";`);
  for (const aggName of aggsReferenced) {
    imports.push(`import { ${aggName} } from "../domain/${lowerFirst(aggName)}";`);
  }
  for (const aggName of reposReferenced) {
    imports.push(
      `import { ${aggName}Repository } from "../db/repositories/${lowerFirst(aggName)}-repository";`,
    );
  }
  for (const aggName of externReferenced) {
    imports.push(
      `import { externHandlers as ${lowerFirst(aggName)}ExternHandlers } from "../domain/${lowerFirst(aggName)}-extern";`,
    );
  }
  if (voEnumReferenced.length > 0) {
    imports.push(`import { ${voEnumReferenced.join(", ")} } from "../domain/value-objects";`);
  }

  return [...imports, "", ...body].join("\n") + "\n";
}

function emitWorkflowRoute(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
): string[] {
  void aggsByName;
  const reqName = `${upperFirst(wf.name)}Request`;
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "post",`);
  out.push(`    path: "/${snake(wf.name)}",`);
  out.push(`    tags: ["workflows"],`);
  out.push(`    operationId: "${camelId(opWorkflow(wf.name))}",`);
  out.push(`    request: {`);
  out.push(`      body: { content: { "application/json": { schema: ${reqName} } } },`);
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
    const txOpts = wf.isolation ? `, { isolationLevel: "${pgIsolationLevel(wf.isolation)}" }` : ``;
    out.push(`    await db.transaction(async (tx) => {${""}`);
    for (const r of reposNeeded) {
      out.push(`      const ${lowerFirst(r.repoName)} = new ${r.aggName}Repository(tx, events);`);
    }
    for (const st of wf.statements) {
      out.push(...renderStmt(st, paramExprs, "      ", ctx));
    }
    for (const save of wf.savesAtExit) {
      out.push(`      await ${lowerFirst(save.repoName)}.save(${save.name});`);
    }
    out.push(`    }${txOpts});`);
  } else {
    for (const r of reposNeeded) {
      out.push(`    const ${lowerFirst(r.repoName)} = new ${r.aggName}Repository(db, events);`);
    }
    for (const st of wf.statements) {
      out.push(...renderStmt(st, paramExprs, "    ", ctx));
    }
    for (const save of wf.savesAtExit) {
      out.push(`    await ${lowerFirst(save.repoName)}.save(${save.name});`);
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
      const fields = st.fields.map((f) => `${f.name}: ${renderArg(f.value)}`).join(", ");
      return [`${indent}const ${st.name} = ${st.aggName}.create({ ${fields} });`];
    }
    case "repo-let": {
      const args = st.args.map(renderArg).join(", ");
      return [
        `${indent}const ${st.name} = await ${lowerFirst(st.repoName)}.${st.method}(${args});`,
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
        const handlerKey = `${lowerFirst(st.op)}${st.aggName}`;
        const checkName = `check${upperFirst(st.op)}`;
        const externAlias = `${lowerFirst(st.aggName)}ExternHandlers`;
        const reqLiteral =
          op.params.length === 0
            ? `{} as Record<string, never>`
            : `{ ${op.params.map((p, i) => `${p.name}: ${renderArg(st.args[i]!)}`).join(", ")} }`;
        return [
          `${indent}${st.target}.${checkName}(${args});`,
          `${indent}{`,
          `${indent}  const handler = ${externAlias}.${handlerKey};`,
          `${indent}  if (!handler) throw new Error("Missing extern handler for ${handlerKey}.  Register one before app.listen().");`,
          `${indent}  try {`,
          `${indent}    await handler(${st.target}, ${reqLiteral});`,
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
      return [`${indent}${st.target}.${lowerFirst(st.op)}(${args});`];
    }
    case "expr-let":
      return [`${indent}const ${st.name} = ${renderArg(st.expr)};`];
  }
}

function lookupOp(
  ctx: BoundedContextIR,
  aggName: string,
  opName: string,
): import("../../../ir/types/loom-ir.js").OperationIR | undefined {
  return ctx.aggregates.find((a) => a.name === aggName)?.operations.find((o) => o.name === opName);
}

function renderExprWithParams(e: ExprIR, paramExprs: Map<string, string>): string {
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
function pgIsolationLevel(level: import("../../../ir/types/loom-ir.js").IsolationLevel): string {
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

/** Value objects referenced by any workflow's parameters.  Same
 *  shape as `routes-builder.collectUsedValueObjects` but scoped to
 *  workflow params instead of aggregate-level surfaces.  Used to
 *  decide which `<Vo>Schema` declarations the workflows file needs
 *  to emit so its request schemas don't reference undefined names. */
function collectUsedValueObjects(ctx: BoundedContextIR) {
  const used = new Set<string>();
  const visit = (t: TypeIR): void => {
    if (t.kind === "valueobject") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const wf of ctx.workflows) {
    for (const p of wf.params) visit(p.type);
  }
  return ctx.valueObjects.filter((v) => used.has(v.name));
}

function collectUsedEnums(ctx: BoundedContextIR) {
  const used = new Set<string>();
  const visit = (t: TypeIR): void => {
    if (t.kind === "enum") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const wf of ctx.workflows) {
    for (const p of wf.params) visit(p.type);
  }
  return ctx.enums.filter((e) => used.has(e.name));
}
