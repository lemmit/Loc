import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import { lowerToDrizzle } from "../../../generator/typescript/repository-find-predicate.js";
import type {
  AggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  ProjectionIR,
  TypeIR,
  ViewIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { viewUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { camelId, opView } from "../../../ir/util/openapi-ids.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { zodForResponse } from "./routes-builder.js";
import {
  emitWorkflowFoldHelpers,
  emitWorkflowStreamSerializers,
  esHelperNames,
} from "./workflow-eventsourced-builder.js";

// ---------------------------------------------------------------------------
// Hono view routes emission.
//
// For each `view` declared in the context, emit a `GET /<snake>`
// route whose body delegates to the source aggregate's repository
// and projects results to either:
//
//   - the aggregate's existing wire shape via `repo.toWire`
//     (shorthand form `view X = Y where ...`), or
//   - a custom record shape declared in the view's full-form body
//     `view X { fields ... bind ... }`.
//
// One file per context — `http/views.ts` — mounted under `/views`
// in `http/index.ts`.  Matches the workflow / aggregate route
// pattern: typed Zod schemas, OpenAPI annotations, on-error filter.
// ---------------------------------------------------------------------------

export function buildViewsRoutesFile(
  ctx: EnrichedBoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
  /** Maps an event-sourced workflow name to its OWNING context, so a merged
   *  multi-context deployable's view reads the same `<owner>_events` const the
   *  schema emits.  Absent → merged `ctx.name` (byte-identical single-context). */
  resolveStreamContext?: (name: string) => string | undefined,
): string {
  if (ctx.views.length === 0) return "";
  // Workflow-sourced views (workflow-instance-views.md).  The read diverges on
  // `wf.eventSourced`:
  //   - **state-based saga** — reads its `<Wf>State` table directly with the
  //     view's filter lowered to a Drizzle `where` (SQL-pushed, no aggregate
  //     repository);
  //   - **event-sourced** — has no state table, so it group-folds the
  //     `<wf>_events` stream via the file-local `loadAll<T>` helper (the same
  //     one the ES instance LIST emits) and applies the SAME predicate
  //     IN-MEMORY (`.filter(r => …)`) over the folded state.
  // Both project `instanceWireShape`, so operationIds / route paths / response
  // components stay identical across the two paths.
  const wfViews: Array<{
    view: ViewIR;
    wf: WorkflowIR;
    eventSourced: boolean;
    table?: string;
    where?: string;
  }> = [];
  const wfDrizzleOps = new Set<string>();
  for (const v of ctx.views) {
    if (v.source.kind !== "workflow") continue;
    const wf = ctx.workflows.find((w) => w.name === v.source.name);
    if (!wf?.instanceWireShape) continue;
    if (wf.eventSourced) {
      wfViews.push({ view: v, wf, eventSourced: true });
      continue;
    }
    // `lowerToDrizzle` prepends `schema.` to the table name itself when it
    // renders column refs, so it takes the BARE table name; the `.from(...)`
    // below uses the `schema.`-qualified form.
    const tableBare = lowerFirst(plural(wf.name));
    const table = `schema.${tableBare}`;
    let where: string | undefined;
    if (v.filter) {
      const lowered = lowerToDrizzle(v.filter, tableBare, ctx);
      if (lowered) {
        where = lowered.expr;
        for (const op of lowered.ops) wfDrizzleOps.add(op);
      }
    }
    wfViews.push({ view: v, wf, eventSourced: false, table, where });
  }
  // Projection-sourced views (projection.md v1.1) — read the persisted
  // `<Proj>Row` read-model table directly, exactly the state-saga SQL-pushed
  // path (projections have no event-sourced variant — always a physical row
  // table).  Unlike workflow sources, a projection source PERMITS the full-form
  // bind-follow (`view.output`): reading projection + repos at query time is
  // legal because a view is a query, not a replayable fold.
  const projViews: Array<{
    view: ViewIR;
    proj: ProjectionIR;
    table: string;
    where?: string;
  }> = [];
  const projDrizzleOps = new Set<string>();
  for (const v of ctx.views) {
    if (v.source.kind !== "projection") continue;
    const proj = ctx.projections.find((p) => p.name === v.source.name);
    if (!proj) continue;
    // The projection row table shares the workflow-state naming convention
    // (`lowerFirst(plural(name))` → the drizzle `schema.<x>` export); the bare
    // form feeds `lowerToDrizzle`'s `schema.<table>.<col>` refs.
    const tableBare = lowerFirst(plural(proj.name));
    const table = `schema.${tableBare}`;
    let where: string | undefined;
    if (v.filter) {
      const lowered = lowerToDrizzle(v.filter, tableBare, ctx);
      if (lowered) {
        where = lowered.expr;
        for (const op of lowered.ops) projDrizzleOps.add(op);
      }
    }
    projViews.push({ view: v, proj, table, where });
  }
  // Event-sourced workflow-views need the per-workflow fold machinery
  // (apply / fold / loadAll) + the shared stream (de)serialisers in scope — the
  // file-local helpers the ES instance LIST also emits.  Emitted once into THIS
  // file (a separate module from `http/workflows.ts`, so no name collision).
  const esWfViews = wfViews.filter((v) => v.eventSourced);
  const esHelperLines: string[] = [];
  if (esWfViews.length > 0) {
    esHelperLines.push(...emitWorkflowStreamSerializers(ctx, { readOnly: true }));
    esHelperLines.push("");
    const done = new Set<string>();
    for (const { wf } of esWfViews) {
      if (done.has(wf.name)) continue;
      done.add(wf.name);
      esHelperLines.push(
        ...emitWorkflowFoldHelpers(wf, ctx, { readOnly: true, resolveStreamContext }),
      );
      esHelperLines.push("");
    }
  }
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  lines.push(`import { newApp } from "./problem-details";`);
  lines.push(
    `import { DomainError, AggregateNotFoundError, ForbiddenError, ExternHandlerError } from "../domain/errors";`,
  );
  lines.push(`import { type DomainEventDispatcher } from "../domain/events";`);
  lines.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  // A workflow-sourced view reads `schema.<table>` as a runtime value
  // (`db.select().from(...)` for state sagas, the ES fold helpers' stream reads
  // for event-sourced ones); aggregate-only files keep the type-only import.
  lines.push(
    wfViews.length > 0 || projViews.length > 0
      ? `import * as schema from "../db/schema";`
      : `import type * as schema from "../db/schema";`,
  );
  // ES fold helpers reference `Events.*`, drizzle `eq`/`asc`, and (for typed
  // saga-state defaults) `Decimal` / `Ids` — derive these from the emitted
  // helper text, the same body-scan the workflows file uses.
  const esHelperStr = esHelperLines.join("\n");
  const esDrizzleOps = ["and", "asc", "eq", "isNull", "lt"].filter((op) =>
    new RegExp(`(?<!\\.)\\b${op}\\(`).test(esHelperStr),
  );
  for (const op of esDrizzleOps) wfDrizzleOps.add(op);
  // Projection-view `where` clauses contribute the same Drizzle ops.
  for (const op of projDrizzleOps) wfDrizzleOps.add(op);
  if (wfDrizzleOps.size > 0) {
    lines.push(`import { ${[...wfDrizzleOps].sort().join(", ")} } from "drizzle-orm";`);
  }
  if (/\bEvents\.\w/.test(esHelperStr)) {
    lines.push(`import type * as Events from "../domain/events";`);
  }
  // A projection full-form first-hop follow re-brands nullable row columns with
  // `Ids.<Agg>Id(...)` (see idsSourceForAux), so it needs the Ids namespace too.
  const projNeedsIds = projViews.some((p) =>
    (p.view.output?.auxiliaries ?? []).some((a) => a.path.length === 1),
  );
  if (/\bIds\.\w/.test(esHelperStr) || projNeedsIds) {
    lines.push(`import * as Ids from "../domain/ids";`);
  }
  if (/(?<!\.)\bDecimal\b/.test(esHelperStr)) {
    lines.push(`import Decimal from "decimal.js";`);
  }
  // Source aggregates + repo imports per view, plus any foreign
  // aggregates referenced via `X id` follow auxiliaries.
  const aggsTouched = new Set<string>();
  for (const v of ctx.views) {
    // Projection-sourced views read the `<Proj>Row` table directly (no source
    // repository), but their full-form bind-follows still bulk-load foreign
    // aggregates through those aggregates' repositories (projection.md v1.1).
    if (v.source.kind === "projection") {
      if (v.output) {
        for (const aux of v.output.auxiliaries) aggsTouched.add(aux.aggName);
      }
      continue;
    }
    // Workflow-sourced views read the saga-state table directly, not an
    // aggregate repository (workflow-instance-views.md) — emitted separately.
    if (v.source.kind !== "aggregate") continue;
    aggsTouched.add(v.source.name);
    if (v.output) {
      for (const aux of v.output.auxiliaries) aggsTouched.add(aux.aggName);
    }
  }
  // Source aggregates need the response schema (for shorthand-view
  // routes); foreign aggregates only referenced by follows don't,
  // but importing them is harmless under strict tsc since the file
  // uses them in projection paths.  Track which aggregates are
  // sources to avoid emitting Response imports for follow-only
  // aggregates that may not have aggregates routes if they have no
  // operations / finds — defensive.
  const sourceAggs = new Set(
    ctx.views.filter((v) => v.source.kind === "aggregate").map((v) => v.source.name),
  );
  for (const aggName of aggsTouched) {
    lines.push(
      `import { ${aggName}Repository } from "../db/repositories/${lowerFirst(aggName)}-repository";`,
    );
    if (sourceAggs.has(aggName)) {
      lines.push(
        `import { ${aggName}Response, ${aggName}ListResponse } from "./${lowerFirst(aggName)}.routes";`,
      );
    }
  }
  // Value object + enum imports — full-form views may bind to enum
  // values (`status`) or value-object fields.
  const vos = ctx.valueObjects.map((v) => v.name);
  const enums = ctx.enums.map((e) => e.name);
  if (vos.length + enums.length > 0) {
    lines.push(`import { ${[...vos, ...enums].join(", ")} } from "../domain/value-objects";`);
  }
  lines.push("");

  // Per-full-form-view response Zod schema.  Shorthand views reuse
  // the aggregate's `<Agg>ListResponse` import.
  const enumValues = new Map(ctx.enums.map((e) => [e.name, e.values] as const));
  for (const view of ctx.views) {
    if (!view.output) continue;
    lines.push(`const ${upperFirst(view.name)}Row = z.object({`);
    for (const f of view.output.fields) {
      lines.push(`  ${f.name}: ${zodForRow(f.type, enumValues)},`);
    }
    lines.push(`}).openapi("${upperFirst(view.name)}Row");`);
    lines.push(
      `const ${upperFirst(view.name)}Response = z.array(${upperFirst(view.name)}Row).openapi("${upperFirst(view.name)}Response");`,
    );
  }
  if (ctx.views.some((v) => v.output)) lines.push("");

  // Workflow-view response schemas — the saga instance shape (`<View>Row` /
  // `<View>Response`), built from the source workflow's `instanceWireShape`.
  for (const { view, wf } of wfViews) {
    lines.push(...emitWorkflowViewSchema(view, wf));
  }
  if (wfViews.length > 0) lines.push("");

  // Projection-view response schemas — the `<Proj>Row` read-model shape, built
  // from the source projection's `wireShape` (mirrors the workflow-view schema).
  // Full-form projection views declare their own record shape, already emitted
  // by the generic `view.output` loop above, so only shorthand views need this.
  for (const { view, proj } of projViews) {
    if (view.output) continue;
    lines.push(...emitProjectionViewSchema(view, proj, enumValues));
  }
  if (projViews.some((p) => !p.view.output)) lines.push("");

  // ES fold machinery (module-level, file-local) for any event-sourced
  // workflow-view source.
  if (esHelperLines.length > 0) {
    lines.push(...esHelperLines);
  }

  // `events` is threaded into aggregate-view repositories (`new XRepo(db,
  // events)`); a workflow-views-only file never constructs a repository, so the
  // param is unused there — name it `_events` to stay clean under Biome's
  // noUnusedFunctionParameters (callers pass it positionally, so the name is
  // irrelevant to them).
  const usesEvents =
    ctx.views.some((v) => v.source.kind === "aggregate") ||
    // A full-form projection view with bind-follows constructs foreign-aggregate
    // repositories (`new XRepository(db, events)`) to bulk-load the followed rows.
    projViews.some((p) => (p.view.output?.auxiliaries.length ?? 0) > 0);
  lines.push(`export function viewsRoutes(`);
  lines.push(`  db: NodePgDatabase<typeof schema>,`);
  lines.push(`  ${usesEvents ? "events" : "_events"}: DomainEventDispatcher,`);
  lines.push(`): OpenAPIHono {`);
  // `newApp()` from `./problem-details` pre-wires the validation hook
  // that maps Zod parse failures (query/path params on view endpoints) to
  // 422 ProblemDetails with `errors[]`.
  lines.push(`  const app = newApp();`);
  lines.push("");

  for (const view of ctx.views) {
    if (view.source.kind !== "aggregate") continue;
    lines.push(...emitViewRoute(view, ctx, aggsByName).map((l) => `  ${l}`));
    lines.push("");
  }
  // Workflow-sourced view routes — `GET /<view>` (workflow-instance-views.md):
  // a state saga's SQL-pushed read or an ES workflow's group-fold + in-memory
  // filter.
  for (const { view, wf, eventSourced, table, where } of wfViews) {
    lines.push(...emitWorkflowViewRoute(view, wf, eventSourced, table, where).map((l) => `  ${l}`));
    lines.push("");
  }
  // Projection-sourced view routes — `GET /<view>` (projection.md v1.1): a
  // direct SQL-pushed read over the `<Proj>Row` table, then (full-form) the
  // aggregate-style bind-follow bulk-loads + projected map.
  for (const { view, proj, table, where } of projViews) {
    lines.push(...emitProjectionViewRoute(view, proj, table, where).map((l) => `  ${l}`));
    lines.push("");
  }

  lines.push(`  app.onError((err, c) => {`);
  lines.push(
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
  );
  // RFC 7807 responder — application/problem+json + x-request-id header.
  lines.push(
    `    const problem = (status: 400 | 403 | 404 | 500, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
  );
  lines.push(
    `    if (err instanceof ForbiddenError) return problem(403, "Forbidden", err.message);`,
  );
  lines.push(
    `    if (err instanceof DomainError) return problem(400, "Bad Request", err.message);`,
  );
  lines.push(
    `    if (err instanceof AggregateNotFoundError) return problem(404, "Not Found", err.message);`,
  );
  lines.push(
    `    if (err instanceof ExternHandlerError) { console.error(err); return problem(500, "Internal Server Error", err.message); }`,
  );
  lines.push(`    console.error(err);`);
  lines.push(`    return problem(500, "Internal Server Error", "internal");`);
  lines.push(`  });`);
  lines.push("");
  lines.push(`  return app;`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

function emitViewRoute(
  view: ViewIR,
  ctx: EnrichedBoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
): string[] {
  void ctx;
  void aggsByName;
  const out: string[] = [];
  const aggSlug = snake(plural(view.source.name));
  const responseSchema = view.output
    ? `${upperFirst(view.name)}Response`
    : `${view.source.name}ListResponse`;
  // Views whose filter / binds reference currentUser
  // thread the request's user through to the repository's
  // synthesised find method.  The auth middleware stashed it on the
  // Hono context earlier in the pipeline.
  const usesUser = viewUsesCurrentUser(view);
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/${snake(view.name)}",`);
  out.push(`    tags: ["views", "${aggSlug}"],`);
  out.push(`    operationId: "${camelId(opView(view.name))}",`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${responseSchema} } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  // The auth `requires` gate (and any currentUser-scoped filter) needs the
  // request principal in scope.  Read it for either.
  if (usesUser || view.requires) {
    out.push(
      `    const currentUser = (httpCtx as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  for (const line of viewGateLines(view)) out.push(line);
  out.push(`    const repo = new ${view.source.name}Repository(db, events);`);
  const repoCallArgs = usesUser ? "currentUser" : "";
  out.push(`    const rows = await repo.${lowerFirst(view.name)}(${repoCallArgs});`);
  if (view.output) {
    // Bulk-load every foreign aggregate referenced by `X id`
    // follows in the bind expressions.  Auxiliaries arrive in
    // dependency order (shortest path first); each one's id source
    // is either the source rows (length-1 paths) or the map of a
    // shorter prefix path (length-2+).  Lookup chain in the
    // projection mirrors the same path.
    const pathToMap = new Map<string, { mapVar: string; aggName: string }>();
    for (const aux of view.output.auxiliaries) {
      const repoVar = `${lowerFirst(aux.aggName)}Repo`;
      const mapVar = aux.mapVar;
      out.push(`    const ${repoVar} = new ${aux.aggName}Repository(db, events);`);
      const idsSource = idsSourceForAux(aux, pathToMap);
      out.push(
        `    const ${mapVar} = new Map((await ${repoVar}.findManyByIds(${idsSource})).map((a) => [a.id as string, a]));`,
      );
      pathToMap.set(aux.path.join("."), { mapVar, aggName: aux.aggName });
    }
    const projectedFields = view.output.binds
      .map((b) => `      ${b.name}: ${renderBindWithFollows(b.expr, "r", pathToMap)}`)
      .join(",\n");
    out.push(`    const projected = rows.map((r) => ({\n${projectedFields},\n    }));`);
    out.push(
      `    return httpCtx.json(projected as z.infer<typeof ${upperFirst(view.name)}Response>, 200);`,
    );
  } else {
    out.push(
      `    return httpCtx.json(rows.map((r) => repo.toWire(r)) as z.infer<typeof ${view.source.name}Response>[], 200);`,
    );
  }
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** A workflow-sourced view's response schema (`<View>Row` / `<View>Response`)
 *  — the saga instance wire shape, walked the same way `emitInstanceRoutes`
 *  walks `instanceWireShape` for the raw instance endpoints
 *  (workflow-instance-visibility.md). */
function emitWorkflowViewSchema(view: ViewIR, wf: WorkflowIR): string[] {
  const T = upperFirst(view.name);
  const out: string[] = [];
  out.push(`const ${T}Row = z.object({`);
  for (const f of wf.instanceWireShape ?? []) {
    out.push(
      `  ${f.name}: ${f.source === "id" ? "z.string()" : zodForResponse(f.type, f.optional)},`,
    );
  }
  out.push(`}).openapi("${T}Row");`);
  out.push(`const ${T}Response = z.array(${T}Row).openapi("${T}Response");`);
  return out;
}

/** A workflow-sourced view route: `GET /<view>` (workflow-instance-views.md).
 *  The read diverges on `wf.eventSourced`:
 *   - **state-based saga** — `db.select().from(<Wf>State).where(<lowered filter>)`
 *     (SQL-pushed);
 *   - **event-sourced** — `loadAll<T>(db)` group-folds the `<wf>_events` stream
 *     into instances (the same helper the ES instance LIST uses), then the SAME
 *     filter is applied IN-MEMORY (`.filter((r) => <predicate>)`).
 *  Either way rows cast to the response type — `c.json` JSON-serialises them
 *  (Date → ISO, branded ids → string), the read-side analogue of the instance
 *  endpoints, and the projected wire shape is identical across the two paths. */
function emitWorkflowViewRoute(
  view: ViewIR,
  wf: WorkflowIR,
  eventSourced: boolean,
  table: string | undefined,
  where: string | undefined,
): string[] {
  const T = upperFirst(view.name);
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/${snake(view.name)}",`);
  out.push(`    tags: ["views", "${snake(plural(wf.name))}"],`);
  out.push(`    operationId: "${camelId(opView(view.name))}",`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${T}Response } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  if (view.requires) {
    out.push(
      `    const currentUser = (httpCtx as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  for (const line of viewGateLines(view)) out.push(line);
  if (eventSourced) {
    const loadAll = esHelperNames(wf).loadAll;
    // In-memory predicate over the folded `<T>State` (`this.<col>` → `r.<col>`).
    const filterClause = view.filter
      ? `.filter((r) => ${renderTsExpr(view.filter, { thisName: "r" })})`
      : "";
    out.push(`    const rows = (await ${loadAll}(db))${filterClause};`);
  } else {
    out.push(
      `    const rows = await db.select().from(${table})${where ? `.where(${where})` : ""};`,
    );
  }
  out.push(`    return httpCtx.json(rows as unknown as z.infer<typeof ${T}Response>, 200);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** A projection-sourced view's response schema (`<View>Row` / `<View>Response`)
 *  for the SHORTHAND form — the `<Proj>Row` read-model shape, walked from the
 *  source projection's `wireShape` exactly as `emitWorkflowViewSchema` walks
 *  `instanceWireShape` (projection.md v1.1).  Full-form views declare their own
 *  record and reuse the generic `<View>Row` emitted upstream. */
function emitProjectionViewSchema(
  view: ViewIR,
  proj: ProjectionIR,
  enumValues: Map<string, string[]>,
): string[] {
  const T = upperFirst(view.name);
  const out: string[] = [];
  out.push(`const ${T}Row = z.object({`);
  // Inline enum unions via `zodForRow` (the same helper the full-form row
  // schema uses) rather than `zodForResponse`'s `<Enum>Schema` reference — this
  // file imports the runtime enum consts, not their zod schema consts.
  for (const f of proj.wireShape ?? []) {
    out.push(`  ${f.name}: ${f.source === "id" ? "z.string()" : zodForRow(f.type, enumValues)},`);
  }
  out.push(`}).openapi("${T}Row");`);
  out.push(`const ${T}Response = z.array(${T}Row).openapi("${T}Response");`);
  return out;
}

/** A projection-sourced view route: `GET /<view>` (projection.md v1.1).  Reads
 *  the `<Proj>Row` table directly with the view's filter lowered to a SQL-pushed
 *  Drizzle `where` (the state-saga path — projections have no ES variant), then:
 *   - **shorthand** — casts the rows to the projection wire shape (`c.json`
 *     JSON-serialises branded ids → string), exactly like the state-saga
 *     workflow-view route;
 *   - **full-form** — runs the aggregate-style bind-follow (bulk-load every
 *     `X id` follow through its repository, then a projected `.map`), the same
 *     machinery `emitViewRoute` uses for an aggregate source — the one path a
 *     workflow source does NOT get. */
function emitProjectionViewRoute(
  view: ViewIR,
  proj: ProjectionIR,
  table: string,
  where: string | undefined,
): string[] {
  const T = upperFirst(view.name);
  const out: string[] = [];
  const usesUser = viewUsesCurrentUser(view);
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/${snake(view.name)}",`);
  out.push(`    tags: ["views", "${snake(plural(proj.name))}"],`);
  out.push(`    operationId: "${camelId(opView(view.name))}",`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${T}Response } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  if (usesUser || view.requires) {
    out.push(
      `    const currentUser = (httpCtx as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  for (const line of viewGateLines(view)) out.push(line);
  out.push(`    const rows = await db.select().from(${table})${where ? `.where(${where})` : ""};`);
  if (view.output) {
    const pathToMap = new Map<string, { mapVar: string; aggName: string }>();
    for (const aux of view.output.auxiliaries) {
      const repoVar = `${lowerFirst(aux.aggName)}Repo`;
      const mapVar = aux.mapVar;
      out.push(`    const ${repoVar} = new ${aux.aggName}Repository(db, events);`);
      const idsSource = idsSourceForAux(aux, pathToMap, true);
      out.push(
        `    const ${mapVar} = new Map((await ${repoVar}.findManyByIds(${idsSource})).map((a) => [a.id as string, a]));`,
      );
      pathToMap.set(aux.path.join("."), { mapVar, aggName: aux.aggName });
    }
    const projectedFields = view.output.binds
      .map((b) => `      ${b.name}: ${renderBindWithFollows(b.expr, "r", pathToMap)}`)
      .join(",\n");
    out.push(`    const projected = rows.map((r) => ({\n${projectedFields},\n    }));`);
    out.push(`    return httpCtx.json(projected as z.infer<typeof ${T}Response>, 200);`);
  } else {
    out.push(`    return httpCtx.json(rows as unknown as z.infer<typeof ${T}Response>, 200);`);
  }
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** Pick the id-source expression for an auxiliary's bulk load.
 *  Length-1 paths source from the row var (`rows.map(r => r.<f>)`);
 *  length-2+ paths source from the prior map (the auxiliary whose
 *  path is the current path's prefix).
 *
 *  `fromRow` distinguishes the projection source: a `<Proj>Row` read-model
 *  column is nullable `string | null` (not the aggregate's non-nullable branded
 *  `<Agg>Id`), so a first-hop follow off a projection row drops NULLs and
 *  re-brands each value with `Ids.<Agg>Id(...)` before `findManyByIds`.  Later
 *  hops read hydrated aggregates and already hold proper id types. */
function idsSourceForAux(
  aux: { path: string[]; aggName: string; mapVar: string },
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
  fromRow = false,
): string {
  if (aux.path.length === 1) {
    if (fromRow) {
      return `rows.map((r) => r.${aux.path[0]!}).filter((x): x is string => x !== null).map((x) => Ids.${aux.aggName}Id(x))`;
    }
    return `rows.map((r) => r.${aux.path[0]!})`;
  }
  const prevPath = aux.path.slice(0, -1).join(".");
  const prev = pathToMap.get(prevPath);
  if (!prev) return `[]`;
  const finalField = aux.path[aux.path.length - 1]!;
  return `[...${prev.mapVar}.values()].map((a) => a.${finalField})`;
}

/** Render a view bind expression with chained `X id` follow
 *  rewriting.  At each `member` whose receiverType is `X id`,
 *  the access becomes `<map>.get(<receiverRendered> as string)!.<member>`
 *  where `<receiverRendered>` is recursively the same walker.
 *  Falls back to standard `renderTsExpr` for non-follow shapes. */
function renderBindWithFollows(
  expr: ExprIR,
  thisName: string,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPath(expr.receiver);
    if (path) {
      const key = path.join(".");
      const map = pathToMap.get(key);
      if (map) {
        const receiverRendered = renderIdReceiver(expr.receiver, thisName, pathToMap);
        return `${map.mapVar}.get(${receiverRendered} as string)!.${expr.member}`;
      }
    }
  }
  return renderTsExpr(expr, { thisName });
}

/** Render an Id-typed expression rooted in a `ref` (single hop) or
 *  a chain of Id-typed member accesses (multi-hop).  For multi-hop,
 *  each intermediate hop uses its corresponding map's `.get(...)!`. */
function renderIdReceiver(
  expr: ExprIR,
  thisName: string,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "ref") {
    return `${thisName}.${expr.name}`;
  }
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPath(expr.receiver);
    if (path) {
      const key = path.join(".");
      const map = pathToMap.get(key);
      if (map) {
        const inner = renderIdReceiver(expr.receiver, thisName, pathToMap);
        return `${map.mapVar}.get(${inner} as string)!.${expr.member}`;
      }
    }
  }
  return renderTsExpr(expr, { thisName });
}

/** Local copy of the lowering's `idFollowPath` for emission-time
 *  path checks.  Kept small and self-contained rather than sharing
 *  with the lowering helper, since the emission-time call site
 *  doesn't need the full lowering env. */
function idFollowPath(e: ExprIR): string[] | undefined {
  if (e.kind === "ref" && e.type?.kind === "id") return [e.name];
  if (e.kind === "member" && e.receiverType.kind === "id") {
    const inner = idFollowPath(e.receiver);
    if (!inner) return undefined;
    return [...inner, e.member];
  }
  return undefined;
}

/** Zod schema for a view-output field's TS type.  Decimals stay as
 *  `z.number()`, ids emit as `z.string()`, enum values are emitted
 *  inline as a string-literal union pulled from `enumValues`. */
function zodForRow(t: TypeIR, enumValues: Map<string, string[]>): string {
  switch (t.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.number().int()";
        case "decimal":
          return "z.number()";
        case "money":
          return "z.string()";
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.boolean()";
        case "datetime":
          return "z.string()";
        case "json":
          return "z.unknown()";
        case "File":
          return "z.object({ url: z.string(), key: z.string(), contentType: z.string(), size: z.number().int() })";
        case "duration":
          // A5: expression-only primitive — never a view-row / wire type.
          throw new Error("internal: 'duration' is expression-only and never reaches a view row");
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return "z.string()";
    case "enum": {
      const values = enumValues.get(t.name) ?? [];
      const lits = values.map((v) => `"${v}"`).join(", ");
      return values.length > 0 ? `z.enum([${lits}])` : "z.string()";
    }
    case "valueobject":
      return "z.unknown()";
    case "entity":
      return "z.unknown()";
    case "array":
      return `z.array(${zodForRow(t.element, enumValues)})`;
    case "optional":
      return `${zodForRow(t.inner, enumValues)}.nullish()`;
    case "action":
    case "slot":
      throw new Error("zodForRow: 'slot' type is UI-only and should not reach a view-row schema.");
    case "genericInstance":
      throw new Error(
        `zodForRow: generic carrier '${t.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
    case "union":
    case "none":
      throw new Error(
        `zodForRow: discriminated unions are not emittable yet (P4); IR-validate should have rejected '${t.kind}'.`,
      );
  }
}

/** Auth-gate lines for a view route: a 403 when the `requires` predicate
 *  (evaluated against the in-scope `currentUser`) fails.  Empty for an ungated
 *  view.  ForbiddenError is mapped to a 403 ProblemDetails by the file's
 *  onError filter — the read-side analogue of an operation `requires` gate.
 *  (The OpenAPI response set is intentionally left unchanged for now so the
 *  cross-backend view contract doesn't drift ahead of the other backends.) */
function viewGateLines(view: ViewIR): string[] {
  if (!view.requires) return [];
  return [`    if (!(${renderTsExpr(view.requires)})) throw new ForbiddenError("Forbidden");`];
}
