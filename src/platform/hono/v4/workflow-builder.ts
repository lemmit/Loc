import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import {
  type AggregateIR,
  type BoundedContextIR,
  type ExprIR,
  type TypeIR,
  type WorkflowIR,
  type WorkflowStmtIR,
  workflowIsGuarded,
  workflowUsesCurrentUser,
} from "../../../ir/types/loom-ir.js";
import { camelId, opWorkflow } from "../../../ir/util/openapi-ids.js";
import { lowerFirst, snake, upperFirst } from "../../../util/naming.js";
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
  /** resourceName → sourceType, so resource-op verb helpers can be
   *  imported from `../resources/<sourceType>` (Phase 4). */
  resourceSourceTypes: Map<string, string> = new Map(),
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
  // RFC 7807 ProblemDetails (with §3.2 `errors[]` extension for validation
  // failures) lives in `http/problem-details.ts` — imported at the top of
  // this file.  Same Zod schema instance referenced in every router so
  // OpenAPI dedupes the component definition.
  body.push("");

  body.push(`export function workflowsRoutes(`);
  body.push(`  db: NodePgDatabase<typeof schema>,`);
  body.push(`  events: DomainEventDispatcher,`);
  body.push(`): OpenAPIHono {`);
  // `newApp()` from `./problem-details` pre-wires the validation hook
  // that maps Zod parse failures to 422 ProblemDetails with `errors[]`.
  body.push(`  const app = newApp();`);
  body.push("");

  for (const wf of ctx.workflows) {
    body.push(...emitWorkflowRoute(wf, ctx, aggsByName).map((l) => `  ${l}`));
    body.push("");
  }

  body.push(`  app.onError((err, c) => {`);
  body.push(
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
  );
  // RFC 7807 responder — application/problem+json + x-request-id header.
  body.push(
    `    const problem = (status: 400 | 403 | 404 | 500, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
  );
  body.push(
    `    if (err instanceof ForbiddenError) return problem(403, "Forbidden", err.message);`,
  );
  body.push(`    if (err instanceof DomainError) return problem(400, "Bad Request", err.message);`);
  body.push(
    `    if (err instanceof AggregateNotFoundError) return problem(404, "Not Found", err.message);`,
  );
  body.push(
    `    if (err instanceof ExternHandlerError) { console.error(err); return problem(500, "Internal Server Error", err.message); }`,
  );
  body.push(`    console.error(err);`);
  body.push(`    return problem(500, "Internal Server Error", "internal");`);
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
  imports.push(`import { ProblemDetails, newApp } from "./problem-details";`);
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
  // Resource-op verb helpers (Phase 4): `<resource>$<verb>` exported by
  // the client module at `../resources/<sourceType>`.  Group the
  // imports by sourceType module; one named import per (resource, verb)
  // pair the body uses.
  const helperByModule = new Map<string, Set<string>>();
  for (const wf of ctx.workflows) {
    for (const op of resourceOpsIn(wf)) {
      const sourceType = resourceSourceTypes.get(op.resourceName);
      if (!sourceType) continue;
      const mod = `../resources/${sourceType}`;
      const set = helperByModule.get(mod) ?? new Set<string>();
      set.add(`${op.resourceName}$${op.verb}`);
      helperByModule.set(mod, set);
    }
  }
  for (const [mod, helpers] of helperByModule) {
    imports.push(`import { ${[...helpers].sort().join(", ")} } from "${mod}";`);
  }

  return [...imports, "", ...body].join("\n") + "\n";
}

/** Every resource-op call in a workflow's statements (bare or let-bound). */
function resourceOpsIn(wf: WorkflowIR): { resourceName: string; verb: string }[] {
  const out: { resourceName: string; verb: string }[] = [];
  for (const st of wf.statements) {
    const call =
      st.kind === "resource-call" ? st.call : st.kind === "expr-let" ? st.expr : undefined;
    if (call?.kind === "call" && call.callKind === "resource-op" && call.resourceOp) {
      out.push({ resourceName: call.resourceOp.resourceName, verb: call.resourceOp.verb });
    }
  }
  return out;
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
  // workflow → 400 (domain) + 422 (validation, ProblemDetails with §3.2
  // `errors[]` extension emitted by the shared defaultHook), per the
  // openapi-errors matrix.  Phase D of
  // docs/proposals/validation-error-extension.md.
  out.push(
    `      400: { description: "Bad Request", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  out.push(
    `      422: { description: "Unprocessable Entity", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  // A `requires` guard denies with 403 (ForbiddenError → onError) — declare
  // it so the published contract documents the authorization outcome.
  if (workflowIsGuarded(wf)) {
    out.push(
      `      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
  }
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
  // Bind the request-scoped current user when the workflow body
  // references `currentUser` (in a guard / precondition / expr).  The
  // renderer emits the bare token `currentUser`; without this binding
  // it's an unbound identifier and the handler throws a ReferenceError
  // (→ 500) before a `requires` guard can deny (→ 403).  Mirrors the
  // per-operation route binding in routes-builder and the .NET handler's
  // `var currentUser = _currentUser.User`.  `auth: required` on the
  // deployable is validated upstream, so the value is present.
  if (workflowUsesCurrentUser(wf)) {
    out.push(
      `    const currentUser = httpCtx.get("currentUser") as import("../auth/user-types").User;`,
    );
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
    case "repo-run": {
      // `Repo.run(<Retrieval>(args), page?)` → the generated
      // `run<Name>(args, page?)` repository method (retrieval.md / PR3-A).
      const args = st.retrievalArgs.map(renderArg);
      if (st.page) {
        const parts: string[] = [];
        if (st.page.offset) parts.push(`offset: ${renderArg(st.page.offset)}`);
        if (st.page.limit) parts.push(`limit: ${renderArg(st.page.limit)}`);
        args.push(`{ ${parts.join(", ")} }`);
      }
      return [
        `${indent}const ${st.name} = await ${lowerFirst(st.repoName)}.run${upperFirst(st.retrievalName)}(${args.join(", ")});`,
      ];
    }
    case "for-each": {
      // `for o in xs { … }` → a JS `for…of`; the body renders at +2
      // indent, then each iteration's dirty bindings save INSIDE the loop
      // (aggregate events drain through the same save).
      const inner = `${indent}  `;
      const bodyLines = st.body.flatMap((s) => renderStmt(s, paramExprs, inner, ctx));
      const saveLines = st.savesPerIteration.map(
        (sv) => `${inner}await ${lowerFirst(sv.repoName)}.save(${sv.name});`,
      );
      return [
        `${indent}for (const ${st.var} of ${renderArg(st.iterable)}) {`,
        ...bodyLines,
        ...saveLines,
        `${indent}}`,
      ];
    }
    case "resource-call":
      // Bare resource-op statement (`files.put(k, v)`).  `renderArg`
      // renders the call as `(await files$put(...))`; emit it as a
      // statement (Phase 4).
      return [`${indent}${renderArg(st.call)};`];
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
  const walk = (stmts: WorkflowStmtIR[]): void => {
    for (const st of stmts) {
      if (st.kind === "repo-let" || st.kind === "repo-run") seen.set(st.repoName, st.aggName);
      else if (st.kind === "for-each") {
        for (const sv of st.savesPerIteration) seen.set(sv.repoName, sv.aggName);
        walk(st.body);
      }
    }
  };
  walk(wf.statements);
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
