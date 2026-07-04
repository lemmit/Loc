// ---------------------------------------------------------------------------
// Index-suggestion advisory lint (uniqueness-and-indexes.md §11, D-INDEX-SUGGEST).
//
// The compiler NEVER auto-derives a performance index from finders — an infra
// decision (write-amplification, cardinality, the composite a DBA actually
// wants) it can't see.  Instead it SUGGESTS: a column read on a filter path
// (`find ... where`, or a reified `filter`) that has no covering leading-column
// index gets a `loom.index-suggestion` WARNING naming the fix — the author opts
// in via `resource index: Entity.col` (§3.2) if they agree.
//
// Delivery: a WARNING-severity `loom.index-suggestion` pushed onto the normal
// `validateLoomModel` diagnostics — the same IR-warning channel every surface
// already consumes (api → LSP squiggles / playground / `parse --json` /
// `generate --json`).  Warning-only, so it can't flip a report's `ok` or block
// generation (both are error-gated); `ddd parse` filters this code into a
// `Suggestions:` footer.  Nothing is ever auto-derived — the author opts in via
// `resource index: Entity.col` (§3.2) if they agree.
//
// Coverage (a column is "already indexed", so no suggestion) — LEADING column
// of any derived/declared index: an FK column, `tenant_id` (multi-tenancy
// 1b-tail derives it), the first column of a `unique (...)` key, or the first
// column of a manual `resource index:` spec.  Excludes boolean columns (a
// standalone btree rarely helps) and non-`kind: state` aggregates (no
// relational table).
// ---------------------------------------------------------------------------

import { snake } from "../../../util/naming.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedSystemIR,
  ExprIR,
  TypeIR,
} from "../../types/loom-ir.js";
import { resolveDataSourceForAggregate } from "../../util/resolve-datasource.js";
import { hasTenantOwned } from "../../util/tenant-stance.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { walkExpr } from "./shared.js";

/** Aggregate-field names read as `this.<field>` anywhere in a filter
 *  predicate (a find `where` or a reified `filter`) — the columns a query
 *  filters on. */
function collectFilterColumns(expr: ExprIR | undefined, out: Set<string>): void {
  walkExpr(expr, (n) => {
    if (n.kind === "member" && n.receiver.kind === "this") out.add(n.member);
    else if (n.kind === "ref" && n.refKind === "this-prop") out.add(n.name);
  });
}

/** The snake-cased LEADING columns already covered by a derived or declared
 *  index for this aggregate's root table — FK columns, `tenant_id`, each
 *  `unique (...)` key's first column, each manual `resource index:` first
 *  column (for a spec targeting this aggregate). */
function coveredColumns(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  sys: EnrichedSystemIR,
): Set<string> {
  const covered = new Set<string>();
  // FK columns — every `X id` field is auto-indexed by the migrations builder.
  for (const f of agg.fields) {
    if (baseType(f.type).kind === "id") covered.add(snake(f.name));
  }
  // `tenant_id` — derived on every tenantOwned aggregate (multi-tenancy 1b-tail).
  if (hasTenantOwned(agg)) covered.add("tenant_id");
  // `unique (...)` leading columns (§4) + manual `resource index:` leading
  // columns targeting this aggregate (§3.2).
  for (const uk of agg.uniqueKeys ?? []) {
    if (uk.columns[0]) covered.add(snake(uk.columns[0]));
  }
  const ds = resolveDataSourceForAggregate(agg, ctx, sys);
  for (const mi of ds?.manualIndexes ?? []) {
    if (mi.entity === agg.name && mi.columns[0]) covered.add(snake(mi.columns[0]));
  }
  return covered;
}

function baseType(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** A boolean column is a poor standalone-index candidate (low selectivity) —
 *  never suggested; a partial/composite there is a human call. */
function isBooleanField(t: TypeIR): boolean {
  const b = baseType(t);
  return b.kind === "primitive" && b.name === "bool";
}

export function validateIndexSuggestions(sys: EnrichedSystemIR, diags: LoomDiagnostic[]): void {
  for (const mod of sys.subdomains) {
    for (const ctx of mod.contexts) {
      const repoByAgg = new Map(ctx.repositories.map((r) => [r.aggregateName, r] as const));
      for (const agg of ctx.aggregates) {
        // Only a relational state table has btree indexes to suggest.  Skip
        // event-sourced / document / abstract aggregates.
        if (agg.isAbstract || agg.persistedAs === "eventLog" || agg.savingShape === "document") {
          continue;
        }
        const ds = resolveDataSourceForAggregate(agg, ctx, sys);
        if (ds && ds.kind !== "state") continue;

        // Filter columns: every finder's `where` + the aggregate's reified
        // filters (capability + hand-written), read on every / some read.
        const filterColumns = new Set<string>();
        for (const find of repoByAgg.get(agg.name)?.finds ?? []) {
          collectFilterColumns(find.filter, filterColumns);
        }
        for (const f of agg.contextFilters ?? []) collectFilterColumns(f, filterColumns);

        const covered = coveredColumns(agg, ctx, sys);
        const fieldByName = new Map(agg.fields.map((f) => [f.name, f] as const));
        const resourceName = ds?.name;

        // Deterministic order (declared field order) so output is stable.
        for (const f of agg.fields) {
          if (!filterColumns.has(f.name)) continue;
          if (isBooleanField(f.type)) continue;
          if (covered.has(snake(f.name))) continue;
          if (!fieldByName.has(f.name)) continue;
          const where = resourceName
            ? `\`index: ${agg.name}.${f.name}\` on resource '${resourceName}'`
            : `\`index: ${agg.name}.${f.name}\` on its \`kind: state\` resource`;
          diags.push({
            severity: "warning",
            code: "loom.index-suggestion",
            message:
              `'${agg.name}.${f.name}' is read on a query filter but has no index. ` +
              `Consider ${where}.`,
            source: `${ctx.name}/${agg.name}`,
          });
        }
      }
    }
  }
}
