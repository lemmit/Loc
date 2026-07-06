import { renderHonoStoreLogCall } from "../../../generator/_obs/render-hono.js";
import { statementSubRegions } from "../../../generator/_trace/sourcemap.js";
import {
  renderWorkflowStmtChunks,
  type WorkflowStmtTarget,
} from "../../../generator/_workflow/stmt-target.js";
import type { OpFragment } from "../../../generator/typescript/emit/aggregate.js";
import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import {
  type AggregateIR,
  type BoundedContextIR,
  type EnrichedBoundedContextIR,
  type ExprIR,
  operationUsesCurrentUser,
  type TypeIR,
  type WorkflowIR,
  type WorkflowStmtIR,
  workflowIsGuarded,
  workflowUsesCurrentUser,
} from "../../../ir/types/loom-ir.js";
import { durableEventTypes } from "../../../ir/util/channels.js";
import {
  type ReadPort,
  readPortsForOperation,
} from "../../../ir/util/domain-service-read-ports.js";
import {
  camelId,
  opOperation,
  opWorkflow,
  opWorkflowInstanceById,
  opWorkflowInstances,
} from "../../../ir/util/openapi-ids.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import { collectReachableTypes } from "../../../ir/util/reachable-types.js";
import { emitsCommandRoute } from "../../../ir/util/workflow-command-route.js";
import { workflowCorrIdValueType } from "../../../ir/util/workflow-instances.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { emitWireSchema, wireToDomainExpr, zodFor, zodForResponse } from "./routes-builder.js";
import {
  emitWorkflowFoldHelpers,
  emitWorkflowStreamSerializers,
  esHelperNames,
  eventSourcedWorkflows,
} from "./workflow-eventsourced-builder.js";

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
  ctx: EnrichedBoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
  /** resourceName → sourceType, so resource-op verb helpers can be
   *  imported from `../resources/<sourceType>` (Phase 4). */
  resourceSourceTypes: Map<string, string> = new Map(),
  /** Source-map Milestone 11 (workflow-body statement regions) — allocated by
   *  the caller (`src/platform/hono/v4/emit.ts`) ONLY when a recorder is
   *  present, so a no-`--sourcemap` run pays no per-statement bookkeeping
   *  cost.  `http/workflows.ts` pools every workflow's command route AND its
   *  reactor/starter handlers, so it never gets a `sourcemap.file(...)`
   *  whole-file region (mirrors the Elixir pooled-file precedent) — these
   *  fragment-only statement regions are the only mapping this file gets. */
  opFragments?: OpFragment[],
): string {
  if (ctx.workflows.length === 0) return "";
  // Build the body first; imports are derived from what the body actually
  // references (keeps the generated import line free of dead names per the
  // generated-code Biome gate). Aggregate / repository / VO / enum imports
  // are all conditional on appearing in the body text.
  // Import candidates are gathered from the facade body PLUS the reactor /
  // event-create handler bodies (which this file now also emits).  The final
  // import list is still the intersection with the emitted text below, so a
  // candidate that isn't actually referenced is dropped — keeping a
  // subscription-free project byte-identical.
  const externAggs = new Set<string>();
  for (const wf of ctx.workflows) {
    for (const st of allHandlerStmts(wf)) {
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

  // Per-workflow request schema — only for workflows with an HTTP command
  // surface.  An event-triggered-only workflow is invoked by the dispatcher,
  // not POSTed, and its facade param is an event type (no wire/zod form), so
  // it gets neither a request schema nor a route.
  for (const wf of ctx.workflows) {
    if (!emitsCommandRoute(wf)) continue;
    body.push(`const ${upperFirst(wf.name)}Request = z.object({`);
    for (const p of wf.params) {
      body.push(`  ${p.name}: ${zodFor(p.type)},`);
    }
    body.push(`}).openapi("${upperFirst(wf.name)}Request");`);
  }
  // Per-workflow instance response DTOs (workflow-instance-visibility.md):
  // the persisted correlation-state row's wire shape + its list carrier.
  // Emitted for every correlation-bearing workflow (`instanceWireShape` set
  // by enrichment) — independent of whether the workflow has a command route.
  for (const wf of ctx.workflows) {
    if (!wf.instanceWireShape) continue;
    body.push(...emitInstanceResponseSchemas(wf));
  }
  // RFC 7807 ProblemDetails (with §3.2 `errors[]` extension for validation
  // failures) lives in `http/problem-details.ts` — imported at the top of
  // this file.  Same Zod schema instance referenced in every router so
  // OpenAPI dedupes the component definition.
  body.push("");

  // Event-sourced workflows whose instance-LIST/byId read routes fold the
  // `<wf>_events` stream need the per-workflow fold machinery (fold / apply /
  // load / loadAll) + the shared stream (de)serialisers in scope.  When such a
  // workflow is ALSO subscribed, `emitSubscriptionHandlers` would emit them; to
  // avoid duplicate declarations we emit them once here (before the router) and
  // pass the done-set down so the subscription block skips them.  `helperDone`
  // tracks per-workflow fold-helper emission; serialisers are emitted once.
  const esInstanceWorkflows = ctx.workflows.filter((w) => w.eventSourced && !!w.instanceWireShape);
  const helperDone = new Set<string>();
  if (esInstanceWorkflows.length > 0) {
    body.push(...emitWorkflowStreamSerializers(ctx));
    body.push("");
    for (const wf of esInstanceWorkflows) {
      body.push(...emitWorkflowFoldHelpers(wf, ctx));
      body.push("");
      helperDone.add(wf.name);
    }
  }

  // A context whose only workflows are event-sourced sagas (invoked via the
  // dispatcher, never an HTTP route) emits an empty `workflowsRoutes` router
  // when none expose instance reads.  Underscore the then-unused `db` /
  // `events` params so the generated-code lint stays clean; a context with any
  // route keeps them (and stays byte-identical).
  const hasHttpRoutes =
    ctx.workflows.some(emitsCommandRoute) || ctx.workflows.some((w) => !!w.instanceWireShape);
  body.push(`export function workflowsRoutes(`);
  body.push(`  ${hasHttpRoutes ? "db" : "_db"}: NodePgDatabase<typeof schema>,`);
  body.push(`  ${hasHttpRoutes ? "events" : "_events"}: DomainEventDispatcher,`);
  body.push(`): OpenAPIHono {`);
  // `newApp()` from `./problem-details` pre-wires the validation hook
  // that maps Zod parse failures to 422 ProblemDetails with `errors[]`.
  body.push(`  const app = newApp();`);
  body.push("");

  for (const wf of ctx.workflows) {
    if (!emitsCommandRoute(wf)) continue;
    body.push(...emitWorkflowRoute(wf, ctx, aggsByName, opFragments).map((l) => `  ${l}`));
    body.push("");
  }

  // Read-only instance routes (workflow-instance-visibility.md): GET the
  // running instances + GET one by correlation id, over the saga-state table.
  // Driven off `instanceWireShape` independently of the command route — an
  // event-triggered-only saga still has instances to observe.
  for (const wf of ctx.workflows) {
    if (!wf.instanceWireShape) continue;
    body.push(...emitInstanceRoutes(wf).map((l) => `  ${l}`));
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

  // In-process event dispatch (channels.md): for every channel-routed
  // `on(e: Event)` reactor / event-triggered `create(e: Event) by` starter
  // (`ctx.eventSubscriptions`, the enrich join), emit a handler function plus
  // a `createInProcessDispatcher(db)` factory that routes each emitted
  // `DomainEvent` to its subscribers.  Absent any subscription this block is
  // skipped entirely, so a channel-less project's `http/workflows.ts` stays
  // byte-identical (and `createApp` keeps the Noop dispatcher).
  if (ctx.eventSubscriptions.length > 0) {
    body.push("");
    body.push(
      ...emitSubscriptionHandlers(ctx, helperDone, esInstanceWorkflows.length > 0, opFragments),
    );
  }
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
  // Candidate aggregate / repository imports: EVERY aggregate in the
  // (possibly multi-context) merged deployable, filtered to what the body
  // actually references.  `aggsTouched` only captures factory-let /
  // repo-let statements, so a retrieval-driven repo from another hosted
  // context (`new StockItemRepository(...)` for a `runItemsToRecount`
  // spec) was never imported — `tsc` then fails with "Cannot find name
  // 'StockItemRepository'".  Scanning the full aggregate set keeps the
  // import line correct across context boundaries; the body-text filter
  // still drops anything not referenced so the file stays dead-import-free.
  const allAggNames = ctx.aggregates.map((a) => a.name);
  const aggsReferenced = allAggNames.filter((n) =>
    new RegExp(`\\bnew\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyStr),
  );
  const reposReferenced = allAggNames.filter((n) =>
    new RegExp(`\\bnew\\s+${n}Repository\\(`).test(bodyStr),
  );
  const externReferenced = [...externAggs].filter((n) =>
    new RegExp(`\\b${lowerFirst(n)}ExternHandlers\\b`).test(bodyStr),
  );
  const voEnumReferenced = valueObjectImport.filter(hasRef);

  const imports: string[] = [];
  imports.push("// Auto-generated.  Do not edit by hand.");
  // `OpenAPIHono` (the router return type) and `newApp` (the validation-hooked
  // factory) are always referenced; `createRoute` / `z` / `ProblemDetails` only
  // when the router actually emits HTTP routes (an event-sourced-only context
  // emits none).  Conditional on body reference so a routed context stays
  // byte-identical while an ES-only one drops the now-unused names.
  const honoNamed = [
    "OpenAPIHono",
    /(?<!\.)\bcreateRoute\(/.test(bodyStr) ? "createRoute" : null,
    /(?<!\.)\bz\./.test(bodyStr) ? "z" : null,
  ].filter((n): n is string => n !== null);
  imports.push(`import { ${honoNamed.join(", ")} } from "@hono/zod-openapi";`);
  const problemNamed = [
    /(?<!\.)\bProblemDetails\b/.test(bodyStr) ? "ProblemDetails" : null,
    "newApp",
  ].filter((n): n is string => n !== null);
  imports.push(`import { ${problemNamed.join(", ")} } from "./problem-details";`);
  if (usesIds) imports.push(`import * as Ids from "../domain/ids";`);
  if (errorClasses.length > 0) {
    imports.push(`import { ${errorClasses.join(", ")} } from "../domain/errors";`);
  }
  if (usesDispatcher)
    imports.push(`import type { DomainEventDispatcher } from "../domain/events";`);
  if (usesEvents) imports.push(`import type * as Events from "../domain/events";`);
  // An event-sourced workflow's folded state may carry a money field, whose
  // typed default (`new Decimal(0)`) and arithmetic need decimal.js.
  if (/(?<!\.)\bDecimal\b/.test(bodyStr)) imports.push(`import Decimal from "decimal.js";`);
  if (usesDb) imports.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  // The persisted-workflow load helper filters by the correlation column.
  const drizzleOps = ["and", "asc", "eq", "isNull", "lt"].filter((op) =>
    new RegExp(`(?<!\\.)\\b${op}\\(`).test(bodyStr),
  );
  if (drizzleOps.length > 0)
    imports.push(`import { ${drizzleOps.join(", ")} } from "drizzle-orm";`);
  // The outbox relay logs event_dead_lettered on the module-scope logger.
  if (/\bbaseLogger\./.test(bodyStr)) imports.push(`import { baseLogger } from "../obs/log";`);
  // ALS accessors used by the reactor drop+log path (`requestLog`), the
  // workflow provenance flush (`requestContext`), and the per-workflow child
  // frame that gives those rows their call-structure scope (`runInChildContext`).
  const alsImports = [
    /(?<!\.)\brequestContext\(/.test(bodyStr) ? "requestContext" : null,
    /(?<!\.)\brequestLog\(/.test(bodyStr) ? "requestLog" : null,
    /(?<!\.)\brunInChildContext\(/.test(bodyStr) ? "runInChildContext" : null,
  ].filter((x): x is string => x !== null);
  if (alsImports.length > 0) imports.push(`import { ${alsImports.join(", ")} } from "../obs/als";`);
  // The provenance flush stamps a fresh per-row trace id.
  if (/(?<!\.)\brandomUUID\(/.test(bodyStr))
    imports.push(`import { randomUUID } from "node:crypto";`);
  // `schema` is used as a runtime value (`db.select().from(schema.x)`) only by
  // the persisted-workflow helpers; otherwise it's `typeof schema` (a type).
  // `import * as schema` still satisfies `typeof schema`, so the value form is
  // a superset — but stick to `import type` when there are no value uses to
  // keep subscription-free files byte-identical.
  if (usesSchema) {
    const schemaAsValue = /(?:db|tx)\.(?:select|insert|update)\(/.test(bodyStr);
    imports.push(
      schemaAsValue
        ? `import * as schema from "../db/schema";`
        : `import type * as schema from "../db/schema";`,
    );
  }
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
  // Domain-service namespaces a workflow body calls (`Registration.…`,
  // `Pricing.…`) — imported from the generated `domain/services.ts`.  Filtered
  // to those actually referenced in the body text (a pure-service call already
  // rendered as `Service.op(…)` will match; a reading-service call renders
  // `(await Service.op(handle, …))` which also matches).
  const servicesReferenced = ctx.domainServices
    .map((s) => s.name)
    .filter((n) => new RegExp(`\\b${n}\\.\\w`).test(bodyStr));
  if (servicesReferenced.length > 0) {
    imports.push(`import { ${servicesReferenced.sort().join(", ")} } from "../domain/services";`);
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

/** Drain each provenanced aggregate's accumulated lineage into
 *  `provenance_records`, stamping the carrier ids.  Shared by the workflow
 *  command route and the event reactor — both invoke ops inline, so the
 *  per-operation route's flush would otherwise be missed and the writes lost.
 *  The caller wraps this in a child frame (`runInChildContext`) so each row
 *  records its call-structure scope.  Empty when no saved aggregate has a
 *  provenance write-site (gated identically to the aggregate's `drainProv`). */
function renderProvFlush(
  provSaves: { name: string }[],
  indent: string,
  dbHandle: string,
): string[] {
  if (provSaves.length === 0) return [];
  const ls: string[] = [`${indent}const reqCtx = requestContext();`];
  for (const save of provSaves) {
    ls.push(`${indent}for (const t of ${save.name}.drainProv()) {`);
    ls.push(`${indent}  await ${dbHandle}.insert(schema.provenanceRecords).values({`);
    ls.push(`${indent}    traceId: randomUUID(),`);
    ls.push(`${indent}    snapshotId: t.snapshotId,`);
    ls.push(`${indent}    targetType: t.target.type,`);
    ls.push(`${indent}    field: t.target.field,`);
    ls.push(`${indent}    inputs: t.inputs,`);
    ls.push(`${indent}    computedValue: t.computedValue,`);
    ls.push(`${indent}    at: new Date(),`);
    ls.push(`${indent}    correlationId: reqCtx?.correlationId ?? null,`);
    ls.push(`${indent}    scopeId: reqCtx?.scopeId ?? null,`);
    ls.push(`${indent}    actorId: reqCtx?.actorId ?? null,`);
    ls.push(`${indent}    parentId: reqCtx?.parentId ?? null,`);
    ls.push(`${indent}  });`);
    ls.push(`${indent}}`);
  }
  return ls;
}

/** True when any inline op-call in `sts` targets an `audited` (non-extern)
 *  operation — the trigger for staging an audit_records row (and opening a
 *  child frame).  Shared by the workflow command route and the event reactor,
 *  both of which invoke ops inline (bypassing the per-operation route's audit). */
function hasAuditedOpCall(ctx: BoundedContextIR, sts: WorkflowStmtIR[]): boolean {
  return sts.some((s) => {
    if (s.kind === "op-call") {
      const o = lookupOp(ctx, s.aggName, s.op);
      return !!o && o.audited && !o.extern;
    }
    if (s.kind === "for-each") return hasAuditedOpCall(ctx, s.body);
    return false;
  });
}

function emitWorkflowRoute(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
  /** Source-map Milestone 11 (workflow-body statement regions) — when passed,
   *  pushes ONE `OpFragment` covering this route's workflow-body chunk list.
   *  `http/workflows.ts` is a POOLED file (every workflow + reactor shares
   *  it), so it never gets a whole-file region — only these fragment-only
   *  statement regions (mirroring the Elixir pooled-file precedent: pooled
   *  files stay unmapped at the whole-file grain, but a fragment anchors by
   *  exact text regardless of what else shares the file). */
  opFragments?: OpFragment[],
): string[] {
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
  // Workflow narrative — `workflow_started` at the command-route entry; the
  // shared catalog identity (field `workflow`) means a dashboard pivots on one
  // event name across every backend.  ALS-backed (`renderHonoStoreLogCall`)
  // since the handler param is `httpCtx`, not the `c` the per-request renderer
  // hardcodes; the request-bound child logger still resolves via ALS.
  out.push(`    ${renderHonoStoreLogCall("workflowStarted", `workflow: "${wf.name}"`)}`);
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
  // The binding is also required when the workflow calls a currentUser-gated
  // operation — the op's method signature takes a trailing `currentUser`
  // argument that the op-call renderer threads through (see the `op-call`
  // case), so `currentUser` must be in scope even if the workflow body
  // itself never names it.
  const callsUserGatedOp = (sts: WorkflowStmtIR[]): boolean =>
    sts.some((s) => {
      if (s.kind === "op-call") {
        const o = lookupOp(ctx, s.aggName, s.op);
        return !!o && operationUsesCurrentUser(o);
      }
      if (s.kind === "for-each") return callsUserGatedOp(s.body);
      return false;
    });
  if (workflowUsesCurrentUser(wf) || callsUserGatedOp(wf.statements)) {
    out.push(
      `    const currentUser = (httpCtx as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  // Repos used by this workflow.  Construct on the request `db` for
  // non-transactional; deferred construction inside the tx callback
  // for transactional.  Includes the read-port repos any `reading`-tier
  // domain-service call needs (domain-services.md rev. 4): the workflow
  // constructs `new <Agg>Repository(...)` for them so the service is handed a
  // live handle even when the workflow body never reads that repo itself.
  const reposNeeded = mergeReadPortRepos(collectReposForWorkflow(wf), wf, ctx);
  const hasEmit = wf.statements.some((st) => st.kind === "emit");
  if (hasEmit) {
    out.push(`    const workflowEvents: Events.DomainEvent[] = [];`);
  }
  // Provenanced writes accumulated during the workflow's steps must be flushed
  // to provenance_records here — without it they are silently dropped (the
  // per-operation route flushes them, but a workflow calls ops inline).  A
  // saved aggregate has `drainProv()` iff one of its operations has a prov
  // write-site; gate identically so we never call a missing method.
  const provSaves = wf.savesAtExit.filter((s) => {
    const agg = aggsByName.get(s.aggName);
    return !!agg && agg.operations.some((o) => opHasProvSite(o));
  });
  // When the workflow flushes provenance, run its body inside a CHILD frame so
  // those rows record their call-structure position — a distinct scope under
  // the request (parentId = the request's root scope), distinguishing a
  // workflow's lineage from a direct operation's.  Off when there's no
  // provenance, keeping provenance-free workflows byte-identical.
  // An `audited` operation invoked inline in a step likewise produces an
  // audit_records row (the per-operation route audits it; a workflow calling
  // it inline used to skip it — an audit-completeness gap).  Those rows also
  // want the child frame's scope / parent ids, so the frame opens for either.
  const auditsOps = hasAuditedOpCall(ctx, wf.statements);
  const wrapsFrame = provSaves.length > 0 || auditsOps;
  // aggregate name → its repo variable, so an inline audited op-call can take
  // the before/after wire snapshots through the repo (`repo.toWire(agg)`).
  const repoVarByAgg = new Map(reposNeeded.map((r) => [r.aggName, lowerFirst(r.repoName)]));
  const bi = wrapsFrame ? "      " : "    ";
  if (wrapsFrame) {
    out.push(`    await runInChildContext(async () => {`);
  }
  // Chunked (one lines-array per top-level statement) rather than the
  // pre-flattened `renderWorkflowStmts` — byte-identical either way
  // (`renderWorkflowStmts` IS `chunks.flat()` by construction), but the
  // per-chunk list lets us surface per-statement sub-regions to the caller
  // that owns the recorder + this file's final content (source-map
  // Milestone 11).  Both branches render directly at their final indent (no
  // post-hoc re-indent transform like the .NET transactional path), so the
  // chunk texts collected here are already the exact text that lands in
  // `http/workflows.ts`.
  const pushFragment = (stmtChunks: string[][]): void => {
    if (!opFragments) return;
    // CAREFUL: `buildWorkflowsFile`'s single call site wraps this function's
    // ENTIRE return value in a uniform +2-space indent
    // (`.map((l) => \`  ${l}\`)`) before it lands in the final file — the
    // fragment text must reflect that FINAL text, so re-apply the identical
    // per-line transform here (mirrors the .NET transactional re-indent).
    const chunkTexts = stmtChunks.map((ls) => ls.map((l) => `  ${l}`).join("\n"));
    if (chunkTexts.length === 0) return;
    opFragments.push({
      fragmentText: chunkTexts.join("\n"),
      subRegions: statementSubRegions(wf.statements, chunkTexts, `${ctx.name}.${wf.name}`),
    });
  };
  if (wf.transactional) {
    const txOpts = wf.isolation ? `, { isolationLevel: "${pgIsolationLevel(wf.isolation)}" }` : ``;
    out.push(`${bi}await db.transaction(async (tx) => {${""}`);
    for (const r of reposNeeded) {
      out.push(`${bi}  const ${lowerFirst(r.repoName)} = new ${r.aggName}Repository(tx, events);`);
    }
    const stmtChunks = renderWorkflowStmtChunks(
      wf.statements,
      honoWorkflowStmtTarget(ctx, paramExprs, "this", { dbHandle: "tx", repoVarByAgg }),
      `${bi}  `,
    );
    out.push(...stmtChunks.flat());
    pushFragment(stmtChunks);
    for (const save of wf.savesAtExit) {
      out.push(`${bi}  await ${lowerFirst(save.repoName)}.save(${save.name});`);
    }
    out.push(...renderProvFlush(provSaves, `${bi}  `, "tx"));
    out.push(`${bi}}${txOpts});`);
  } else {
    for (const r of reposNeeded) {
      out.push(`${bi}const ${lowerFirst(r.repoName)} = new ${r.aggName}Repository(db, events);`);
    }
    const stmtChunks = renderWorkflowStmtChunks(
      wf.statements,
      honoWorkflowStmtTarget(ctx, paramExprs, "this", { dbHandle: "db", repoVarByAgg }),
      bi,
    );
    out.push(...stmtChunks.flat());
    pushFragment(stmtChunks);
    for (const save of wf.savesAtExit) {
      out.push(`${bi}await ${lowerFirst(save.repoName)}.save(${save.name});`);
    }
    out.push(...renderProvFlush(provSaves, bi, "db"));
  }
  if (wrapsFrame) {
    out.push(`    });`);
  }
  if (hasEmit) {
    out.push(`    for (const ev of workflowEvents) await events.dispatch(ev);`);
  }
  // `workflow_completed` on the success path — emits / a thrown guard / a domain
  // error short-circuit before reaching here, so the line fires only when the
  // body ran to its terminal 204.
  out.push(`    ${renderHonoStoreLogCall("workflowCompleted", `workflow: "${wf.name}"`)}`);
  out.push(`    return httpCtx.body(null, 204);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** The instance-response Zod DTO + its list carrier for an observable
 *  workflow (workflow-instance-visibility.md).  Walks `instanceWireShape` the
 *  same way `routes-builder.emitResponseDtoSchema` walks an aggregate's
 *  `wireShape` — id-source rows are `z.string()`, the rest go through the
 *  shared `zodForResponse`.  File-local (`const`): nothing imports these. */
function emitInstanceResponseSchemas(wf: WorkflowIR): string[] {
  const T = upperFirst(wf.name);
  const out: string[] = [];
  out.push(`const ${T}InstanceResponse = z.object({`);
  for (const f of wf.instanceWireShape ?? []) {
    if (f.source === "id") {
      out.push(`  ${f.name}: z.string(),`);
    } else {
      out.push(`  ${f.name}: ${zodForResponse(f.type, f.optional)},`);
    }
  }
  out.push(`}).openapi("${T}InstanceResponse");`);
  out.push(
    `const ${T}InstanceListResponse = z.array(${T}InstanceResponse).openapi("${T}InstanceListResponse");`,
  );
  return out;
}

/** The two read-only instance routes for an observable workflow:
 *    GET /<snake>/instances        → list every running instance
 *    GET /<snake>/instances/{id}   → one instance by correlation id (404 if absent)
 *  The route paths + operationIds are identical across state-based and
 *  event-sourced workflows (they come from `opWorkflowInstances` /
 *  `opWorkflowInstanceById`, so cross-backend OpenAPI parity holds); only the
 *  READ BODY diverges on `wf.eventSourced`:
 *    - state-based  → select the `<wf>` correlation-state Drizzle table directly
 *      (the same table `emitWorkflowStateHelpers` loads/upserts).
 *    - event-sourced → fold the per-correlation `<wf>_events` stream
 *      (`loadAll<T>` group-fold for LIST; `load<T>Events` + `fold<T>` for byId),
 *      mirroring the event-sourced aggregate repository's group-fold.
 *  Rows / folded state are cast to the response type: `c.json` JSON-serialises
 *  them (Date → ISO string, branded ids → string), so the value matches the
 *  wire shape.  The route prefix nests under the already-mounted `/workflows`
 *  router, so `/<snake>/instances` does not collide with the bare-path POST
 *  command. */
function emitInstanceRoutes(wf: WorkflowIR): string[] {
  const T = upperFirst(wf.name);
  const slug = snake(wf.name);
  const table = `schema.${lowerFirst(plural(wf.name))}`;
  const corr = wf.correlationField as string;
  const helpers = esHelperNames(wf);
  const out: string[] = [];
  // List.
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/${slug}/instances",`);
  out.push(`    tags: ["workflows"],`);
  out.push(`    operationId: "${camelId(opWorkflowInstances(wf.name))}",`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${T}InstanceListResponse } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  if (wf.eventSourced) {
    out.push(`    const rows = await ${helpers.loadAll}(db);`);
  } else {
    out.push(`    const rows = await db.select().from(${table});`);
  }
  out.push(
    `    return httpCtx.json(rows as unknown as z.infer<typeof ${T}InstanceListResponse>, 200);`,
  );
  out.push(`  },`);
  out.push(`);`);
  // By correlation id.
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/${slug}/instances/{id}",`);
  out.push(`    tags: ["workflows"],`);
  out.push(`    operationId: "${camelId(opWorkflowInstanceById(wf.name))}",`);
  // The param schema derives from the correlation id's value type — guid →
  // uuid-format string, int/long → coerced integer, string → plain — so the
  // parity gate's path-param dimension agrees with .NET / Java / Python /
  // Phoenix by construction (docs/plans/non-guid-id-http-params.md).
  const corrVt = workflowCorrIdValueType(wf);
  const idParamZod =
    corrVt === "guid"
      ? "z.string().uuid()"
      : corrVt === "string"
        ? "z.string()"
        : "z.coerce.number().int()";
  // `load<T>Events` / `fold<T>` key streams as text; a numeric id stringifies.
  const idAsKey = corrVt === "int" || corrVt === "long" ? "String(id)" : "id";
  out.push(`    request: { params: z.object({ id: ${idParamZod} }) },`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${T}InstanceResponse } } },`,
  );
  out.push(
    `      404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  out.push(`    const { id } = httpCtx.req.valid("param");`);
  if (wf.eventSourced) {
    // Single-stream load + fold for the given correlation id; an empty stream
    // means no such instance.
    out.push(`    const __stream = await ${helpers.load}(db, ${idAsKey});`);
    out.push(`    if (__stream.length === 0) throw new AggregateNotFoundError("not_found");`);
    out.push(`    const row = ${helpers.fold}(${idAsKey}, __stream);`);
  } else {
    out.push(
      `    const rows = await db.select().from(${table}).where(eq(${table}.${corr}, id)).limit(1);`,
    );
    out.push(`    const row = rows[0];`);
    out.push(`    if (!row) throw new AggregateNotFoundError("not_found");`);
  }
  out.push(`    return httpCtx.json(row as unknown as z.infer<typeof ${T}InstanceResponse>, 200);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** All statements that contribute emitted handler code for a workflow — the
 *  facade body plus the reactor / event-create handler bodies this file emits.
 *  Used only to gather import candidates (intersected with the emitted text). */
function allHandlerStmts(wf: WorkflowIR): WorkflowStmtIR[] {
  return [
    ...wf.statements,
    ...(wf.subscriptions ?? []).flatMap((o) => o.statements),
    ...wf.creates.flatMap((c) => c.statements),
  ];
}

/** Deterministic handler-function name for an event subscription —
 *  `<workflow>On<Event>` for reactors, `<workflow>Start<Event>` for
 *  event-triggered creates. */
function handlerName(workflow: string, trigger: "on" | "create", event: string): string {
  return `${lowerFirst(workflow)}${trigger === "on" ? "On" : "Start"}${upperFirst(event)}`;
}

/** Emit the in-process subscription handlers + the `createInProcessDispatcher`
 *  factory for a context that has channel-routed subscriptions. */
function emitSubscriptionHandlers(
  ctx: EnrichedBoundedContextIR,
  /** Workflows whose fold helpers were already emitted (by the instance-route
   *  prelude in `buildWorkflowsFile`); skip re-emitting to avoid duplicate
   *  declarations. */
  helperDone: Set<string> = new Set<string>(),
  /** Whether the stream (de)serialisers were already emitted by the prelude. */
  serializersDone = false,
  /** Source-map Milestone 11 — forwarded into each reactor/starter handler
   *  body (see `emitHandlerFn` / `emitEventSourcedHandlerFn`). */
  opFragments?: OpFragment[],
): string[] {
  const subs = ctx.eventSubscriptions;
  const out: string[] = [];
  // Stream (de)serialisers shared by every event-sourced workflow's fold —
  // emitted once when any ES workflow is subscribed (workflow-and-applier.md
  // A2-S5b).  Reuses the aggregate event store's `eventToData` / `rowToEvent`.
  // Skipped when the instance-route prelude already emitted them.
  if (eventSourcedWorkflows(ctx).length > 0 && !serializersDone) {
    out.push(...emitWorkflowStreamSerializers(ctx));
    out.push("");
  }
  // Per-workflow persistence helpers, once per correlation-bearing workflow any
  // handler loads from: an `eventSourced` workflow gets its fold-from-stream
  // helpers (fold / apply / load / append); a state-based saga gets its
  // load/save row helpers.
  for (const sub of subs) {
    const wf = ctx.workflows.find((w) => w.name === sub.workflow);
    if (wf?.correlationField && !helperDone.has(wf.name)) {
      out.push(
        ...(wf.eventSourced ? emitWorkflowFoldHelpers(wf, ctx) : emitWorkflowStateHelpers(wf)),
      );
      out.push("");
      helperDone.add(wf.name);
    }
  }
  // Group handler names by event type for the dispatcher switch.
  const byEvent = new Map<string, string[]>();
  for (const sub of subs) {
    const wf = ctx.workflows.find((w) => w.name === sub.workflow);
    if (!wf) continue;
    let statements: WorkflowStmtIR[];
    let saves: { name: string; aggName: string; repoName: string }[];
    let correlation: ExprIR | undefined;
    if (sub.trigger === "on") {
      const on = (wf.subscriptions ?? []).find(
        (o) => o.event === sub.event && o.param === sub.param,
      );
      if (!on) continue;
      statements = on.statements;
      saves = on.savesAtExit;
      correlation = on.correlation;
    } else {
      const cr = wf.creates.find((c) => c.eventRef === sub.event && c.eventBinding === sub.param);
      if (!cr) continue;
      statements = cr.statements;
      saves = cr.savesAtExit;
      correlation = cr.correlation;
    }
    const fn = handlerName(sub.workflow, sub.trigger, sub.event);
    out.push(
      ...(wf.eventSourced
        ? emitEventSourcedHandlerFn(
            fn,
            wf,
            sub.trigger,
            sub.event,
            sub.param,
            correlation,
            statements,
            saves,
            ctx,
            sub.trigger === "create" && (wf.subscriptions ?? []).some((o) => o.event === sub.event),
            opFragments,
          )
        : emitHandlerFn(
            fn,
            wf,
            sub.trigger,
            sub.event,
            sub.param,
            correlation,
            statements,
            saves,
            ctx,
            durableEventTypes(ctx).size > 0,
            opFragments,
          )),
    );
    out.push("");
    const list = byEvent.get(sub.event) ?? [];
    list.push(fn);
    byEvent.set(sub.event, list);
  }
  out.push(...emitDispatcherFactory(byEvent));
  const durable = durableEventTypes(ctx);
  if (durable.size > 0) {
    out.push("");
    out.push(...emitOutboxMachinery(durable));
  }
  return out;
}

/** Transactional-outbox tier (dispatch-delivery-semantics.md): events carried
 *  by a channel with `retention: log | work` are recorded in `__loom_outbox`
 *  (same control-flow point the inline dispatch sat at) instead of being
 *  dispatched in-process; `startOutboxRelay` drains undispatched rows through
 *  the in-process dispatcher — at-least-once, so consumers must tolerate
 *  redelivery.  Exhausted rows (attempts ≥ maxAttempts) stay in the table and
 *  log `event_dead_lettered` once. */
function emitOutboxMachinery(durable: ReadonlySet<string>): string[] {
  const types = [...durable].sort().map((t) => JSON.stringify(t));
  const out: string[] = [];
  out.push(
    `export const DURABLE_EVENT_TYPES: ReadonlySet<string> = new Set([${types.join(", ")}]);`,
  );
  out.push(``);
  out.push(`export function createOutboxDispatcher(`);
  out.push(`  db: NodePgDatabase<typeof schema>,`);
  out.push(`  inner: DomainEventDispatcher,`);
  out.push(`): DomainEventDispatcher {`);
  out.push(`  return {`);
  out.push(`    async dispatch(event: Events.DomainEvent): Promise<void> {`);
  out.push(`      if (DURABLE_EVENT_TYPES.has(event.type)) {`);
  out.push(
    `        await db.insert(schema.loomOutbox).values({ type: event.type, payload: event });`,
  );
  out.push(`        return; // the relay delivers`);
  out.push(`      }`);
  out.push(`      await inner.dispatch(event);`);
  out.push(`    },`);
  out.push(`  };`);
  out.push(`}`);
  out.push(``);
  out.push(`export function startOutboxRelay(`);
  out.push(`  db: NodePgDatabase<typeof schema>,`);
  out.push(`  inner: DomainEventDispatcher,`);
  out.push(`  opts: { intervalMs?: number; maxAttempts?: number; batchSize?: number } = {},`);
  out.push(`): () => void {`);
  out.push(`  const intervalMs = opts.intervalMs ?? 500;`);
  out.push(`  const maxAttempts = opts.maxAttempts ?? 5;`);
  out.push(`  const batchSize = opts.batchSize ?? 50;`);
  out.push(`  let draining = false;`);
  out.push(`  const drain = async (): Promise<void> => {`);
  out.push(`    if (draining) return;`);
  out.push(`    draining = true;`);
  out.push(`    try {`);
  out.push(`      const rows = await db`);
  out.push(`        .select()`);
  out.push(`        .from(schema.loomOutbox)`);
  out.push(
    `        .where(and(isNull(schema.loomOutbox.dispatchedAt), lt(schema.loomOutbox.attempts, maxAttempts)))`,
  );
  out.push(`        .orderBy(asc(schema.loomOutbox.occurredAt))`);
  out.push(`        .limit(batchSize);`);
  out.push(`      for (const row of rows) {`);
  out.push(`        try {`);
  // The outbox row id rides on the dispatched event so the saga handler's
  // idempotent-consumer marker can no-op on redelivery (dispatch-delivery-
  // semantics.md §3).  Inline (ephemeral) dispatch carries no id.
  out.push(
    `          await inner.dispatch({ ...(row.payload as Events.DomainEvent), __loomEventId: row.id } as unknown as Events.DomainEvent);`,
  );
  out.push(
    `          await db.update(schema.loomOutbox).set({ dispatchedAt: new Date() }).where(eq(schema.loomOutbox.id, row.id));`,
  );
  out.push(`        } catch (err) {`);
  out.push(`          const attempts = row.attempts + 1;`);
  out.push(
    `          await db.update(schema.loomOutbox).set({ attempts }).where(eq(schema.loomOutbox.id, row.id));`,
  );
  out.push(`          if (attempts >= maxAttempts) {`);
  out.push(
    `            baseLogger.warn({ event: "event_dead_lettered", type: row.type, attempts, error: err instanceof Error ? err.message : String(err) });`,
  );
  out.push(`          }`);
  out.push(`        }`);
  out.push(`      }`);
  out.push(`    } finally {`);
  out.push(`      draining = false;`);
  out.push(`    }`);
  out.push(`  };`);
  out.push(`  const timer = setInterval(() => void drain(), intervalMs);`);
  out.push(`  return () => clearInterval(timer);`);
  out.push(`}`);
  return out;
}

/** `loadX` / `saveX` for a workflow's persisted correlation row, plus the row
 *  type.  `loadX` reads by the correlation column; `saveX` upserts on it.
 *  Keyed off the Drizzle table the schema emitter produces (PR #991). */
function emitWorkflowStateHelpers(wf: WorkflowIR): string[] {
  const T = upperFirst(wf.name);
  const table = `schema.${lowerFirst(plural(wf.name))}`;
  const corr = wf.correlationField as string;
  return [
    `type ${T}State = typeof ${table}.$inferInsert;`,
    `async function load${T}(`,
    `  db: NodePgDatabase<typeof schema>,`,
    `  key: string,`,
    `): Promise<${T}State | undefined> {`,
    `  const rows = await db.select().from(${table}).where(eq(${table}.${corr}, key)).limit(1);`,
    `  return rows[0];`,
    `}`,
    `async function save${T}(db: NodePgDatabase<typeof schema>, state: ${T}State): Promise<void> {`,
    `  await db.insert(${table}).values(state).onConflictDoUpdate({ target: ${table}.${corr}, set: state });`,
    `}`,
  ];
}

/** The object literal that allocates a fresh workflow instance: the correlation
 *  key plus a typed default for each required (non-optional) non-key saga state
 *  field, so the literal satisfies the row's insert type.  Optional fields are
 *  omitted (nullable columns). */
function allocateLiteral(wf: WorkflowIR): string {
  const corr = wf.correlationField as string;
  const parts = [`${corr}: __key`];
  for (const f of wf.stateFields ?? []) {
    if (f.name === corr || f.optional) continue;
    parts.push(`${f.name}: ${defaultLiteralFor(f.type)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

/** A backend-zero literal for a required saga-state column, matching the
 *  Drizzle insert type: numeric integers → `0`, precise-decimals (numeric
 *  columns) → the string `"0"`, bool → `false`, datetime → `new Date()`, json →
 *  `{}`, everything textual (string / guid / enum / id) → `""`, arrays → `[]`. */
function defaultLiteralFor(t: TypeIR): string {
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
        return "0";
      case "decimal":
      case "money":
        return `"0"`;
      case "bool":
        return "false";
      case "datetime":
        return "new Date()";
      case "json":
        return "{}";
      default:
        return `""`;
    }
  }
  if (t.kind === "array") return "[]";
  return `""`;
}

/** One reactor / event-create handler.  The inbound event instance binds as
 *  the body's event param directly (it is already domain-typed in-process —
 *  no wire→domain conversion, unlike the HTTP command path); repos are built
 *  on `db` with the re-entrant `events` dispatcher so a body `emit` re-routes
 *  to its own subscribers (choreography chains).
 *
 *  Both forms are **persisted** when the workflow has a correlation field: a
 *  `create` starter loads-or-allocates its row (allocate seeds the correlation
 *  key + typed defaults for required saga state); an `on` reactor routes to the
 *  existing row, or — when none exists for the key — drops the event and logs
 *  `event_unrouted` (a continuation can't run before its start; channels.md
 *  drop+log policy).  Either way the body renders with `this.<stateField>`
 *  reading the row, and the row is saved at exit. */
function emitHandlerFn(
  fn: string,
  wf: WorkflowIR,
  trigger: "on" | "create",
  eventName: string,
  paramName: string,
  correlation: ExprIR | undefined,
  statements: WorkflowStmtIR[],
  saves: { name: string; aggName: string; repoName: string }[],
  ctx: BoundedContextIR,
  /** Idempotent-consumer marker (dispatch-delivery-semantics.md §3): under a
   *  durable channel the relay redelivers at-least-once, so the handler
   *  no-ops when the saga row already records the inbound outbox event id
   *  and stamps it before save.  Ephemeral contexts stay byte-identical. */
  durable = false,
  /** Source-map Milestone 11 — see `emitWorkflowRoute`'s `opFragments`; same
   *  fragment-only discipline, keyed off the SAME `${ctx.name}.${wf.name}`
   *  construct as the workflow's command-route body (a reactor/starter body
   *  belongs to the same workflow). */
  opFragments?: OpFragment[],
): string[] {
  const out: string[] = [];
  out.push(`export async function ${fn}(`);
  out.push(`  db: NodePgDatabase<typeof schema>,`);
  out.push(`  events: DomainEventDispatcher,`);
  out.push(`  ${paramName}: Events.${eventName},`);
  out.push(`): Promise<void> {`);
  const persisted = !!wf.correlationField;
  const hasEmit = statements.some((st) => st.kind === "emit");
  if (hasEmit) out.push(`  const workflowEvents: Events.DomainEvent[] = [];`);
  const noParams = new Map<string, string>();
  let thisName = "this";
  if (persisted) {
    const T = upperFirst(wf.name);
    const corr = wf.correlationField as string;
    // Correlation key: the `by <expr>` routing value, else the event field
    // that name-matches the correlation field (the omitted-`by` rule).
    const keyExpr = correlation
      ? renderExprWithParams(correlation, noParams)
      : `${paramName}.${corr}`;
    out.push(`  const __key = ${keyExpr};`);
    if (trigger === "create") {
      // Load-or-allocate: a starter creates the instance if its key is new.
      out.push(`  const state = (await load${T}(db, __key)) ?? ${allocateLiteral(wf)};`);
    } else {
      // Route-to-existing, else drop + log: a continuation needs a started
      // instance.  `requestLog()` resolves the request-bound logger (the
      // dispatcher runs inside the request that emitted the event).
      out.push(`  const state = await load${T}(db, __key);`);
      out.push(`  if (!state) {`);
      out.push(
        `    ${renderHonoStoreLogCall("eventUnrouted", `workflow: "${wf.name}", event_type: "${eventName}", key: __key`)}`,
      );
      out.push(`    return;`);
      out.push(`  }`);
    }
    if (durable) {
      // The relay threads the outbox row id onto the dispatched event
      // (`__loomEventId`); inline (ephemeral) dispatch carries none.
      out.push(`  const __eventId = (${paramName} as { __loomEventId?: string }).__loomEventId;`);
      out.push(`  if (__eventId !== undefined && state.lastEventId === __eventId) {`);
      out.push(`    return; // already processed — at-least-once redelivery (idempotent consumer)`);
      out.push(`  }`);
    }
    thisName = "state";
  }
  // A reactor invokes ops inline, so a provenanced write OR an `audited` op-call
  // it makes would be missed — the per-operation route flushes provenance and
  // stages audit, but the reactor's inline path did neither.  Mirror the
  // workflow command path: run the body in a child frame (so the rows record
  // their call-structure scope, parentId chaining to the dispatching request),
  // flush each saved aggregate's lineage, and stage audit for inline audited
  // op-calls (via the target's `audit` context).  Gated so a reactor with
  // neither stays byte-identical (no frame, no flush, no audit).
  const provSaves = saves.filter((s) => {
    const agg = ctx.aggregates.find((a) => a.name === s.aggName);
    return !!agg && agg.operations.some((o) => opHasProvSite(o));
  });
  const auditsOps = hasAuditedOpCall(ctx, statements);
  const wrapsFrame = provSaves.length > 0 || auditsOps;
  const reactorRepos = collectReposFromStmts(statements, saves);
  const repoVarByAgg = new Map(reactorRepos.map((r) => [r.aggName, lowerFirst(r.repoName)]));
  const bi = wrapsFrame ? "    " : "  ";
  if (wrapsFrame) out.push(`  await runInChildContext(async () => {`);
  for (const r of reactorRepos) {
    out.push(`${bi}const ${lowerFirst(r.repoName)} = new ${r.aggName}Repository(db, events);`);
  }
  const stmtChunks = renderWorkflowStmtChunks(
    statements,
    honoWorkflowStmtTarget(ctx, noParams, thisName, { dbHandle: "db", repoVarByAgg }),
    bi,
  );
  out.push(...stmtChunks.flat());
  if (opFragments) {
    const chunkTexts = stmtChunks.map((ls) => ls.join("\n"));
    if (chunkTexts.length > 0) {
      opFragments.push({
        fragmentText: chunkTexts.join("\n"),
        subRegions: statementSubRegions(statements, chunkTexts, `${ctx.name}.${wf.name}`),
      });
    }
  }
  for (const save of saves) out.push(`${bi}await ${lowerFirst(save.repoName)}.save(${save.name});`);
  out.push(...renderProvFlush(provSaves, bi, "db"));
  if (wrapsFrame) out.push(`  });`);
  if (persisted && durable) {
    out.push(`  if (__eventId !== undefined) state.lastEventId = __eventId;`);
  }
  if (persisted) out.push(`  await save${upperFirst(wf.name)}(db, state);`);
  if (hasEmit) out.push(`  for (const ev of workflowEvents) await events.dispatch(ev);`);
  out.push(`}`);
  return out;
}

/** One reactor / event-create handler for an **event-sourced** workflow
 *  (workflow-and-applier.md A2-S5b).  The saga analogue of an event-sourced
 *  aggregate's command: instead of loading-or-allocating a mutable state row,
 *  it folds the workflow's `<wf>_events` stream into `state` (the appliers),
 *  runs the emit-only body (which reads `state` and orchestrates other
 *  aggregates), then **appends its own emitted events** (those it folds) to the
 *  stream gap-free and re-publishes every emit for choreography.
 *
 *  Mirrors `emitHandlerFn` exactly except the persistence seam: fold-on-load in
 *  place of `loadX`, append-own-events in place of `saveX`.  A `create` starter
 *  folds a possibly-empty stream (initial state); an `on` reactor requires a
 *  non-empty stream (the saga must have started) and otherwise drops + logs
 *  `event_unrouted`.  Own-state is never written via `:=` (the A1 discipline
 *  forbids it — state changes only through folded events). */
function emitEventSourcedHandlerFn(
  fn: string,
  wf: WorkflowIR,
  trigger: "on" | "create",
  eventName: string,
  paramName: string,
  correlation: ExprIR | undefined,
  statements: WorkflowStmtIR[],
  saves: { name: string; aggName: string; repoName: string }[],
  ctx: BoundedContextIR,
  /** A `create` starter that shares its event with an `on` reactor on the SAME
   *  workflow (the event-sourced-saga double-append case, S5b): the starter must
   *  no-op when the stream ALREADY exists (the `on` reactor owns that event), the
   *  inverse of the `on` handler's emptiness guard.  Without it both handlers
   *  append and the workflow event folds twice.  A create with no paired `on`
   *  stays byte-identical (guard omitted). */
  guardStreamExists = false,
  /** Source-map Milestone 11 — see `emitWorkflowRoute`'s `opFragments`; same
   *  fragment-only discipline and construct id. */
  opFragments?: OpFragment[],
): string[] {
  const out: string[] = [];
  const corr = wf.correlationField as string;
  const helpers = esHelperNames(wf);
  out.push(`export async function ${fn}(`);
  out.push(`  db: NodePgDatabase<typeof schema>,`);
  out.push(`  events: DomainEventDispatcher,`);
  out.push(`  ${paramName}: Events.${eventName},`);
  out.push(`): Promise<void> {`);
  out.push(`  const workflowEvents: Events.DomainEvent[] = [];`);
  const noParams = new Map<string, string>();
  // Correlation key: the `by <expr>` routing value, else the event field that
  // name-matches the correlation field (the omitted-`by` rule).
  const keyExpr = correlation
    ? renderExprWithParams(correlation, noParams)
    : `${paramName}.${corr}`;
  out.push(`  const __key = ${keyExpr};`);
  out.push(`  const __stream = await ${helpers.load}(db, __key as string);`);
  if (trigger === "on") {
    // A continuation needs a started saga — an empty stream means none exists.
    out.push(`  if (__stream.length === 0) {`);
    out.push(
      `    ${renderHonoStoreLogCall("eventUnrouted", `workflow: "${wf.name}", event_type: "${eventName}", key: __key`)}`,
    );
    out.push(`    return;`);
    out.push(`  }`);
  } else if (guardStreamExists) {
    // Inverse of the `on` guard (S5b): the paired `on` reactor already handles
    // this event once the saga has started, so the starter must NOT re-append —
    // a non-empty stream means it exists.  Mirrors the `on` telemetry inverted.
    out.push(`  if (__stream.length !== 0) {`);
    out.push(
      `    ${renderHonoStoreLogCall("eventUnrouted", `workflow: "${wf.name}", event_type: "${eventName}", key: __key`)}`,
    );
    out.push(`    return;`);
    out.push(`  }`);
  }
  out.push(`  const state = ${helpers.fold}(__key as string, __stream);`);
  // `state` is read by the body's `this.<field>` refs (thisName: "state"); a
  // pure-emit body that never reads it would leave it unused — `void` keeps the
  // generated-code lint clean either way (same pattern as the apply param).
  out.push(`  void state;`);
  // Same body-rendering machinery as the state-based reactor: inline op-calls
  // may flush provenance / stage audit, so wrap a child frame when either is
  // present; build the orchestrated repos on `db` with the re-entrant
  // dispatcher so a body `emit` re-routes (choreography chains).
  const provSaves = saves.filter((s) => {
    const agg = ctx.aggregates.find((a) => a.name === s.aggName);
    return !!agg && agg.operations.some((o) => opHasProvSite(o));
  });
  const auditsOps = hasAuditedOpCall(ctx, statements);
  const wrapsFrame = provSaves.length > 0 || auditsOps;
  const reactorRepos = collectReposFromStmts(statements, saves);
  const repoVarByAgg = new Map(reactorRepos.map((r) => [r.aggName, lowerFirst(r.repoName)]));
  const bi = wrapsFrame ? "    " : "  ";
  if (wrapsFrame) out.push(`  await runInChildContext(async () => {`);
  for (const r of reactorRepos) {
    out.push(`${bi}const ${lowerFirst(r.repoName)} = new ${r.aggName}Repository(db, events);`);
  }
  const stmtChunks = renderWorkflowStmtChunks(
    statements,
    honoWorkflowStmtTarget(ctx, noParams, "state", { dbHandle: "db", repoVarByAgg }),
    bi,
  );
  out.push(...stmtChunks.flat());
  if (opFragments) {
    const chunkTexts = stmtChunks.map((ls) => ls.join("\n"));
    if (chunkTexts.length > 0) {
      opFragments.push({
        fragmentText: chunkTexts.join("\n"),
        subRegions: statementSubRegions(statements, chunkTexts, `${ctx.name}.${wf.name}`),
      });
    }
  }
  for (const save of saves) out.push(`${bi}await ${lowerFirst(save.repoName)}.save(${save.name});`);
  out.push(...renderProvFlush(provSaves, bi, "db"));
  if (wrapsFrame) out.push(`  });`);
  // Append the workflow's OWN events (the ones it folds) to its stream,
  // gap-free; every emitted event (own + choreography) is then re-published.
  out.push(
    `  await ${helpers.append}(db, __key as string, workflowEvents.filter((e) => ${helpers.foldedSet}.has(e.type)));`,
  );
  out.push(`  for (const ev of workflowEvents) await events.dispatch(ev);`);
  out.push(`}`);
  return out;
}

/** The in-process dispatcher: a `DomainEventDispatcher` whose `dispatch`
 *  switches on `event.type` and fans each event out to its handlers, passing
 *  itself so a handler's own emits re-enter.  `createApp` installs this as the
 *  default dispatcher (replacing Noop) when the context has subscriptions. */
function emitDispatcherFactory(byEvent: Map<string, string[]>): string[] {
  const out: string[] = [];
  out.push(`export function createInProcessDispatcher(`);
  out.push(`  db: NodePgDatabase<typeof schema>,`);
  out.push(`): DomainEventDispatcher {`);
  out.push(`  const dispatcher: DomainEventDispatcher = {`);
  out.push(`    async dispatch(event: Events.DomainEvent): Promise<void> {`);
  out.push(`      switch (event.type) {`);
  for (const [event, fns] of byEvent) {
    out.push(`        case "${event}": {`);
    for (const fn of fns) out.push(`          await ${fn}(db, dispatcher, event);`);
    out.push(`          break;`);
    out.push(`        }`);
  }
  out.push(`        default:`);
  out.push(`          break;`);
  out.push(`      }`);
  out.push(`    },`);
  out.push(`  };`);
  out.push(`  return dispatcher;`);
  out.push(`}`);
  return out;
}

/** Repos referenced by a handler body — same derivation as
 *  `collectReposForWorkflow` but over a statement list + its saves (reactors /
 *  event-creates carry statements + savesAtExit, not a whole WorkflowIR). */
function collectReposFromStmts(
  statements: WorkflowStmtIR[],
  saves: { name: string; aggName: string; repoName: string }[],
): { repoName: string; aggName: string }[] {
  const seen = new Map<string, string>();
  const walk = (stmts: WorkflowStmtIR[]): void => {
    for (const st of stmts) {
      if (st.kind === "repo-let" || st.kind === "repo-run") seen.set(st.repoName, st.aggName);
      else if (st.kind === "for-each") {
        for (const sv of st.savesPerIteration) seen.set(sv.repoName, sv.aggName);
        walk(st.body);
      } else if (st.kind === "if-let") {
        seen.set(st.repoName, st.aggName);
        for (const sv of st.savesInThen) seen.set(sv.repoName, sv.aggName);
        for (const sv of st.savesInElse) seen.set(sv.repoName, sv.aggName);
        walk(st.thenBody);
        walk(st.elseBody ?? []);
      }
    }
  };
  walk(statements);
  for (const save of saves) seen.set(save.repoName, save.aggName);
  return [...seen.entries()].map(([repoName, aggName]) => ({ repoName, aggName }));
}

// The Hono leaf table for the shared workflow statement spine
// (`_workflow/stmt-target.ts`). Built per render call so it captures the
// `paramExprs` / `thisName` in scope (the route handler and the saga handler
// pass different bindings); the dispatch + `for-each` recursion live in the
// spine.
function honoWorkflowStmtTarget(
  ctx: BoundedContextIR,
  paramExprs: Map<string, string>,
  thisName = "this",
  /** Present only on the command-route path: enables staging an audit_records
   *  row for an inline `audited` op-call (the reactor path passes none). */
  audit?: { dbHandle: string; repoVarByAgg: Map<string, string> },
): WorkflowStmtTarget {
  // Read-port wiring (domain-services.md rev. 4, Slice 1): a `reading`-tier
  // domain-service call is supplied its repository handle(s) ahead of the user
  // args.  The handle var is `lowerFirst(repo)` — the SAME var the workflow
  // constructs for that repo (`collectReposForWorkflow` includes service ports),
  // so a service reading `Accounts` is passed the workflow's `accounts` repo.
  // PURE services resolve to `[]` → byte-identical.
  const readPortArgs = workflowReadPortResolver(ctx);
  const renderArg = (e: ExprIR): string =>
    renderExprWithParams(e, paramExprs, thisName, readPortArgs);
  // Unique suffix per in-body audit capture so multiple audited op-calls in one
  // workflow don't collide on the before/after temp-var names.
  let auditSeq = 0;
  return {
    indentUnit: "  ",
    precondition: (st, indent) => [
      `${indent}if (!(${renderArg(st.expr)})) throw new DomainError(${JSON.stringify(`Precondition failed: ${st.source}`)});`,
    ],
    requires: (st, indent) => [
      `${indent}if (!(${renderArg(st.expr)})) throw new ForbiddenError(${JSON.stringify(`Forbidden: ${st.source}`)});`,
    ],
    emit: (st, indent) => {
      const fieldList = [
        `type: "${st.eventName}"`,
        ...st.fields.map((f) => `${f.name}: ${renderArg(f.value)}`),
      ].join(", ");
      return [`${indent}workflowEvents.push({ ${fieldList} });`];
    },
    factoryLet: (st, indent) => {
      const fields = st.fields.map((f) => `${f.name}: ${renderArg(f.value)}`).join(", ");
      return [`${indent}const ${st.name} = ${st.aggName}.create({ ${fields} });`];
    },
    repoLet: (st, indent) => {
      const args = st.args.map(renderArg).join(", ");
      return [
        `${indent}const ${st.name} = await ${lowerFirst(st.repoName)}.${st.method}(${args});`,
      ];
    },
    opCall: (st, indent) => {
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
      // A currentUser-gated op takes a trailing `currentUser` argument
      // (appended to the method signature); thread the in-scope binding.
      const callArgs =
        op && operationUsesCurrentUser(op)
          ? [args, "currentUser"].filter(Boolean).join(", ")
          : args;
      const callLine = `${indent}${st.target}.${lowerFirst(st.op)}(${callArgs});`;
      // Audited op invoked inline → stage an audit_records row bracketing the
      // call with before/after wire snapshots, mirroring the per-operation
      // route.  Only on the command-route path (audit context present) and when
      // the aggregate's repo var is known (needed for `toWire`); otherwise the
      // plain call is emitted (no audit), never a reference to a missing repo.
      const repoVar = audit && op?.audited ? audit.repoVarByAgg.get(st.aggName) : undefined;
      if (audit && op?.audited && repoVar) {
        const n = auditSeq++;
        const before = `__auditBefore${n}`;
        const after = `__auditAfter${n}`;
        const c = `__auditCtx${n}`;
        return [
          `${indent}const ${before} = ${repoVar}.toWire(${st.target});`,
          callLine,
          `${indent}const ${after} = ${repoVar}.toWire(${st.target});`,
          `${indent}const ${c} = requestContext();`,
          `${indent}await ${audit.dbHandle}.insert(schema.auditRecords).values({`,
          `${indent}  auditId: randomUUID(),`,
          `${indent}  operationId: "${camelId(opOperation(st.aggName, st.op))}",`,
          `${indent}  action: "${st.op}",`,
          `${indent}  targetType: "${st.aggName}",`,
          `${indent}  targetId: (${after} as { id: string }).id,`,
          `${indent}  actor: ${c}?.currentUser ?? null,`,
          `${indent}  before: ${before},`,
          `${indent}  after: ${after},`,
          `${indent}  at: new Date(),`,
          `${indent}  status: "ok",`,
          `${indent}  correlationId: ${c}?.correlationId ?? null,`,
          `${indent}  scopeId: ${c}?.scopeId ?? null,`,
          `${indent}  parentId: ${c}?.parentId ?? null,`,
          `${indent}});`,
        ];
      }
      return [callLine];
    },
    exprLet: (st, indent) => [`${indent}const ${st.name} = ${renderArg(st.expr)};`],
    // `field := value` — own-state mutation: write `value` onto the loaded
    // correlation-state row (`thisName` = `state` on the persisted-state path),
    // which `save<Wf>(db, state)` flushes at handler exit.
    assign: (st, indent) => [
      `${indent}${thisName}.${st.target.segments[0]} = ${renderArg(st.value)};`,
    ],
    repoRun: (st, indent) => {
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
    },
    forEach: (st, indent, bodyLines) => {
      // `for o in xs { … }` → a JS `for…of`; the spine renders the body at
      // +2 indent (`indentUnit`); each iteration's dirty bindings save
      // INSIDE the loop (aggregate events drain through the same save).
      const inner = `${indent}  `;
      const saveLines = st.savesPerIteration.map(
        (sv) => `${inner}await ${lowerFirst(sv.repoName)}.save(${sv.name});`,
      );
      return [
        `${indent}for (const ${st.var} of ${renderArg(st.iterable)}) {`,
        ...bodyLines,
        ...saveLines,
        `${indent}}`,
      ];
    },
    ifLet: (st, indent, thenLines, elseLines) => {
      // `if let o = Repo.find(<Criterion>) { … } else { … }` → run the shared
      // `findAllBy<Criterion>` retrieval with `limit: 1`, take the first row (or
      // `null`), and branch.  The `!== null` narrows `o` to non-null in the
      // then-branch; each branch's dirty bindings save INSIDE that branch.
      const inner = `${indent}  `;
      const args = st.retrievalArgs.map(renderArg);
      args.push("{ limit: 1 }");
      const thenSaves = st.savesInThen.map(
        (sv) => `${inner}await ${lowerFirst(sv.repoName)}.save(${sv.name});`,
      );
      const elseSaves = st.savesInElse.map(
        (sv) => `${inner}await ${lowerFirst(sv.repoName)}.save(${sv.name});`,
      );
      const out = [
        `${indent}const ${st.var} = (await ${lowerFirst(st.repoName)}.run${upperFirst(st.retrievalName)}(${args.join(", ")}))[0] ?? null;`,
        `${indent}if (${st.var} !== null) {`,
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
    // Bare resource-op statement (`files.put(k, v)`).  `renderArg` renders
    // the call as `(await files$put(...))`; emit it as a statement (Phase 4).
    resourceCall: (st, indent) => [`${indent}${renderArg(st.call)};`],
    // Bare `Transfer.run(src, dst, amount)` domain-service call
    // (domain-services.md rev. 4, the `mutating` tier).  `renderArg` produces
    // the backend call (read-port-aware; `(await …)` for a reading service);
    // emit as a statement.  The mutated aggregate args persist via the
    // workflow's exit-saves (`savesAtExit`), emitted after the body.
    domainServiceCall: (st, indent) => [`${indent}${renderArg(st.call)};`],
  };
}

function lookupOp(
  ctx: BoundedContextIR,
  aggName: string,
  opName: string,
): import("../../../ir/types/loom-ir.js").OperationIR | undefined {
  return ctx.aggregates.find((a) => a.name === aggName)?.operations.find((o) => o.name === opName);
}

function renderExprWithParams(
  e: ExprIR,
  paramExprs: Map<string, string>,
  thisName = "this",
  /** Resolver for the read-port handle args a `reading`-tier domain-service
   *  call takes (domain-services.md rev. 4); threaded onto the TS render
   *  context.  Undefined ⇒ no prepend (pure-service / non-workflow callers). */
  readPortArgs?: (service: string, op: string) => string[],
): string {
  // Workflow params are local consts now; ExprIR `ref` nodes for them
  // already carry refKind="param" and the bare name.  renderTsExpr
  // emits bare names for params, which match the local consts we
  // just declared.  So a plain renderTsExpr is correct.
  //
  // `thisName` redirects `this.<stateField>` saga reads: the HTTP route
  // path leaves it `"this"` (no workflow `this` in scope there); the
  // dispatcher handler passes the loaded state-row local so
  // `this.<field>` renders as `state.field` (persisted correlation).
  void paramExprs;
  return renderTsExpr(e, { thisName, readPortArgs });
}

/** Build the read-port resolver for a workflow's `reading`-tier domain-service
 *  calls (domain-services.md rev. 4, Slice 1).  Given a `<service>.<op>` call,
 *  returns the repository handle var names (`lowerFirst(repo)`) to prepend — the
 *  read-ports the service operation consumes (derived from its body), in order.
 *  A pure service op has no ports, so the resolver returns `[]` and the call
 *  renders byte-identically. */
function workflowReadPortResolver(
  ctx: BoundedContextIR,
): (service: string, op: string) => string[] {
  return (service, op) => {
    const svc = ctx.domainServices.find((s) => s.name === service);
    const operation = svc?.operations.find((o) => o.name === op);
    if (!operation) return [];
    return readPortsForOperation(operation).map((p) => lowerFirst(p.repo));
  };
}

/** Every read-port a workflow's `reading`-tier domain-service calls require —
 *  the repository handles those services read, so the workflow constructs them
 *  (`new <Aggregate>Repository(tx, events)`) even when its own body never reads
 *  that repository directly.  De-duplicated by repository name across all
 *  service calls in the body. */
function collectServiceReadPorts(wf: WorkflowIR, ctx: BoundedContextIR): ReadPort[] {
  const byRepo = new Map<string, ReadPort>();
  const visit = (e: ExprIR): void => {
    if (e.kind === "call" && e.callKind === "domain-service" && e.serviceRef) {
      const svc = ctx.domainServices.find((s) => s.name === e.serviceRef!.service);
      const operation = svc?.operations.find((o) => o.name === e.serviceRef!.op);
      if (operation) {
        for (const p of readPortsForOperation(operation)) {
          if (!byRepo.has(p.repo)) byRepo.set(p.repo, p);
        }
      }
    }
    for (const c of exprChildren(e)) visit(c);
  };
  const walkStmts = (stmts: WorkflowStmtIR[]): void => {
    for (const st of stmts) {
      for (const e of workflowStmtExprs(st)) visit(e);
      if (st.kind === "for-each") walkStmts(st.body);
      else if (st.kind === "if-let") {
        walkStmts(st.thenBody);
        walkStmts(st.elseBody ?? []);
      }
    }
  };
  walkStmts(wf.statements);
  return [...byRepo.values()];
}

/** Merge a workflow's directly-used repos with the read-port repos its
 *  `reading`-tier domain-service calls require, de-duplicated by repository
 *  name (a repo the workflow already constructs is not added twice).  Service
 *  ports append after the workflow's own repos so a port-only project stays a
 *  pure extension. */
function mergeReadPortRepos(
  own: { repoName: string; aggName: string }[],
  wf: WorkflowIR,
  ctx: BoundedContextIR,
): { repoName: string; aggName: string }[] {
  const seen = new Set(own.map((r) => r.repoName));
  const out = [...own];
  for (const port of collectServiceReadPorts(wf, ctx)) {
    if (seen.has(port.repo)) continue;
    seen.add(port.repo);
    out.push({ repoName: port.repo, aggName: port.aggregate });
  }
  return out;
}

/** The expressions a workflow statement directly carries (one level — the
 *  per-kind nesting is handled by `collectServiceReadPorts`'s spine walk). */
function workflowStmtExprs(st: WorkflowStmtIR): ExprIR[] {
  switch (st.kind) {
    case "expr-let":
      return [st.expr];
    case "precondition":
    case "requires":
      return [st.expr];
    case "resource-call":
      return [st.call];
    case "op-call":
    case "repo-let":
      return st.args;
    case "factory-let":
    case "emit":
      return st.fields.map((f) => f.value);
    case "for-each":
      return [st.iterable];
    case "if-let":
      return st.retrievalArgs;
    default:
      return [];
  }
}

/** Direct sub-expressions of an ExprIR (for the read-port call scan). */
function exprChildren(e: ExprIR): ExprIR[] {
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
      return e.body ? [e.body] : [];
    default:
      return [];
  }
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
      } else if (st.kind === "if-let") {
        seen.set(st.repoName, st.aggName);
        for (const sv of st.savesInThen) seen.set(sv.repoName, sv.aggName);
        for (const sv of st.savesInElse) seen.set(sv.repoName, sv.aggName);
        walk(st.thenBody);
        walk(st.elseBody ?? []);
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
/** Type seeds named on the context's workflow surface — every workflow
 *  parameter.  The schema collectors take the transitive closure of these
 *  through value objects' own fields (see `collectReachableTypes`) so a
 *  `<Vo>Schema` body never references an undeclared `<Enum>Schema`. */
function* workflowSchemaSeeds(ctx: BoundedContextIR): Generator<TypeIR> {
  for (const wf of ctx.workflows) {
    for (const p of wf.params) yield p.type;
  }
}

function collectUsedValueObjects(ctx: BoundedContextIR) {
  const { valueObjects } = collectReachableTypes(workflowSchemaSeeds(ctx), ctx.valueObjects);
  return ctx.valueObjects.filter((v) => valueObjects.has(v.name));
}

function collectUsedEnums(ctx: BoundedContextIR) {
  const { enums } = collectReachableTypes(workflowSchemaSeeds(ctx), ctx.valueObjects);
  return ctx.enums.filter((e) => enums.has(e.name));
}
