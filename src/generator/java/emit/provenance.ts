import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FieldIR,
  SystemIR,
} from "../../../ir/types/loom-ir.js";
import { resolveDataSourceConfig } from "../../../ir/util/resolve-datasource.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Provenance runtime — the Java / Spring counterpart of the Hono
// `domain/provenance.ts` SDK, the .NET `Domain/Common/ProvLineage.cs` +
// `provenance_records` history table, and the elixir-vanilla `<App>.Provenance`
// module.  Emitted only when a context declares at least one `provenanced`
// field (gated on `agg.fields.some(f => f.provenanced)`, never on a backend
// allowlist).
//
//   - `ProvLineage` / `ProvTarget` / `ProvInput` (domain.common) — the
//     immutable lineage value every provenanced write-site builds.  Same jsonb
//     shape as the Hono/.NET lineages (`{ snapshotId, target: { type, field },
//     inputs: [{ path, value }], computedValue }`); persisted co-located on the
//     row's `<field>_provenance` jsonb column (Hibernate's JSON FormatMapper)
//     and appended to the `provenance_records` history table.
//   - `ProvenanceRecord` (infrastructure.persistence) — the append-only JPA
//     `@Entity` for the `provenance_records` table, one row per write,
//     flushed in the aggregate's `@Transactional` save (governance stamps
//     included).
//   - `ProvenanceRecordRepository` (infrastructure.persistence) — the Spring
//     Data interface the repository impl `saveAll`s the drained lineage into.
//
// The per-write capture (the `_provTraces` buffer + the co-located
// `<field>Provenance` field + `drainProv()`) is emitted by entity.ts /
// render-stmt.ts; the flush is wired by repository.ts; the late migration is
// `renderProvenanceMigration` below.
// ---------------------------------------------------------------------------

/** A field carrying the `provenanced` modifier (root field). */
export function provenancedFieldsOf(entity: { fields: FieldIR[] }): FieldIR[] {
  return entity.fields.filter((f) => f.provenanced);
}

/** True iff any aggregate root in the given contexts declares a `provenanced`
 *  field — gates the shared runtime files + repository flush wiring.
 *  Operations (the write sites) live on the root, so a containment carries no
 *  co-located lineage slot — root fields only, matching the .NET emitter. */
export function contextsHaveProvenance(contexts: EnrichedBoundedContextIR[]): boolean {
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      if (provenancedFieldsOf(agg).length > 0) return true;
    }
  }
  return false;
}

/** Snake-cased name of the co-located backing column for a provenanced field
 *  (`total` → `total_provenance`).  Shared by the entity's JPA `@Column`, the
 *  wire DTO, and the migration `ALTER TABLE`, so all three agree. */
export function provColumn(fieldName: string): string {
  return `${snake(fieldName)}_provenance`;
}

/** Every provenanced aggregate across the given contexts, with the Postgres
 *  schema its state table lives in (so the migration `ALTER TABLE` targets the
 *  resolved `<schema>.<table>`, not a bare name).  `schema` is undefined for
 *  the default (`public`) schema. */
export function provenancedAggregates(
  contexts: EnrichedBoundedContextIR[],
  sys?: SystemIR,
): Array<{ agg: EnrichedAggregateIR; fields: FieldIR[]; schema?: string }> {
  const out: Array<{ agg: EnrichedAggregateIR; fields: FieldIR[]; schema?: string }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      const fields = provenancedFieldsOf(agg);
      if (fields.length === 0) continue;
      const schema = sys ? resolveDataSourceConfig(agg, ctx, sys)?.schema : undefined;
      out.push({ agg, fields, schema });
    }
  }
  return out;
}

/** The shared `ProvLineage` value (domain.common).  Java records → Jackson
 *  round-trips them through Hibernate's JSON FormatMapper with no surface
 *  ceremony, keeping the jsonb column shape identical to the Hono lineage. */
export function renderProvLineage(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/** Resolved aggregate type + field name a provenanced write targets. */`,
    `public record ProvTarget(String type, String field) {`,
    `}`,
    ``,
  );
}

/** One leaf input — emitted as its own file (Java's one-public-type rule). */
export function renderProvInput(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/** One leaf input feeding a provenanced write — the source-side path and`,
    ` *  the value it held when the write ran.  Value is opaque (Object) so any`,
    ` *  scalar / value object round-trips through Jackson verbatim. */`,
    `public record ProvInput(String path, Object value) {`,
    `}`,
    ``,
  );
}

/** The lineage record itself. */
export function renderProvLineageRecord(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `import java.util.List;`,
    ``,
    `/** The lineage of one provenanced write: the rule snapshot it came from,`,
    ` *  the field it targeted, the inputs that fed it, and the value it`,
    ` *  produced.  Persisted co-located on the row (current) and appended to`,
    ` *  the provenance_records history table (every write). */`,
    `public record ProvLineage(`,
    `    String snapshotId,`,
    `    ProvTarget target,`,
    `    List<ProvInput> inputs,`,
    `    Object computedValue) {`,
    `}`,
    ``,
  );
}

/** The append-only history JPA `@Entity` (infrastructure.persistence).
 *  Mirrors the Hono `provenance_records` Drizzle table / the .NET
 *  `ProvenanceRecord` EF entity column-for-column (governance stamps
 *  included). */
export function renderProvenanceRecordEntity(basePkg: string): string {
  return lines(
    `package ${basePkg}.infrastructure.persistence;`,
    ``,
    `import java.time.Instant;`,
    `import java.util.List;`,
    ``,
    `import org.hibernate.annotations.JdbcTypeCode;`,
    `import org.hibernate.type.SqlTypes;`,
    ``,
    `import jakarta.persistence.Column;`,
    `import jakarta.persistence.Entity;`,
    `import jakarta.persistence.Id;`,
    `import jakarta.persistence.Table;`,
    ``,
    `import ${basePkg}.domain.common.ProvInput;`,
    ``,
    `/** One append-only row per provenanced write, inserted in the same`,
    ` *  transaction as the aggregate save (atomic).  The current lineage is`,
    ` *  also stored co-located on the aggregate row's <field>_provenance jsonb`,
    ` *  column; this table is the full per-write history. */`,
    `@Entity`,
    `@Table(name = "provenance_records")`,
    `public class ProvenanceRecord {`,
    `    @Id`,
    `    @Column(name = "trace_id")`,
    `    String traceId;`,
    ``,
    `    @Column(name = "snapshot_id")`,
    `    String snapshotId;`,
    ``,
    `    @Column(name = "target_type")`,
    `    String targetType;`,
    ``,
    `    @Column(name = "field")`,
    `    String field;`,
    ``,
    `    @JdbcTypeCode(SqlTypes.JSON)`,
    `    @Column(name = "inputs")`,
    `    List<ProvInput> inputs;`,
    ``,
    `    @JdbcTypeCode(SqlTypes.JSON)`,
    `    @Column(name = "computed_value")`,
    `    Object computedValue;`,
    ``,
    `    @Column(name = "at")`,
    `    Instant at;`,
    ``,
    `    @Column(name = "correlation_id")`,
    `    String correlationId;`,
    ``,
    `    @Column(name = "scope_id")`,
    `    String scopeId;`,
    ``,
    `    @Column(name = "actor_id")`,
    `    String actorId;`,
    ``,
    `    @Column(name = "parent_id")`,
    `    String parentId;`,
    ``,
    `    ProvenanceRecord() {`,
    `    }`,
    ``,
    `    public ProvenanceRecord(String traceId, String snapshotId, String targetType, String field,`,
    `            List<ProvInput> inputs, Object computedValue, Instant at, String correlationId,`,
    `            String scopeId, String actorId, String parentId) {`,
    `        this.traceId = traceId;`,
    `        this.snapshotId = snapshotId;`,
    `        this.targetType = targetType;`,
    `        this.field = field;`,
    `        this.inputs = inputs;`,
    `        this.computedValue = computedValue;`,
    `        this.at = at;`,
    `        this.correlationId = correlationId;`,
    `        this.scopeId = scopeId;`,
    `        this.actorId = actorId;`,
    `        this.parentId = parentId;`,
    `    }`,
    `}`,
    ``,
  );
}

/** The Spring Data interface the repository impl drains the lineage into. */
export function renderProvenanceRecordRepository(basePkg: string): string {
  return lines(
    `package ${basePkg}.infrastructure.persistence;`,
    ``,
    `import org.springframework.data.jpa.repository.JpaRepository;`,
    ``,
    `public interface ProvenanceRecordRepository extends JpaRepository<ProvenanceRecord, String> {`,
    `}`,
    ``,
  );
}

// A Flyway version far above any module migration so this DDL sorts last (the
// aggregate tables already exist, so the co-located-column ALTERs apply).
// Parity with the .NET `29991231235959` / elixir-vanilla `29991231000000`
// provenance migration; `.9` keeps it distinct in Flyway's `V<v>.<n>__` scheme.
const PROVENANCE_MIGRATION_VERSION = "29991231235959";

/** Emit the late Flyway migration when any provenanced field exists: CREATE
 *  the history table + ADD the co-located `<field>_provenance` jsonb column on
 *  each owning aggregate's (schema-qualified) table.  No-op otherwise (keeps
 *  non-provenance projects byte-identical). */
export function emitJavaProvenanceMigration(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR | undefined,
  out: Map<string, string>,
): void {
  const provAggs = provenancedAggregates(contexts, sys);
  if (provAggs.length === 0) return;
  const alters = provAggs.flatMap(({ agg, fields, schema }) => {
    const base = plural(snake(agg.name));
    const table = schema ? `${schema}.${base}` : base;
    return fields.map(
      (f) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${provColumn(f.name)} jsonb;`,
    );
  });
  const sql = lines(
    `-- Auto-generated by Loom — provenance runtime (provenance.md).`,
    `-- Late migration: sorts after every module migration so the aggregate`,
    `-- tables exist for the co-located-column ALTERs.  Not part of MigrationsIR.`,
    ``,
    `CREATE TABLE IF NOT EXISTS provenance_records (`,
    `  trace_id text PRIMARY KEY,`,
    `  snapshot_id text NOT NULL,`,
    `  target_type text NOT NULL,`,
    `  field text NOT NULL,`,
    `  inputs jsonb NOT NULL,`,
    `  computed_value jsonb,`,
    `  at timestamptz NOT NULL,`,
    `  correlation_id text,`,
    `  scope_id text,`,
    `  actor_id text,`,
    `  parent_id text`,
    `);`,
    ``,
    `CREATE INDEX IF NOT EXISTS provenance_records_target_idx ON provenance_records (target_type, field);`,
    `CREATE INDEX IF NOT EXISTS provenance_records_correlation_idx ON provenance_records (correlation_id);`,
    ``,
    ...alters,
    ``,
  );
  out.set(
    `src/main/resources/db/migration/V${PROVENANCE_MIGRATION_VERSION}.9__Provenance.sql`,
    sql,
  );
}
