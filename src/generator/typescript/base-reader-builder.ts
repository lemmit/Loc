// Polymorphic base reader for an aggregate-inheritance hierarchy
// (aggregate-inheritance.md), either layout.
//
// An abstract base has no user repository (the validator forbids one — abstract
// aggregates aren't instantiated), but the whole point of inheritance here is
// polymorphic access: "reference any Party, query all Parties".  This emitter
// generates a read-only `<Base>Repository` returning the `Customer | Supplier`
// tagged union.  It is the read home for `find all <Base>` and for
// dereferencing a polymorphic `<Base> id`.
//
// Both layouts DELEGATE to the per-concrete repositories rather than querying a
// table directly, so every read rides the loader that already applies the
// concrete's `kind` scoping, capability filters, contained parts and `X id[]`
// associations.  Hono/Drizzle only (v1).

import type { EnrichedAggregateIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst } from "../../util/naming.js";

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

/** The read-only `<Base>Repository` for a TPH (`sharedTable`) hierarchy.
 *
 *  It DELEGATES to the per-concrete repositories, exactly as the TPC reader
 *  below does — and for a second reason on top of that one's.  The hand-rolled
 *  version read `schema.<base>` directly, which meant it saw the shared table
 *  through NONE of the machinery the concrete repositories apply to it: no
 *  capability `filter`, no tenancy predicate, no contained parts, no `X id[]`
 *  associations.  Both concrete repos in a `tenantOwned` hierarchy AND-ed a
 *  tenant predicate into every read while this reader emitted a bare
 *  `select().from(schema.vehicles)` — a cross-tenant read the moment the
 *  polymorphic reader is wired to a route, which `docs/inheritance.md` already
 *  describes as its purpose (`F2-CB-C12`).  Delegating makes every one of those
 *  concerns ride along by construction instead of needing to be re-applied
 *  here, which is why the doc said "delegates to the concrete loaders" in the
 *  first place. */
export function buildBaseReaderFile(
  base: EnrichedAggregateIR,
  concretes: EnrichedAggregateIR[],
): string {
  return buildDelegatingBaseReaderFile(base, concretes, "sharedTable");
}

/** The read-only `<Base>Repository` for a TPC (`ownTable`) hierarchy.
 *
 *  A TPC base has NO table — each concrete is a standalone table with its own
 *  fully-featured repository.  So rather than hand-roll a fragile `unionAll`
 *  over differently-shaped concrete tables (which could only read flat scalars
 *  and would silently drop contained parts / `X id[]` associations), this
 *  reader DELEGATES to the per-concrete repositories and concatenates.  Same
 *  emission as the TPH reader above — see `buildDelegatingBaseReaderFile`. */
export function buildTpcBaseReaderFile(
  base: EnrichedAggregateIR,
  concretes: EnrichedAggregateIR[],
): string {
  return buildDelegatingBaseReaderFile(base, concretes, "ownTable");
}

/** The polymorphic base reader, for either layout: `findAll()` is the union of
 *  each concrete's `all()`, `findById()` tries each concrete in turn.  Every
 *  aggregate therefore loads its complete tree — and through its own capability
 *  filters — via the loader that already knows how.
 *
 *  N round-trips instead of one (one per concrete); the trade is correctness +
 *  reuse over a single hand-aligned query.  Hono/Drizzle only (v1). */
function buildDelegatingBaseReaderFile(
  base: EnrichedAggregateIR,
  concretes: EnrichedAggregateIR[],
  layout: "sharedTable" | "ownTable",
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
    `// Polymorphic ${base.name} reader (${layout === "ownTable" ? "TPC / ownTable" : "TPH / sharedTable"}): delegates to each`,
    `// concrete repository so every aggregate loads its full tree — and through`,
    `// its own capability filters — then unions the results.  Read-only; writes`,
    `// go through the per-concrete repos.`,
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
