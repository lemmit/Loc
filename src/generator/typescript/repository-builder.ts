import { wireShapeFor } from "../../ir/enrichments.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  FieldIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../ir/loom-ir.js";
import { findUsesCurrentUser, viewUsesCurrentUser } from "../../ir/loom-ir.js";
import { camel, pascal, plural } from "../../util/naming.js";
import { renderTsExpr } from "./render-expr.js";
import { valueObjectColumnNames } from "./templates.js";

// ---------------------------------------------------------------------------
// Generates the TypeScript repository file for an aggregate.
//
// The repository shape is fixed:
//   - `findById(id)` loads root + all contained part rows in a transaction
//     and reconstructs the aggregate tree
//   - `getById(id)` is `findById` with a not-found error
//   - `save(aggregate)` upserts root, then diff-syncs each contained
//     collection (insert new + update existing + delete removed) inside a
//     transaction, then dispatches drained domain events
//   - one method per repository-defined `find` query, body filled by
//     convention-based parameter-name → property-name matching
//
// All projection logic (Domain ↔ Drizzle row) is generated procedurally
// so type-safety in the output survives strict `tsc`.
// ---------------------------------------------------------------------------

export function buildRepositoryFile(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): string {
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  // Walk every find's filter to figure out which Drizzle operators
  // we'll need.  Default operators (eq / and / inArray) are always
  // pulled in; the lowering may add ne / gt / gte / lt / lte / or /
  // not depending on the expression shape.
  const drizzleOps = new Set<string>(["eq", "and", "inArray"]);
  // Walk find filters AND any matching view filters — both lower to
  // Drizzle predicates on the same table and share the same operator
  // import surface.
  const viewFilters = ctx.views
    .filter((v) => v.aggregateName === agg.name && v.filter)
    .map((v) => v.filter!);
  const allFilters = [
    ...(repo?.finds ?? [])
      .map((f) => f.filter)
      .filter((x): x is import("../../ir/loom-ir.js").ExprIR => !!x),
    ...viewFilters,
  ];
  for (const f of allFilters) {
    const lowered = lowerToDrizzle(f, camel(plural(agg.name)), ctx);
    if (lowered) for (const op of lowered.ops) drizzleOps.add(op);
  }
  lines.push(`import { ${[...drizzleOps].sort().join(", ")} } from "drizzle-orm";`);
  lines.push(`import * as schema from "../schema";`);
  // If any find or matching view filter references
  // currentUser, the per-method signature gains a `currentUser: User`
  // parameter that the closure-captured Drizzle predicate reads.
  // Pull the User type in as a type-only import so the file
  // compiles even when the verifier hook isn't wired yet.
  const repoUsesUser =
    (repo?.finds ?? []).some(findUsesCurrentUser) ||
    ctx.views.filter((v) => v.aggregateName === agg.name).some(viewUsesCurrentUser);
  if (repoUsesUser) {
    lines.push(`import type { User } from "../../auth/user-types";`);
  }
  // Imports for domain types
  const partNames = agg.parts.map((p) => p.name);
  const domainImports = [agg.name, ...partNames].join(", ");
  lines.push(`import { ${domainImports} } from "../../domain/${camel(agg.name)}";`);
  const valueObjectsUsed = collectValueObjects(agg, ctx);
  const enumsUsed = collectEnums(agg, ctx);
  const voOrEnumImports = [...valueObjectsUsed, ...enumsUsed];
  if (voOrEnumImports.length > 0) {
    lines.push(`import { ${voOrEnumImports.join(", ")} } from "../../domain/value-objects";`);
  }
  lines.push(`import * as Ids from "../../domain/ids";`);
  lines.push(`import { AggregateNotFoundError } from "../../domain/errors";`);
  lines.push(`import type { DomainEventDispatcher } from "../../domain/events";`);
  lines.push("");
  lines.push(`type Db = NodePgDatabase<typeof schema>;`);
  lines.push(`type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];`);
  lines.push("");

  lines.push(`export class ${agg.name}Repository {`);
  lines.push(`  constructor(`);
  lines.push(`    private readonly db: Db,`);
  lines.push(`    private readonly events: DomainEventDispatcher,`);
  lines.push(`  ) {}`);
  lines.push("");

  // findById
  lines.push(...findByIdMethod(agg, ctx));
  lines.push("");

  // getById
  lines.push(`  async getById(id: Ids.${agg.name}Id): Promise<${agg.name}> {`);
  lines.push(`    const found = await this.findById(id);`);
  lines.push(`    if (!found) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`);
  lines.push(`    return found;`);
  lines.push(`  }`);
  lines.push("");

  // findManyByIds — bulk loader used by views that follow `Id<X>`
  // references in bind expressions (slice 3).  Same hydration path
  // as the array-return finds; filter is a single `inArray`.
  lines.push(...findManyByIdsMethod(agg, ctx));
  lines.push("");

  // save
  lines.push(...saveMethod(agg, ctx));
  lines.push("");

  // Find queries
  if (repo) {
    for (const find of repo.finds) {
      lines.push(...findQueryMethod(agg, find, ctx));
      lines.push("");
    }
  }

  // Views — context-level saved queries whose source is this
  // aggregate.  Each lowers to a parameterless find emitted the
  // same way as a repository find, so the validator's queryable
  // checks + the existing bulk hydration all work for free.
  for (const view of ctx.views.filter((v) => v.aggregateName === agg.name)) {
    const synthesised: FindIR = {
      name: camel(view.name),
      params: [],
      returnType: { kind: "array", element: { kind: "entity", name: agg.name } },
      filter: view.filter,
    };
    lines.push(...findQueryMethod(agg, synthesised, ctx));
    lines.push("");
  }

  // toWire — domain instance → wire DTO (plain object).  Used by the
  // Hono routes layer to serialize responses; the shape mirrors the
  // .NET <Agg>Response record so the cross-check sees identical specs.
  lines.push(...toWireMethod(agg, ctx));
  lines.push("");

  lines.push(`}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// toWire — domain → wire DTO serializer (matches the routes-builder's
// `<Agg>Response` zod schema; see routes-builder.ts).
// ---------------------------------------------------------------------------

function toWireMethod(agg: AggregateIR, ctx: BoundedContextIR): string[] {
  const lines: string[] = [];
  lines.push(`  toWire(root: ${agg.name}): unknown {`);
  lines.push(`    return ${wireProjectionEntity(agg, "root", ctx)};`);
  lines.push(`  }`);
  return lines;
}

function wireProjectionEntity(
  ent: AggregateIR | EntityPartIR,
  varExpr: string,
  ctx: BoundedContextIR,
): string {
  // Single canonical walk — see `agg.wireShape` (populated by
  // src/ir/enrichments.ts).  This
  // serializer feeds repo.toWire(); its output's keys must line up
  // with the route's response Zod schema and the .NET DTO.  Single
  // canonical walk populated by `enrichLoomModel`.
  const fields = wireShapeFor(ent);
  const parts: string[] = [];
  for (const wf of fields) {
    if (wf.source === "id") {
      parts.push(`id: ${varExpr}.id as string`);
      continue;
    }
    if (wf.source === "containment") {
      const partName =
        wf.type.kind === "array" && wf.type.element.kind === "entity"
          ? wf.type.element.name
          : wf.type.kind === "entity"
            ? wf.type.name
            : "";
      const partIR = ctx.aggregates.flatMap((a) => a.parts).find((p) => p.name === partName);
      if (!partIR) continue;
      if (wf.type.kind === "array") {
        parts.push(
          `${wf.name}: ${varExpr}.${wf.name}.map((__e: ${partIR.name}) => (${wireProjectionEntity(partIR, "__e", ctx)}))`,
        );
      } else {
        parts.push(`${wf.name}: ${wireProjectionEntity(partIR, `${varExpr}.${wf.name}`, ctx)}`);
      }
      continue;
    }
    // property or derived — both reach the value via the same getter
    // on the domain class.
    parts.push(
      `${wf.name}: ${wireProjectionValue(`${varExpr}.${wf.name}`, wf.type, ctx, wf.optional)}`,
    );
  }
  return `{ ${parts.join(", ")} }`;
}

function wireProjectionValue(
  expr: string,
  t: TypeIR,
  ctx: BoundedContextIR,
  optional: boolean,
): string {
  if (t.kind === "optional") {
    return `(${expr} == null ? null : ${wireProjectionValue(expr, t.inner, ctx, true)})`;
  }
  if (t.kind === "primitive") {
    if (t.name === "datetime")
      return optional
        ? `(${expr} == null ? null : (${expr} as Date).toISOString())`
        : `(${expr} as Date).toISOString()`;
    // decimal: JSON number — .NET serializes decimal the same way, so
    // both backends round-trip identically.
    return expr;
  }
  if (t.kind === "id") return `${expr} as string`;
  if (t.kind === "enum") return `${expr} as string`;
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return expr;
    const fields = vo.fields
      .map((vf) => `${vf.name}: ${wireProjectionValue(`${expr}.${vf.name}`, vf.type, ctx, false)}`)
      .join(", ");
    if (optional) {
      return `(${expr} == null ? null : { ${fields} })`;
    }
    return `{ ${fields} }`;
  }
  if (t.kind === "array") {
    return `${expr}.map((__a: never) => (${wireProjectionValue("__a", t.element, ctx, false)}))`;
  }
  if (t.kind === "entity") return expr;
  return expr;
}

// ---------------------------------------------------------------------------
// findById — load root, load each part collection, hydrate
// ---------------------------------------------------------------------------

function findManyByIdsMethod(agg: AggregateIR, ctx: BoundedContextIR): string[] {
  const lines: string[] = [];
  const tableName = camel(plural(agg.name));
  lines.push(`  async findManyByIds(ids: Ids.${agg.name}Id[]): Promise<${agg.name}[]> {`);
  lines.push(`    if (ids.length === 0) return [];`);
  lines.push(
    `    const rootRows = await this.db.select().from(schema.${tableName}).where(inArray(schema.${tableName}.id, ids));`,
  );
  lines.push(`    if (rootRows.length === 0) return [];`);
  // Bulk-load every containment (collections + singulars) into per-
  // parent maps; mirrors the array-return path of findQueryMethod.
  const eagerContains = agg.contains
    .map((c) => ({ c, part: agg.parts.find((p) => p.name === c.partName) }))
    .filter((x): x is { c: typeof x.c; part: EntityPartIR } => !!x.part);
  if (eagerContains.length > 0) {
    lines.push(`    const __ids = rootRows.map((r) => r.id);`);
    for (const { c, part } of eagerContains) {
      const childTable = camel(plural(part.name));
      lines.push(
        `    const ${c.name}Rows = await this.db.select().from(schema.${childTable}).where(inArray(schema.${childTable}.parentId, __ids));`,
      );
      if (c.collection) {
        lines.push(`    const ${c.name}ByParent = new Map<string, ${part.name}[]>();`);
        lines.push(`    for (const r of ${c.name}Rows) {`);
        lines.push(`      const list = ${c.name}ByParent.get(r.parentId) ?? [];`);
        lines.push(`      list.push(${hydrateEntityExpr(part, "r", agg, ctx)});`);
        lines.push(`      ${c.name}ByParent.set(r.parentId, list);`);
        lines.push(`    }`);
      } else {
        lines.push(`    const ${c.name}ByParent = new Map<string, ${part.name}>();`);
        lines.push(`    for (const r of ${c.name}Rows) {`);
        lines.push(`      if (${c.name}ByParent.has(r.parentId)) continue;`);
        lines.push(
          `      ${c.name}ByParent.set(r.parentId, ${hydrateEntityExpr(part, "r", agg, ctx)});`,
        );
        lines.push(`    }`);
      }
    }
  }
  lines.push(`    return rootRows.map((root) => ${hydrateRootForFindAllExpr(agg, "root", ctx)});`);
  lines.push(`  }`);
  return lines;
}

function findByIdMethod(agg: AggregateIR, ctx: BoundedContextIR): string[] {
  const lines: string[] = [];
  const tableName = camel(plural(agg.name));
  lines.push(`  async findById(id: Ids.${agg.name}Id): Promise<${agg.name} | null> {`);
  lines.push(`    return await this.db.transaction(async (tx) => {`);
  lines.push(
    `      const rootRows = await tx.select().from(schema.${tableName}).where(eq(schema.${tableName}.id, id));`,
  );
  lines.push(`      if (rootRows.length === 0) return null;`);
  lines.push(`      const root = rootRows[0]!;`);

  // Load child collections (only for `contains` on the root)
  for (const c of agg.contains) {
    const part = agg.parts.find((p) => p.name === c.partName);
    if (!part) continue;
    const childTable = camel(plural(part.name));
    if (c.collection) {
      lines.push(
        `      const ${c.name}Rows = await tx.select().from(schema.${childTable}).where(eq(schema.${childTable}.parentId, id));`,
      );
      lines.push(
        `      const ${c.name} = ${c.name}Rows.map((r) => ${hydrateEntityExpr(part, "r", agg, ctx)});`,
      );
    } else {
      lines.push(
        `      const ${c.name}Rows = await tx.select().from(schema.${childTable}).where(eq(schema.${childTable}.parentId, id)).limit(1);`,
      );
      lines.push(
        `      const ${c.name} = ${c.name}Rows.length > 0 ? ${hydrateEntityExpr(part, `${c.name}Rows[0]!`, agg, ctx)} : null;`,
      );
    }
  }

  // Hydrate root
  lines.push(`      return ${hydrateRootExpr(agg, "root", ctx)};`);
  lines.push(`    });`);
  lines.push(`  }`);
  return lines;
}

function hydrateRootExpr(agg: AggregateIR, rowVar: string, ctx: BoundedContextIR): string {
  const fields: string[] = [];
  fields.push(`id: Ids.${agg.name}Id(${rowVar}.id)`);
  for (const f of agg.fields) {
    fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx)}`);
  }
  for (const c of agg.contains) {
    fields.push(`${c.name}`);
  }
  return `${agg.name}._create({ ${fields.join(", ")} })`;
}

function hydrateEntityExpr(
  part: EntityPartIR,
  rowVar: string,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const fields: string[] = [];
  fields.push(`id: Ids.${part.name}Id(${rowVar}.id)`);
  fields.push(`parentId: Ids.${agg.name}Id(${rowVar}.parentId)`);
  for (const f of part.fields) {
    fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx)}`);
  }
  return `${part.name}._create({ ${fields.join(", ")} })`;
}

function hydrateFieldExpr(f: FieldIR, rowVar: string, ctx: BoundedContextIR): string {
  return hydrateValueExpr(f.name, f.type, rowVar, ctx, f.optional);
}

function hydrateValueExpr(
  fieldName: string,
  t: TypeIR,
  rowVar: string,
  ctx: BoundedContextIR,
  optional: boolean,
): string {
  const colExpr = `${rowVar}.${fieldName}`;
  if (t.kind === "optional") {
    return `(${colExpr} == null ? null : ${hydrateValueExpr(fieldName, t.inner, rowVar, ctx, true)})`;
  }
  if (t.kind === "primitive") {
    if (t.name === "decimal") return `Number(${colExpr})`;
    return colExpr;
  }
  if (t.kind === "id") {
    return `Ids.${t.targetName}Id(${colExpr})`;
  }
  if (t.kind === "enum") {
    return `${colExpr} as ${t.name}`;
  }
  if (t.kind === "valueobject") {
    const cols = valueObjectColumnNames(fieldName, t.name, ctx);
    const args = cols
      .map((c) => primitiveColumnRead(`${rowVar}.${c.columnName}`, c.type))
      .join(", ");
    if (optional) {
      return `(${rowVar}.${cols[0]!.columnName} == null ? null : new ${t.name}(${args}))`;
    }
    return `new ${t.name}(${args})`;
  }
  return colExpr;
}

function primitiveColumnRead(expr: string, t: TypeIR): string {
  if (t.kind === "primitive" && t.name === "decimal") return `Number(${expr})`;
  return expr;
}

// ---------------------------------------------------------------------------
// save — upsert root + diff-sync children + dispatch events
// ---------------------------------------------------------------------------

function saveMethod(agg: AggregateIR, ctx: BoundedContextIR): string[] {
  const lines: string[] = [];
  const tableName = camel(plural(agg.name));
  lines.push(`  async save(aggregate: ${agg.name}): Promise<void> {`);
  lines.push(`    await this.db.transaction(async (tx) => {`);
  lines.push(`      const rootRow = ${rootProjection(agg, "aggregate", ctx)};`);
  lines.push(
    `      await tx.insert(schema.${tableName}).values(rootRow).onConflictDoUpdate({ target: schema.${tableName}.id, set: rootRow });`,
  );
  for (const c of agg.contains) {
    if (!c.collection) continue;
    const part = agg.parts.find((p) => p.name === c.partName);
    if (!part) continue;
    const childTable = camel(plural(part.name));
    lines.push("");
    lines.push(
      `      const __existing${pascal(c.name)} = await tx.select({ id: schema.${childTable}.id }).from(schema.${childTable}).where(eq(schema.${childTable}.parentId, aggregate.id));`,
    );
    lines.push(
      `      const __existingIds${pascal(c.name)} = new Set(__existing${pascal(c.name)}.map((r) => r.id));`,
    );
    lines.push(
      `      const __currentIds${pascal(c.name)} = new Set(aggregate.${c.name}.map((e) => e.id as string));`,
    );
    lines.push(
      `      const __toDelete${pascal(c.name)} = [...__existingIds${pascal(c.name)}].filter((id) => !__currentIds${pascal(c.name)}.has(id));`,
    );
    lines.push(`      if (__toDelete${pascal(c.name)}.length > 0) {`);
    lines.push(
      `        await tx.delete(schema.${childTable}).where(and(eq(schema.${childTable}.parentId, aggregate.id), inArray(schema.${childTable}.id, __toDelete${pascal(c.name)})));`,
    );
    lines.push(`      }`);
    lines.push(`      for (const child of aggregate.${c.name}) {`);
    lines.push(`        const childRow = ${entityProjection(part, "child", ctx)};`);
    lines.push(
      `        await tx.insert(schema.${childTable}).values(childRow).onConflictDoUpdate({ target: schema.${childTable}.id, set: childRow });`,
    );
    lines.push(`      }`);
  }
  lines.push(`    });`);
  lines.push("");
  lines.push(`    for (const event of aggregate.pullEvents()) {`);
  lines.push(`      await this.events.dispatch(event);`);
  lines.push(`    }`);
  lines.push(`  }`);
  return lines;
}

function rootProjection(agg: AggregateIR, varExpr: string, ctx: BoundedContextIR): string {
  return projectionObject(varExpr, [
    { fieldName: "id", expr: `${varExpr}.id as string` },
    ...agg.fields.flatMap((f) => projectFieldEntries(f, varExpr, ctx)),
  ]);
}

function entityProjection(part: EntityPartIR, varExpr: string, ctx: BoundedContextIR): string {
  return projectionObject(varExpr, [
    { fieldName: "id", expr: `${varExpr}.id as string` },
    { fieldName: "parentId", expr: `${varExpr}.parentId as string` },
    ...part.fields.flatMap((f) => projectFieldEntries(f, varExpr, ctx)),
  ]);
}

function projectFieldEntries(
  f: FieldIR,
  varExpr: string,
  ctx: BoundedContextIR,
): { fieldName: string; expr: string }[] {
  return projectValueEntries(f.name, f.type, `${varExpr}.${f.name}`, ctx, f.optional);
}

function projectValueEntries(
  fieldName: string,
  t: TypeIR,
  valueExpr: string,
  ctx: BoundedContextIR,
  optional: boolean,
): { fieldName: string; expr: string }[] {
  if (t.kind === "optional") {
    return projectValueEntries(fieldName, t.inner, valueExpr, ctx, true);
  }
  if (t.kind === "primitive") {
    if (t.name === "decimal") {
      return [{ fieldName, expr: `String(${valueExpr})` }];
    }
    return [{ fieldName, expr: valueExpr }];
  }
  if (t.kind === "id") {
    return [{ fieldName, expr: `${valueExpr} as string` }];
  }
  if (t.kind === "enum") {
    return [{ fieldName, expr: valueExpr }];
  }
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return [{ fieldName, expr: valueExpr }];
    return vo.fields.flatMap((vf) => {
      const sub = `${valueExpr}.${vf.name}`;
      return projectValueEntries(`${fieldName}_${vf.name}`, vf.type, sub, ctx, optional);
    });
  }
  return [{ fieldName, expr: valueExpr }];
}

function projectionObject(
  _varExpr: string,
  entries: { fieldName: string; expr: string }[],
): string {
  return `{ ${entries.map((e) => `${e.fieldName}: ${e.expr}`).join(", ")} }`;
}


// ---------------------------------------------------------------------------
// Find queries — convention-based equality predicates
// ---------------------------------------------------------------------------

function findQueryMethod(agg: AggregateIR, find: FindIR, ctx: BoundedContextIR): string[] {
  const lines: string[] = [];
  const tableName = camel(plural(agg.name));
  // When the find's `where` references currentUser, the
  // method gains a trailing `currentUser: User` parameter that the
  // closure-captured Drizzle predicate reads from.  Hono routes /
  // workflow handlers thread the user from `c.get("currentUser")`
  // into the call.
  const usesUser = findUsesCurrentUser(find);
  const baseParams = find.params.map((p) => `${p.name}: ${tsTypeForReturn(p.type)}`);
  const params = (usesUser ? [...baseParams, "currentUser: User"] : baseParams).join(", ");
  let whereClause: string;
  if (find.filter) {
    // The IR validator (Layer ②) rejects any `where` clause that
    // can't lower to Drizzle's queryable subset, so by the time we
    // get here lowering always succeeds.  See validateLoomModel +
    // firstNonQueryableNode in src/ir/validate.ts.
    const lowered = lowerToDrizzle(find.filter, tableName, ctx);
    if (!lowered) {
      throw new Error(
        `internal: where-clause for find '${find.name}' on '${agg.name}' ` +
          "could not lower to Drizzle, but the validator should have caught this. " +
          "Please file a bug.",
      );
    }
    whereClause = `.where(${lowered.expr})`;
  } else {
    const conditions: string[] = [];
    for (const p of find.params) {
      const matched = agg.fields.find(
        (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
      );
      if (matched) {
        // Drizzle's `eq<T>(left, right)` infers `T` from the column's
        // TS type (plain `string` for `text(...)` columns).  Branded
        // id params (`Ids.CustomerId = string & {…}`) are structurally
        // assignable to `string`, so no cast is needed.  An older
        // version of this code wrote `${p.name} as never` defensively;
        // the cast hid type safety (a column rename desyncing from a
        // find name produced bad runtime SQL with no compile error)
        // and is gone now.
        conditions.push(`eq(schema.${tableName}.${matched.name}, ${p.name})`);
      }
    }
    whereClause =
      conditions.length === 0
        ? ""
        : `.where(${conditions.length === 1 ? conditions[0] : `and(${conditions.join(", ")})`})`;
  }

  if (find.returnType.kind === "array") {
    lines.push(`  async ${find.name}(${params}): Promise<${agg.name}[]> {`);
    lines.push(
      `    const rootRows = await this.db.select().from(schema.${tableName})${whereClause};`,
    );
    lines.push(`    if (rootRows.length === 0) return [];`);
    // Bulk-load every containment (collections + singulars).  Earlier
    // versions of this code only handled a SINGLE collection
    // containment per find — anything else was silently dropped, so a
    // `find ...(): Order[]` against an aggregate with `contains
    // shipping: Address` (singular) emitted code referencing an
    // undefined `shipping` variable.  Now we load each containment
    // into a per-parent Map and use a hydrate helper that reads from
    // those maps.
    const eagerContains = agg.contains
      .map((c) => ({ c, part: agg.parts.find((p) => p.name === c.partName) }))
      .filter((x): x is { c: typeof x.c; part: EntityPartIR } => !!x.part);
    if (eagerContains.length > 0) {
      lines.push(`    const __ids = rootRows.map((r) => r.id);`);
      for (const { c, part } of eagerContains) {
        const childTable = camel(plural(part.name));
        lines.push(
          `    const ${c.name}Rows = await this.db.select().from(schema.${childTable}).where(inArray(schema.${childTable}.parentId, __ids));`,
        );
        if (c.collection) {
          lines.push(`    const ${c.name}ByParent = new Map<string, ${part.name}[]>();`);
          lines.push(`    for (const r of ${c.name}Rows) {`);
          lines.push(`      const list = ${c.name}ByParent.get(r.parentId) ?? [];`);
          lines.push(`      list.push(${hydrateEntityExpr(part, "r", agg, ctx)});`);
          lines.push(`      ${c.name}ByParent.set(r.parentId, list);`);
          lines.push(`    }`);
        } else {
          // Singular containment: at most one row per parent (DB
          // doesn't enforce that, but the aggregate boundary does).
          // First-row-wins on duplicates.
          lines.push(`    const ${c.name}ByParent = new Map<string, ${part.name}>();`);
          lines.push(`    for (const r of ${c.name}Rows) {`);
          lines.push(`      if (${c.name}ByParent.has(r.parentId)) continue;`);
          lines.push(
            `      ${c.name}ByParent.set(r.parentId, ${hydrateEntityExpr(part, "r", agg, ctx)});`,
          );
          lines.push(`    }`);
        }
      }
    }
    lines.push(
      `    return rootRows.map((root) => ${hydrateRootForFindAllExpr(agg, "root", ctx)});`,
    );
    lines.push(`  }`);
    return lines;
  }

  // Optional / single result variants
  if (find.returnType.kind === "optional") {
    lines.push(`  async ${find.name}(${params}): Promise<${agg.name} | null> {`);
  } else {
    lines.push(`  async ${find.name}(${params}): Promise<${agg.name}> {`);
  }
  lines.push(
    `    const rootRows = await this.db.select().from(schema.${tableName})${whereClause}.limit(1);`,
  );
  if (find.returnType.kind === "optional") {
    lines.push(`    if (rootRows.length === 0) return null;`);
  } else {
    lines.push(`    if (rootRows.length === 0) throw new AggregateNotFoundError("not found");`);
  }
  lines.push(
    `    return await this.findById(rootRows[0]!.id as Ids.${agg.name}Id) as ${agg.name}${find.returnType.kind === "optional" ? " | null" : ""};`,
  );
  lines.push(`  }`);
  return lines;
}

/** Variant of `hydrateRootExpr` where ALL containments
 * (collections + singulars) are pre-loaded into per-parent maps.
 * Used by the array-returning find path to fully hydrate every root
 * in one batched read.  Singular containments default to `null` if
 * the parent had no row in the bulk join. */
function hydrateRootForFindAllExpr(
  agg: AggregateIR,
  rowVar: string,
  ctx: BoundedContextIR,
): string {
  const fields: string[] = [];
  fields.push(`id: Ids.${agg.name}Id(${rowVar}.id)`);
  for (const f of agg.fields) {
    fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx)}`);
  }
  for (const c of agg.contains) {
    if (c.collection) {
      fields.push(`${c.name}: ${c.name}ByParent.get(${rowVar}.id) ?? []`);
    } else {
      fields.push(`${c.name}: ${c.name}ByParent.get(${rowVar}.id) ?? null`);
    }
  }
  return `${agg.name}._create({ ${fields.join(", ")} })`;
}

function tsTypeForReturn(t: TypeIR): string {
  if (t.kind === "id") return `Ids.${t.targetName}Id`;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
      case "decimal":
        return "number";
      case "string":
      case "guid":
        return "string";
      case "bool":
        return "boolean";
      case "datetime":
        return "Date";
    }
  }
  if (t.kind === "enum") return t.name;
  if (t.kind === "array") return `${tsTypeForReturn(t.element)}[]`;
  if (t.kind === "optional") return `${tsTypeForReturn(t.inner)} | null`;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectValueObjects(agg: AggregateIR, ctx: BoundedContextIR): string[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "valueobject") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const part of agg.parts) for (const f of part.fields) visit(f.type);
  return ctx.valueObjects.filter((v) => used.has(v.name)).map((v) => v.name);
}

function collectEnums(agg: AggregateIR, ctx: BoundedContextIR): string[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "enum") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const part of agg.parts) for (const f of part.fields) visit(f.type);
  return ctx.enums.filter((e) => used.has(e.name)).map((e) => e.name);
}

// ---------------------------------------------------------------------------
// IR expression → Drizzle expression
//
// Lowers the common subset of `where`-clause expressions to Drizzle
// operators (eq / ne / gt / gte / lt / lte / and / or / not), keyed
// off `schema.<table>.<column>` references.  Returns null when the
// expression contains shapes Drizzle can't represent in plain SQL
// (collection ops, lambdas, member access into parts, etc.); the
// caller then falls back to a TODO comment.
// ---------------------------------------------------------------------------

const COMPARE_OP_TO_DRIZZLE: Record<string, string> = {
  "==": "eq",
  "!=": "ne",
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
};

interface DrizzleLowering {
  /** The TypeScript source for the whole expression. */
  expr: string;
  /** Operators referenced; caller adds them to the file's import line. */
  ops: Set<string>;
}

function lowerToDrizzle(
  expr: import("../../ir/loom-ir.js").ExprIR,
  tableName: string,
  ctx: BoundedContextIR,
): DrizzleLowering | null {
  const ops = new Set<string>();
  const text = lowerExpr(expr);
  if (text === null) return null;
  return { expr: text, ops };

  function lowerExpr(e: import("../../ir/loom-ir.js").ExprIR): string | null {
    if (e.kind === "paren") return lowerExpr(e.inner);
    if (e.kind === "binary") {
      if (e.op === "&&" || e.op === "||") {
        const l = lowerExpr(e.left);
        const r = lowerExpr(e.right);
        if (l === null || r === null) return null;
        const fn = e.op === "&&" ? "and" : "or";
        ops.add(fn);
        return `${fn}(${l}, ${r})`;
      }
      const drizzleFn = COMPARE_OP_TO_DRIZZLE[e.op];
      if (!drizzleFn) return null;
      const colExpr = renderColumnRef(e.left) ?? renderColumnRef(e.right);
      const valueExpr =
        renderColumnRef(e.left) === null ? renderValue(e.left) : renderValue(e.right);
      if (colExpr === null || valueExpr === null) return null;
      ops.add(drizzleFn);
      return `${drizzleFn}(${colExpr}, ${valueExpr})`;
    }
    if (e.kind === "unary" && e.op === "!") {
      const inner = lowerExpr(e.operand);
      if (inner === null) return null;
      ops.add("not");
      return `not(${inner})`;
    }
    return null;
  }

  function renderColumnRef(e: import("../../ir/loom-ir.js").ExprIR): string | null {
    if (e.kind === "paren") return renderColumnRef(e.inner);
    // `this.field` — direct column access.  In the IR this is a
    // `member` over the `this` literal.
    if (e.kind === "member" && e.receiver.kind === "this") {
      return `schema.${tableName}.${e.member}`;
    }
    // `this.field.subField` (value-object member access).  Schema
    // flattens VO fields into `<field>_<subField>` columns.
    if (
      e.kind === "member" &&
      e.receiver.kind === "member" &&
      e.receiver.receiver.kind === "this"
    ) {
      return `schema.${tableName}.${e.receiver.member}_${e.member}`;
    }
    // Bare-identifier reference to a `this` property (the validator
    // resolves these to `this-prop`).
    if (e.kind === "ref" && e.refKind === "this-prop") {
      return `schema.${tableName}.${e.name}`;
    }
    return null;
  }

  function renderValue(e: import("../../ir/loom-ir.js").ExprIR): string | null {
    if (e.kind === "paren") return renderValue(e.inner);
    if (e.kind === "literal") {
      switch (e.lit) {
        case "string":
          return JSON.stringify(e.value);
        case "int":
        case "decimal":
          return e.value;
        case "bool":
          return e.value;
        case "null":
          return "null";
        default:
          return null;
      }
    }
    if (e.kind === "ref") {
      // Param / let / lambda: bare identifier.  Drizzle's `eq<T>` infers
      // `T` from the column on the left side; branded id types are
      // structurally assignable to the column's plain string/number
      // type, so a bare reference type-checks cleanly.  An older
      // version cast `${e.name} as never` defensively — that hid a
      // class of type errors (a where-clause referencing a renamed
      // column or a parameter with the wrong type compiled silently),
      // so the cast is gone.
      if (e.refKind === "param" || e.refKind === "let" || e.refKind === "lambda") {
        return e.name;
      }
      // Enum value: render as the literal string.  EF / Drizzle store
      // enums as text columns matching `OrderStatus.Draft` → "Draft".
      if (e.refKind === "enum-value") {
        return JSON.stringify(e.name);
      }
    }
    // `currentUser.<field>` — slice 1C row-level filter.  The repo
    // method receives a `currentUser: User` parameter; the renderer
    // emits a plain JS member access against it.  Drizzle infers
    // the column-side branded type and the User field's plain type
    // is structurally assignable.
    if (e.kind === "member" && e.receiver.kind === "ref" && e.receiver.refKind === "current-user") {
      return `currentUser.${e.member}`;
    }
    void ctx;
    return null;
  }
}
