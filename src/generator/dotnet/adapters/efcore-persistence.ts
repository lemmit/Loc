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

import type { AggregateIR, DataSourceIR, StorageIR } from "../../../ir/types/loom-ir.js";
import type { EmitCtx, Lines, PersistenceAdapter } from "../../_adapters/index.js";
import { renderConfiguration, renderDbContext } from "../emit/efcore.js";
import { emitDotnetMigrations } from "../emit/migrations.js";
import { renderRepositoryImpl } from "../emit/repository.js";
import { buildFindBodies } from "../find-emit.js";

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
function findRepoFor(ctx: EmitCtx, aggName: string) {
  for (const c of ctx.contexts) {
    const r = c.repositories.find((repo) => repo.aggregateName === aggName);
    if (r) return r;
  }
  return undefined;
}

const splitLines = (s: string): Lines => s.split("\n");

export const efcorePersistenceAdapter: PersistenceAdapter = {
  name: "efcore",
  supportedStrategies: ["state"],
  // D-DOCUMENT-AXIS Slice D: efcore emits both relational tables and the
  // single-JSON-document shape (`normalised(false)`) via the
  // persistence-record pattern (`(id, data jsonb, version)`), so it
  // advertises both saving shapes.
  supportedShapes: ["normalised", "document"],

  supports(storageType, kind, persistenceStrategy) {
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
      `    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.10" />`,
      `    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="8.0.10">`,
      `      <PrivateAssets>all</PrivateAssets>`,
      `      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>`,
      `    </PackageReference>`,
      `    <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="8.0.10">`,
      `      <PrivateAssets>all</PrivateAssets>`,
      `      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>`,
      `    </PackageReference>`,
      `    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.10" />`,
    ];
  },

  emitConnectionSetup(_physicalStores: readonly StorageIR[], ctx: EmitCtx): Lines {
    // DbContext registration spliced into Program.cs by the existing
    // template (program.ts:206-213).  The `usesStamping` branch adds
    // the AuditableInterceptor — emit the auditable-aware form when
    // any aggregate carries `contextStamps`, mirroring the inline
    // logic in `renderProgram`.
    const ns = nsOf(ctx);
    const usesStamping = ctx.contexts.some((c) =>
      c.aggregates.some((a) => (a.contextStamps?.length ?? 0) > 0),
    );
    if (usesStamping) {
      return [
        `builder.Services.AddScoped<${ns}.Infrastructure.Persistence.AuditableInterceptor>();`,
        `builder.Services.AddDbContext<AppDbContext>((sp, opts) =>`,
        `{`,
        `    opts.UseNpgsql(builder.Configuration.GetConnectionString("Default"));`,
        `    opts.AddInterceptors(sp.GetRequiredService<${ns}.Infrastructure.Persistence.AuditableInterceptor>());`,
        `});`,
      ];
    }
    return [
      `builder.Services.AddDbContext<AppDbContext>(opts =>`,
      `    opts.UseNpgsql(builder.Configuration.GetConnectionString("Default")));`,
    ];
  },

  emitRepository(agg: AggregateIR, _logical: DataSourceIR, ctx: EmitCtx): Lines {
    // Wraps `renderRepositoryImpl` — the per-aggregate EF repository
    // class.  The orchestrator still calls `renderRepositoryImpl`
    // directly today (../index.ts:emitAggregate); future wire-up
    // routes through this adapter.  Logical config (schema /
    // tablePrefix) is unused today — see `renderConfiguration` for
    // where it'll plug in.
    const ns = nsOf(ctx);
    const repo = findRepoFor(ctx, agg.name);
    // The find-body builder threads usings back for filters using
    // regex etc.  Mirrors the orchestrator's local Set<string>.
    const extra = new Set<string>();
    // EnrichedAggregateIR cast is safe: ctx.contexts are
    // EnrichedBoundedContextIR, so every aggregate the orchestrator
    // would pass through here is already enriched.
    const enriched = agg as import("../../../ir/types/loom-ir.js").EnrichedAggregateIR;
    const findBodies = buildFindBodies(enriched, repo, extra);
    return splitLines(
      renderRepositoryImpl(enriched, repo, ns, findBodies, {
        extraUsings: [...extra].sort(),
        emitTrace: !!ctx.emitTrace,
      }),
    );
  },

  emitMigrations(
    _aggs: readonly AggregateIR[],
    _physicalStores: readonly StorageIR[],
    ctx: EmitCtx,
  ): Lines | null {
    // Per-deployable migration emission — already a separate
    // file-emit fn that writes into the passed Map.  We wrap it
    // here by collecting into a temporary map, then flattening the
    // emitted file paths + contents into a Lines stream (one block
    // per file, blank-line separated) so the adapter contract
    // (Lines | null) holds.  The orchestrator's `emitDotnetMigrations`
    // call in ../index.ts owns the actual file placement today.
    if (!ctx.migrations || ctx.migrations.length === 0) return null;
    const ns = nsOf(ctx);
    const collected = new Map<string, string>();
    emitDotnetMigrations(ctx.migrations, ns, collected);
    const out: string[] = [];
    for (const [path, content] of [...collected.entries()].sort()) {
      out.push(`// ---- ${path} ----`);
      out.push(...content.split("\n"));
      out.push("");
    }
    return out;
  },

  emitOutbox(_physical: StorageIR, _aggs: readonly AggregateIR[], _ctx: EmitCtx): Lines | null {
    // Transactional outbox emission is deferred to a later slice of
    // the micro-plan (the validator already rejects `publish:
    // integration | both` without a transactional store, so reaching
    // here today is a capability gap rather than silent success).
    return null;
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
    enums: ctx.contexts.flatMap((c) => c.enums),
    valueObjects: ctx.contexts.flatMap((c) => c.valueObjects),
    events: ctx.contexts.flatMap((c) => c.events),
    aggregates: ctx.contexts.flatMap((c) => c.aggregates),
    repositories: ctx.contexts.flatMap((c) => c.repositories),
    workflows: ctx.contexts.flatMap((c) => c.workflows),
    views: ctx.contexts.flatMap((c) => c.views),
  } as import("../../../ir/types/loom-ir.js").EnrichedBoundedContextIR;
  return splitLines(renderDbContext(merged, ns));
}
