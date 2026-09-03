import type {
  EnrichedBoundedContextIR,
  ExprIR,
  SeedRowIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, upperFirst } from "../../../util/naming.js";
import { javaLogEvent } from "../../_obs/render-java.js";
import {
  type Entry,
  groupByDataset,
  type SeederAggregate,
  seederAggregates,
  usedAggregates,
} from "../../_persistence/seed-datasets.js";
import { renderSeedRowInsert } from "../../sql-pg.js";
import { collectJavaExprImports, renderJavaExpr } from "../render-expr.js";

// ---------------------------------------------------------------------------
// First-boot database seeding (database-seeding.md) — one
// `<Ctx>SeedRunner` ApplicationRunner per context with `seed` blocks.
//
// Per D-SEED-PATH the default path is **through the domain `create`**:
// each row becomes `<agg>Repository.save(<Agg>.create(…))`, so the
// aggregate's invariants run.  Java's `create(...)` factory takes every
// create-input field positionally (unlike .NET's required-only), so a
// row's args are ordered by `forCreateInput` with omitted fields → null.
//
// Per D-SEED-IDEMPOTENCY a `__loom_seed` marker table holds one row per
// applied dataset (ship-once); `default` always runs, others opt in via
// the LOOM_SEED env var.  `raw` rows bypass the domain and emit the
// shared cross-backend INSERT (schema-qualified — java tables live in
// per-module schemas, not the search_path).
// ---------------------------------------------------------------------------

export interface SeedCtx {
  basePkg: string;
  /** Package the runner lands in (infrastructure.persistence). */
  pkg: string;
  entityPkgOf: (aggName: string) => string;
  repoPkgOf: (aggName: string) => string;
  /** Migration schema per aggregate — qualifies raw INSERTs. */
  schemaOf: (aggName: string) => string | undefined;
}

export function renderJavaSeedRunner(ctx: EnrichedBoundedContextIR, sctx: SeedCtx): string | null {
  const datasets = groupByDataset(ctx);
  if (datasets.length === 0) return null;
  // The shared seeder model (M-T6.52): which aggregates are seedable, and
  // each one's ordered create-call parameters — the aggregate's full
  // create-input set for a state aggregate, or the event-sourced `create`
  // action's OWN declared params for an event-sourced one.  `renderArgs`
  // used to build every call from `forCreateInput(agg.fields)` regardless
  // of shape — on an event-sourced aggregate that is a param-count/name
  // mismatch against the `create` factory's OWN params
  // (`Account.create("seeded-alice", null)` against `create(String owner)`,
  // javac "cannot be applied") — this is what fixes it.
  const aggByName = seederAggregates(ctx);

  const imports = new Set<string>();
  const fnBlocks: string[] = [];
  const callLines: string[] = [];
  for (const ds of datasets) {
    const entries = ds.entries.filter((e) => aggByName.has(e.row.aggregate));
    if (entries.length === 0) continue;
    fnBlocks.push(...renderDatasetFn(ds.name, entries, aggByName, sctx, imports));
    callLines.push(`        seed${upperFirst(ds.name)}(requested);`);
  }
  if (callLines.length === 0) return null;

  const repoFields = usedAggregates(datasets, new Set(aggByName.keys()));
  const ctorParams = [
    "JdbcTemplate jdbc",
    ...repoFields.map((a) => `${a}Repository ${repoField(a)}`),
  ].join(", ");
  return lines(
    `package ${sctx.pkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    imports.size > 0 ? `` : null,
    `import java.util.HashSet;`,
    `import java.util.Set;`,
    ``,
    `import org.springframework.boot.ApplicationArguments;`,
    `import org.springframework.boot.ApplicationRunner;`,
    `import org.springframework.jdbc.core.JdbcTemplate;`,
    `import org.springframework.stereotype.Component;`,
    ``,
    ...repoFields.flatMap((a) => {
      const entityPkg = sctx.entityPkgOf(a);
      const repoPkg = sctx.repoPkgOf(a);
      return [
        entityPkg !== sctx.pkg ? `import ${entityPkg}.${a};` : null,
        repoPkg !== sctx.pkg ? `import ${repoPkg}.${a}Repository;` : null,
      ].filter((l): l is string => l !== null);
    }),
    `import ${sctx.basePkg}.domain.enums.*;`,
    `import ${sctx.basePkg}.domain.ids.*;`,
    `import ${sctx.basePkg}.domain.valueobjects.*;`,
    `import ${sctx.basePkg}.config.CatalogLog;`,
    ``,
    `/** First-boot seed data (database-seeding.md).  Ship-once per dataset`,
    ` *  via the __loom_seed marker; re-runs are no-ops.`,
    ` *  \`default\` always runs; other datasets opt in via LOOM_SEED. */`,
    `@Component`,
    `public class ${ctx.name}SeedRunner implements ApplicationRunner {`,
    `    private final JdbcTemplate jdbc;`,
    ...repoFields.map((a) => `    private final ${a}Repository ${repoField(a)};`),
    ``,
    `    public ${ctx.name}SeedRunner(${ctorParams}) {`,
    `        this.jdbc = jdbc;`,
    ...repoFields.map((a) => `        this.${repoField(a)} = ${repoField(a)};`),
    `    }`,
    ``,
    `    @Override`,
    `    public void run(ApplicationArguments args) {`,
    `        jdbc.execute("CREATE TABLE IF NOT EXISTS \\"__loom_seed\\" (\\"dataset\\" text PRIMARY KEY, \\"applied_at\\" timestamptz NOT NULL DEFAULT now())");`,
    `        var requested = new HashSet<String>();`,
    `        for (var part : System.getenv().getOrDefault("LOOM_SEED", "").split(",")) {`,
    `            if (!part.isBlank()) requested.add(part.trim());`,
    `        }`,
    ...callLines,
    `    }`,
    ``,
    ...fnBlocks,
    `    private boolean datasetEnabled(String dataset, Set<String> requested) {`,
    `        return "default".equals(dataset) || requested.contains(dataset);`,
    `    }`,
    ``,
    `    private boolean alreadySeeded(String dataset) {`,
    `        var found = jdbc.queryForList("SELECT 1 FROM \\"__loom_seed\\" WHERE \\"dataset\\" = ?", Integer.class, dataset);`,
    `        return !found.isEmpty();`,
    `    }`,
    ``,
    `    private void markSeeded(String dataset) {`,
    `        jdbc.update("INSERT INTO \\"__loom_seed\\" (\\"dataset\\") VALUES (?)", dataset);`,
    `    }`,
    `}`,
    ``,
  );
}

function renderDatasetFn(
  dataset: string,
  entries: Entry[],
  aggByName: Map<string, SeederAggregate>,
  sctx: SeedCtx,
  imports: Set<string>,
): string[] {
  const rowLines = entries.map((e) => {
    if (e.raw) {
      const sql = renderSeedRowInsert(
        e.row.aggregate,
        e.row.fields,
        sctx.schemaOf(e.row.aggregate),
      );
      return `        jdbc.execute(${JSON.stringify(sql)});`;
    }
    const agg = aggByName.get(e.row.aggregate)!;
    return `        ${repoField(e.row.aggregate)}.save(${e.row.aggregate}.create(${renderArgs(e.row, agg, imports)}));`;
  });
  return [
    `    private void seed${upperFirst(dataset)}(Set<String> requested) {`,
    `        if (!datasetEnabled(${JSON.stringify(dataset)}, requested)) return;`,
    `        if (alreadySeeded(${JSON.stringify(dataset)})) return;`,
    ...rowLines,
    `        markSeeded(${JSON.stringify(dataset)});`,
    `        CatalogLog.event(${javaLogEvent("seedApplied")}, "dataset", ${JSON.stringify(dataset)});`,
    `    }`,
    ``,
  ];
}

/** Positional `create(…)` args, over the shared seeder model's ordered
 *  `createParams` (M-T6.52) — the aggregate's full create-input set for a
 *  state aggregate, or the event-sourced `create` action's OWN declared
 *  params for an event-sourced one.  Java's factory takes every one of
 *  THOSE positionally; rows omit trailing/middle params → null.  This used
 *  to always read `forCreateInput(agg.fields)` — every declared FIELD —
 *  which on an event-sourced aggregate is a different, usually longer, list
 *  than the `create` factory's own params: `Account.create("seeded-alice",
 *  null)` positionally against `create(String owner)` (javac "cannot be
 *  applied", the wrong-arg-count half of M-T6.52). */
function renderArgs(row: SeedRowIR, agg: SeederAggregate, imports: Set<string>): string {
  const byName = new Map(row.fields.map((f) => [f.name, f.value]));
  return agg.createParams
    .map((p) => {
      const v = byName.get(p.name);
      if (!v) return "null";
      collectJavaExprImports(v, imports);
      return renderSeedValue(v, p.type, imports);
    })
    .join(", ");
}

/** A provided seed value, coerced where the DSL literal and the Java type
 *  diverge: a STRING literal for a `datetime` field parses to an `Instant`
 *  (the factory takes `Instant`, not the wire string). */
function renderSeedValue(value: ExprIR, fieldType: TypeIR, imports: Set<string>): string {
  let t = fieldType;
  while (t.kind === "optional") t = t.inner;
  if (t.kind === "primitive" && t.name === "datetime" && value.kind === "literal") {
    imports.add("java.time.Instant");
    return `Instant.parse(${renderJavaExpr(value)})`;
  }
  return renderJavaExpr(value);
}

function repoField(agg: string): string {
  return `${lowerFirst(plural(agg))}Repository`;
}
