import { pagedReturn } from "../../ir/stdlib/generics.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FindIR,
  RepositoryIR,
} from "../../ir/types/loom-ir.js";
import {
  aggregateUsesMoneyDeep,
  aggregateUsesPrincipalContextFilter,
  findUsesCurrentUser,
  isQueryTimeProjection,
} from "../../ir/types/loom-ir.js";
import { tableOwnerName } from "../../ir/util/inheritance.js";
import { aggregateIsVersioned } from "../../ir/util/versioned-capability.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural } from "../../util/naming.js";
import { aggregateIsAudited } from "./emit/audit-stamp.js";
import {
  contextFilterPredicate,
  findByIdMethod,
  findManyByIdsMethod,
  findQueryMethod,
  lowerToDrizzle,
  nonPrincipalContextFilterEntries,
  nonPrincipalContextFilters,
  reifiableCriterion,
  renderCriterionFn,
  repoTableName,
  runMethod,
} from "./repository-find-builder.js";
import { writeScopePredicate } from "./repository-find-predicate.js";
import { collectEnums, collectValueObjects } from "./repository-imports-builder.js";
import { repoPortImportLine, repoPortName } from "./repository-port-builder.js";
import { saveMethod } from "./repository-save-builder.js";
import { toWireMethod } from "./repository-wire-builder.js";

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
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  emitTrace = false,
): string {
  // Walk every find's filter (and any matching capability filters — both
  // lower to Drizzle predicates on the same table) to figure out
  // which Drizzle operators we'll need.  Default operators (eq / and
  // / inArray) are always pulled in; the lowering may add ne / gt /
  // gte / lt / lte / or / not depending on the expression shape.
  const drizzleOps = new Set<string>(["eq", "and", "inArray"]);
  // A paged find runs a `count()` aggregate for its total (P3b).  Added as a
  // candidate; the import narrower below keeps it only if `count(` is emitted.
  // A paged find runs a `count()` for the total and an `asc`/`desc` ORDER BY
  // for the server-side sort (M-T2.6).  Seed all three; the body-scan narrower
  // below drops any that don't actually appear in the emitted method.
  if ((repo?.finds ?? []).some((f) => pagedReturn(f.returnType))) {
    drizzleOps.add("count");
    drizzleOps.add("asc");
    drizzleOps.add("desc");
  }
  const allFilters = [
    ...(repo?.finds ?? [])
      .map((f) => f.filter)
      .filter((x): x is import("../../ir/types/loom-ir.js").ExprIR => !!x),
    // Non-principal capability filters (`filter !this.isDeleted`) AND
    // into every root read; include them in the ops walk so the import
    // narrower keeps `and` / `not` / comparison helpers they need.
    ...nonPrincipalContextFilters(agg),
  ];
  for (const f of allFilters) {
    const lowered = lowerToDrizzle(f, lowerFirst(plural(agg.name)), ctx);
    if (lowered) for (const op of lowered.ops) drizzleOps.add(op);
  }
  // Context retrievals (retrieval.md) targeting this aggregate emit a
  // `run<Name>` method.  Their `where` lowers to Drizzle (same oracle as
  // finds, so collect its ops), and a non-empty `sort` pulls in `asc` /
  // `desc` from drizzle-orm.
  const aggRetrievals = (ctx.retrievals ?? []).filter(
    (r) => r.targetType.kind === "entity" && r.targetType.name === agg.name,
  );
  for (const r of aggRetrievals) {
    const lowered = lowerToDrizzle(r.where, lowerFirst(plural(agg.name)), ctx);
    if (lowered) for (const op of lowered.ops) drizzleOps.add(op);
    if (r.sort.length > 0) for (const s of r.sort) drizzleOps.add(s.direction);
  }
  // Reified criteria (one module-level predicate fn per named criterion a
  // retrieval or find `where` reifies to — the functional analog of .NET's
  // `Criterion<T>`).  Deduped by name across both consumers (a criterion used
  // by a find *and* a retrieval emits one fn); the fn body lowers the
  // criterion's own predicate against the candidate table, so its Drizzle ops
  // join the import narrowing walk.  runMethod / findQueryMethod call these
  // instead of inlining (parity-clean).
  const retrievalTable = repoTableName(agg, ctx);
  const criterionFnByName = new Map<string, string>();
  const reifyingRefs = [
    ...aggRetrievals.map((r) => r.criterionRef),
    ...(repo?.finds ?? []).map((f) => f.criterionRef),
    // Capability `filter` declarations that are exactly one named criterion
    // (reified-criteria.md, the anonymous-`filter` row) — the predicate
    // builder calls the same module-level fn (non-principal entries only;
    // principal filters are validator-rejected on Hono).
    ...nonPrincipalContextFilterEntries(agg).map((e) => e.criterionRef),
  ];
  for (const ref of reifyingRefs) {
    const c = reifiableCriterion(ref, ctx, retrievalTable);
    if (c && !criterionFnByName.has(c.name)) {
      criterionFnByName.set(c.name, renderCriterionFn(c, retrievalTable, ctx));
      const lowered = lowerToDrizzle(c.body, retrievalTable, ctx);
      if (lowered) for (const op of lowered.ops) drizzleOps.add(op);
    }
  }
  const criterionFns = [...criterionFnByName.values()];
  // The single AND-able capability-filter predicate for this aggregate's
  // table (null when it has no non-principal capability filter).  Threaded
  // into each root-table read site below; child/containment reads
  // (parentId-keyed) are unaffected — the filter constrains root rows.
  const filterPred = contextFilterPredicate(agg, lowerFirst(plural(agg.name)), ctx, drizzleOps);
  // If any find or matching capability filter references currentUser, the
  // per-method signature gains a `currentUser: User` parameter that
  // the closure-captured Drizzle predicate reads.  Pull the User
  // type in as a type-only import so the file compiles even when
  // the verifier hook isn't wired yet.
  const repoUsesUser = (repo?.finds ?? []).some(findUsesCurrentUser);
  // A principal-referencing capability `filter` (`filter this.tenantId ==
  // currentUser.tenantId`) reads the ambient principal via `requireCurrentUser()`
  // inside every root read's predicate — so the repo imports that accessor
  // (DEBT-01).  Unlike a per-find `currentUser` use, no method signature changes.
  const usesPrincipalFilter = aggregateUsesPrincipalContextFilter(agg);
  const partNames = agg.parts.map((p) => p.name);
  const domainImports = [agg.name, ...partNames].join(", ");
  const valueObjectsUsed = collectValueObjects(agg, ctx);
  const enumsUsed = collectEnums(agg, ctx);
  const voOrEnumImports = [...valueObjectsUsed, ...enumsUsed];
  // Query-time projections (read-path-architecture.md rev.13) sourced from this
  // aggregate synthesise a parameterless-find repository read —
  // `repo.<projName>()` returns the filtered aggregate
  // rows the projection route then follows (`join`) + projects (`select`).  A
  // parameterised projection's `where` still lowers criterion params away at
  // compile time, so the synthesised find stays parameterless.
  const projectionFinds: FindIR[] = ctx.projections
    .filter((p) => isQueryTimeProjection(p) && p.query?.source === agg.name)
    .map((p) => ({
      name: lowerFirst(p.name),
      params: [],
      returnType: { kind: "array", element: { kind: "entity", name: agg.name } },
      filter: p.query?.filter,
    }));

  // Individual methods, hoisted so the same strings feed BOTH the class body
  // AND the derived repository PORT (audit S7 — the concrete `implements` a
  // domain-side `<Agg>RepositoryPort`; the members are extracted from these
  // exact headers, so `implements` always type-checks).  `toWire` is
  // presentation, not part of the repository contract, so it is excluded from
  // the port.
  const findByIdM = findByIdMethod(agg, ctx, emitTrace, filterPred);
  const getByIdM = getByIdMethod(agg, ctx, drizzleOps);
  // Bulk loader used by views that follow `X id` references in bind
  // expressions.  Same hydration path as the array-return finds; filter is a
  // single `inArray`.
  const findManyByIdsM = findManyByIdsMethod(agg, ctx, filterPred);
  const saveM = saveMethod(agg, ctx, emitTrace);
  // Hard delete — emitted only when the aggregate has a canonical `destroy`
  // (declared or via `crudish`), so plain aggregates' repos are unchanged.
  const deleteM = agg.canonicalDestroy ? deleteMethod(agg, ctx) : null;
  // Find queries — capability filter AND-ed into each read.
  const findMs = (repo?.finds ?? []).map((find) => findQueryMethod(agg, find, ctx, filterPred));
  const viewFindMs = [...projectionFinds].map((find) =>
    findQueryMethod(agg, find, ctx, filterPred),
  );
  // `run<Name>` per context retrieval targeting this aggregate.
  const runMs = aggRetrievals.map((r) => runMethod(agg, r, ctx, filterPred));
  const toWireM = toWireMethod(agg, ctx);

  // Render the class body first so the file's imports + `type Tx` can be
  // narrowed to what's actually referenced — keeps the generated header
  // free of dead names (Biome generated-code gate).
  const bodyStr = lines(
    `export class ${agg.name}Repository implements ${repoPortName(agg.name)} {`,
    // Explicit field declarations + constructor assignments, not
    // parameter properties — the latter is non-erasable sugar Node's
    // type stripping rejects; see docs/old/plans/dap-node-debug.md
    // "Non-erasable syntax" and emit/value-objects.ts's renderValueObject.
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
    findByIdM,
    "",
    getByIdM,
    "",
    findManyByIdsM,
    "",
    saveM,
    "",
    ...(deleteM ? [deleteM, ""] : []),
    ...findMs.flatMap((m) => [m, ""]),
    ...viewFindMs.flatMap((m) => [m, ""]),
    ...runMs.flatMap((m) => [m, ""]),
    // toWire — domain instance → wire DTO (plain object).  Used by the
    // Hono routes layer to serialize responses; the shape mirrors the
    // .NET <Agg>Response record so the cross-check sees identical specs.
    toWireM,
    "",
    `}`,
  );

  // Strip string contents so symbols mentioned only inside error messages
  // or labels don't register as references for the import narrowing below.
  // The criterion fns sit outside the class but their bodies use the same
  // Drizzle ops, so scan them too.
  const bodyScan = `${criterionFns.join("\n")}\n${bodyStr}`
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  // Narrow `drizzle-orm` ops to those actually called in the body, drop
  // `type Tx` when no method declares a `(tx: Tx)` parameter.
  const usedDrizzleOps = [...drizzleOps]
    // `op(` call or `op`…`` tagged template (the `sql` intrinsic wrapper).
    .filter((op) => new RegExp(`\\b${op}[(\\\`]`).test(bodyScan))
    .sort();
  const usesTx = /:\s*Tx\b/.test(bodyScan);
  // VO / enum imports: per-symbol. A name needs a runtime value when
  // the body uses `new <Vo>(` (value-object construction) or `<Name>.<member>`
  // (enum value access). Otherwise it's type-only.
  const isValueUsed = (n: string): boolean =>
    new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyScan);
  const voOrEnumReferenced = voOrEnumImports.filter((n) => new RegExp(`\\b${n}\\b`).test(bodyScan));
  const anyVoOrEnumValueUsed = voOrEnumReferenced.some(isValueUsed);
  let voOrEnumImportLine: string | false = false;
  if (voOrEnumReferenced.length > 0) {
    if (!anyVoOrEnumValueUsed) {
      voOrEnumImportLine = `import type { ${voOrEnumReferenced.join(", ")} } from "../../domain/value-objects";`;
    } else {
      const symbols = voOrEnumReferenced.map((n) => (isValueUsed(n) ? n : `type ${n}`));
      voOrEnumImportLine = `import { ${symbols.join(", ")} } from "../../domain/value-objects";`;
    }
  }

  const repoUsesMoney = aggregateUsesMoneyDeep(agg, ctx.valueObjects);

  const file = lines(
    "// Auto-generated.  Do not edit by hand.",
    repoUsesMoney && `import Decimal from "decimal.js";`,
    // Domain-side repository PORT this concrete implements (audit S7).
    repoPortImportLine(agg.name),
    `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`,
    // A paged find's server-side ORDER BY types its sort-column whitelist as
    // `Record<string, AnyPgColumn>` (M-T2.6).
    /\bAnyPgColumn\b/.test(bodyScan) && `import type { AnyPgColumn } from "drizzle-orm/pg-core";`,
    usedDrizzleOps.length > 0 && `import { ${usedDrizzleOps.join(", ")} } from "drizzle-orm";`,
    `import * as schema from "../schema";`,
    repoUsesUser && `import type { User } from "../../auth/user-types";`,
    // …or a reified criterion fn (a tenancy `criterion` used by a
    // find/retrieval) binds the principal through the same accessor — detected
    // from the scanned body, which includes the criterion fns (line above).
    (usesPrincipalFilter || /\brequireCurrentUser\(/.test(bodyScan)) &&
      `import { requireCurrentUser } from "../../auth/middleware";`,
    // Persist-time audit stamping helper — pulled in only when this aggregate's
    // `save()` stamps (audited).  Stamps the audit columns from the ambient
    // request principal at the upsert (db/audit-stamp.ts).
    aggregateIsAudited(agg) && `import { stampInsert, stampUpdate } from "../audit-stamp";`,
    `import { ${domainImports} } from "../../domain/${lowerFirst(agg.name)}";`,
    voOrEnumImportLine,
    `import * as Ids from "../../domain/ids";`,
    // `ConcurrencyError` only when this aggregate is `versioned` — a
    // non-versioned repository's imports stay byte-identical.
    aggregateIsVersioned(agg)
      ? `import { AggregateNotFoundError, ConcurrencyError } from "../../domain/errors";`
      : `import { AggregateNotFoundError } from "../../domain/errors";`,
    `import type { DomainEventDispatcher } from "../../domain/events";`,
    `import { requestLog } from "../../obs/als";`,
    "",
    `type Db = NodePgDatabase<typeof schema>;`,
    usesTx && `type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];`,
    "",
    // Reified-criterion predicate functions (module-level, ahead of the class
    // that calls them).  Empty when no retrieval reifies a named criterion.
    criterionFns.length > 0 && criterionFns.join("\n"),
    criterionFns.length > 0 && "",
    bodyStr,
    "",
  );
  return file;
}

/** `async getById(id)` — the command-load path (distinct from `findById`, the
 *  read path): every mutation route loads through this.  When the aggregate
 *  carries a `writeScopeFilter` (authorization Phase 3 P3.1 — the write scope is
 *  strictly narrower than the read scope), a write-scope existence pre-guard
 *  runs first: a row a caller may READ but not WRITE (out of write scope) is
 *  indistinguishable from a missing one (404), and the `findById` read filter
 *  still hydrates the row afterwards.  Byte-identical (plain
 *  `findById` + not-found throw) when there is no write narrowing. */
function getByIdMethod(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  drizzleOps: Set<string>,
): string {
  const tableName = repoTableName(agg, ctx);
  const writePred = writeScopePredicate(agg, tableName, ctx, drizzleOps);
  const guard: string[] = [];
  if (writePred) {
    drizzleOps.add("and");
    drizzleOps.add("eq");
    guard.push(
      `    const inScope = await this.db.select({ id: schema.${tableName}.id }).from(schema.${tableName}).where(and(eq(schema.${tableName}.id, id), ${writePred})).limit(1);`,
      `    if (inScope.length === 0) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
    );
  }
  return lines(
    `  async getById(id: Ids.${agg.name}Id): Promise<${agg.name}> {`,
    ...guard,
    `    const found = await this.findById(id);`,
    `    if (!found) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
    `    return found;`,
    `  }`,
  );
}

/** `async delete(id)` — hard-delete the aggregate root row.  A single
 * `DELETE … WHERE id = …`; containment children and join-table rows are
 * removed by their `ON DELETE CASCADE` foreign keys, so no per-child
 * cleanup is needed here (unlike `save`, which diffs collections).  Only
 * emitted when `agg.canonicalDestroy` is set. */
function deleteMethod(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  // A TPH concrete subtype lives in its abstract base's shared table, so the
  // delete targets the owner's table (`tableOwnerName`) — not the subtype's
  // own pluralised name, which has no `schema` export (matches save/find).
  const tableName = lowerFirst(plural(tableOwnerName(agg, ctx.aggregates)));
  return lines(
    `  async delete(id: Ids.${agg.name}Id): Promise<void> {`,
    `    await this.db.delete(schema.${tableName}).where(eq(schema.${tableName}.id, id));`,
    `  }`,
  );
}

// ---------------------------------------------------------------------------
// toWire — domain → wire DTO serializer (matches the routes-builder's
// `<Agg>Response` zod schema; see routes-builder.ts).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// findById — load root, load each part collection, hydrate
// ---------------------------------------------------------------------------

// Restore the co-located lineage so a fresh load (and any subsequent GET)
// surfaces it — without this the lineage would vanish after the request
// that wrote it.  The column is `$type`d ProvLineage, so no cast needed.

// ---------------------------------------------------------------------------
// save — upsert root + diff-sync children + dispatch events
// ---------------------------------------------------------------------------

// Co-located provenance sidecar: the `<field>_provenance` column reads
// straight off the domain getter (typed `ProvLineage | null`), so save
// and the `$type`d jsonb column line up without a cast.

// ---------------------------------------------------------------------------
// Find queries — convention-based equality predicates
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
