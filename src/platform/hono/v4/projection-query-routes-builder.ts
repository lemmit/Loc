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

export function buildQueryProjectionsFile(ctx: EnrichedBoundedContextIR): string {
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
  const allAggs = new Set([...sourceAggs, ...followAggs]);
  const usesEvents =
    projections.some((p) => (p.query?.auxiliaries.length ?? 0) > 0) || sourceAggs.size > 0;
  const needsIds = projections.some((p) =>
    (p.query?.auxiliaries ?? []).some((a) => a.path.length >= 1),
  );

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  lines.push(`import { newApp } from "./problem-details";`);
  lines.push(
    `import { DomainError, AggregateNotFoundError, ForbiddenError, ExternHandlerError } from "../domain/errors";`,
  );
  lines.push(`import { type DomainEventDispatcher } from "../domain/events";`);
  lines.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  // `schema` is normally needed only for `NodePgDatabase<typeof schema>` — a
  // TYPE position — but the two paths that query a table DIRECTLY (a raw-table
  // source, and a whole-table aggregation) name `schema.<table>` as a VALUE.
  // A type-only import makes that `TS1361: 'schema' cannot be used as a value`,
  // which no test caught because no `.ddd` in the repo exercises either path.
  // A value import satisfies the type position too, so this is a widening;
  // projections that need neither keep the type-only import byte-for-byte.
  const schemaAsValue = rawReads.size > 0 || aggWheres.size > 0;
  lines.push(
    schemaAsValue
      ? `import * as schema from "../db/schema";`
      : `import type * as schema from "../db/schema";`,
  );
  if (rawDrizzleOps.size > 0) {
    lines.push(`import { ${[...rawDrizzleOps].sort().join(", ")} } from "drizzle-orm";`);
  }
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
  lines.push(`  db: NodePgDatabase<typeof schema>,`);
  lines.push(`  ${usesEvents ? "events" : "_events"}: DomainEventDispatcher,`);
  lines.push(`): OpenAPIHono {`);
  lines.push(`  const app = newApp();`);
  lines.push("");

  for (const p of projections) {
    lines.push(
      ...emitQueryProjectionRoute(p, rawReads.get(p.name), aggWheres.get(p.name)).map(
        (l) => `  ${l}`,
      ),
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
    // RS-26 — sanitized; the inner exception reaches the log, not the wire.
    `    if (err instanceof ExternHandlerError) { console.error(err); return problem(500, "Internal Server Error", "internal"); }`,
  );
  lines.push(`    console.error(err);`);
  lines.push(`    return problem(500, "Internal Server Error", "internal");`);
  lines.push(`  });`);
  lines.push("");
  lines.push(`  return app;`);
  lines.push(`}`);
  return `${lines.join("\n")}\n`;
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
  if (c.optional) return `${expr} == null ? null : ${c.asString ? "String" : "Number"}(${expr})`;
  return c.asString ? `String(${expr} ?? "0")` : `Number(${expr} ?? 0)`;
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
function coerceGroupKey(sel: GroupKeySelect, expr: string, key: GroupKey): string {
  const optional = sel.type.kind === "optional";
  const inner = sel.type.kind === "optional" ? sel.type.inner : sel.type;
  // A TRANSFORMED key is selected as a raw `sql` expression, which Drizzle
  // types `unknown` — re-assert the driver's runtime type before coercing.
  const read = key.transform ? `(${expr} as ${GROUP_KEY_TRANSFORM_TS_TYPE[key.transform]})` : expr;
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
