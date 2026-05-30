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
 *  of the concrete domain classes). Lives in `domain/<base>.ts`. */
export function buildBaseUnionFile(
  base: EnrichedAggregateIR,
  concretes: EnrichedAggregateIR[],
): string {
  const imports = concretes.map((c) => `import type { ${c.name} } from "./${lowerFirst(c.name)}";`);
  return lines(
    "// Auto-generated.  Do not edit by hand.",
    ...imports,
    "",
    `// Polymorphic ${base.name} — the tagged union of its concrete subtypes`,
    `// (discriminated by the shared table's \`kind\` column at the data layer).`,
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
    `  constructor(private readonly db: Db) {}`,
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
    // eslint-disable-next-line no-template-curly-in-string — emitted code
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
