import type { AggregateIR } from "../../../ir/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural } from "../../../util/naming.js";
import { renderCsExpr } from "../render-expr.js";

// .NET DbContext-level emission for capabilities.
//
// Three artefact families are produced from the union of every
// aggregate's `implementsCapabilities` + `contextFilters` + the
// per-capability grouping derived from them:
//
//   1. Domain/Common/I<Name>.cs — empty marker interfaces, one per
//      distinct capability name appearing on any aggregate.  These
//      are user-visible types: application code can `if (e is IFoo)`
//      / declare `IEnumerable<IFoo>` etc.
//
//   2. Infrastructure/Persistence/<Name>Filters.cs — typed static
//      helpers for installing query filters on aggregates that opt
//      into the capability AND declare `filter` predicates.  One
//      `Apply<T>(ModelBuilder)` method per (capability, aggregate)
//      pair, since EF Core's HasQueryFilter is a per-entity-type
//      API regardless of any interface grouping.
//
//   3. The OnModelCreating snippet returned by `renderCapabilityPass`
//      runs one reflection loop per capability: scan
//      `mb.Model.GetEntityTypes()`, find those that implement the
//      marker interface, dispatch to the matching `Apply` method.
//
// Aggregates with `contextFilters` but no `implements` fall back to
// per-EntityConfiguration emission (no grouping possible); that
// path stays in `efcore.tpl.ts:renderConfiguration`.

/** Capability name + the aggregates that opted into it.  Used to
 * gate marker / filter / pass emission per name. */
interface CapabilityGroup {
  /** Name as declared in source (`implements "softDeletable"`). */
  name: string;
  /** Aggregates implementing this capability. */
  aggregates: AggregateIR[];
}

/** Group aggregates by every capability name they declare.  An
 * aggregate with N implementsCapabilities entries shows up in N
 * groups.  Sorted by name so emission order is deterministic. */
export function capabilityGroups(aggregates: readonly AggregateIR[]): CapabilityGroup[] {
  const by = new Map<string, AggregateIR[]>();
  for (const a of aggregates) {
    for (const name of a.implementsCapabilities ?? []) {
      let list = by.get(name);
      if (!list) {
        list = [];
        by.set(name, list);
      }
      list.push(a);
    }
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, aggs]) => ({ name, aggregates: aggs }));
}

/** Marker-interface name on the .NET side: `softDeletable` →
 * `ISoftDeletable`.  Pure naming convention; the interface body
 * is empty. */
export function capabilityInterfaceName(capName: string): string {
  return `I${capName[0]!.toUpperCase()}${capName.slice(1)}`;
}

/** Empty marker interface — the type tag.  No declared members;
 * runtime stamping/filtering walks each entity type concretely
 * because EF Core requires per-type API calls. */
export function renderCapabilityInterface(ns: string, capName: string): string {
  const ifaceName = capabilityInterfaceName(capName);
  return (
    lines(
      "// Auto-generated.",
      `namespace ${ns}.Domain.Common;`,
      "",
      `/// <summary>Marker interface for aggregates that declared`,
      `/// <c>implements "${capName}"</c>.  Runtime stamping /`,
      `/// query-filter infrastructure scans for entities implementing`,
      `/// this type and applies the per-aggregate code generated`,
      `/// from each aggregate's <c>filter</c> and <c>stamp</c>`,
      `/// declarations.</summary>`,
      `public interface ${ifaceName} { }`,
    ) + "\n"
  );
}

/** Per-aggregate filter installation helper.  Static class with one
 * generic `Apply<T>(ModelBuilder)` per aggregate that participates
 * in the capability AND declares any filter predicates.  EF Core's
 * `HasQueryFilter` is per-entity-type — interface grouping doesn't
 * change that — so we still emit one call per entity, but they're
 * collected in one file and invoked from one OnModelCreating loop. */
export function renderCapabilityFilters(
  ns: string,
  cap: CapabilityGroup,
): string | undefined {
  // Only emit when at least one participating aggregate has filters.
  const withFilters = cap.aggregates.filter((a) => (a.contextFilters?.length ?? 0) > 0);
  if (withFilters.length === 0) return undefined;
  const ifaceName = capabilityInterfaceName(cap.name);
  const helperName = `${cap.name[0]!.toUpperCase()}${cap.name.slice(1)}Filters`;
  // Per-aggregate Apply method: takes the ModelBuilder, calls
  // HasQueryFilter with the translated predicate.  Multiple filters
  // on one aggregate combine via `&&`.
  const applyMethods = withFilters.flatMap((agg) => {
    const predicate = (agg.contextFilters ?? [])
      .map((p) => renderCsExpr(p, { thisName: "x" }))
      .join(" && ");
    const aggUsing = `using ${ns}.Domain.${plural(agg.name)};`;
    void aggUsing; // collected at the file header
    return [
      "",
      `    public static void ApplyTo${agg.name}(ModelBuilder mb)`,
      "    {",
      `        mb.Entity<${agg.name}>().HasQueryFilter(x => ${predicate});`,
      "    }",
    ];
  });
  const aggUsings = withFilters.map((a) => `using ${ns}.Domain.${plural(a.name)};`);
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      `using ${ns}.Domain.Common;`,
      ...aggUsings,
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      `/// <summary>Per-aggregate query-filter installers for the`,
      `/// <c>${cap.name}</c> capability.  Invoked from`,
      `/// <see cref="AppDbContext.OnModelCreating"/> via reflection,`,
      `/// scoped by the <see cref="${ifaceName}"/> marker.</summary>`,
      `public static class ${helperName}`,
      "{",
      `    public static void Apply(ModelBuilder mb, System.Type entityType)`,
      "    {",
      `        // Dispatch on entity type so the right strongly-typed`,
      `        // Apply method runs.  Generated from the IR's`,
      `        // implementsCapabilities + contextFilters union.`,
      ...withFilters.map(
        (agg) =>
          `        if (entityType == typeof(${agg.name})) { ApplyTo${agg.name}(mb); return; }`,
      ),
      "    }",
      ...applyMethods,
      "}",
    ) + "\n"
  );
}

/** OnModelCreating snippet: one loop per capability that has any
 * filter-emitting participants.  Iterates the model's entity types,
 * finds those that implement the capability's marker interface, and
 * dispatches to the corresponding helper.  Returns an empty array
 * when no capability emits filters — the DbContext body stays
 * minimal in projects that don't use the feature. */
export function renderCapabilityPass(
  ns: string,
  groups: readonly CapabilityGroup[],
): string[] {
  const out: string[] = [];
  for (const cap of groups) {
    const hasFilters = cap.aggregates.some((a) => (a.contextFilters?.length ?? 0) > 0);
    if (!hasFilters) continue;
    const ifaceName = capabilityInterfaceName(cap.name);
    const helperName = `${cap.name[0]!.toUpperCase()}${cap.name.slice(1)}Filters`;
    out.push(
      "        foreach (var entityType in modelBuilder.Model.GetEntityTypes())",
      "        {",
      `            if (typeof(${ifaceName}).IsAssignableFrom(entityType.ClrType))`,
      "            {",
      `                ${helperName}.Apply(modelBuilder, entityType.ClrType);`,
      "            }",
      "        }",
    );
  }
  return out;
}
