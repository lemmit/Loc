// ---------------------------------------------------------------------------
// efcore — the real PersistenceAdapter for the dotnet platform.  Wraps the
// existing emit functions in `../emit/*` so the produced source is
// byte-identical with today's `generateDotnetForContexts` output.
//
// F5 first slice: the adapter EXPOSES the contract; the orchestrator
// (`src/generator/dotnet/index.ts`) still calls the underlying emit fns
// directly.  Future F5 slices will rewire the orchestrator to dispatch
// through this adapter, at which point the existing call sites collapse
// into one entry per platform — no semantic change to the output.
// ---------------------------------------------------------------------------

import type { AggregateIR } from "../../../ir/types/loom-ir.js";
import { dedupeByName } from "../../../util/dedupe.js";
import { PLATFORM_SAVING_SHAPES } from "../../../util/platform-axes.js";
import type { EmitCtx, Lines, PersistenceAdapter } from "../../_adapters/index.js";
import { renderConfiguration, renderDbContext } from "../emit/efcore.js";

/** Per-deployable namespace — every dotnet emit fn keys off it for
 *  `using` directives + class declarations.  Mirrors the `ns` parameter
 *  the orchestrator threads through today — `deployable.name` with
 *  the first letter capitalised (see `src/platform/dotnet.ts:emitProject`). */
function nsOf(ctx: EmitCtx): string {
  const name = ctx.deployable.name;
  return name[0]!.toUpperCase() + name.slice(1);
}

/** Find the matching repository declaration in any of the deployable's
 *  contexts.  Mirrors `findRepoFor` in `../index.ts`. */
function _findRepoFor(ctx: EmitCtx, aggName: string) {
  for (const c of ctx.contexts) {
    const r = c.repositories.find((repo) => repo.aggregateName === aggName);
    if (r) return r;
  }
  return undefined;
}

const splitLines = (s: string): Lines => s.split("\n");

export const efcorePersistenceAdapter: PersistenceAdapter = {
  name: "efcore",
  supportedStrategies: ["state", "eventLog"],
  // D-DOCUMENT-AXIS: EF emits all three saving shapes — relational
  // tables, `embedded` (owned-types `.ToJson()`), and the opaque
  // `document` blob.  Sourced from the single capability map so the
  // adapter advertisement and the validator never drift.
  supportedShapes: PLATFORM_SAVING_SHAPES.dotnet,

  supports(storageType, kind, persistenceStrategy) {
    // Event-sourced streams (appliers A2.2b): an append-only `<agg>_events`
    // table on the same relational store (no Marten), folded at load.
    if (persistenceStrategy === "eventLog") {
      return ["postgres", "mysql", "sqlite"].includes(storageType) && kind === "eventLog";
    }
    return (
      persistenceStrategy === "state" &&
      ["postgres", "mysql", "sqlite", "inMemory"].includes(storageType) &&
      ["state", "snapshot", "replica"].includes(kind)
    );
  },

  emitProjectDeps(_ctx: EmitCtx): Lines {
    // EF Core + Npgsql package refs — identical to what `renderCsproj`
    // splices into the deployable's <ItemGroup>.  Wrapping them here
    // lets the future orchestrator collect deps from every adapter
    // without `renderCsproj` keeping a closed list.
    return [
      `    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.9" />`,
      `    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.9">`,
      `      <PrivateAssets>all</PrivateAssets>`,
      `      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>`,
      `    </PackageReference>`,
      `    <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.9">`,
      `      <PrivateAssets>all</PrivateAssets>`,
      `      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>`,
      `    </PackageReference>`,
      `    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="10.0.2" />`,
    ];
  },
};

/** Per-aggregate EF configuration class — `renderConfiguration`
 *  output.  Not on the formal PersistenceAdapter contract today
 *  (configurations are an EF-internal concern); exposed here for
 *  the orchestrator's call site (`../index.ts:emitAggregate`) so
 *  the eventual rewire knows where it ends up. */
export function emitConfiguration(agg: AggregateIR, ctx: EmitCtx): Lines {
  const ns = nsOf(ctx);
  const enriched = agg as import("../../../ir/types/loom-ir.js").EnrichedAggregateIR;
  const owningContext = ctx.contexts.find((c) => c.aggregates.some((a) => a.name === agg.name));
  if (!owningContext) return [];
  return splitLines(renderConfiguration(enriched, ns, owningContext));
}

/** `renderDbContext` wrapper — the merged-aggregates DbContext for
 *  the deployable.  Not on the formal PersistenceAdapter contract
 *  today either; same forward-wiring placeholder as
 *  `emitConfiguration` above. */
export function emitDbContext(ctx: EmitCtx): Lines {
  const ns = nsOf(ctx);
  const merged = {
    name: ns,
    // Dedupe the ambient root-level enums / VOs that enrichment folds into
    // every hosted context — a plain union would emit duplicate enum / class
    // declarations across the merged DbContext.
    enums: dedupeByName(ctx.contexts.flatMap((c) => c.enums)),
    valueObjects: dedupeByName(ctx.contexts.flatMap((c) => c.valueObjects)),
    events: ctx.contexts.flatMap((c) => c.events),
    aggregates: ctx.contexts.flatMap((c) => c.aggregates),
    repositories: ctx.contexts.flatMap((c) => c.repositories),
    workflows: ctx.contexts.flatMap((c) => c.workflows),
    views: ctx.contexts.flatMap((c) => c.views),
  } as import("../../../ir/types/loom-ir.js").EnrichedBoundedContextIR;
  return splitLines(renderDbContext(merged, ns));
}
