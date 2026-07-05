import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EntityPartIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import {
  aggregateUsesMoney,
  aggregateUsesPrincipalContextFilter,
  findUsesCurrentUser,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural } from "../../util/naming.js";
import { renderHonoStoreLogCall } from "../_obs/render-hono.js";
import { renderTsExpr } from "./render-expr.js";
import { collectEnums, collectValueObjects } from "./repository-imports-builder.js";
import { toWireMethod } from "./repository-wire-builder.js";

// ---------------------------------------------------------------------------
// Document-shaped (`shape(document)`) repository for the Hono/Drizzle
// backend — the TS counterpart of the .NET document emit.
//
// A document aggregate persists as ONE jsonb column (`(id, data,
// version)`) instead of the normalised table-per-entity tree.  Where
// C# needs snapshot records + STJ converters (private setters), TS is
// structural: the repository serialises the aggregate's public getters
// into a plain object (`<entity>ToDoc`) and rebuilds it through the
// same `_rehydrate({...})` factory the normalised hydrate uses
// (`<entity>FromDoc`).  Contained parts nest; references ride as id
// strings; finds evaluate in-memory over the rehydrated documents.
//
// `toWire` is reused unchanged — it reads the domain instance's
// getters, not the DB row, so the wire contract is identical to the
// normalised path (and to .NET).
// ---------------------------------------------------------------------------

export function buildDocumentRepositoryFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  _emitTrace = false,
): string {
  const tableName = lowerFirst(plural(agg.name));
  const idVar = `Ids.${agg.name}Id`;
  const repoUsesUser = (repo?.finds ?? []).some(findUsesCurrentUser);
  // A principal-referencing (tenancy) capability filter evaluates the request
  // actor IN-APP over the rehydrated document (DEBT-02 Slice B): each read binds
  // `requireCurrentUser()` so the in-app predicate (`currentUser.tenantId`) can
  // read it.  Fail-closed — the accessor throws when unauthenticated.
  const usesPrincipalFilter = aggregateUsesPrincipalContextFilter(agg);
  const principalBind = usesPrincipalFilter
    ? `    const currentUser = requireCurrentUser();`
    : null;

  const findMethods = (repo?.finds ?? []).map((find) => documentFindMethod(agg, find, ctx));

  // Capability filter (e.g. soft-delete / tenancy) applied in-app on the by-id
  // reads so a hidden / cross-tenant record reads as not-found, matching the
  // find paths above.
  const capRec = documentCapabilityBody(agg, "rec");
  const capX = documentCapabilityBody(agg, "x");

  const bodyStr = lines(
    `export class ${agg.name}Repository {`,
    `  constructor(`,
    `    private readonly db: Db,`,
    `    private readonly events: DomainEventDispatcher,`,
    `  ) {}`,
    "",
    `  async findById(id: ${idVar}): Promise<${agg.name} | null> {`,
    `    const rows = await this.db.select().from(schema.${tableName}).where(eq(schema.${tableName}.id, id));`,
    `    const row = rows[0];`,
    `    ${renderHonoStoreLogCall("aggregateLoaded", `aggregate: "${agg.name}", id: id as string, found: !!row`)}`,
    `    if (!row) return null;`,
    // No capability filter → return the rehydrated doc directly (byte-identical
    // to the pre-DEBT-02 emission); with one, bind it and gate by the predicate.
    ...(capRec
      ? [
          ...(principalBind ? [principalBind] : []),
          `    const rec = ${lowerFirst(agg.name)}FromDoc(row.data as ${agg.name}Doc);`,
          `    if (!(${capRec})) return null;`,
          `    return rec;`,
        ]
      : [`    return ${lowerFirst(agg.name)}FromDoc(row.data as ${agg.name}Doc);`]),
    `  }`,
    "",
    `  async getById(id: ${idVar}): Promise<${agg.name}> {`,
    `    const found = await this.findById(id);`,
    `    if (!found) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
    `    return found;`,
    `  }`,
    "",
    `  async findManyByIds(ids: ${idVar}[]): Promise<${agg.name}[]> {`,
    `    if (ids.length === 0) return [];`,
    ...(principalBind && capX ? [principalBind] : []),
    `    const rows = await this.db.select().from(schema.${tableName}).where(inArray(schema.${tableName}.id, ids));`,
    `    return rows.map((r) => ${lowerFirst(agg.name)}FromDoc(r.data as ${agg.name}Doc))${capX ? `.filter((x) => ${capX})` : ""};`,
    `  }`,
    "",
    `  async save(aggregate: ${agg.name}): Promise<void> {`,
    `    const data = ${lowerFirst(agg.name)}ToDoc(aggregate);`,
    `    const existing = await this.db.select({ version: schema.${tableName}.version }).from(schema.${tableName}).where(eq(schema.${tableName}.id, aggregate.id));`,
    `    if (existing.length === 0) {`,
    `      await this.db.insert(schema.${tableName}).values({ id: aggregate.id as string, data, version: 1 });`,
    `    } else {`,
    `      await this.db.update(schema.${tableName}).set({ data, version: existing[0]!.version + 1 }).where(eq(schema.${tableName}.id, aggregate.id));`,
    `    }`,
    `    ${renderHonoStoreLogCall("repositorySave", `aggregate: "${agg.name}", id: aggregate.id as string`)}`,
    `    for (const event of aggregate.pullEvents()) {`,
    `      ${renderHonoStoreLogCall("eventDispatched", `event_type: (event as object).constructor.name, aggregate: "${agg.name}", id: aggregate.id as string`)}`,
    `      await this.events.dispatch(event);`,
    `    }`,
    `  }`,
    "",
    ...findMethods.flatMap((m) => [m, ""]),
    toWireMethod(agg, ctx),
    "",
    `}`,
    "",
    // Document (de)serialisers — module-level so they can recurse into
    // contained parts without widening the class surface.
    docTypeAlias(agg, true, agg.name, ctx),
    "",
    ...agg.parts.flatMap((p) => [docTypeAlias(p, false, agg.name, ctx), ""]),
    entityToDocFn(agg, ctx),
    "",
    ...agg.parts.flatMap((p) => [entityToDocFn(p, ctx), ""]),
    entityFromDocFn(agg, true, agg.name, ctx),
    "",
    ...agg.parts.flatMap((p) => [entityFromDocFn(p, false, agg.name, ctx), ""]),
  );

  // Import narrowing — mirror buildRepositoryFile so the file header
  // stays free of dead names (generated-code Biome gate).
  const bodyScan = bodyStr
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const voOrEnumImports = [...collectValueObjects(agg, ctx), ...collectEnums(agg, ctx)];
  const isValueUsed = (n: string): boolean =>
    new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyScan);
  const voOrEnumReferenced = voOrEnumImports.filter((n) => new RegExp(`\\b${n}\\b`).test(bodyScan));
  let voOrEnumImportLine: string | false = false;
  if (voOrEnumReferenced.length > 0) {
    const anyValue = voOrEnumReferenced.some(isValueUsed);
    voOrEnumImportLine = anyValue
      ? `import { ${voOrEnumReferenced.map((n) => (isValueUsed(n) ? n : `type ${n}`)).join(", ")} } from "../../domain/value-objects";`
      : `import type { ${voOrEnumReferenced.join(", ")} } from "../../domain/value-objects";`;
  }
  const partNames = agg.parts.map((p) => p.name);
  const domainImports = [agg.name, ...partNames].join(", ");

  return lines(
    "// Auto-generated.  Do not edit by hand.",
    aggregateUsesMoney(agg) && `import Decimal from "decimal.js";`,
    `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`,
    `import { eq, inArray } from "drizzle-orm";`,
    `import * as schema from "../schema";`,
    repoUsesUser && `import type { User } from "../../auth/user-types";`,
    `import { ${domainImports} } from "../../domain/${lowerFirst(agg.name)}";`,
    voOrEnumImportLine,
    `import * as Ids from "../../domain/ids";`,
    `import { AggregateNotFoundError } from "../../domain/errors";`,
    `import type { DomainEventDispatcher } from "../../domain/events";`,
    // A principal-referencing capability filter (tenancy) binds
    // `requireCurrentUser()` into the in-app document predicate (DEBT-02 Slice
    // B), the same ambient-accessor path the relational/embedded builders use.
    usesPrincipalFilter && `import { requireCurrentUser } from "../../auth/middleware";`,
    `import { requestLog } from "../../obs/als";`,
    "",
    `type Db = NodePgDatabase<typeof schema>;`,
    "",
    bodyStr,
    "",
  );
}

// --- find methods (in-memory over rehydrated documents) -------------------

/** A `shape(document)` aggregate stores every field inside the `data` jsonb
 *  column, so a capability `filter` can't be a SQL column predicate — it's
 *  applied in-app against the rehydrated aggregate (the read already
 *  deserialises every row, so this matches the document read model).  Returns
 *  the boolean body under `varName` (`!varName.isDeleted`), AND-ed across ALL
 *  the aggregate's filters, or null.  A principal/tenancy predicate renders its
 *  `currentUser.<claim>` access against a `currentUser` binding the caller
 *  introduces (`requireCurrentUser()` for by-id reads, the find's own
 *  `currentUser` param when it has one) — DEBT-02 Slice B. */
export function documentCapabilityBody(agg: EnrichedAggregateIR, varName: string): string | null {
  const preds = (agg.contextFilters ?? []).map(
    (p) => `(${renderTsExpr(p, { thisName: varName })})`,
  );
  return preds.length > 0 ? preds.join(" && ") : null;
}

function documentFindMethod(
  agg: EnrichedAggregateIR,
  find: FindIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const tableName = lowerFirst(plural(agg.name));
  const usesUser = findUsesCurrentUser(find);
  const baseParams = find.params.map((p) => `${p.name}: ${tsParamType(p.type)}`);
  const params = (usesUser ? [...baseParams, "currentUser: User"] : baseParams).join(", ");
  const pred = findPredicate(agg, find, ctx);
  const isArray = find.returnType.kind === "array";
  const isOptional = find.returnType.kind === "optional";
  const ret = isArray ? `${agg.name}[]` : isOptional ? `${agg.name} | null` : agg.name;
  // Capability filter narrows `all` to the visible set BEFORE the find's own
  // predicate runs, so a find never returns a capability-hidden (soft-deleted)
  // record.
  const cap = documentCapabilityBody(agg, "x");
  const allExpr = cap ? `all.filter((x) => ${cap})` : "all";
  const selector = isArray
    ? pred
      ? `${allExpr}.filter(${pred})`
      : allExpr
    : isOptional
      ? `${allExpr}.find(${pred ?? "() => true"}) ?? null`
      : `${allExpr}.find(${pred ?? "() => true"})!`;
  const rowsExpr = isArray ? "result.length" : "result == null ? 0 : 1";
  // A principal capability filter needs `currentUser` in scope.  A find that
  // already takes a `currentUser: User` param (findUsesCurrentUser) reuses it;
  // otherwise bind the ambient accessor (fail-closed).
  const needsPrincipalBind = aggregateUsesPrincipalContextFilter(agg) && !usesUser;
  return lines(
    `  async ${find.name}(${params}): Promise<${ret}> {`,
    ...(needsPrincipalBind ? [`    const currentUser = requireCurrentUser();`] : []),
    `    const rows = await this.db.select().from(schema.${tableName});`,
    `    const all = rows.map((r) => ${lowerFirst(agg.name)}FromDoc(r.data as ${agg.name}Doc));`,
    `    const result = ${selector};`,
    `    ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: ${rowsExpr}`)}`,
    `    return result;`,
    `  }`,
  );
}

/** In-memory predicate `(x) => …` for a document find, or `undefined`
 *  for a parameterless filter-less find (findAll). */
export function findPredicate(
  agg: AggregateIR,
  find: FindIR,
  ctx: EnrichedBoundedContextIR,
): string | undefined {
  if (find.filter) {
    void ctx;
    return `(x) => ${renderTsExpr(find.filter, { thisName: "x" })}`;
  }
  if (find.params.length === 0) return undefined;
  const conds: string[] = [];
  for (const p of find.params) {
    const matched = agg.fields.find(
      (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
    );
    if (matched) conds.push(`x.${matched.name} === ${p.name}`);
  }
  if (conds.length === 0) return undefined;
  return `(x) => ${conds.join(" && ")}`;
}

// --- document (de)serialisers --------------------------------------------

export function entityToDocFn(
  entity: AggregateIR | EntityPartIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const fnName = `${lowerFirst(entity.name)}ToDoc`;
  const entries: string[] = [`id: a.id as string`];
  if (isPart(entity)) entries.push(`parentId: a.parentId as string`);
  for (const f of entity.fields) {
    entries.push(`${f.name}: ${serializeField(f.type, `a.${f.name}`, ctx)}`);
  }
  for (const c of entity.contains) {
    entries.push(
      c.collection
        ? `${c.name}: a.${c.name}.map((e) => ${lowerFirst(c.partName)}ToDoc(e))`
        : `${c.name}: ${lowerFirst(c.partName)}ToDoc(a.${c.name})`,
    );
  }
  return lines(
    `function ${fnName}(a: ${entity.name}): ${entity.name}Doc {`,
    `  return { ${entries.join(", ")} };`,
    `}`,
  );
}

export function entityFromDocFn(
  entity: AggregateIR | EntityPartIR,
  isRoot: boolean,
  rootName: string,
  ctx: EnrichedBoundedContextIR,
): string {
  const fnName = `${lowerFirst(entity.name)}FromDoc`;
  const entries: string[] = [`id: Ids.${entity.name}Id(d.id)`];
  if (!isRoot) entries.push(`parentId: Ids.${rootName}Id(d.parentId)`);
  for (const f of entity.fields) {
    entries.push(`${f.name}: ${deserializeField(f.type, `d.${f.name}`, ctx)}`);
  }
  for (const c of entity.contains) {
    entries.push(
      c.collection
        ? `${c.name}: (d.${c.name} ?? []).map((x) => ${lowerFirst(c.partName)}FromDoc(x))`
        : `${c.name}: ${lowerFirst(c.partName)}FromDoc(d.${c.name})`,
    );
  }
  return lines(
    `function ${fnName}(d: ${entity.name}Doc): ${entity.name} {`,
    `  return ${entity.name}._rehydrate({ ${entries.join(", ")} });`,
    `}`,
  );
}

export function docTypeAlias(
  entity: AggregateIR | EntityPartIR,
  isRoot: boolean,
  rootName: string,
  ctx: EnrichedBoundedContextIR,
): string {
  const members: string[] = ["id: string"];
  if (!isRoot) members.push(`parentId: string`);
  void rootName;
  for (const f of entity.fields) members.push(`${f.name}: ${docFieldType(f.type, ctx)}`);
  for (const c of entity.contains) {
    members.push(c.collection ? `${c.name}: ${c.partName}Doc[]` : `${c.name}: ${c.partName}Doc`);
  }
  return `type ${entity.name}Doc = { ${members.join("; ")} };`;
}

function isPart(e: AggregateIR | EntityPartIR): e is EntityPartIR {
  return !("operations" in e);
}

export function serializeField(t: TypeIR, accessor: string, ctx: EnrichedBoundedContextIR): string {
  if (t.kind === "optional") {
    return `(${accessor} == null ? null : ${serializeField(t.inner, accessor, ctx)})`;
  }
  if (t.kind === "primitive") {
    if (t.name === "money") return `${accessor}.toString()`;
    if (t.name === "datetime") return `${accessor}.toISOString()`;
    return accessor;
  }
  if (t.kind === "id") return `${accessor} as string`;
  if (t.kind === "enum") return accessor;
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return accessor;
    return `{ ${vo.fields.map((vf) => `${vf.name}: ${serializeField(vf.type, `${accessor}.${vf.name}`, ctx)}`).join(", ")} }`;
  }
  if (t.kind === "array") {
    if (t.element.kind === "id") return `${accessor}.map((x) => x as string)`;
    return `${accessor}.map((x) => ${serializeField(t.element, "x", ctx)})`;
  }
  return accessor;
}

export function deserializeField(
  t: TypeIR,
  accessor: string,
  ctx: EnrichedBoundedContextIR,
): string {
  if (t.kind === "optional") {
    return `(${accessor} == null ? null : ${deserializeField(t.inner, accessor, ctx)})`;
  }
  if (t.kind === "primitive") {
    if (t.name === "money") return `new Decimal(${accessor})`;
    if (t.name === "datetime") return `new Date(${accessor})`;
    if (t.name === "decimal") return `Number(${accessor})`;
    return accessor;
  }
  if (t.kind === "id") return `Ids.${t.targetName}Id(${accessor})`;
  if (t.kind === "enum") return `${accessor} as ${t.name}`;
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return accessor;
    return `new ${vo.name}(${vo.fields.map((vf) => deserializeField(vf.type, `${accessor}.${vf.name}`, ctx)).join(", ")})`;
  }
  if (t.kind === "array") {
    if (t.element.kind === "id") {
      return `(${accessor} ?? []).map((s: string) => Ids.${t.element.targetName}Id(s))`;
    }
    return `(${accessor} ?? []).map((x) => ${deserializeField(t.element, "x", ctx)})`;
  }
  return accessor;
}

export function docFieldType(t: TypeIR, ctx: EnrichedBoundedContextIR): string {
  if (t.kind === "optional") return `${docFieldType(t.inner, ctx)} | null`;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
      case "decimal":
        return "number";
      case "bool":
        return "boolean";
      case "json":
        return "unknown";
      default:
        // string / guid / money / datetime — all carried as strings in JSON.
        return "string";
    }
  }
  if (t.kind === "id" || t.kind === "enum") return "string";
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return "unknown";
    return `{ ${vo.fields.map((vf) => `${vf.name}: ${docFieldType(vf.type, ctx)}`).join("; ")} }`;
  }
  if (t.kind === "array") return `${docFieldType(t.element, ctx)}[]`;
  return "unknown";
}

export function tsParamType(t: TypeIR): string {
  if (t.kind === "id") return `Ids.${t.targetName}Id`;
  if (t.kind === "enum") return t.name;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
      case "decimal":
        return "number";
      case "money":
        return "Decimal";
      case "bool":
        return "boolean";
      case "datetime":
        return "Date";
      default:
        return "string";
    }
  }
  return "string";
}
