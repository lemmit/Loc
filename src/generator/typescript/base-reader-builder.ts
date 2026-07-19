// Polymorphic base reader for a TPH hierarchy (aggregate-inheritance.md).
//
// An abstract `sharedTable` (TPH) base has no user repository (the validator
// forbids one — abstract aggregates aren't instantiated), but the whole point
// of TPH is polymorphic access: "reference any Party, query all Parties".
// This emitter generates a read-only `<Base>Repository` that scans the shared
// table and dispatches on the `kind` discriminator to hydrate the right
// concrete, returning the `Customer | Supplier` tagged union.  It is the read
// home for `find all <Base>` and for dereferencing a polymorphic `<Base> id`.
//
// Hono/Drizzle only (v1), mirroring the rest of the TPH slice.  Reads are
// scalar/VO/enum/id-shaped; contained parts and reference collections aren't
// eagerly loaded here (the per-concrete repository loads those) — see
// hydrateConcreteFromSharedRow.

import type { EnrichedAggregateIR, EnrichedBoundedContextIR } from "../../ir/types/loom-ir.js";
import { aggregateUsesMoney } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural } from "../../util/naming.js";
import { hydrateConcreteFromSharedRow } from "./repository-find-builder.js";
import { collectEnums, collectValueObjects } from "./repository-imports-builder.js";

/** The `<Base> = Concrete | …` discriminated-union type (TS structural union
 *  of the concrete domain classes). Lives in `domain/<base>.ts`.  `layout`
 *  only tunes the explanatory comment: TPH discriminates on a shared `kind`
 *  column; TPC discriminates structurally across per-concrete tables. */
export function buildBaseUnionFile(
  base: EnrichedAggregateIR,
  concretes: EnrichedAggregateIR[],
  layout: "sharedTable" | "ownTable" = "sharedTable",
): string {
  const imports = concretes.map((c) => `import type { ${c.name} } from "./${lowerFirst(c.name)}";`);
  const discriminatorNote =
    layout === "sharedTable"
      ? "// (discriminated by the shared table's `kind` column at the data layer)."
      : "// (each concrete is its own table; the union is resolved per-table by the base reader).";
  return lines(
    "// Auto-generated.  Do not edit by hand.",
    ...imports,
    "",
    `// Polymorphic ${base.name} — the tagged union of its concrete subtypes`,
    discriminatorNote,
    `export type ${base.name} = ${concretes.map((c) => c.name).join(" | ")};`,
    "",
  );
}

/** The read-only `<Base>Repository` — `findById` + `findAll` over the shared
 *  TPH table, dispatching on `kind`. */
export function buildBaseReaderFile(
  base: EnrichedAggregateIR,
  concretes: EnrichedAggregateIR[],
  ctx: EnrichedBoundedContextIR,
): string {
  const table = lowerFirst(plural(base.name));
  const cases = concretes.flatMap((c) => [
    `    case ${JSON.stringify(c.name)}:`,
    `      return ${hydrateConcreteFromSharedRow(c, "row", ctx)};`,
  ]);
  const bodyStr = lines(
    `export class ${base.name}Repository {`,
    // Explicit field declaration + constructor assignment, not a
    // parameter property — see emit/value-objects.ts's renderValueObject.
    `  private readonly db: Db;`,
    `  constructor(db: Db) {`,
    `    this.db = db;`,
    `  }`,
    "",
    `  async findById(id: Ids.${base.name}Id): Promise<${base.name} | null> {`,
    `    const rows = await this.db.select().from(schema.${table}).where(eq(schema.${table}.id, id));`,
    `    if (rows.length === 0) return null;`,
    `    return hydrate${base.name}(rows[0]!);`,
    `  }`,
    "",
    `  async findAll(): Promise<${base.name}[]> {`,
    `    const rows = await this.db.select().from(schema.${table});`,
    `    return rows.map(hydrate${base.name});`,
    `  }`,
    `}`,
    "",
    `type ${base.name}Row = typeof schema.${table}.$inferSelect;`,
    "",
    `function hydrate${base.name}(row: ${base.name}Row): ${base.name} {`,
    `  switch (row.kind) {`,
    ...cases,
    `    default:`,
    "      throw new Error(`unknown " + base.name + " kind: ${row.kind}`);",
    `  }`,
    `}`,
  );

  // Narrow VO / enum imports to those the concrete hydrations reference, and
  // pull Decimal only when a concrete uses money — same discipline as the
  // per-aggregate repository builder keeps the generated header dead-name-free.
  const bodyScan = bodyStr
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const voOrEnum = [
    ...new Set(concretes.flatMap((c) => [...collectValueObjects(c, ctx), ...collectEnums(c, ctx)])),
  ].filter((n) => new RegExp(`\\b${n}\\b`).test(bodyScan));
  const isValueUsed = (n: string): boolean =>
    new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyScan);
  let voOrEnumImportLine: string | false = false;
  if (voOrEnum.length > 0) {
    voOrEnumImportLine = voOrEnum.some(isValueUsed)
      ? `import { ${voOrEnum.map((n) => (isValueUsed(n) ? n : `type ${n}`)).join(", ")} } from "../../domain/value-objects";`
      : `import type { ${voOrEnum.join(", ")} } from "../../domain/value-objects";`;
  }
  const usesMoney = concretes.some(aggregateUsesMoney);

  return lines(
    "// Auto-generated.  Do not edit by hand.",
    usesMoney && `import Decimal from "decimal.js";`,
    `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`,
    `import { eq } from "drizzle-orm";`,
    `import * as schema from "../schema";`,
    `import * as Ids from "../../domain/ids";`,
    ...concretes.map((c) => `import { ${c.name} } from "../../domain/${lowerFirst(c.name)}";`),
    voOrEnumImportLine,
    `import type { ${base.name} } from "../../domain/${lowerFirst(base.name)}";`,
    "",
    `type Db = NodePgDatabase<typeof schema>;`,
    "",
    bodyStr,
    "",
  );
}

/** The read-only `<Base>Repository` for a TPC (`ownTable`) hierarchy.
 *
 *  Unlike TPH, a TPC base has NO table — each concrete is a standalone table
 *  with its own fully-featured repository.  So rather than hand-roll a fragile
 *  `unionAll` over differently-shaped concrete tables (which could only read
 *  flat scalars and would silently drop contained parts / `X id[]`
 *  associations), this reader DELEGATES to the per-concrete repositories and
 *  concatenates: `findAll()` is the union of each concrete's `all()`,
 *  `findById()` tries each concrete in turn.  Every aggregate therefore loads
 *  its complete tree through the loader that already knows how.  It returns the
 *  `Customer | Supplier` tagged union — the read home for `find all <Base>`.
 *
 *  N round-trips instead of one (one per concrete); the trade is correctness +
 *  reuse over a single hand-aligned query.  Hono/Drizzle only (v1). */
export function buildTpcBaseReaderFile(
  base: EnrichedAggregateIR,
  concretes: EnrichedAggregateIR[],
): string {
  const repoCtor = (c: EnrichedAggregateIR): string => `${c.name}Repository`;
  const repoField = (c: EnrichedAggregateIR): string => `${lowerFirst(c.name)}Repo`;
  return lines(
    "// Auto-generated.  Do not edit by hand.",
    `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`,
    `import * as schema from "../schema";`,
    `import type { DomainEventDispatcher } from "../../domain/events";`,
    `import * as Ids from "../../domain/ids";`,
    ...concretes.map((c) => `import { ${repoCtor(c)} } from "./${lowerFirst(c.name)}-repository";`),
    `import type { ${base.name} } from "../../domain/${lowerFirst(base.name)}";`,
    "",
    `type Db = NodePgDatabase<typeof schema>;`,
    "",
    `// Polymorphic ${base.name} reader (TPC / ownTable): delegates to each`,
    `// concrete repository so every aggregate loads its full tree, then unions`,
    `// the results.  Read-only — writes go through the per-concrete repos.`,
    `export class ${base.name}Repository {`,
    ...concretes.map((c) => `  private readonly ${repoField(c)}: ${repoCtor(c)};`),
    `  constructor(db: Db, events: DomainEventDispatcher) {`,
    ...concretes.map((c) => `    this.${repoField(c)} = new ${repoCtor(c)}(db, events);`),
    `  }`,
    "",
    `  async findById(id: Ids.${base.name}Id): Promise<${base.name} | null> {`,
    ...concretes.flatMap((c) => [
      `    const ${repoField(c)}Hit = await this.${repoField(c)}.findById(id as unknown as Ids.${c.name}Id);`,
      `    if (${repoField(c)}Hit) return ${repoField(c)}Hit;`,
    ]),
    `    return null;`,
    `  }`,
    "",
    `  async findAll(): Promise<${base.name}[]> {`,
    `    const results = await Promise.all([`,
    ...concretes.map((c) => `      this.${repoField(c)}.all(),`),
    `    ]);`,
    `    return results.flat();`,
    `  }`,
    `}`,
    "",
  );
}
