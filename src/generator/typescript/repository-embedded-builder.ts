import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import {
  aggregateUsesMoneyDeep,
  aggregateUsesPrincipalContextFilter,
  findUsesCurrentUser,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural } from "../../util/naming.js";
import { renderHonoStoreLogCall } from "../_obs/render-hono.js";
import { docTypeAlias, entityFromDocFn, entityToDocFn } from "./repository-document-builder.js";
import {
  buildFindWhereClause,
  hydrateRootExpr,
  lowerToDrizzle,
} from "./repository-find-builder.js";
import { combinePredicate, contextFilterPredicate } from "./repository-find-predicate.js";
import { collectEnums, collectValueObjects } from "./repository-imports-builder.js";
import { repoPortImportLine, repoPortName } from "./repository-port-builder.js";
import { projectFieldEntries } from "./repository-save-builder.js";
import { toWireMethod } from "./repository-wire-builder.js";

// ---------------------------------------------------------------------------
// Embedded-children (`shape(embedded)`) repository for the Hono/Drizzle
// backend — the queryable middle of the saving-shape spectrum.
//
// The aggregate ROOT stays a normal row (its scalar / `X id` fields are
// real columns), so the root is hydrated/saved exactly like the
// relational path (`hydrateRootExpr` / `projectFieldEntries` reused) and
// finds run as real SQL `WHERE` on the root.  Each CONTAINMENT folds
// into a single jsonb column — (de)serialised through the same
// `<part>ToDoc` / `<part>FromDoc` helpers the document repository uses.
// No part tables, no join tables.
//
// `toWire` is reused unchanged.
// ---------------------------------------------------------------------------

function isRefCollection(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "id";
}

/** Per-containment local-const declarations that materialise the jsonb
 *  columns into part instances, named `<c.name>` so `hydrateRootExpr`'s
 *  bare-name containment refs resolve to them.  `rowVar` is the loaded
 *  row.  Also covers reference-collection fields (jsonb id arrays). */
function hydrateLocals(agg: EnrichedAggregateIR, rowVar: string, indent: string): string[] {
  const out: string[] = [];
  for (const f of agg.fields) {
    if (isRefCollection(f.type) && f.type.kind === "array" && f.type.element.kind === "id") {
      const target = f.type.element.targetName;
      out.push(
        `${indent}const ${f.name} = ((${rowVar}.${f.name} ?? []) as string[]).map((s) => Ids.${target}Id(s));`,
      );
    }
  }
  for (const c of agg.contains) {
    const fromDoc = `${lowerFirst(c.partName)}FromDoc`;
    if (c.collection) {
      out.push(
        `${indent}const ${c.name} = ((${rowVar}.${c.name} ?? []) as ${c.partName}Doc[]).map((x) => ${fromDoc}(x));`,
      );
    } else if (c.optional) {
      // Optional single containment: the jsonb cell is NULL when unset, so guard
      // the deserialiser — a null hydrates to `null`, not a `<Part>FromDoc(null)`
      // crash (parity with the nullable column emitted in emit/schema.ts).
      out.push(
        `${indent}const ${c.name} = ${rowVar}.${c.name} == null ? null : ${fromDoc}(${rowVar}.${c.name} as ${c.partName}Doc);`,
      );
    } else {
      out.push(`${indent}const ${c.name} = ${fromDoc}(${rowVar}.${c.name} as ${c.partName}Doc);`);
    }
  }
  return out;
}

export function buildEmbeddedRepositoryFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  _emitTrace = false,
): string {
  const tableName = lowerFirst(plural(agg.name));
  const idVar = `Ids.${agg.name}Id`;
  const repoUsesUser = (repo?.finds ?? []).some(findUsesCurrentUser);

  // Drizzle ops the find where-clauses need (default eq/and/inArray; the
  // lowering adds ne/gt/or/… per filter shape).
  const drizzleOps = new Set<string>(["eq", "and", "inArray"]);
  for (const f of repo?.finds ?? []) {
    if (!f.filter) continue;
    const lowered = lowerToDrizzle(f.filter, tableName, ctx);
    if (lowered) for (const op of lowered.ops) drizzleOps.add(op);
  }
  // A `shape(embedded)` aggregate keeps its root scalars as real columns, so a
  // (non-principal) capability `filter` AND-s into every root read as a Drizzle
  // SQL predicate — the same machinery the relational repository uses (DEBT-02).
  // null when the aggregate has no such filter → embedded reads stay identical.
  const filterPred = contextFilterPredicate(agg, tableName, ctx, drizzleOps);

  // Root-row column entries (reused from the relational save projection)
  // + ref-collection jsonb arrays + one jsonb entry per containment.
  const rootEntries: string[] = [`id: aggregate.id as string`];
  for (const f of agg.fields) {
    if (isRefCollection(f.type)) {
      rootEntries.push(`${f.name}: aggregate.${f.name}.map((x) => x as string)`);
      continue;
    }
    for (const e of projectFieldEntries(f, "aggregate", ctx)) {
      rootEntries.push(`${e.fieldName}: ${e.expr}`);
    }
  }
  for (const c of agg.contains) {
    const toDoc = `${lowerFirst(c.partName)}ToDoc`;
    if (c.collection) {
      rootEntries.push(`${c.name}: aggregate.${c.name}.map((e) => ${toDoc}(e))`);
    } else if (c.optional) {
      // Optional single containment serialises to a nullable jsonb cell.
      rootEntries.push(
        `${c.name}: aggregate.${c.name} == null ? null : ${toDoc}(aggregate.${c.name})`,
      );
    } else {
      // Required single containment — the domain getter is typed `Part | null`
      // (defaulted on create); assert before serialising (parity with .NET's
      // `= default!` owned entity).
      rootEntries.push(`${c.name}: ${toDoc}(aggregate.${c.name}!)`);
    }
  }
  const rootRow = `{ ${rootEntries.join(", ")} }`;

  const findMethods = (repo?.finds ?? []).map((find) =>
    embeddedFindMethod(agg, find, ctx, filterPred),
  );

  const bodyStr = lines(
    `export class ${agg.name}Repository implements ${repoPortName(agg.name)} {`,
    // Explicit field declarations + constructor assignments, not
    // parameter properties — see emit/value-objects.ts's renderValueObject.
    `  private readonly db: Db;`,
    `  private readonly events: DomainEventDispatcher;`,
    `  constructor(`,
    `    db: Db,`,
    `    events: DomainEventDispatcher,`,
    `  ) {`,
    `    this.db = db;`,
    `    this.events = events;`,
    `  }`,
    "",
    `  async findById(id: ${idVar}): Promise<${agg.name} | null> {`,
    `    const rows = await this.db.select().from(schema.${tableName}).where(${combinePredicate(`eq(schema.${tableName}.id, id)`, filterPred)});`,
    `    const row = rows[0];`,
    `    ${renderHonoStoreLogCall("aggregateLoaded", `aggregate: "${agg.name}", id: id as string, found: !!row`)}`,
    `    if (!row) return null;`,
    ...hydrateLocals(agg, "row", "    "),
    `    return ${hydrateRootExpr(agg, "row", ctx)};`,
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
    `    const rows = await this.db.select().from(schema.${tableName}).where(${combinePredicate(`inArray(schema.${tableName}.id, ids)`, filterPred)});`,
    `    return rows.map((row) => {`,
    ...hydrateLocals(agg, "row", "      "),
    `      return ${hydrateRootExpr(agg, "row", ctx)};`,
    `    });`,
    `  }`,
    "",
    `  async save(aggregate: ${agg.name}): Promise<void> {`,
    `    const rootRow = ${rootRow};`,
    `    await this.db.insert(schema.${tableName}).values(rootRow).onConflictDoUpdate({ target: schema.${tableName}.id, set: rootRow });`,
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
    // Containment (de)serialisers — parts only; the root uses columns.
    ...agg.parts.flatMap((p) => [docTypeAlias(p, false, agg.name, ctx), ""]),
    ...agg.parts.flatMap((p) => [entityToDocFn(p, ctx), ""]),
    ...agg.parts.flatMap((p) => [entityFromDocFn(p, false, agg.name, ctx), ""]),
  );

  // Import narrowing — mirror buildRepositoryFile.
  const bodyScan = bodyStr
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const usedDrizzleOps = [...drizzleOps]
    // `op(` call or `op`…`` tagged template (the `sql` intrinsic wrapper).
    .filter((op) => new RegExp(`\\b${op}[(\\\`]`).test(bodyScan))
    .sort();
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
    aggregateUsesMoneyDeep(agg, ctx.valueObjects) && `import Decimal from "decimal.js";`,
    // Domain-side repository PORT this concrete implements (audit S7).
    repoPortImportLine(agg.name),
    `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`,
    `import { ${usedDrizzleOps.join(", ")} } from "drizzle-orm";`,
    `import * as schema from "../schema";`,
    repoUsesUser && `import type { User } from "../../auth/user-types";`,
    `import { ${domainImports} } from "../../domain/${lowerFirst(agg.name)}";`,
    voOrEnumImportLine,
    `import * as Ids from "../../domain/ids";`,
    `import { AggregateNotFoundError } from "../../domain/errors";`,
    `import type { DomainEventDispatcher } from "../../domain/events";`,
    // A principal-referencing capability filter (tenancy) weaves
    // `requireCurrentUser()` into every embedded root read (DEBT-02), the same
    // ambient-accessor path the relational builder uses — so import it.
    aggregateUsesPrincipalContextFilter(agg) &&
      `import { requireCurrentUser } from "../../auth/middleware";`,
    `import { requestLog } from "../../obs/als";`,
    "",
    `type Db = NodePgDatabase<typeof schema>;`,
    "",
    bodyStr,
    "",
  );
}

function embeddedFindMethod(
  agg: EnrichedAggregateIR,
  find: FindIR,
  ctx: EnrichedBoundedContextIR,
  filterPred: string | null,
): string {
  const tableName = lowerFirst(plural(agg.name));
  const usesUser = findUsesCurrentUser(find);
  const baseParams = find.params.map((p) => `${p.name}: ${tsFindParamType(p.type)}`);
  const params = (usesUser ? [...baseParams, "currentUser: User"] : baseParams).join(", ");
  const whereClause = buildFindWhereClause(agg, find, tableName, ctx, filterPred);
  const isArray = find.returnType.kind === "array";
  const isOptional = find.returnType.kind === "optional";
  const ret = isArray ? `${agg.name}[]` : isOptional ? `${agg.name} | null` : agg.name;
  const rowsExpr = isArray ? "result.length" : "result == null ? 0 : 1";
  // Map a loaded row → domain instance (root columns + containment jsonb).
  const mapRow = lines(
    `(row) => {`,
    ...hydrateLocals(agg, "row", "      "),
    `      return ${hydrateRootExpr(agg, "row", ctx)};`,
    `    }`,
  );
  const tail = isArray
    ? `const result = rows.map(${mapRow});`
    : isOptional
      ? `const result = rows.length > 0 ? [rows[0]!].map(${mapRow})[0]! : null;`
      : `const result = [rows[0]!].map(${mapRow})[0]!;`;
  return lines(
    `  async ${find.name}(${params}): Promise<${ret}> {`,
    `    const rows = await this.db.select().from(schema.${tableName})${whereClause};`,
    `    ${tail}`,
    `    ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: ${rowsExpr}`)}`,
    `    return result;`,
    `  }`,
  );
}

function tsFindParamType(t: TypeIR): string {
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
