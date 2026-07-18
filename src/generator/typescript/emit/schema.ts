import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  EnrichedBoundedContextIR,
  ExprIR,
  FieldIR,
  IdValueType,
  ProjectionIR,
  TypeIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { durableEventTypes } from "../../../ir/util/channels.js";
import { directParentName } from "../../../ir/util/containment-parent.js";
import {
  isTphBase,
  isTphConcrete,
  ownFieldsOf,
  tableOwnerName,
  tphConcretesOf,
} from "../../../ir/util/inheritance.js";
import type { ResolvedDataSource } from "../../../ir/util/resolve-datasource.js";
import { effectiveSavingShape } from "../../../ir/util/resolve-datasource.js";
import { type ValueCollectionIR, valueCollectionsFor } from "../../../ir/util/value-collections.js";
import { lines as joinLines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";

/** Per-aggregate dataSource lookup the orchestrator passes in.  Lets
 *  the schema emitter ask "what schema / tablePrefix does THIS
 *  aggregate's storage binding say?" without coupling to the
 *  resolver internals.  Returns `undefined` when the system has no
 *  matching dataSource — the table emits as a plain `pgTable(...)`
 *  with no schema qualifier, byte-identical with pre-dataSource emit.
 *  When defined, `.schema` is always populated (defaulted to
 *  `snake(context.name)` when the DSL omits `schema:`). */
export type DataSourceLookup = (agg: AggregateIR) => ResolvedDataSource | undefined;

/** Snake-case a schema name into a valid Drizzle const identifier with
 *  a `Schema` suffix (`sales` → `salesSchema`).  The suffix is what
 *  keeps the pgSchema declaration from colliding with a table const of
 *  the same lemma — e.g. context `Orders` defaults its schema to
 *  `"orders"` and the `Order` aggregate emits a table const `orders`,
 *  so the schema needs to live under a distinct name. */
function schemaConstName(schemaName: string): string {
  const camel = lowerFirst(
    schemaName
      .split(/[^a-zA-Z0-9]/)
      .filter(Boolean)
      .map((part, i) => (i === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
      .join(""),
  );
  return `${camel}Schema`;
}

// All-procedural Drizzle schema emission.  Column generation has too
// much per-field branching to express cleanly in any template engine,
// so the entire file is built with the `lines` helper + small per-table
// builders.
//
// Indexes: parts always get an index on their parentId column (joined
// on every aggregate load); aggregate roots get an index on every
// column referenced by a repository find — either by an explicit
// `where this.<col>` clause or by a convention-based parameter
// match.  Without these, common reads degrade to sequential scans
// once the table has more than a few hundred rows.
export function renderSchema(
  ctx: EnrichedBoundedContextIR,
  opts: {
    audit?: boolean;
    provenance?: boolean;
    /** Per-aggregate dataSource lookup — when present, the schema
     *  emitter routes each table through `pgSchema(...)` (when
     *  `schema` is set) and prepends `tablePrefix` to the table
     *  name.  Absent / returns undefined → byte-identical with the
     *  pre-dataSource single-`pgTable(...)` shape.  Join tables and
     *  the audit / provenance tables inherit the schema of the
     *  aggregate they belong to (or stay schemaless when there's no
     *  binding). */
    resolveDataSource?: DataSourceLookup;
    /** Per-workflow schema lookup — the schema its saga table (correlation
     *  state / event-log stream) lands in, resolved from the workflow's
     *  OWNING context (this `ctx` may be a merged union of several, so a
     *  workflow's schema can't be derived from `ctx` alone).  Built by the
     *  caller via `resolveContextSchema`, mirroring `resolveDataSource`'s
     *  agg→context map-back.  Absent / undefined → unqualified `pgTable`,
     *  byte-identical with the pre-fix output. */
    resolveWorkflowSchema?: (wf: WorkflowIR) => string | undefined;
    /** Per-projection schema lookup — the schema its read-model table lands in,
     *  resolved from the projection's OWNING context (mirrors
     *  `resolveWorkflowSchema`).  Absent / undefined → unqualified `pgTable`. */
    resolveProjectionSchema?: (proj: ProjectionIR) => string | undefined;
    /** Per-stream OWNING-context name lookup — maps an event-sourced aggregate /
     *  workflow name to the name of the bounded context that declares it.  This
     *  `ctx` may be a merged union of several contexts (multi-context
     *  deployable), so the per-context `<ctx>_events` log must be named after
     *  the stream's OWNING context (matching the repository + migrations), not
     *  the merged `ctx.name`.  Absent / undefined → the merged `ctx.name`,
     *  byte-identical for single-context systems. */
    resolveStreamContext?: (streamName: string) => string | undefined;
  } = {},
): string {
  const lookup = opts.resolveDataSource;
  // Collect every distinct schema name we'll need across the body so
  // we can emit ONE `pgSchema(...)` declaration at the top per
  // schema.  Order: insertion order from the aggregate walk.
  const schemaNames: string[] = [];
  const schemaSeen = new Set<string>();
  // Register a schema name so exactly one `pgSchema(...)` decl is emitted for
  // it (order = first-seen).  Returns undefined for a falsy name so callers
  // can pass through an unqualified table.
  const registerSchema = (name: string | undefined): string | undefined => {
    if (!name) return undefined;
    if (!schemaSeen.has(name)) {
      schemaSeen.add(name);
      schemaNames.push(name);
    }
    return name;
  };
  const schemaFor = (agg: AggregateIR): string | undefined => registerSchema(lookup?.(agg)?.schema);
  const prefixFor = (agg: AggregateIR): string | undefined => lookup?.(agg)?.tablePrefix;
  const tables: string[] = [];
  for (const agg of ctx.aggregates) {
    const schema = schemaFor(agg);
    const prefix = prefixFor(agg);
    // An abstract base that is NOT a TPH base owns no table.  A TPC
    // (`ownTable`) base is kept in the generation view only so the base-reader
    // pass can emit its polymorphic `find all <Base>` reader — it must not emit
    // a table of its own (each concrete is standalone).  The TPH base falls
    // through to `emitTphTable` below; every other abstract base emits nothing.
    if (agg.isAbstract && !isTphBase(agg, ctx.aggregates)) continue;
    // TPH (aggregate-inheritance.md, sharedTable): the whole hierarchy is one
    // table named for the abstract base.  A TPH concrete shares it, so it
    // emits no table of its own; the abstract base emits the shared table
    // (base columns + every concrete's own columns, made nullable, + the
    // `kind` discriminator).
    if (isTphConcrete(agg, ctx.aggregates)) {
      // …but a TPH concrete's contained parts still need their own tables.
      // Each part FKs the SHARED base table (the concrete has no table of its
      // own), so the parent name resolves through `tableOwnerName` — the part
      // row's `parentId` holds the shared-table row id, which is exactly the
      // concrete's id (Pattern 4, TPT-via-`contains`).  `emitTable` keys the
      // parts otherwise identically to a plain aggregate's.
      const owner = tableOwnerName(agg, ctx.aggregates);
      for (const part of agg.parts) {
        tables.push(
          emitTable(
            part.name,
            part.fields,
            directParentName(agg, part.name, owner),
            ctx,
            new Set(),
            agg.idValueType,
            { schema, prefix },
          ),
        );
      }
      continue;
    }
    if (isTphBase(agg, ctx.aggregates)) {
      tables.push(emitTphTable(agg, ctx, { schema, prefix }));
      continue;
    }
    // Event-sourced (`persistedAs(eventLog)`): the aggregate's truth is its
    // event stream, which lives in the single per-context `<ctx>_events` log
    // (emitted once after this loop, event-log-architecture.md) — no
    // per-aggregate table.  State is rehydrated by folding the stream, filtered
    // by `stream_type`, through the appliers.
    if (agg.persistedAs === "eventLog") {
      continue;
    }
    const shape = effectiveSavingShape(agg, lookup?.(agg));
    // Document (`shape(document)`): the whole aggregate is one opaque
    // jsonb blob (`id, data, version`).  No part/join tables.
    if (shape === "document") {
      tables.push(emitDocumentTable(agg.name, agg.idValueType, { schema, prefix }));
      continue;
    }
    // Embedded (`shape(embedded)`): queryable root row + one jsonb column
    // per containment.  No part tables, no join tables.
    if (shape === "embedded") {
      tables.push(emitEmbeddedTable(agg, ctx, indexedColumnsFor(agg, ctx), { schema, prefix }));
      continue;
    }
    const indexed = indexedColumnsFor(agg, ctx);
    tables.push(
      emitTable(agg.name, agg.fields, undefined, ctx, indexed, agg.idValueType, { schema, prefix }),
    );
    for (const part of agg.parts) {
      tables.push(
        emitTable(
          part.name,
          part.fields,
          directParentName(agg, part.name, agg.name),
          ctx,
          new Set(),
          agg.idValueType,
          { schema, prefix },
        ),
      );
    }
    // Many-to-many join tables for `T id[]` reference collections.
    // Live in the same schema as the owning aggregate so cross-table
    // FKs stay valid.
    for (const assoc of agg.associations) {
      tables.push(emitJoinTable(assoc, { schema, prefix }));
    }
    // Id-less child tables for `<VO>[]` value-object collections — one
    // row per element keyed by (parent_id, ordinal), columns flattened
    // from the value object.  Plain relational shape (portable).
    for (const vc of valueCollectionsFor(agg)) {
      tables.push(emitValueCollectionTable(vc, ctx, agg.idValueType, { schema, prefix }));
    }
    for (const part of agg.parts) {
      for (const vc of valueCollectionsFor(part)) {
        tables.push(emitValueCollectionTable(vc, ctx, agg.idValueType, { schema, prefix }));
      }
    }
  }
  // The per-context event log (event-log-architecture.md): one `<ctx>_events`
  // table shared by every `persistedAs(eventLog)` aggregate and every
  // `eventSourced` workflow in the context, discriminated by `stream_type`.
  // Keyed by OWNING context, because this `ctx` may be a merged union of
  // several contexts (multi-context deployable) — each owning context that has
  // any event-sourced stream gets its own log, named to match the repository +
  // migrations (`<owner>_events`).  Aggregate binding fixes the schema first
  // (an owning context with both an ES aggregate and an ES workflow shares one
  // log), else the workflow schema resolver.
  const eventLogs = new Map<string, { schema?: string; prefix?: string }>();
  for (const agg of ctx.aggregates) {
    if (agg.persistedAs !== "eventLog") continue;
    const owner = opts.resolveStreamContext?.(agg.name) ?? ctx.name;
    if (!eventLogs.has(owner)) {
      eventLogs.set(owner, { schema: schemaFor(agg), prefix: prefixFor(agg) });
    }
  }
  for (const wf of ctx.workflows) {
    if (!wf.eventSourced) continue;
    const owner = opts.resolveStreamContext?.(wf.name) ?? ctx.name;
    if (!eventLogs.has(owner)) {
      eventLogs.set(owner, { schema: registerSchema(opts.resolveWorkflowSchema?.(wf)) });
    }
  }
  for (const [owner, info] of eventLogs) {
    tables.push(emitEventLogTable(owner, info));
  }
  if (opts.audit) tables.push(AUDIT_TABLE);
  if (opts.provenance) tables.push(PROVENANCE_TABLE);
  // Transactional outbox (dispatch-delivery-semantics.md): emitted when any
  // channel asks for durability (`retention: log | work`).  The dispatcher
  // records durable events here; the relay drains undispatched rows in
  // insert order (serial id) through the in-process dispatcher.
  if (durableEventTypes(ctx).size > 0) tables.push(OUTBOX_TABLE);
  // Persisted workflow-correlation state (workflow-and-applier.md A2-S2):
  // one row per running workflow instance, keyed by the correlation field, with
  // the saga state fields as columns.  Emitted for any workflow that declares a
  // single id-shaped correlation field; the in-process dispatcher loads/saves
  // these rows to route inbound events to the right instance.  A workflow
  // without a correlation field (a plain command workflow) gets no table —
  // byte-identical.
  for (const wf of ctx.workflows) {
    // The saga table is context-owned — it lands in the workflow's context
    // schema (registered so its `pgSchema(...)` decl is emitted), matching the
    // migration DDL.  Unqualified when the context has no dataSource binding.
    const wfSchema = registerSchema(opts.resolveWorkflowSchema?.(wf));
    // An `eventSourced` workflow's stream lives in the shared per-context
    // `<ctx>_events` log emitted above (folded on load, filtered by
    // `stream_type`) — no per-workflow table.  A plain correlation-bearing
    // workflow keeps its mutable state row.
    if (!wf.eventSourced && wf.correlationField)
      tables.push(emitWorkflowStateTable(wf, ctx, wfSchema));
  }
  // Projection read models (projection.md): one context-owned state table per
  // projection, keyed by its correlation column — the fold dispatcher upserts
  // rows here and the read routes select from it.  Shares the workflow saga
  // schema resolution (a projection is a context member like a workflow).
  for (const proj of ctx.projections) {
    const projSchema = registerSchema(opts.resolveProjectionSchema?.(proj));
    tables.push(emitProjectionTable(proj, ctx, projSchema));
  }
  const schemaDecls = schemaNames.map(
    (name) => `export const ${schemaConstName(name)} = pgSchema("${name}");`,
  );
  const enumLines = ctx.enums.map(
    (e) =>
      `export const ${lowerFirst(e.name)}Enum = pgEnum("${snake(e.name)}", [${e.values.map((v) => `"${v}"`).join(", ")}]);`,
  );
  // Derive the drizzle-pg-core import list from what the body actually
  // calls — every helper here is invoked as a function (`text(...)`,
  // `pgEnum(...)`, etc.), so a `\b<name>\(` scan is exact and keeps the
  // import line free of dead names per the generated-code Biome gate.
  const body = [...schemaDecls, ...enumLines, "", tables.join("\n\n")].join("\n");
  const candidates = [
    "pgTable",
    "pgSchema",
    "text",
    "integer",
    "bigint",
    "bigserial",
    "numeric",
    "boolean",
    "timestamp",
    "pgEnum",
    "uuid",
    "index",
    "primaryKey",
    "jsonb",
  ];
  // `(?<!\.)` excludes method calls like `text("id").primaryKey()` so we
  // only import a helper when it's invoked as a top-level function call.
  const imports = candidates.filter((c) => new RegExp(`(?<!\\.)\\b${c}\\(`).test(body)).join(", ");
  return (
    joinLines(
      "// Auto-generated.",
      `import { ${imports} } from "drizzle-orm/pg-core";`,
      "",
      ...(schemaDecls.length > 0 ? [...schemaDecls, ""] : []),
      ...enumLines,
      "",
      tables.join("\n\n"),
    ) + "\n"
  );
}

/** Drizzle read-model table for a projection (projection.md) — mirrors
 *  `emitWorkflowStateTable`: the `keyed by` correlation column is the PK, the
 *  remaining state fields are columns.  No idempotent marker in v1. */
function emitProjectionTable(proj: ProjectionIR, ctx: BoundedContextIR, schema?: string): string {
  const tableName = snake(plural(proj.name));
  const lines: string[] = [];
  const factory = schema ? `${schemaConstName(schema)}.table` : "pgTable";
  lines.push(`export const ${lowerFirst(plural(proj.name))} = ${factory}("${tableName}", {`);
  for (const f of proj.stateFields) {
    if (f.name === proj.correlationField) {
      const corrType = f.type.kind === "id" ? f.type.valueType : "guid";
      lines.push(`  ${f.name}: ${drizzleIdColumn(corrType, snake(f.name))}.primaryKey(),`);
    } else {
      // Non-key columns NULLABLE — a fold upserts only the fields its event
      // carries, so a row is partial until every contributing event arrives.
      lines.push(...drizzleColumnLines({ ...f, optional: true }, ctx).map((s) => `  ${s}`));
    }
  }
  lines.push(`});`);
  return lines.join("\n");
}

/** A many-to-many join table for an `T id[]` reference collection.
 * Two FK columns, a composite primary key over (owner, target) — the
 * pair IS the whole row, since `T id[]` is contractually a set (membership
 * only, no order) — and an index on the target FK for the reverse
 * membership query.  No `ordinal` column: deterministic read-back order is
 * a read-time projection (ORDER BY the target FK id), not stored state. */
function emitJoinTable(
  assoc: AssociationIR,
  options: { schema?: string; prefix?: string } = {},
): string {
  const tableConst = joinTableConstName(assoc);
  const ownerKey = joinColumnName(assoc.ownerFk);
  const targetKey = joinColumnName(assoc.targetFk);
  const lines: string[] = [];
  const baseTable = assoc.joinTable;
  const tableName = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  lines.push(`export const ${tableConst} = ${tableFactory}("${tableName}", {`);
  lines.push(`  ${ownerKey}: ${drizzleIdColumn(assoc.valueType, assoc.ownerFk)}.notNull(),`);
  lines.push(`  ${targetKey}: ${drizzleIdColumn(assoc.valueType, assoc.targetFk)}.notNull(),`);
  lines.push(`}, (table) => ({`);
  lines.push(
    `  ${tableConst}Pk: primaryKey({ columns: [table.${ownerKey}, table.${targetKey}] }),`,
  );
  lines.push(
    `  ${tableConst}TargetIdx: index("${assoc.joinTable}_${assoc.targetFk}_idx").on(table.${targetKey}),`,
  );
  lines.push(`}));`);
  return lines.join("\n");
}

/** Drizzle `const` name for a join table — `trainer_party` →
 * `trainerParty`.  Shared with the repository builder so both refer to
 * the same `schema.<const>`. */
export function joinTableConstName(assoc: AssociationIR): string {
  return lowerFirst(camelizeSnake(assoc.joinTable));
}

/** Drizzle column-property key for a join FK — `pokemon_id` →
 * `pokemonId`.  The SQL column name stays snake_case. */
export function joinColumnName(fk: string): string {
  return camelizeSnake(fk);
}

/** `trainer_party` → `trainerParty`; `pokemon_id` → `pokemonId`. */
function camelizeSnake(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

// Audit-log table.  Emitted only when the model declares at least one
// `audited` operation.  One row per successful audited invocation, written
// in the same transaction as the operation's aggregate save (atomic — the
// row and the state change commit or roll back together).  See
// `docs/old/proposals/audit-and-logging.md`.
const OUTBOX_TABLE = `export const loomOutbox = pgTable("__loom_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
});`;

const AUDIT_TABLE = `export const auditRecords = pgTable("audit_records", {
  auditId: text("audit_id").primaryKey(),
  operationId: text("operation_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  actor: jsonb("actor"),
  before: jsonb("before").notNull(),
  after: jsonb("after").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  correlationId: text("correlation_id"),
  scopeId: text("scope_id"),
  parentId: text("parent_id"),
}, (t) => [
  index("audit_records_target_idx").on(t.targetType, t.targetId),
  index("audit_records_correlation_idx").on(t.correlationId),
]);`;

// Provenance history table.  Emitted only when the model declares at least
// one written `provenanced` field.  One append-only row per provenanced
// write, inserted in the same transaction as the operation's aggregate
// save (atomic).  The current lineage is *also* stored co-located on the
// aggregate row's `<field>_provenance` jsonb column; this table is the
// full per-write history.
const PROVENANCE_TABLE = `export const provenanceRecords = pgTable("provenance_records", {
  traceId: text("trace_id").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  targetType: text("target_type").notNull(),
  field: text("field").notNull(),
  inputs: jsonb("inputs").notNull(),
  computedValue: jsonb("computed_value"),
  at: timestamp("at", { withTimezone: true }).notNull(),
  correlationId: text("correlation_id"),
  scopeId: text("scope_id"),
  actorId: text("actor_id"),
  parentId: text("parent_id"),
}, (t) => [
  index("provenance_records_target_idx").on(t.targetType, t.field),
  index("provenance_records_correlation_idx").on(t.correlationId),
]);`;

/** Field names on the aggregate root that should be indexed so the
 * generated finds don't run sequential scans.  Walks every find: if
 * it has an explicit `where` clause, indexes the column refs;
 * otherwise indexes the column matching each parameter by name
 * (mirrors the convention in `repository-builder.ts:findQueryMethod`). */
function indexedColumnsFor(agg: AggregateIR, ctx: BoundedContextIR): Set<string> {
  const out = new Set<string>();
  const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
  if (!repo) return out;
  for (const find of repo.finds) {
    if (find.filter) {
      collectColumnRefs(find.filter, out);
    } else {
      for (const p of find.params) {
        const matched = agg.fields.find(
          (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
        );
        if (matched) out.add(matched.name);
      }
    }
  }
  return out;
}

/** Walks a queryable `where` IR expression and adds every `this.<col>`
 * (and `this.<vo>.<sub>` flattened-VO column) it references. */
function collectColumnRefs(e: ExprIR, out: Set<string>): void {
  switch (e.kind) {
    case "binary":
      collectColumnRefs(e.left, out);
      collectColumnRefs(e.right, out);
      return;
    case "paren":
      collectColumnRefs(e.inner, out);
      return;
    case "unary":
      collectColumnRefs(e.operand, out);
      return;
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "this-vo-prop") {
        out.add(e.name);
      }
      return;
    case "member":
      if (e.receiver.kind === "this") {
        out.add(e.member);
      } else if (e.receiver.kind === "member" && e.receiver.receiver.kind === "this") {
        // `this.vo.sub` — Drizzle column is `<vo>_<sub>`.
        out.add(`${e.receiver.member}_${e.member}`);
      }
      return;
    default:
      return;
  }
}

/** Embedded-children persistence table (`shape(embedded)`): the root's
 *  scalar / `X id` fields stay queryable columns (like the relational
 *  root), but each containment folds into a single jsonb column and
 *  reference collections into a jsonb id-array column.  No part tables,
 *  no join tables.  Mirrors the EF owned-`.ToJson()` / Phoenix embedded
 *  shape and the shared embedded migration table. */
function emitEmbeddedTable(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  indexedColumns: Set<string>,
  options: { schema?: string; prefix?: string } = {},
): string {
  const baseTable = snake(plural(agg.name));
  const tableName = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  const lines: string[] = [];
  lines.push(`export const ${lowerFirst(plural(agg.name))} = ${tableFactory}("${tableName}", {`);
  lines.push(`  id: ${drizzleIdColumn(agg.idValueType, "id")}.primaryKey(),`);
  for (const f of agg.fields) {
    if (f.type.kind === "array" && f.type.element.kind === "id") {
      const not = f.optional ? "" : ".notNull()";
      lines.push(`  ${f.name}: jsonb("${snake(f.name)}")${not},`);
      continue;
    }
    lines.push(...drizzleColumnLines(f, ctx).map((s) => `  ${s}`));
  }
  for (const c of agg.contains) {
    lines.push(`  ${c.name}: jsonb("${snake(c.name)}").notNull(),`);
  }
  const indexEntries = [...indexedColumns].map(
    (col) =>
      `    ${lowerFirst(agg.name)}${pascalize(col)}Idx: index("${tableName}_${snake(col)}_idx").on(table.${col}),`,
  );
  if (indexEntries.length === 0) {
    lines.push(`});`);
  } else {
    lines.push(`}, (table) => ({`);
    lines.push(...indexEntries);
    lines.push(`}));`);
  }
  return lines.join("\n");
}

/** Persisted workflow-correlation state table.  PK is the workflow's single
 *  id-shaped correlation field (`text(...).primaryKey()`, mirroring the
 *  aggregate-id column); the remaining state fields are saga columns rendered
 *  the same way an aggregate's are.  Reuses `drizzleColumnLines`, so column
 *  types stay in lockstep with aggregate tables. */
function emitWorkflowStateTable(wf: WorkflowIR, ctx: BoundedContextIR, schema?: string): string {
  const tableName = snake(plural(wf.name));
  const lines: string[] = [];
  const factory = schema ? `${schemaConstName(schema)}.table` : "pgTable";
  lines.push(`export const ${lowerFirst(plural(wf.name))} = ${factory}("${tableName}", {`);
  for (const f of wf.stateFields ?? []) {
    if (f.name === wf.correlationField) {
      const corrType = f.type.kind === "id" ? f.type.valueType : "guid";
      lines.push(`  ${f.name}: ${drizzleIdColumn(corrType, snake(f.name))}.primaryKey(),`);
    } else {
      lines.push(...drizzleColumnLines(f, ctx).map((s) => `  ${s}`));
    }
  }
  // Idempotent-consumer marker (dispatch-delivery-semantics.md §3): under a
  // durable channel the relay redelivers at-least-once, so the saga row
  // records the last processed outbox event id — the handler preamble
  // no-ops on a repeat.  Ephemeral-only contexts stay byte-identical.
  if (durableEventTypes(ctx).size > 0) {
    lines.push(`  lastEventId: text("last_event_id"),`);
  }
  lines.push(`});`);
  return lines.join("\n");
}

/** Document-shaped persistence table: one jsonb `data` column holding
 *  the whole serialised aggregate read model + a `version` concurrency
 *  counter.  Mirrors the .NET `<Agg>Document` record. */
/** Event-log stream table (D-DOCUMENT-AXIS / appliers A2): one append-only
 *  table per event-sourced aggregate.  A row is one recorded event keyed by
 *  `(stream_id, version)` — `stream_id` is the aggregate id, `version` its
 *  position in the stream (1-based, gap-free).  `type` discriminates the
 *  event for the fold; `data` is the event payload.  No global sequence in
 *  the MVP — `(stream_id, version)` ordering is all fold-from-zero needs. */
function emitEventLogTable(
  name: string,
  options: { schema?: string; prefix?: string } = {},
): string {
  const baseTable = `${snake(name)}_events`;
  const tableName = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  const constName = `${lowerFirst(name)}Events`;
  return [
    `export const ${constName} = ${tableFactory}("${tableName}", {`,
    // `seq` — context-global monotonic cursor (event-log-architecture.md).
    // DB-assigned bigserial; inert until the replay reader lands.
    `  seq: bigserial("seq", { mode: "number" }).notNull(),`,
    // `stream_type` — the owning aggregate/workflow name; discriminates the
    // streams that share this per-context log so a fold reads only its own.
    `  streamType: text("stream_type").notNull(),`,
    `  streamId: text("stream_id").notNull(),`,
    `  version: integer("version").notNull(),`,
    `  type: text("type").notNull(),`,
    `  data: jsonb("data").notNull(),`,
    `  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),`,
    `}, (table) => ({`,
    `  ${constName}Pk: primaryKey({ columns: [table.streamType, table.streamId, table.version] }),`,
    `}));`,
  ].join("\n");
}

function emitDocumentTable(
  name: string,
  idType: IdValueType,
  options: { schema?: string; prefix?: string } = {},
): string {
  const baseTable = snake(plural(name));
  const tableName = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  return [
    `export const ${lowerFirst(plural(name))} = ${tableFactory}("${tableName}", {`,
    `  id: ${drizzleIdColumn(idType, "id")}.primaryKey(),`,
    `  data: jsonb("data").notNull(),`,
    `  version: integer("version").notNull(),`,
    `});`,
  ].join("\n");
}

/** TPH shared table (aggregate-inheritance.md, sharedTable): one table for
 *  the whole hierarchy.  Columns are `id`, the `kind` discriminator, the
 *  abstract base's own columns (keeping their declared nullability), then
 *  every concrete subtype's own columns forced nullable (a row is only ever
 *  one `kind`, so the other kinds' columns are null).  Concrete columns are
 *  de-duplicated by name (first declaration wins) — a later validator can
 *  tighten clashing redeclarations.  v1 covers scalar / value-object / enum /
 *  id columns; parts, containments, and reference collections on a TPH
 *  hierarchy are a later slice. */
function emitTphTable(
  base: AggregateIR,
  ctx: BoundedContextIR,
  options: { schema?: string; prefix?: string } = {},
): string {
  const baseTable = snake(plural(base.name));
  const tableName = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  const lines: string[] = [];
  lines.push(`export const ${lowerFirst(plural(base.name))} = ${tableFactory}("${tableName}", {`);
  lines.push(`  id: ${drizzleIdColumn(base.idValueType, "id")}.primaryKey(),`);
  lines.push(`  kind: text("kind").notNull(),`);
  for (const f of base.fields) {
    lines.push(...drizzleColumnLines(f, ctx).map((s) => `  ${s}`));
  }
  const seen = new Set(base.fields.map((f) => f.name));
  for (const concrete of tphConcretesOf(base, ctx.aggregates)) {
    for (const f of ownFieldsOf(concrete, base)) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      // Force nullable: only rows of this concrete's `kind` populate it.
      lines.push(...drizzleColumnLines({ ...f, optional: true }, ctx).map((s) => `  ${s}`));
    }
  }
  lines.push(`});`);
  return lines.join("\n");
}

/** Id-less child table for a value-object collection field (`<VO>[]`).
 *  Columns: the owner FK + an `ordinal` (preserves list order) + the value
 *  object's flattened fields; primary key `(parentId, ordinal)`.  A plain
 *  relational child table — no Postgres array / jsonb — so it ports to any
 *  SQL backend that shares the database. */
function emitValueCollectionTable(
  vc: ValueCollectionIR,
  ctx: BoundedContextIR,
  idType: IdValueType,
  options: { schema?: string; prefix?: string } = {},
): string {
  const vo = ctx.valueObjects.find((v) => v.name === vc.voName);
  const tableName = options.prefix ? `${options.prefix}${vc.childTable}` : vc.childTable;
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  const lines: string[] = [];
  lines.push(`export const ${vc.tableConst} = ${tableFactory}("${tableName}", {`);
  lines.push(`  parentId: ${drizzleIdColumn(idType, vc.parentFk)}.notNull(),`);
  lines.push(`  ordinal: integer("ordinal").notNull(),`);
  for (const f of vo?.fields ?? []) {
    lines.push(...drizzleColumnLines(f, ctx).map((s) => `  ${s}`));
  }
  lines.push(`}, (table) => ({`);
  lines.push(`  ${vc.tableConst}Pk: primaryKey({ columns: [table.parentId, table.ordinal] }),`);
  lines.push(
    `  ${vc.tableConst}ParentIdIdx: index("${tableName}_parent_id_idx").on(table.parentId),`,
  );
  lines.push(`}));`);
  return lines.join("\n");
}

function emitTable(
  name: string,
  fields: FieldIR[],
  parentName: string | undefined,
  ctx: BoundedContextIR,
  indexedColumns: Set<string>,
  idType: IdValueType,
  options: { schema?: string; prefix?: string } = {},
): string {
  const baseTable = snake(plural(name));
  const tableName = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const lines: string[] = [];
  // dataSource-driven schema routing: when the owning aggregate's
  // dataSource declares `schema: "tenant_a"`, the table goes through
  // the schema's `.table(...)` factory instead of the top-level
  // `pgTable(...)` — same shape on the database side, Drizzle
  // qualifies the SQL with the schema name.
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  lines.push(`export const ${lowerFirst(plural(name))} = ${tableFactory}("${tableName}", {`);
  lines.push(`  id: ${drizzleIdColumn(idType, "id")}.primaryKey(),`);
  if (parentName) {
    // `.references()` mirrors the migration's `FOREIGN KEY … REFERENCES …
    // ON DELETE CASCADE` so the Drizzle schema's relational metadata matches
    // the DDL Loom emits.
    const parentTableConst = lowerFirst(plural(parentName));
    lines.push(
      `  parentId: ${drizzleIdColumn(idType, `${snake(parentName)}_id`)}.notNull().references(() => ${parentTableConst}.id, { onDelete: "cascade" }),`,
    );
  }
  for (const f of fields) {
    lines.push(...drizzleColumnLines(f, ctx).map((s) => `  ${s}`));
  }
  // Co-located provenance: a `<field>_provenance` jsonb column holding the
  // current lineage for each provenanced field.  Typed (via `$type`) as
  // the ProvLineage shape so save/hydrate/toWire round-trip without casts.
  for (const f of fields) {
    if (!f.provenanced) continue;
    lines.push(
      `  ${f.name}_provenance: jsonb("${snake(f.name)}_provenance").$type<import("../domain/provenance").ProvLineage>(),`,
    );
  }
  // Index callback — Drizzle's pgTable accepts a second arg
  // `(table) => ({ idxName: index(...).on(table.col) })`.  We emit
  // an entry for parts' `parentId` (joined every read) plus every
  // root column referenced by a find.
  const indexEntries: string[] = [];
  if (parentName) {
    // Index name keys off the real FK column (`<parent>_id`), matching the
    // migration's `CREATE INDEX <table>_<parent>_id_idx`.
    const parentSnake = snake(parentName);
    indexEntries.push(
      `    ${lowerFirst(name)}${pascalize(parentSnake)}IdIdx: index("${tableName}_${parentSnake}_id_idx").on(table.parentId),`,
    );
  }
  for (const col of indexedColumns) {
    indexEntries.push(
      `    ${lowerFirst(name)}${pascalize(col)}Idx: index("${tableName}_${snake(col)}_idx").on(table.${col}),`,
    );
  }
  if (indexEntries.length === 0) {
    lines.push(`});`);
  } else {
    lines.push(`}, (table) => ({`);
    lines.push(...indexEntries);
    lines.push(`}));`);
  }
  return lines.join("\n");
}

function pascalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** The Drizzle column factory call for an id-shaped column (aggregate PK,
 *  `X id` reference, containment / join-table FK, workflow correlation key).
 *  Mirrors the migration builder's `idColumnType` so the Drizzle schema and the
 *  generated DDL declare the same Postgres type: guid → uuid, int → integer,
 *  long → bigint, string → text. */
function drizzleIdColumn(valueType: IdValueType, colName: string): string {
  switch (valueType) {
    case "guid":
      return `uuid("${colName}")`;
    case "int":
      return `integer("${colName}")`;
    case "long":
      return `bigint("${colName}", { mode: "number" })`;
    case "string":
      return `text("${colName}")`;
  }
}

function drizzleColumnLines(f: FieldIR, ctx: BoundedContextIR): string[] {
  const t = f.type;
  const optional = f.optional || t.kind === "optional";
  const innerType = t.kind === "optional" ? t.inner : t;
  // Value-object fields inline as multiple columns named
  // `<prefix>_<vo_field>`; this keeps queries on single columns and avoids
  // an additional join for simple flattenable VOs.
  if (innerType.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === innerType.name);
    if (vo) {
      const out: string[] = [];
      for (const voField of vo.fields) {
        out.push(
          ...drizzleColumnLinesForName(`${f.name}_${voField.name}`, voField.type, optional, ctx),
        );
      }
      return out;
    }
  }
  return drizzleColumnLinesForName(f.name, innerType, optional, ctx);
}

function drizzleColumnLinesForName(
  fieldName: string,
  t: TypeIR,
  optional: boolean,
  ctx: BoundedContextIR,
): string[] {
  const colName = snake(fieldName);
  const inner = t.kind === "optional" ? t.inner : t;
  const opt = optional || t.kind === "optional";
  const not = opt ? "" : ".notNull()";
  switch (inner.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (inner.name) {
        case "int":
          return [`${fieldName}: integer("${colName}")${not},`];
        case "long":
          return [`${fieldName}: bigint("${colName}", { mode: "number" })${not},`];
        case "decimal":
          return [`${fieldName}: numeric("${colName}")${not},`];
        case "money":
          // Bounded NUMERIC(19,4) is the finance default — same shape
          // sqlx + rust_decimal will read cleanly when the Rust
          // backend lands.  Drizzle's numeric() returns a string at
          // runtime so the repository-builder hydrates via
          // `new Decimal(row.col)` without precision loss.
          return [`${fieldName}: numeric("${colName}", { precision: 19, scale: 4 })${not},`];
        case "string":
          return [`${fieldName}: text("${colName}")${not},`];
        case "bool":
          return [`${fieldName}: boolean("${colName}")${not},`];
        case "datetime":
          return [`${fieldName}: timestamp("${colName}", { withTimezone: true })${not},`];
        case "guid":
          return [`${fieldName}: uuid("${colName}")${not},`];
        case "json":
          return [`${fieldName}: jsonb("${colName}")${not},`];
        case "File":
          // File reference (FileRef) stores as JSONB, exactly like `json` —
          // the bytes live in object storage; the column carries the reference.
          return [`${fieldName}: jsonb("${colName}")${not},`];
        case "duration":
          // A5: expression-only primitive — never a stored column in this
          // slice (Postgres `interval` columns are a follow-on).
          throw new Error("internal: 'duration' is expression-only and never reaches a column");
      }
    case "id":
      return [`${fieldName}: ${drizzleIdColumn(inner.valueType, colName)}${not},`];
    case "enum":
      return [`${fieldName}: ${lowerFirst(inner.name)}Enum("${colName}")${not},`];
    case "valueobject": {
      const vo = ctx.valueObjects.find((v) => v.name === inner.name);
      if (!vo) return [`${fieldName}: text("${colName}")${not},`];
      const out: string[] = [];
      for (const voField of vo.fields) {
        out.push(
          ...drizzleColumnLinesForName(`${fieldName}_${voField.name}`, voField.type, opt, ctx),
        );
      }
      return out;
    }
    case "entity":
      return [`${fieldName}: text("${colName}")${not},`];
    case "array":
      // Collections of references (`T id[]`) are persisted as a
      // many-to-many join table (emitted separately in renderSchema),
      // so they contribute no column on the owning table.
      if (inner.element.kind === "id") return [];
      // Scalar collections (`string[]`, `int[]`, enum[]) map to a native
      // Postgres array column: the element's own column builder with
      // `.array()` appended, which drizzle types as `Element[]`.
      if (inner.element.kind === "primitive" || inner.element.kind === "enum") {
        // Render the element's bare column builder (opt = true suppresses its
        // own `.notNull()`); the array field's own nullability is applied via
        // `not` after `.array()`, so an optional `T[]?` stays nullable and a
        // required `T[]` becomes `.array().notNull()`.
        const elemLines = drizzleColumnLinesForName(fieldName, inner.element, true, ctx);
        if (elemLines.length === 1) {
          const elemLine = elemLines[0]!;
          // `field: <builder>,` → `field: <builder>.array()<not>,`
          const builder = elemLine.slice(elemLine.indexOf(": ") + 2, elemLine.lastIndexOf(","));
          return [`${fieldName}: ${builder}.array()${not},`];
        }
      }
      // Collections of value objects (`<VO>[]`) are persisted as an id-less
      // child table (emitted separately in renderSchema via
      // `emitValueCollectionTable`), so they contribute no column here.
      if (inner.element.kind === "valueobject") return [];
      return [`${fieldName}: text("${colName}")${not}, // non-scalar arrays stored as text`];
    case "optional":
      return drizzleColumnLinesForName(fieldName, inner.inner, true, ctx);
    case "action":
    case "slot":
      throw new Error(
        "drizzleColumnLinesForName: 'slot' type is UI-only and should not reach the schema emitter.",
      );
    case "genericInstance":
      throw new Error(
        `drizzleColumnLinesForName: generic carrier '${inner.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
    case "union":
    case "none":
      throw new Error(
        `drizzleColumnLinesForName: discriminated unions are not emittable yet (P4); IR-validate should have rejected '${inner.kind}'.`,
      );
  }
}

// Used by the repository builder to learn which columns a value-object
// field expands into.
export function valueObjectColumnNames(
  ownerFieldName: string,
  voName: string,
  ctx: BoundedContextIR,
): { columnName: string; subFieldName: string; type: TypeIR }[] {
  const vo = ctx.valueObjects.find((v) => v.name === voName);
  if (!vo) return [];
  return vo.fields.map((f) => ({
    columnName: `${ownerFieldName}_${f.name}`,
    subFieldName: f.name,
    type: f.type,
  }));
}
