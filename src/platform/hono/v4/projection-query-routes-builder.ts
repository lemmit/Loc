import { renderHonoLogCall } from "../../../generator/_obs/render-hono.js";
import { MONEY_WIRE_SCALE } from "../../../generator/money-scale.js";
import { whereToMikroFilter } from "../../../generator/typescript/emit/mikroorm.js";
import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import {
  DRIZZLE_INTRINSIC_SQL,
  lowerToDrizzle,
} from "../../../generator/typescript/repository-find-predicate.js";
import type {
  EnrichedBoundedContextIR,
  ExprIR,
  ProjectionAggregateIR,
  ProjectionIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import {
  isQueryTimeProjection,
  queryProjectionUsesCurrentUser,
} from "../../../ir/types/loom-ir.js";
import { problemTitle } from "../../../ir/util/openapi-errors.js";
import {
  type AggregateSelect,
  aggregateCoercion,
  GROUP_KEY_TRANSFORM_INTRINSIC,
  type GroupKey,
  type GroupKeySelect,
  groupedAggregates,
  groupKeyOf,
  wholeTableAggregates,
} from "../../../ir/util/projection-aggregate.js";
import { resolveErrorStatus } from "../../../util/error-defaults.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Hono query-time projection routes emission (read-path-architecture.md
// rev.13, § "projection generalises").
//
// A QUERY-TIME projection (`from <Agg> [as a] where … join … select …`, no
// `on(e)` folds) is the always-current read model of the query-time projection
// read.  It reads live — the repository synthesises
// a parameterless `repo.<projName>()` find from the projection's `where`
// (repository-builder.ts), the route bulk-loads every `join` follow
// (`query.auxiliaries`) through the followed aggregate's repository, and
// projects each row through the `select` expressions (rewriting `X id` follows
// to the loaded-alias map).
//
// One file per context — `http/projections.ts` — mounted under `/projections`
// in `http/index.ts` (the folded projection
// read model keeps its own by-key route elsewhere).  Only backends that have
// ported this emit are permitted a query-time projection by the IR validator
// (`loom.projection-query-time-unsupported`); node is the first.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The persistence-adapter seam (M-T6.23 slice 4).
//
// Three of the four query-projection shapes read the SOURCE TABLE directly
// rather than through a repository — a whole-table aggregation, a grouped
// aggregation, and a raw-table (`from <Workflow>` / `from <Projection>`) source
// — because the whole point of an aggregation is that it pushes DOWN to SQL and
// materialises no rows.  Those three are the only adapter-divergent part:
//
//   drizzle   db.select({...}).from(schema.orders).where(<drizzle expr>)
//             …aggregates via drizzle's count()/sum(); rows come back keyed by
//             the select alias, numerics as strings.
//   mikroorm  db.createQueryBuilder(OrderRow, "o").select([raw("…")]).where(
//             <FilterQuery>) — the aggregate/grouping expressions are SQL
//             fragments, and the WHERE reuses `whereToMikroFilter` (the same
//             lowering every mikro find uses) rather than growing a second
//             predicate→SQL renderer.
//
// The FOURTH shape (repository-sourced: `repo.<projName>()` + `findManyByIds`
// joins + `toWire`) is adapter-neutral already — the mikro repository emitter
// synthesises the very same projection find (`synthProjectionFinds`), so those
// route bodies are byte-identical between adapters and are not part of the seam.
//
// All four are ported.  The raw-table arm was missing in the first version of
// this slice while its gate was already deleted, so the shape fell through to
// the drizzle branch and emitted `db.select().from(schema.…)` into an
// EntityManager file with no `schema` import (an owner review caught it).  If a
// FIFTH shape is ever added, add its mikro arm in the same change as the emit —
// a fall-through here is a generate-then-broken-build, which is worse than the
// gate that used to stand in its place.
//
// One MikroORM constraint shapes the emission: a `raw()` fragment is
// SINGLE-USE per query ("Trying to modify a raw query fragment that was already
// used"), so a computed grouping key that appears in SELECT, GROUP BY and ORDER
// BY is emitted as three separate `raw()` calls of the same SQL text.
// ---------------------------------------------------------------------------

export function buildQueryProjectionsFile(
  ctx: EnrichedBoundedContextIR,
  /** `persistence: mikroorm` — read the direct-table shapes through the
   *  EntityManager's QueryBuilder instead of Drizzle (M-T6.23 slice 4).  Default
   *  false keeps the Drizzle output byte-identical. */
  usingMikro = false,
): string {
  const projections = (ctx.projections ?? []).filter(isQueryTimeProjection);
  if (projections.length === 0) return "";

  const enumValues = new Map(ctx.enums.map((e) => [e.name, e.values] as const));

  // Foreign aggregates touched: the query source (for its repo + Response) and
  // every `join` follow target (for its repo).  A WORKFLOW source reads the
  // saga-state table directly, and a PROJECTION source reads the folded
  // `<Proj>Row` read-model table directly — both without a repository, so
  // neither contributes here.
  const sourceAggs = new Set<string>();
  const followAggs = new Set<string>();
  const isRawTableSource = (kind?: string) => kind === "workflow" || kind === "projection";
  for (const p of projections) {
    if (p.query?.source && !isRawTableSource(p.query.sourceKind)) sourceAggs.add(p.query.source);
    for (const aux of p.query?.auxiliaries ?? []) followAggs.add(aux.aggName);
  }
  // Pre-compute each raw-table-sourced projection's read (table + Drizzle
  // `where`) — a WORKFLOW source reads its persisted saga-state table, a
  // PROJECTION source reads the SOURCE projection's folded `<Proj>Row` read-model
  // table (named `schema.<lowerFirst(plural(source))>`, exactly as the folded
  // projection emitter in projection-builder.ts creates it).  Accumulate the
  // Drizzle operators the filter needs so the import line below can list them.
  // `lowerToDrizzle` takes the BARE table name and prepends `schema.` on the
  // column refs itself.
  const rawDrizzleOps = new Set<string>();
  const rawReads = new Map<string, { table: string; where?: string }>();
  for (const p of projections) {
    if (!isRawTableSource(p.query?.sourceKind) || !p.query?.source) continue;
    const tableBare = lowerFirst(plural(p.query.source));
    let where: string | undefined;
    if (p.query.filter) {
      const lowered = lowerToDrizzle(p.query.filter, tableBare, ctx);
      if (lowered) {
        where = lowered.expr;
        for (const op of lowered.ops) rawDrizzleOps.add(op);
      }
    }
    rawReads.set(p.name, { table: `schema.${tableBare}`, where });
  }
  // Aggregation reads — whole-table singletons AND grouped (`group by`)
  // projections: the table is queried DIRECTLY (not through the repository —
  // the point of the shape is to never materialise rows), so the projection's
  // `where` lowers to SQL here exactly as a raw-table source's does.  Also
  // collects the drizzle aggregate functions the routes will call, so the
  // `drizzle-orm` import below lists them.
  //
  // Deliberately covers EVERY source kind, including the raw-table ones.  The
  // route emitter takes the aggregate branches before the raw-table branch, so
  // skipping workflow/projection sources here would emit their aggregation with
  // the `where` silently dropped — a wrong answer rather than a broken build.
  // Both paths name the table identically (`lowerFirst(plural(source))`), so one
  // lowering serves both.
  const aggWheres = new Map<string, string | undefined>();
  for (const p of projections) {
    const grouped = groupedAggregates(p);
    const aggregates = grouped?.aggregates ?? wholeTableAggregates(p);
    if (!aggregates || !p.query?.source) continue;
    for (const s of aggregates) rawDrizzleOps.add(s.aggregate.op);
    // A COMPUTED grouping key (`group by o.placedAt.startOfDay()`) renders
    // through the Drizzle intrinsic snippets, which build a `sql` template.
    if ((grouped?.groupBy ?? []).some((e) => groupKeyOf(e)?.transform)) rawDrizzleOps.add("sql");
    if (!p.query.filter) {
      aggWheres.set(p.name, undefined);
      continue;
    }
    const lowered = lowerToDrizzle(p.query.filter, lowerFirst(plural(p.query.source)), ctx);
    if (lowered) {
      aggWheres.set(p.name, lowered.expr);
      for (const op of lowered.ops) rawDrizzleOps.add(op);
    } else {
      aggWheres.set(p.name, undefined);
    }
  }
  // MikroORM WHERE lowering for the same direct-table shapes: a FilterQuery
  // object built by the shared `whereToMikroFilter` (the lowering every mikro
  // find already uses), keyed per projection.  `undefined` = no filter.
  const mikroWheres = new Map<string, string | undefined>();
  if (usingMikro) {
    for (const p of projections) {
      const f = p.query?.filter;
      mikroWheres.set(p.name, f ? mikroFilterFor(f) : undefined);
    }
  }
  const allAggs = new Set([...sourceAggs, ...followAggs]);
  const usesEvents =
    projections.some((p) => (p.query?.auxiliaries.length ?? 0) > 0) || sourceAggs.size > 0;
  const needsIds = projections.some((p) =>
    (p.query?.auxiliaries ?? []).some((a) => a.path.length >= 1),
  );

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  lines.push(`import { frameworkProblemBody, newApp } from "./problem-details";`);
  lines.push(`import { HTTPException } from "hono/http-exception";`);
  lines.push(
    `import { DomainError, AggregateNotFoundError, ForbiddenError, ExternHandlerError } from "../domain/errors";`,
  );
  lines.push(`import { type DomainEventDispatcher } from "../domain/events";`);
  if (usingMikro) {
    // The direct-table shapes need the Row entity classes + `raw`; the
    // repository-sourced shape needs neither.  Both are body-scan-gated below.
    lines.push(`import { EntityManager } from "@mikro-orm/postgresql";`);
  } else {
    lines.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  }
  // `schema` is normally needed only for `NodePgDatabase<typeof schema>` — a
  // TYPE position — but the two paths that query a table DIRECTLY (a raw-table
  // source, and a whole-table aggregation) name `schema.<table>` as a VALUE.
  // A type-only import makes that `TS1361: 'schema' cannot be used as a value`,
  // which no test caught because no `.ddd` in the repo exercises either path.
  // A value import satisfies the type position too, so this is a widening;
  // projections that need neither keep the type-only import byte-for-byte.
  const schemaAsValue = rawReads.size > 0 || aggWheres.size > 0;
  if (!usingMikro) {
    lines.push(
      schemaAsValue
        ? `import * as schema from "../db/schema";`
        : `import type * as schema from "../db/schema";`,
    );
    if (rawDrizzleOps.size > 0) {
      lines.push(`import { ${[...rawDrizzleOps].sort().join(", ")} } from "drizzle-orm";`);
    }
  }
  if (anyMoneyAggregate(projections)) lines.push(`import Decimal from "decimal.js";`);
  if (needsIds) lines.push(`import * as Ids from "../domain/ids";`);
  for (const aggName of [...allAggs].sort()) {
    lines.push(
      `import { ${aggName}Repository } from "../db/repositories/${lowerFirst(aggName)}-repository";`,
    );
  }
  const vos = ctx.valueObjects.map((v) => v.name);
  const enums = ctx.enums.map((e) => e.name);
  if (vos.length + enums.length > 0) {
    lines.push(`import { ${[...vos, ...enums].join(", ")} } from "../domain/value-objects";`);
  }
  lines.push("");

  // Per-projection row / response schema (the declared `<Proj>Row` shape).
  for (const p of projections) {
    const T = upperFirst(p.name);
    lines.push(`const ${T}Row = z.object({`);
    for (const f of p.wireShape ?? []) {
      lines.push(
        `  ${f.name}: ${f.source === "id" ? "z.string()" : zodForRow(f.type, enumValues)},`,
      );
    }
    lines.push(`}).openapi("${T}Row");`);
    // A whole-table aggregation yields ONE row, so its response is the row
    // itself — not an array of one.  (The array wrapper on a singleton was the
    // shape that made `select orders = count` look like a list of counts.)  A
    // GROUPED aggregation yields one row PER KEY, so it keeps the array —
    // `wholeTableAggregates` already refuses it.
    lines.push(
      wholeTableAggregates(p)
        ? `const ${T}Response = ${T}Row.openapi("${T}Response");`
        : `const ${T}Response = z.array(${T}Row).openapi("${T}Response");`,
    );
  }
  lines.push("");

  lines.push(`export function queryProjectionsRoutes(`);
  lines.push(`  db: ${usingMikro ? "EntityManager" : "NodePgDatabase<typeof schema>"},`);
  lines.push(`  ${usesEvents ? "events" : "_events"}: DomainEventDispatcher,`);
  lines.push(`): OpenAPIHono {`);
  lines.push(`  const app = newApp();`);
  lines.push("");

  for (const p of projections) {
    lines.push(
      ...emitQueryProjectionRoute(
        p,
        rawReads.get(p.name),
        aggWheres.get(p.name),
        usingMikro ? { where: mikroWheres.get(p.name) } : undefined,
      ).map((l) => `  ${l}`),
    );
    lines.push("");
  }

  lines.push(`  app.onError((err, c) => {`);
  lines.push(
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
  );
  // M-T5.20 — the projection router is hono's FOURTH `app.onError`, and it was
  // the one the first conversion pass missed: the aggregate, workflow and
  // extern-handler routers all resolved while this one still answered the
  // hardcoded 403/422.  That is worse than a cross-backend split — it is one
  // BACKEND disagreeing with itself, so `httpStatus DomainError -> N` moved a
  // system's operation routes and silently not its projection routes.
  //
  // Found by censusing the emitted statuses per backend and noticing node still
  // had literals after the sweep; no test caught it because the override
  // fixtures carry no projection.  `denial-ladder-override-parity` now does.
  const projDomainStatus = resolveErrorStatus("DomainError", ctx.structuralErrorStatuses);
  const projForbiddenStatus = resolveErrorStatus("Forbidden", ctx.structuralErrorStatuses);
  const projProblemUnion = [
    ...new Set<number>([400, projForbiddenStatus, 404, 422, projDomainStatus, 500]),
  ]
    .sort((a, b) => a - b)
    .join(" | ");
  lines.push(
    `    const problem = (status: ${projProblemUnion}, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
  );
  lines.push(
    `    if (err instanceof ForbiddenError) return problem(${projForbiddenStatus}, ${JSON.stringify(problemTitle(projForbiddenStatus))}, err.message);`,
  );
  lines.push(
    `    if (err instanceof DomainError) return problem(${projDomainStatus}, ${JSON.stringify(problemTitle(projDomainStatus))}, err.message);`,
  );
  lines.push(
    `    if (err instanceof AggregateNotFoundError) return problem(404, "Not Found", err.message);`,
  );
  lines.push(
    // RS-28 — sanitized; the inner exception reaches the log, not the wire.
    `    if (err instanceof ExternHandlerError) { console.error(err); return problem(500, "Internal Server Error", "internal"); }`,
  );
  lines.push(
    // FRAMEWORK fault, not a domain one — hono raises `HTTPException` for the
    // faults it detects itself (a malformed JSON body is the common one, at
    // 400).  Without this arm it falls past every domain check into the
    // generic 500 below, reporting a CLIENT fault as a server fault.
    `    if (err instanceof HTTPException) { ${renderHonoLogCall("clientError", "error: err.message, status: err.status")} return c.body(frameworkProblemBody(err.status, err.message, c.req.path), err.status, { "content-type": "application/problem+json", "x-request-id": trace_id }); }`,
  );
  lines.push(`    console.error(err);`);
  lines.push(`    return problem(500, "Internal Server Error", "internal");`);
  lines.push(`  });`);
  lines.push("");
  lines.push(`  return app;`);
  lines.push(`}`);
  const file = lines.join("\n");
  if (!usingMikro) return `${file}\n`;
  // Body-scan the emitted routes for the mikro-only names: `raw` (the SQL
  // fragments) and each Row entity class a direct-table shape reads.  A
  // repository-sourced-only file references neither, so it stays free of both
  // imports — and of any dependency on the entity module.
  const rowClasses = [
    ...new Set(
      projections
        .filter((p) => p.query?.source)
        .map((p) => mikroRowClassFor(p, p.query!.source!))
        .filter((cls) => new RegExp(`\\b${cls}\\b`).test(file)),
    ),
  ].sort();
  const extra: string[] = [];
  if (/(?<!\.)\braw\(/.test(file)) extra.push(`import { raw } from "@mikro-orm/core";`);
  if (rowClasses.length > 0)
    extra.push(`import { ${rowClasses.join(", ")} } from "../db/entities";`);
  if (extra.length === 0) return `${file}\n`;
  // Splice after the EntityManager import, keeping the import block contiguous.
  const marker = `import { EntityManager } from "@mikro-orm/postgresql";`;
  return `${file.replace(marker, [marker, ...extra].join("\n"))}\n`;
}

/** One query-time projection route: `GET /<projName>` under `/projections`.
 *  Sources filtered aggregate rows via the synthesised `repo.<projName>()`
 *  find, bulk-loads each `join` follow, then projects each row through the
 *  `select` expressions — the query-time projection read, parameterised by the
 *  projection's own row shape. */
function emitQueryProjectionRoute(
  p: ProjectionIR,
  rawRead?: { table: string; where?: string },
  aggregateWhere?: string,
  /** Present ⇒ `persistence: mikroorm`: `where` is a MikroORM FilterQuery
   *  literal (or undefined for an unfiltered read).  The direct-table shapes
   *  below branch on it; the repository-sourced shape ignores it, being
   *  adapter-neutral. */
  mikro?: { where?: string },
): string[] {
  const T = upperFirst(p.name);
  const source = p.query!.source!;
  const aggSlug = snake(plural(source));
  const usesUser = queryProjectionUsesCurrentUser(p);
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/${snake(p.name)}",`);
  out.push(`    tags: ["projections", "${aggSlug}"],`);
  out.push(`    operationId: "projection${T}",`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${T}Response } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  const gate = p.query!.requires;
  const grouped = groupedAggregates(p);
  const aggregates = wholeTableAggregates(p);
  out.push(`  async (httpCtx) => {`);
  // The `requires` gate (and any currentUser-scoped filter) needs the request
  // principal in scope; a failing gate denies with 403 (ForbiddenError → 403)
  // BEFORE the query runs.
  if (usesUser || gate) {
    out.push(
      `    const currentUser = (httpCtx as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  if (gate) {
    out.push(`    if (!(${renderTsExpr(gate)})) throw new ForbiddenError("Forbidden");`);
  }
  // GROUPED AGGREGATION (`group by` — M-T4.2): one row per distinct
  // grouping-key combination, aggregates computed per group.  Same SQL
  // push-down rationale as the whole-table singleton below, but the response
  // is the LIST shape (an array of the declared row), so the read GROUPs BY —
  // and ORDERs BY, for a deterministic cross-backend read — exactly the
  // grouping columns, in one query.
  if (grouped && mikro) {
    const rowClass = mikroRowClassFor(p, source);
    const alias = "src";
    // SELECT: one raw fragment per grouping key + per aggregate, each aliased to
    // the projection field so the row comes back keyed like the drizzle one.
    const selects = [
      ...grouped.keys.map(
        (k) =>
          `raw(${JSON.stringify(`${mikroGroupKeySql(k.expr, alias)} as "${snake(k.field)}"`)})`,
      ),
      ...grouped.aggregates.map(
        (sel) =>
          `raw(${JSON.stringify(`${mikroAggregateSql(sel.aggregate, alias)} as "${snake(sel.field)}"`)})`,
      ),
    ];
    // GROUP BY / ORDER BY repeat the key expressions — each as its OWN `raw()`
    // call, because a raw fragment is single-use per query.
    const groupSql = grouped.groupBy.map((e) => mikroGroupKeySql(e, alias));
    out.push(`    const qb = db.createQueryBuilder(${rowClass}, ${JSON.stringify(alias)});`);
    out.push(`    qb.select([${selects.join(", ")}]);`);
    if (mikro.where) out.push(`    qb.where(${mikro.where});`);
    out.push(`    qb.groupBy([${groupSql.map((g) => `raw(${JSON.stringify(g)})`).join(", ")}]);`);
    out.push(
      `    qb.orderBy([${groupSql.map((g) => `{ [raw(${JSON.stringify(g)})]: "asc" }`).join(", ")}]);`,
    );
    const rowType = [
      ...grouped.keys.map((k) => `${snake(k.field)}: unknown`),
      ...grouped.aggregates.map((sel) => `${snake(sel.field)}: unknown`),
    ].join("; ");
    // `mapResults: false`.  MikroORM's default result mapping renames DB columns
    // back to ENTITY PROPERTY names, which silently rewrites any select alias
    // that happens to be a real column: a `customer_id` grouping key came back
    // as `customerId`, so reading `r.customer_id` yielded undefined and the wire
    // carried the string "undefined" (M-T6.23 slice 4 — found by the
    // `projection-groupby` behavioural case; the aggregate aliases were
    // unaffected precisely because `avg_lines` is not a column).  Verbatim
    // aliases keep the read keyed by what the SELECT actually asked for.
    out.push(`    const rows = await qb.execute<{ ${rowType} }[]>("all", false);`);
    out.push(`    const projected = rows.map((r) => ({`);
    for (const k of grouped.keys) {
      out.push(
        `      ${k.field}: ${coerceGroupKey(k, `r.${snake(k.field)}`, groupKeyOrThrow(k.expr), true)},`,
      );
    }
    for (const sel of grouped.aggregates) {
      out.push(`      ${sel.field}: ${coerceAggregate(sel, `r.${snake(sel.field)}`)},`);
    }
    out.push(`    }));`);
    out.push(`    return httpCtx.json(projected as z.infer<typeof ${T}Response>, 200);`);
    out.push(`  },`);
    out.push(`);`);
    return out;
  }
  // WHOLE-TABLE aggregation, mikro edition: the same push-down, one row out.
  if (aggregates && mikro) {
    const rowClass = mikroRowClassFor(p, source);
    const alias = "src";
    const selects = aggregates.map(
      (sel) =>
        `raw(${JSON.stringify(`${mikroAggregateSql(sel.aggregate, alias)} as "${snake(sel.field)}"`)})`,
    );
    out.push(`    const qb = db.createQueryBuilder(${rowClass}, ${JSON.stringify(alias)});`);
    out.push(`    qb.select([${selects.join(", ")}]);`);
    if (mikro.where) out.push(`    qb.where(${mikro.where});`);
    const rowType = aggregates.map((sel) => `${snake(sel.field)}: unknown`).join("; ");
    // `mapResults: false` — see the grouped branch above.
    out.push(`    const [row] = await qb.execute<{ ${rowType} }[]>("all", false);`);
    out.push(`    const projected = {`);
    for (const sel of aggregates) {
      out.push(`      ${sel.field}: ${coerceAggregate(sel, `row?.${snake(sel.field)}`)},`);
    }
    out.push(`    };`);
    out.push(`    return httpCtx.json(projected as z.infer<typeof ${T}Response>, 200);`);
    out.push(`  },`);
    out.push(`);`);
    return out;
  }
  if (grouped) {
    const sourceTable = `schema.${lowerFirst(plural(source))}`;
    const groupCols = grouped.groupBy.map((e) => groupKeyExpr(e, sourceTable)).join(", ");
    const cols = [
      ...grouped.keys.map((k) => `${k.field}: ${groupKeyExpr(k.expr, sourceTable, true)}`),
      ...grouped.aggregates.map((s) => `${s.field}: ${drizzleAggregate(s.aggregate, sourceTable)}`),
    ].join(", ");
    out.push(
      `    const rows = await db.select({ ${cols} }).from(${sourceTable})${
        aggregateWhere ? `.where(${aggregateWhere})` : ""
      }.groupBy(${groupCols}).orderBy(${groupCols});`,
    );
    out.push(`    const projected = rows.map((r) => ({`);
    for (const k of grouped.keys) {
      out.push(`      ${k.field}: ${coerceGroupKey(k, `r.${k.field}`, groupKeyOrThrow(k.expr))},`);
    }
    for (const s of grouped.aggregates) {
      out.push(`      ${s.field}: ${coerceAggregate(s, `r.${s.field}`)},`);
    }
    out.push(`    }));`);
    out.push(`    return httpCtx.json(projected as z.infer<typeof ${T}Response>, 200);`);
    out.push(`  },`);
    out.push(`);`);
    return out;
  }
  // WHOLE-TABLE AGGREGATION (read-path-architecture.md rev. 8's singleton) —
  // the aggregation pushes DOWN to SQL rather than loading rows and folding
  // them.  This is the whole point of the shape: the naive read is a `SELECT *`
  // over the source table with every row rehydrated into a domain object to
  // produce one integer, which is the scaling failure M-T2.6 removed from
  // `findAll`.  One row out, so the response is the row itself.
  if (aggregates) {
    const sourceTable = `schema.${lowerFirst(plural(source))}`;
    const cols = aggregates
      .map((s) => `${s.field}: ${drizzleAggregate(s.aggregate, sourceTable)}`)
      .join(", ");
    out.push(
      `    const [row] = await db.select({ ${cols} }).from(${sourceTable})${
        aggregateWhere ? `.where(${aggregateWhere})` : ""
      };`,
    );
    const projectedFields = aggregates
      .map((s) => `      ${s.field}: ${coerceAggregate(s, `row?.${s.field}`)},`)
      .join("\n");
    out.push(`    const projected = {`);
    out.push(...projectedFields.split("\n"));
    out.push(`    };`);
    out.push(`    return httpCtx.json(projected as z.infer<typeof ${T}Response>, 200);`);
    out.push(`  },`);
    out.push(`);`);
    return out;
  }
  // alias → { mapVar, idRow } — the loaded-map var and the source-row expression
  // that yields this alias's key (the join's `on <idRef>`, rendered off `r`).
  const aliasMap = new Map<string, { mapVar: string; idRow: string }>();
  // RAW-TABLE source on the mikro adapter (M-T6.23 slice 4, completed after an
  // owner review): a WORKFLOW source reads its saga-state Row, a PROJECTION
  // source the folded read-model Row.  `em.find` hands back ENTITIES whose
  // property names are exactly what the shared `select` projection reads off
  // `r`, so only the READ differs from drizzle — the projection body below is
  // untouched.
  //
  // This arm existed on drizzle only; without it the mikro path fell through to
  // the drizzle branch and emitted `db.select().from(schema.…)` into a file with
  // no `schema` import — a generate-then-`tsc`-fail, which is the exact silent
  // class M-T6.23 exists to kill.  No corpus fixture carries this shape, which
  // is why the runtime leg stayed green; `node-mikroorm-query-projections.test.ts`
  // now pins it.
  if (mikro && rawRead) {
    const rowClass = mikroRowClassFor(p, source);
    out.push(`    const rows = await db.find(${rowClass}, ${mikro.where ?? "{}"});`);
    const projectedFields = (p.query!.selects ?? [])
      .map((sel) => `      ${sel.field}: ${renderProjectionSelect(sel.expr, aliasMap)}`)
      .join(",\n");
    out.push(`    const projected = rows.map((r) => ({\n${projectedFields},\n    }));`);
    out.push(`    return httpCtx.json(projected as z.infer<typeof ${T}Response>, 200);`);
    out.push(`  },`);
    out.push(`);`);
    return out;
  }
  if (rawRead) {
    // RAW-TABLE source (WORKFLOW saga-state table or a folded PROJECTION's
    // `<Proj>Row` read-model table): read the table directly (no repository, no
    // `join` follows — validator-gated), applying the `where` in SQL.  The
    // `select` projection below reads the source row fields off each row exactly
    // like an aggregate candidate.
    out.push(
      `    const rows = await db.select().from(${rawRead.table})${rawRead.where ? `.where(${rawRead.where})` : ""};`,
    );
    const projectedFields = (p.query!.selects ?? [])
      .map((s) => `      ${s.field}: ${renderProjectionSelect(s.expr, aliasMap)}`)
      .join(",\n");
    out.push(`    const projected = rows.map((r) => ({\n${projectedFields},\n    }));`);
    out.push(`    return httpCtx.json(projected as z.infer<typeof ${T}Response>, 200);`);
    out.push(`  },`);
    out.push(`);`);
    return out;
  }
  out.push(`    const repo = new ${source}Repository(db, events);`);
  out.push(`    const rows = await repo.${lowerFirst(p.name)}(${usesUser ? "currentUser" : ""});`);
  // Bulk-load every `join` follow (dependency-ordered), then project.  Each
  // join binds an ALIAS (`c`) to the loaded-by-id map; a `select` reads through
  // that alias (`c.name`), rewritten to `<mapVar>.get(<idRowExpr> as string)!`.
  const pathToMap = new Map<string, { mapVar: string; aggName: string }>();
  const joins = p.query!.joins;
  const auxes = p.query!.auxiliaries;
  for (let i = 0; i < auxes.length; i++) {
    const aux = auxes[i]!;
    const join = joins[i];
    const repoVar = `${lowerFirst(aux.aggName)}Repo`;
    out.push(`    const ${repoVar} = new ${aux.aggName}Repository(db, events);`);
    const idsSource = idsSourceForAux(aux, pathToMap);
    out.push(
      `    const ${aux.mapVar} = new Map((await ${repoVar}.findManyByIds(${idsSource})).map((a) => [a.id as string, a]));`,
    );
    pathToMap.set(aux.path.join("."), { mapVar: aux.mapVar, aggName: aux.aggName });
    if (join)
      aliasMap.set(join.alias, {
        mapVar: aux.mapVar,
        idRow: renderTsExpr(join.idRef, { thisName: "r" }),
      });
  }
  if ((p.query!.selects?.length ?? 0) === 0) {
    // SHORTHAND (no `select`): the row IS the source aggregate's wire shape, so
    // serialise each source row through the repository's `toWire` (the same
    // projection the aggregate's own read routes use) — no per-field mapping.
    out.push(`    const projected = rows.map((r) => repo.toWire(r));`);
  } else {
    const projectedFields = (p.query!.selects ?? [])
      .map((s) => `      ${s.field}: ${renderProjectionSelect(s.expr, aliasMap)}`)
      .join(",\n");
    out.push(`    const projected = rows.map((r) => ({\n${projectedFields},\n    }));`);
  }
  out.push(`    return httpCtx.json(projected as z.infer<typeof ${T}Response>, 200);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** The MikroORM Row entity class a direct-table projection shape reads.  Mirrors
 *  the three source kinds the drizzle path names a table for: an AGGREGATE
 *  source reads `<Agg>Row`, a WORKFLOW source its saga-state Row, a PROJECTION
 *  source the folded read-model Row — the same three classes `renderMikroEntities`
 *  emits, so the names cannot drift. */
function mikroRowClassFor(p: ProjectionIR, source: string): string {
  const kind = p.query?.sourceKind;
  if (kind === "workflow") return `${upperFirst(source)}Row`;
  if (kind === "projection") return `${upperFirst(source)}Row`;
  return `${source}Row`;
}

/** A projection `where` as a MikroORM FilterQuery literal.
 *
 *  Throws on a predicate outside the adapter's subset, and that is deliberate:
 *  `validateFindPredicateAdapterSupport` now walks query-time projection filters
 *  too (`loom.find-predicate-unsupported`), so reaching here with an unlowerable
 *  predicate is an internal contradiction, exactly like `aggregateColumn`'s
 *  non-column argument.  Swallowing it would drop the filter and answer a
 *  plausible WRONG number. */
function mikroFilterFor(filter: ExprIR): string {
  return whereToMikroFilter(filter);
}

/** The SQL aggregate expression for one `select`, aliased column-qualified so it
 *  is unambiguous inside the QueryBuilder's own FROM alias. */
function mikroAggregateSql(agg: ProjectionAggregateIR, alias: string): string {
  if (agg.op === "count" || !agg.arg) return "count(*)";
  return `${agg.op}(${mikroAggregateColumn(agg.arg, alias)})`;
}

/** The column an aggregation reads, as `<alias>."<snake_column>"`.  Mirrors
 *  `aggregateColumn`: the argument is a source-row member access, and the mikro
 *  Row's DB column is the snake_cased property (MikroORM's underscored naming
 *  strategy, which is what every raw statement this adapter emits assumes). */
function mikroAggregateColumn(arg: ExprIR, alias: string): string {
  if (arg.kind === "member") return `${alias}."${snake(arg.member)}"`;
  throw new Error("internal: a whole-table aggregation argument must be a source column reference");
}

/** The SQL for one grouping key — the mikro twin of `groupKeyExpr`.  A BARE key
 *  is the qualified column; a COMPUTED key is the same Postgres function the
 *  drizzle intrinsic snippet emits (`date_trunc('day', …)`), spelled directly so
 *  the SELECT, GROUP BY and ORDER BY carry byte-identical text — which is what
 *  makes Postgres accept the grouped select. */
function mikroGroupKeySql(e: ExprIR, alias: string): string {
  const key = groupKeyOrThrow(e);
  const col = `${alias}."${snake(key.column)}"`;
  if (!key.transform) return col;
  const fn = MIKRO_GROUP_KEY_TRANSFORM_SQL[key.transform];
  if (!fn) {
    throw new Error(
      `internal: no SQL for grouping transform '${key.transform}' on the mikroorm adapter — the transform table and this one disagree`,
    );
  }
  return fn(col);
}

/** Postgres SQL per supported grouping transform.  Deliberately the SAME
 *  function the drizzle `DRIZZLE_INTRINSIC_SQL["datetime.startOfDay"]` snippet
 *  builds, so a bucketed key groups identically on both adapters. */
const MIKRO_GROUP_KEY_TRANSFORM_SQL: Record<
  GroupKey["transform"] & string,
  (col: string) => string
> = {
  startOfDay: (col) => `date_trunc('day', ${col})`,
};

/** The Drizzle aggregate call for one `select`.  `count` counts ROWS (no
 *  column); the rest take the aggregated column, which is source-row-rooted so
 *  it renders as the plain `schema.<table>.<field>` ref every other predicate
 *  in this file uses. */
function drizzleAggregate(agg: ProjectionAggregateIR, sourceTable: string): string {
  if (agg.op === "count" || !agg.arg) return "count()";
  return `${agg.op}(${aggregateColumn(agg.arg, sourceTable)})`;
}

/** The column an aggregation reads, as a Drizzle ref.  The argument arrives
 *  lowered against the source candidate, so `sum(o.total)` is `this.total` —
 *  a member access whose name IS the schema column key. */
function aggregateColumn(arg: ExprIR, sourceTable: string): string {
  if (arg.kind === "member") return `${sourceTable}.${arg.member}`;
  // Anything else is a computed expression over the row, which SQL would have
  // to evaluate per row before aggregating.  Not reachable: the validator only
  // normalises a plain column reference into `select.aggregate`.
  throw new Error("internal: a whole-table aggregation argument must be a source column reference");
}

/** Coerce one Drizzle aggregate result to the projection row's declared wire
 *  type.  Postgres returns `numeric` aggregates as STRINGS through the driver
 *  (and `NULL` over an empty table), so this is load-bearing rather than
 *  cosmetic — an uncoerced `sum` would ship a string where the row declares a
 *  number, or `null` where it declares a value.
 *
 *  `count` is the one operator with a meaningful zero: counting no rows is 0,
 *  not absent.  `sum` over no rows is `NULL` in SQL; Loom's row type decides
 *  whether that surfaces as a zero or as `null`, and a non-optional declared
 *  field means zero. */
function coerceAggregate(sel: AggregateSelect, expr: string): string {
  const c = aggregateCoercion(sel);
  if (c.isCount) return `Number(${expr} ?? 0)`;
  // money pins the FIXED wire scale (RS-12) rather than echoing the scale the
  // driver hands back: `sum`/`max`/`min` return the STORED scale (2dp for a
  // `money("10.00")` write) and the empty-table default would ship a bare
  // `"0"`, where this aggregate's own read route sends `.toFixed(4)` (#2549).
  // `Decimal` (not `Number`) because money can exceed float64's exact range.
  if (c.isMoney) {
    return c.optional
      ? `${expr} == null ? null : new Decimal(${expr}).toFixed(${MONEY_WIRE_SCALE})`
      : `new Decimal(${expr} ?? 0).toFixed(${MONEY_WIRE_SCALE})`;
  }
  if (c.optional) return `${expr} == null ? null : ${c.asString ? "String" : "Number"}(${expr})`;
  return c.asString ? `String(${expr} ?? "0")` : `Number(${expr} ?? 0)`;
}

/** Whether any projection here aggregates a `money` column — the gate for the
 *  `decimal.js` import `coerceAggregate` emits calls into.  Emitting the call
 *  without the import is a `TS2304`, so the flag and the import stay adjacent
 *  (the same discipline the elixir emitter applies to `__money_round/1`). */
function anyMoneyAggregate(projections: readonly ProjectionIR[]): boolean {
  return projections.some((p) => {
    const aggs = groupedAggregates(p)?.aggregates ?? wholeTableAggregates(p) ?? [];
    return aggs.some((a) => aggregateCoercion(a).isMoney);
  });
}

/** The validated grouping key an expression names.  The validator pins every
 *  `group by` entry (and every key select) to a source column, optionally
 *  bucketed by one supported transform (`loom.projection-groupby-key-not-
 *  columnar`), so — mirroring `aggregateColumn` — a miss here is an internal
 *  error, not a fallback. */
function groupKeyOrThrow(e: ExprIR): GroupKey {
  const key = groupKeyOf(e);
  if (key === null) {
    throw new Error("internal: a group-by column must be a source column reference");
  }
  return key;
}

/** The Drizzle expression for one grouping key.  A BARE key is the plain
 *  `schema.<table>.<column>` ref (the column name IS the schema key); a
 *  COMPUTED key routes through the SAME `DRIZZLE_INTRINSIC_SQL` snippet a
 *  where-position intrinsic uses, so the SELECT, GROUP BY and ORDER BY all
 *  carry a byte-identical expression — which is what makes Postgres accept the
 *  grouped select at all (a SELECT expression must match a GROUP BY one). */
function groupKeyExpr(e: ExprIR, sourceTable: string, forSelect = false): string {
  const key = groupKeyOrThrow(e);
  const col = `${sourceTable}.${key.column}`;
  if (!key.transform) return col;
  const snippet = DRIZZLE_INTRINSIC_SQL[GROUP_KEY_TRANSFORM_INTRINSIC[key.transform]];
  if (!snippet) {
    throw new Error(
      `internal: no Drizzle snippet for grouping transform '${key.transform}' — the intrinsic catalogue and the transform table disagree`,
    );
  }
  const sql = snippet(col, []);
  // In the SELECT position the value is READ BACK, so it needs a decoder.
  // Drizzle does NOT apply the driver's type parser to a raw `sql` member: it
  // hands back the wire text verbatim (`"2026-08-01 00:00:00+00"`), NOT a
  // `Date` — a `.toISOString()` on it is a runtime TypeError that no `as Date`
  // cast can catch.  `.mapWith(<column>)` reuses that column's own
  // `mapFromDriverValue`, so a bucketed key decodes exactly like the bare
  // column it was computed from.  GROUP BY / ORDER BY read nothing back, so
  // they stay the plain snippet and keep matching the SELECT byte-for-byte.
  return forSelect ? `${sql}.mapWith(${col})` : sql;
}

/** The runtime TS type a transformed grouping key comes back as.  Drizzle types
 *  a raw `sql` select member `unknown`, so the projection has to re-assert what
 *  the driver actually returns before coercing it to the wire shape —
 *  `date_trunc` over a `timestamp` column still yields a `Date`. */
const GROUP_KEY_TRANSFORM_TS_TYPE: Record<GroupKey["transform"] & string, string> = {
  startOfDay: "Date",
};

/** Coerce one grouping-key column value to the projection row's DECLARED wire
 *  type — the key-side twin of `coerceAggregate`.  A key arrives as whatever
 *  its Drizzle column returns: enum → the wire string already, integer →
 *  number, uuid/text → string — those pass through untouched — but `numeric`
 *  (money/decimal) is a STRING through the driver and `timestamp` a `Date`,
 *  so the numeric family and datetime rewrap to match the row schema. */
function coerceGroupKey(
  sel: GroupKeySelect,
  expr: string,
  key: GroupKey,
  /** `persistence: mikroorm` — a transformed key needs DECODING, not a cast
   *  (see below). */
  usingMikro = false,
): string {
  const optional = sel.type.kind === "optional";
  const inner = sel.type.kind === "optional" ? sel.type.inner : sel.type;
  // A TRANSFORMED key is selected as a raw SQL expression, which neither adapter
  // types — but the two differ in what the DRIVER hands back, and that is a
  // runtime difference a cast cannot paper over:
  //
  //   drizzle   `.mapWith(<column>)` in the select reuses that column's own
  //             `mapFromDriverValue`, so a bucketed timestamp arrives as a
  //             `Date` and only needs its type re-asserted.
  //   mikroorm  a raw QueryBuilder select has no per-column decoder at all, so
  //             `date_trunc(...)` arrives as the wire STRING
  //             ("2026-08-01 00:00:00+00").  `as Date` compiles and then
  //             `.toISOString()` throws `is not a function` at runtime — which
  //             is exactly how this was found (M-T6.23 slice 4, the
  //             `projection-groupby` behavioural case 500'd on the computed
  //             `startOfDay` key while every other shape passed).
  const tsType = key.transform ? GROUP_KEY_TRANSFORM_TS_TYPE[key.transform] : undefined;
  const read = !key.transform
    ? expr
    : usingMikro && tsType === "Date"
      ? `new Date(${expr} as string)`
      : `(${expr} as ${tsType})`;
  const coerced = groupKeyWireExpr(inner, read);
  if (coerced === read) return read;
  return optional ? `${expr} == null ? null : ${coerced}` : coerced;
}

/** The non-null coercion for one grouping key's declared inner type. */
function groupKeyWireExpr(inner: TypeIR, expr: string): string {
  if (inner.kind === "id") return `String(${expr})`;
  if (inner.kind !== "primitive") return expr;
  switch (inner.name) {
    case "int":
    case "long":
    case "decimal":
      // `numeric` (decimal) comes back as a string; int/long are already
      // numbers, and `Number` keeps the three shapes on one rule.
      return `Number(${expr})`;
    case "money":
      // Wire-carried as a string (`zodForRow`), exactly like the aggregate
      // coercion's `asString` arm.
      return `String(${expr})`;
    case "datetime":
      return `${expr}.toISOString()`;
    default:
      return expr;
  }
}

/** Render a `select` expression against the source row `r` and the join alias
 *  maps.  A member access on a join alias (`c.name`, where `c` is a `join
 *  Customer as c on <idRef>`) rewrites to `<mapVar>.get(<idRow> as string)!.name`
 *  — the loaded-by-id aggregate for that row.  Source-candidate reads (`o.id`,
 *  bare `lineCount`) lower to `this`/row refs and render off `r` unchanged. */
function renderProjectionSelect(
  expr: ExprIR,
  aliasMap: Map<string, { mapVar: string; idRow: string }>,
): string {
  if (expr.kind === "member" && expr.receiver.kind === "ref") {
    const alias = aliasMap.get(expr.receiver.name);
    if (alias) return `${alias.mapVar}.get(${alias.idRow} as string)!.${expr.member}`;
  }
  return renderTsExpr(expr, { thisName: "r" });
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
export function idsSourceForAux(
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

/** Zod schema for a projection-output field's TS type.  Decimals stay as
 *  `z.number()`, ids emit as `z.string()`, enum values are emitted
 *  inline as a string-literal union pulled from `enumValues`. */
export function zodForRow(t: TypeIR, enumValues: Map<string, string[]>): string {
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
          // A5: expression-only primitive — never a projection-row / wire type.
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
