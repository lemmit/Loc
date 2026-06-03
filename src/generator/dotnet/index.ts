import { enrichLoomModel } from "../../ir/enrich/enrichments.js";
import { lowerModel } from "../../ir/lower/lower.js";
import type {
  BoundedContextIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
  SystemIR,
} from "../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../ir/types/migrations-ir.js";
import { isTpcBase } from "../../ir/util/inheritance.js";
import {
  effectiveSavingShape,
  isDocumentShaped,
  resolveDataSourceConfig,
} from "../../ir/util/resolve-datasource.js";
import type { Model } from "../../language/generated/ast.js";
import { plural, upperFirst } from "../../util/naming.js";
import type { EmitCtx, LayoutAdapter, StyleAdapter } from "../_adapters/index.js";
import { generateReactForContexts } from "../react/index.js";
import {
  byLayerLayoutAdapter,
  type DotnetArtifact,
  type DotnetArtifactCategory,
} from "./adapters/by-layer-layout.js";
import { cqrsStyleAdapter } from "./adapters/cqrs-style.js";
import { emitDotnetResourceFiles } from "./adapters/resource-clients.js";
import { emitAuthFiles } from "./auth-emit.js";
import {
  emitBaseReaders,
  emitCommon,
  emitDispatcher,
  emitEnums,
  emitEvents,
  emitIds,
  emitStampingInterceptor,
  emitValueObjects,
} from "./context-scaffolding-emit.js";
import { emitCqrs } from "./cqrs-emit.js";
import { renderDapperRepository, renderDapperSchema } from "./emit/dapper.js";
import { renderDomainLog, renderDomainLogBehavior } from "./emit/domain-log.js";
import { emitDotnetMigrations } from "./emit/migrations.js";
import { renderRequestLoggingMiddleware } from "./emit/request-logging.js";
import { emitDotnetSeeds } from "./emit/seed.js";
import {
  joinEntityName,
  renderAbstractBaseEntity,
  renderConfiguration,
  renderCsproj,
  renderDbContext,
  renderDockerfile,
  renderDockerignore,
  renderDocumentConfiguration,
  renderDocumentPoco,
  renderDocumentRepositoryImpl,
  renderEntity,
  renderEvent,
  renderExceptionFilter,
  renderIDomainEvent,
  renderJoinEntity,
  renderJoinEntityConfiguration,
  renderListWrapperFilter,
  renderProblemDetailsFilter,
  renderProgram,
  renderRepositoryImpl,
  renderRepositoryInterface,
  renderRequiredFromCtorParamFilter,
  renderSnapshots,
  renderTestCsproj,
  renderTestsFile,
} from "./emit.js";
import {
  buildFindBodies,
  buildRetrievalBodies,
  collectFindBodyUsings,
  collectRetrievalBodyUsings,
} from "./find-emit.js";
import { hasAnyWireValidator, renderValidationBehavior } from "./validator-emit.js";
import { emitViews } from "./view-emit.js";
import { emitWorkflows } from "./workflow-emit.js";

// ---------------------------------------------------------------------------
// .NET backend entry point.
//
// `generateDotnet(model)` returns a Map of relative paths → file
// contents.  Per bounded context it produces:
//
//   Domain/Ids/                    — record-struct ID types
//   Domain/Enums/                  — enums
//   Domain/ValueObjects/           — immutable record-classes
//   Domain/Events/                 — IDomainEvent + per-event records
//   Domain/Common/                 — DomainException, IDomainEventDispatcher
//   Domain/<Plural>/               — aggregate root, parts, repo interface
//   Application/<Plural>/Requests/ — wire-shape request DTOs
//   Application/<Plural>/Responses/— wire-shape response DTOs
//   Application/<Plural>/Commands/ — Mediator commands + handlers
//   Application/<Plural>/Queries/  — Mediator queries + handlers
//   Infrastructure/Persistence/    — AppDbContext + EF configurations
//   Infrastructure/Repositories/   — EF-backed repositories
//   Infrastructure/Events/         — NoopDomainEventDispatcher
//   Api/                           — controllers + DomainExceptionFilter
//   Tests/<Plural>/                — xUnit test classes (when `test` blocks
//                                    are declared in the .ddd source)
//   Program.cs, <ns>.csproj        — hosting entry + project file
// ---------------------------------------------------------------------------

/**
 * Legacy entry: lowers the whole model and emits one project from each
 * top-level bounded context (used by `ddd generate dotnet <file>`).
 */
export function generateDotnet(
  model: Model,
  options: { emitTrace?: boolean } = {},
): Map<string, string> {
  // See platform/hono/v4/emit.ts:generateTypeScript for the
  // lowering + enrichment two-step (Hono backend's shell since the
  // versioned-package split).
  const loom = enrichLoomModel(lowerModel(model));
  return generateDotnetForContexts(loom.contexts, undefined, undefined, options);
}

/**
 * System-mode entry: emits a single .NET project from a pre-filtered
 * list of contexts under the chosen namespace.  When emitting for a
 * deployable, the namespace is the deployable name.  When called with
 * a single context (non-system entry point), the namespace is that
 * context's name.
 *
 * `system` (when present) carries the system-wide user-claim shape +
 * the deployable's auth setting — the entry threads them into the
 * Auth/* file emitter and the Program.cs middleware mount.  Loose
 * top-level contexts (no enclosing system) skip that path entirely.
 */
export function generateDotnetForContexts(
  contexts: EnrichedBoundedContextIR[],
  namespace?: string,
  system?: {
    deployable: DeployableIR;
    sys: SystemIR;
    migrations?: MigrationsIR[];
    styleAdapter?: StyleAdapter;
    layoutAdapter?: LayoutAdapter;
  },
  options: { emitTrace?: boolean } = {},
): Map<string, string> {
  const out = new Map<string, string>();
  const emitTrace = !!options.emitTrace;
  if (namespace !== undefined) {
    // Single project containing all the given contexts under one namespace.
    emitProjectFromContexts(contexts, namespace, out, system, emitTrace);
  } else {
    for (const ctx of contexts) {
      emitContext(ctx, ctx.name, out, emitTrace);
    }
  }
  return out;
}

function emitProjectFromContexts(
  contexts: EnrichedBoundedContextIR[],
  ns: string,
  out: Map<string, string>,
  system?: {
    deployable: DeployableIR;
    sys: SystemIR;
    migrations?: MigrationsIR[];
    styleAdapter?: StyleAdapter;
    layoutAdapter?: LayoutAdapter;
  },
  emitTrace = false,
): void {
  // Fullstack-dotnet branch — when the deployable declares a `ui:`
  // mount, the .NET project hosts an embedded React SPA from
  // `wwwroot/`.  Controllers move to `/api/*` so the SPA's path
  // namespace stays free for client-side routing; `Program.cs` adds
  // `UseStaticFiles` + `MapFallbackToFile`; the Dockerfile becomes
  // multi-stage and copies the SPA bundle into `wwwroot/`.  See
  // `src/platform/dotnet.ts:mountsUi` + `src/ir/lower/lower.ts` for the
  // upstream wiring.
  const hasEmbeddedSpa = !!system?.deployable.uiName;
  const routePrefix = hasEmbeddedSpa ? "api/" : undefined;
  // Common files written once per project, regardless of how many
  // contexts contribute their domain code.
  emitCommon(ns, out);
  emitDispatcher(ns, out);
  out.set("Domain/Events/IDomainEvent.cs", renderIDomainEvent(ns));
  // Adapter dispatch context — built once per system-mode emit so
  // every per-aggregate call dispatches through the same EmitCtx
  // (deployable, contexts, sys, migrations).  Threaded into
  // `emitAggregate` only; helpers that don't yet route through
  // adapters keep the existing direct emit-fn calls.
  //
  // The dotnet generator dispatches through the deployable's RESOLVED
  // style / layout adapters (D-REALIZATION-AXES `application:` /
  // `directoryLayout:`), threaded in via `system.{style,layout}Adapter`.
  // The system orchestrator resolves them through
  // `platform/resolve-adapters.ts`; the generator never imports
  // `src/platform/` itself, so the backend-packages layering invariant
  // (no `src/generator/* → src/platform/*` edges) holds.  When unresolved
  // (legacy single-context generate mode), the call sites fall back to
  // the OWN sibling adapters (`./adapters/cqrs-style.js`,
  // `./adapters/by-layer-layout.js`) — byte-identical under the size-1
  // real menus, since the resolved adapter IS that sibling.
  const emitCtx: EmitCtx | undefined = system
    ? {
        deployable: system.deployable,
        contexts,
        sys: system.sys,
        migrations: system.migrations,
        emitTrace,
        styleAdapter: system.styleAdapter,
        layoutAdapter: system.layoutAdapter,
      }
    : undefined;
  // Each context contributes its enums / VOs / events / aggregates.
  for (const ctx of contexts) {
    emitIds(ctx, ns, out);
    emitEnums(ctx, ns, out);
    emitValueObjects(ctx, ns, out);
    for (const ev of ctx.events) {
      out.set(`Domain/Events/${ev.name}.cs`, renderEvent(ev, ns));
    }
    for (const agg of ctx.aggregates) {
      emitAggregate(agg, ctx, ns, out, routePrefix, emitTrace, emitCtx);
    }
    emitBaseReaders(ctx, ns, out);
    emitWorkflows(ctx, ns, out, { routePrefix, sys: system?.sys });
    emitViews(ctx, ns, out, { routePrefix });
  }
  // DbContext + project shell are emitted once, with all aggregates
  // collected from the union of contexts.
  const merged: EnrichedBoundedContextIR = {
    name: ns,
    enums: contexts.flatMap((c) => c.enums),
    valueObjects: contexts.flatMap((c) => c.valueObjects),
    events: contexts.flatMap((c) => c.events),
    payloads: contexts.flatMap((c) => c.payloads),
    aggregates: contexts.flatMap((c) => c.aggregates),
    repositories: contexts.flatMap((c) => c.repositories),
    workflows: contexts.flatMap((c) => c.workflows),
    views: contexts.flatMap((c) => c.views),
    criteria: contexts.flatMap((c) => c.criteria),
    channels: contexts.flatMap((c) => c.channels),
    retrievals: contexts.flatMap((c) => c.retrievals),
    seeds: contexts.flatMap((c) => c.seeds),
  };
  // Auth files — emitted only when the deployable opts in
  // via `auth: required` AND the system declares a user block (the
  // validator already rejects the half-state).  Computed first
  // because the capability-interface emitter needs to know whether
  // the auditable interceptor can rely on ICurrentUserAccessor.
  const authRequired = !!(system?.deployable.auth?.required && system.sys.user);
  if (authRequired && system?.sys) {
    emitAuthFiles(system.sys, ns, out);
  }
  // SaveChangesInterceptor — emitted only when at least one
  // aggregate has stamping rules contributed by macros.  Driven by
  // a per-entity-type switch built from each aggregate's
  // `contextStamps` IR (no marker interface, no per-aggregate
  // hand-written stamping logic).
  emitStampingInterceptor(merged, ns, out);
  const usesStamping = merged.aggregates.some((a) => (a.contextStamps?.length ?? 0) > 0);
  // Persistence selection (D-REALIZATION-AXES `persistence:`): `dapper` replaces
  // the EF Core DbContext + model-derived migrations with an Npgsql/Dapper
  // connection + a self-applied `DbSchema` (CREATE TABLE IF NOT EXISTS).  The
  // validator gates dapper to the supported subset, so the EF-only branches
  // below stay byte-identical for the default `efcore`.
  const usingDapper = system?.deployable.persistence === "dapper";
  if (usingDapper) {
    out.set("Infrastructure/Persistence/DbSchema.cs", renderDapperSchema(merged.aggregates, ns));
  } else {
    out.set(
      "Infrastructure/Persistence/AppDbContext.cs",
      renderDbContext(merged, ns, documentAggNames(contexts, system?.sys)),
    );
  }
  // FluentValidation pipeline — emit the generic
  // ValidationBehavior + the csproj package ref + the
  // Program.cs registrations only when at least one aggregate
  // has wire-translatable invariants / preconditions.  Computed
  // before the exception filter render so its FluentValidation
  // arm is gated on the same flag.
  const usesValidators = merged.aggregates.some(hasAnyWireValidator);
  out.set("Api/DomainExceptionFilter.cs", renderExceptionFilter(ns, { usesValidators }));
  out.set("Api/ProblemDetailsResponsesFilter.cs", renderProblemDetailsFilter(ns));
  out.set(
    "Api/ListResponseWrapperFilter.cs",
    renderListWrapperFilter(ns, listWrapperPairs(contexts)),
  );
  out.set("Api/RequiredFromCtorParamFilter.cs", renderRequiredFromCtorParamFilter(ns));
  if (usesValidators) {
    out.set("Application/Common/ValidationBehavior.cs", renderValidationBehavior(ns));
  }
  // Per-module Postgres migrations — empty `migrations` (non-system
  // entry points) → no-op.  Emitted before the project shell so
  // Program.cs sees `hasMigrations` and adds the
  // `Database.Migrate()` startup call.
  // EF migrations only for the efcore path — dapper applies its own
  // `DbSchema` at startup (see renderProgram), so it needs no migration files
  // and `hasMigrations` stays false to suppress the `Database.Migrate()` call.
  const hasMigrations = !usingDapper && !!(system?.migrations && system.migrations.length > 0);
  if (hasMigrations) {
    emitDotnetMigrations(system!.migrations!, ns, out);
  }
  // First-boot seed data (database-seeding.md, Phase 3a) — emits
  // Infrastructure/Persistence/Seed.cs when the served contexts declare any
  // `seed` block.  Through the domain `Create` (D-SEED-PATH), ship-once per
  // dataset (D-SEED-IDEMPOTENCY).  Program.cs gets `hasSeeds` below so it
  // adds the `Seed.RunSeeds(...)` startup call after `Database.Migrate()`.
  if (merged.seeds.length > 0) {
    emitDotnetSeeds(merged, ns, out);
  }
  const hasSeeds = out.has("Infrastructure/Persistence/Seed.cs");
  // Resource client classes (objectStore / queue / api) + their NuGet
  // deps (Phase 4c).  Empty when the deployable wires no consumable
  // resources — the csproj stays byte-identical.
  const resourceEmission = emitDotnetResourceFiles(system?.sys, ns);
  for (const [path, content] of resourceEmission.files) out.set(path, content);
  emitProject(merged, ns, out, {
    authRequired,
    usesValidators,
    usesStamping,
    hasEmbeddedSpa,
    hasMigrations,
    hasSeeds,
    emitTrace,
    usingDapper,
    resourceNugetDeps: resourceEmission.nugetDeps,
  });
  emitTestProject(merged, ns, out);
  // Fullstack mode — generate the React project under ClientApp/.
  // The SPA hits `/api/*` on its own origin (apiBaseUrl: ""), so
  // `api/config.ts` produces `fetch("/api/...")`-shaped calls that
  // line up with the .NET controllers' new route prefix.  Filter
  // out files the .NET project owns (Dockerfile, .dockerignore,
  // certs, e2e suite — the .NET project ships its own equivalents
  // at the root).
  if (hasEmbeddedSpa && system) {
    const spaFiles = generateReactForContexts(contexts, system.sys, system.deployable, {
      apiBaseUrl: "/api",
      pathPrefix: "ClientApp/",
    });
    for (const [path, content] of spaFiles) {
      // The React generator's pack also ships `Dockerfile` /
      // `.dockerignore` / `certs/.gitkeep` at the project root —
      // duplicates of the .NET project's equivalents and unused in
      // fullstack mode (the .NET Dockerfile multi-stage owns the
      // SPA build).  Skip them so the file map stays clean.  The
      // e2e harness lives outside ClientApp/ in fullstack mode (or
      // not at all — users own that surface).
      if (
        path === "ClientApp/Dockerfile" ||
        path === "ClientApp/.dockerignore" ||
        path === "ClientApp/certs/.gitkeep" ||
        path.startsWith("ClientApp/e2e/")
      )
        continue;
      out.set(path, content);
    }
    out.set("ClientApp/.gitignore", "node_modules\ndist\n");
  }
}

/** Element-schema → named-wrapper pairs for the list-response document
 *  filter.  Mirrors Hono/Phoenix naming: every aggregate's `<Agg>Response`
 *  → `<Agg>ListResponse` (also covers shorthand views, which reuse it), and
 *  each full-form view's `<View>Row` → `<View>Response`. */
function listWrapperPairs(
  contexts: readonly EnrichedBoundedContextIR[],
): Array<{ element: string; wrapper: string }> {
  const pairs: Array<{ element: string; wrapper: string }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      // Abstract TPC bases emit no DTOs (no routes / handlers), so there is no
      // `<Base>Response` to wrap.
      if (agg.isAbstract) continue;
      pairs.push({ element: `${agg.name}Response`, wrapper: `${agg.name}ListResponse` });
    }
    for (const view of ctx.views) {
      if (view.output) {
        pairs.push({
          element: `${upperFirst(view.name)}Row`,
          wrapper: `${upperFirst(view.name)}Response`,
        });
      }
    }
  }
  return pairs;
}

function emitContext(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  emitTrace = false,
): void {
  emitIds(ctx, ns, out);
  emitEnums(ctx, ns, out);
  emitValueObjects(ctx, ns, out);
  emitEvents(ctx, ns, out);
  emitCommon(ns, out);
  emitDispatcher(ns, out);
  for (const agg of ctx.aggregates) {
    emitAggregate(agg, ctx, ns, out, undefined, emitTrace);
  }
  emitBaseReaders(ctx, ns, out);
  emitWorkflows(ctx, ns, out);
  emitViews(ctx, ns, out);
  // Stamping interceptor — same gating as the system path.
  emitStampingInterceptor(ctx, ns, out);
  // Same FluentValidation gate as the system path — drives the
  // pipeline behavior emit + csproj + Program.cs registration +
  // the DomainExceptionFilter arm.
  const usesValidators = ctx.aggregates.some(hasAnyWireValidator);
  emitInfrastructure(ctx, ns, out, usesValidators);
  if (usesValidators) {
    out.set("Application/Common/ValidationBehavior.cs", renderValidationBehavior(ns));
  }
  const usesStamping = ctx.aggregates.some((a) => (a.contextStamps?.length ?? 0) > 0);
  // First-boot seed data (database-seeding.md) — the legacy per-context path
  // emits the seeder too (consistent with `generate ts`), so `generate dotnet`
  // on a seeded model produces + wires Seed.cs.
  if (ctx.seeds.length > 0) {
    emitDotnetSeeds(ctx, ns, out);
  }
  const hasSeeds = out.has("Infrastructure/Persistence/Seed.cs");
  emitProject(ctx, ns, out, { usesValidators, usesStamping, emitTrace, hasSeeds });
  emitTestProject(ctx, ns, out);
}

// ---------------------------------------------------------------------------
// Per-aggregate emission
// ---------------------------------------------------------------------------

function emitAggregate(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  routePrefix?: string,
  emitTrace = false,
  /** Adapter-dispatch context — present only in system-mode emit
   *  (legacy single-context entry doesn't have a deployable + sys to
   *  build it from).  When provided, the CQRS step routes through
   *  the local `cqrsStyleAdapter.emitForAggregate` +
   *  `byLayerLayoutAdapter.pathFor` instead of the direct `emitCqrs`
   *  call.  Byte-identical because the adapter wraps the same
   *  `emitCqrs` underneath. */
  emitCtx?: EmitCtx,
): void {
  const aggFolder = plural(agg.name);
  // Per-aggregate placement (D-REALIZATION-AXES `directoryLayout:`): route the
  // aggregate's domain + persistence files through the deployable's RESOLVED
  // layout adapter (threaded via emitCtx), falling back to byLayer in the
  // legacy single-context path.  byLayer reproduces the historical inline
  // paths byte-for-byte; byFeature rehomes them under `Features/<Agg>/`.  The
  // adapters ignore the EmitCtx arg for path routing, so an empty stand-in is
  // fine when there's no system context.
  const layout = emitCtx?.layoutAdapter ?? byLayerLayoutAdapter;
  const place = (name: string, category: DotnetArtifactCategory, content: string): void => {
    out.set(
      layout.pathFor(
        { name, content, category, aggregateName: agg.name } as DotnetArtifact,
        emitCtx ?? ({} as EmitCtx),
      ),
      content,
    );
  };
  // An abstract TPC (`ownTable`) base owns no table, no repository, no routes
  // — it is kept in the generation view only to anchor the polymorphic reader
  // (emitBaseReaders) and to give the concretes a C# base class to inherit.
  // Emit just the abstract class and stop; everything else below is per
  // instantiable aggregate.
  if (agg.isAbstract) {
    place(`${agg.name}.cs`, "entity", renderAbstractBaseEntity(agg, ns));
    return;
  }
  // A concrete TPC subtype inherits the abstract base's fields from the base
  // class instead of re-declaring them; thread the base name + its field set
  // through so renderEntity emits `: <Base>` and skips the inherited fields.
  const tpcBase = agg.extendsAggregate
    ? ctx.aggregates.find((a) => a.name === agg.extendsAggregate && isTpcBase(a, ctx.aggregates))
    : undefined;
  const superType = tpcBase
    ? { name: tpcBase.name, fieldNames: new Set(tpcBase.fields.map((f) => f.name)) }
    : undefined;
  const repo = findRepoFor(ctx, agg.name);
  // dataSource resolution drives BOTH the table-mapping knobs (schema /
  // tablePrefix) and the saving SHAPE.  `isDoc` (shape(document))
  // switches this aggregate onto the document-persistence path: a
  // single JSONB column + STJ round-trip, no normalised entity table,
  // no join tables.  In the legacy single-context entry there's no
  // emitCtx/sys, so resolution falls back to the aggregate header's
  // `normalised(…)` (the default).
  const ds = emitCtx ? resolveDataSourceConfig(agg, ctx, emitCtx.sys) : undefined;
  const shape = effectiveSavingShape(agg, ds);
  const isDoc = shape === "document";
  const isEmbedded = shape === "embedded";

  for (const part of agg.parts) {
    place(`${part.name}.cs`, "entity", renderEntity(part, false, ns, agg.name, emitTrace, isDoc));
  }
  place(
    `${agg.name}.cs`,
    "entity",
    renderEntity(agg, true, ns, agg.name, emitTrace, isDoc, superType),
  );
  // Views whose source is this aggregate become parameterless,
  // filtered, list-returning finds on the repository.  Synthesised
  // here so all the existing find emission paths (interface,
  // implementation, EF Core configuration) pick them up uniformly.
  const repoWithViews = mergeViewsAsFinds(agg, repo, ctx);
  // Context retrievals (retrieval.md) targeting this aggregate emit a
  // `Run<Name>Async` repository method.  Document-shaped aggregates skip
  // them in v1 (the in-memory document impl doesn't compose LINQ query
  // operators); they stay a follow-up.
  const aggRetrievals = isDoc
    ? []
    : (ctx.retrievals ?? []).filter(
        (r) => r.targetType.kind === "entity" && r.targetType.name === agg.name,
      );
  place(
    `I${agg.name}Repository.cs`,
    "repository-interface",
    renderRepositoryInterface(agg, repoWithViews, ns, aggRetrievals),
  );
  // A find with a `where` expression that lowers to `Regex.IsMatch`
  // declares its System.Text.RegularExpressions dependency; the
  // repository impl emitter then adds the using.  Retrieval `where`
  // predicates contribute the same way.
  const repoImplUsings = collectFindBodyUsings(repoWithViews);
  collectRetrievalBodyUsings(aggRetrievals, repoImplUsings);
  const findBodies = buildFindBodies(agg, repoWithViews);
  const retrievalBodies = buildRetrievalBodies(agg, aggRetrievals);
  // Persistence selection (D-REALIZATION-AXES `persistence:`): `dapper`
  // emits an Npgsql/Dapper repository (and no EF configuration / document /
  // join-table files — the validator gates those features out for dapper);
  // `efcore` (default) keeps the EF Core repository + configuration path
  // byte-identical.
  const usingDapper = emitCtx?.deployable.persistence === "dapper";
  if (usingDapper) {
    place(
      `${agg.name}Repository.cs`,
      "repository-impl",
      renderDapperRepository(agg, repoWithViews, ns),
    );
  } else {
    place(
      `${agg.name}Repository.cs`,
      "repository-impl",
      isDoc
        ? renderDocumentRepositoryImpl(agg, repoWithViews, ns, findBodies, {
            extraUsings: [...repoImplUsings].sort(),
          })
        : renderRepositoryImpl(agg, repoWithViews, ns, findBodies, {
            extraUsings: [...repoImplUsings].sort(),
            emitTrace,
            retrievals: aggRetrievals,
            retrievalBodies,
          }),
    );
    if (isDoc) {
      // Document-shaped persistence: a `<Agg>Document` record (one JSONB
      // column) + its EF configuration + the snapshot DTOs the repository
      // (de)serialises.  No normalised entity configuration, no join
      // tables — contained parts + references fold into the document.
      place(`${agg.name}Document.cs`, "document-poco", renderDocumentPoco(agg, ns));
      place(
        `${agg.name}DocumentConfiguration.cs`,
        "ef-configuration",
        renderDocumentConfiguration(agg, ns, { schema: ds?.schema, tablePrefix: ds?.tablePrefix }),
      );
      place(`${agg.name}Snapshots.cs`, "entity", renderSnapshots(agg, ns));
    } else {
      // Relational (default) AND embedded both use the normal entity +
      // repository + DbSet<Agg>; they differ only in the EF configuration:
      // `embedded` folds each containment into a JSONB column via owned-
      // types `.ToJson(...)` (no child table), so its `OwnsMany/OwnsOne`
      // calls carry `.ToJson()` and the join tables are skipped.
      // dataSource-driven schema / tablePrefix knobs flow through both.
      place(
        `${agg.name}Configuration.cs`,
        "ef-configuration",
        renderConfiguration(agg, ns, ctx, {
          schema: ds?.schema,
          tablePrefix: ds?.tablePrefix,
          embedded: isEmbedded,
        }),
      );
      // One file per reference-collection association: the join entity
      // class + its EF Core configuration (composite PK, ordinal, FK
      // converters).  Skipped for embedded (reference collections fold
      // into a JSONB column) and when the aggregate has no `Id<T>[]` fields.
      if (!isEmbedded) {
        for (const assoc of agg.associations) {
          const cls = joinEntityName(assoc);
          place(`${cls}.cs`, "join-entity", renderJoinEntity(assoc, ns));
          place(
            `${cls}Configuration.cs`,
            "join-entity-configuration",
            renderJoinEntityConfiguration(assoc, ns),
          );
        }
      }
    }
  }
  // CQRS emission — adapter-dispatched when an EmitCtx is available
  // (system mode), direct call in the legacy single-context path.
  // The two paths produce identical Map entries: the adapter wraps
  // the same `emitCqrs` underneath, and the byLayer layout adapter
  // recomputes the same `Application/<Plural>/...` + `Api/...` paths
  // the emitter writes inline.
  if (emitCtx) {
    // Resolved selection (D-REALIZATION-AXES) when the orchestrator
    // threaded one in; the sibling default otherwise.  Size-1 menus →
    // the same object → byte-identical.
    const style = emitCtx.styleAdapter ?? cqrsStyleAdapter;
    const layout = emitCtx.layoutAdapter ?? byLayerLayoutAdapter;
    const artifacts = style.emitForAggregate?.(agg, emitCtx) ?? [];
    for (const artifact of artifacts) {
      out.set(layout.pathFor(artifact, emitCtx), artifact.content);
    }
  } else {
    emitCqrs(agg, repo, ctx, ns, out, { routePrefix, emitTrace });
  }
  const testsFile = renderTestsFile(agg, ctx, ns);
  if (testsFile) {
    out.set(`Tests/${ns}.Tests/${aggFolder}/${agg.name}Tests.cs`, testsFile);
  }
}

// ---------------------------------------------------------------------------
// Infrastructure & project shell
// ---------------------------------------------------------------------------

function emitInfrastructure(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  usesValidators: boolean,
): void {
  out.set(
    "Infrastructure/Persistence/AppDbContext.cs",
    renderDbContext(ctx, ns, documentAggNames([ctx])),
  );
  out.set("Api/DomainExceptionFilter.cs", renderExceptionFilter(ns, { usesValidators }));
  out.set("Api/ProblemDetailsResponsesFilter.cs", renderProblemDetailsFilter(ns));
  out.set("Api/ListResponseWrapperFilter.cs", renderListWrapperFilter(ns, listWrapperPairs([ctx])));
  out.set("Api/RequiredFromCtorParamFilter.cs", renderRequiredFromCtorParamFilter(ns));
}

function emitProject(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
  options?: {
    authRequired?: boolean;
    usesValidators?: boolean;
    usesStamping?: boolean;
    hasEmbeddedSpa?: boolean;
    hasMigrations?: boolean;
    hasSeeds?: boolean;
    emitTrace?: boolean;
    usingDapper?: boolean;
    resourceNugetDeps?: Record<string, string>;
  },
): void {
  const hasExtern = ctx.aggregates.some((a) => a.operations.some((o) => o.extern));
  const usesValidators = !!options?.usesValidators;
  const usesStamping = !!options?.usesStamping;
  const hasEmbeddedSpa = !!options?.hasEmbeddedSpa;
  const hasMigrations = !!options?.hasMigrations;
  const hasSeeds = !!options?.hasSeeds;
  const emitTrace = !!options?.emitTrace;
  const usingDapper = !!options?.usingDapper;
  out.set(
    "Program.cs",
    renderProgram(ctx, ns, {
      authRequired: !!options?.authRequired,
      usesValidators,
      usesStamping,
      hasEmbeddedSpa,
      hasMigrations,
      hasSeeds,
      emitTrace,
      usingDapper,
    }),
  );
  out.set(
    `${ns}.csproj`,
    renderCsproj(ns, hasExtern, usesValidators, options?.resourceNugetDeps, usingDapper),
  );
  out.set("Dockerfile", renderDockerfile(ns, { hasEmbeddedSpa }));
  out.set(".dockerignore", renderDockerignore());
  out.set("certs/.gitkeep", "");
  // Catalog-identity request log — always-on.  Cross-backend parity
  // with Phoenix's <App>.Telemetry and Hono's pino access log.
  out.set("Middleware/RequestLoggingMiddleware.cs", renderRequestLoggingMiddleware(ns));
  if (emitTrace) {
    // Domain-layer logger plumbing — emitted only on --trace so the
    // default artefact stays free of an AsyncLocal accessor + the
    // pipeline behavior that sets it.
    out.set("Domain/Common/DomainLog.cs", renderDomainLog(ns));
    out.set("Application/Common/DomainLogBehavior.cs", renderDomainLogBehavior(ns));
  }
}

function emitTestProject(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  // Only emit a test csproj when at least one aggregate declares a `test`
  // block — otherwise the project would have nothing to compile.
  const anyTests = ctx.aggregates.some((a) => a.tests.length > 0);
  if (!anyTests) return;
  out.set(`Tests/${ns}.Tests/${ns}.Tests.csproj`, renderTestCsproj(ns));
}

function findRepoFor(ctx: BoundedContextIR, name: string): RepositoryIR | undefined {
  return ctx.repositories.find((r) => r.aggregateName === name);
}

/** Names of document-shaped (`shape(document)`) aggregates across the
 *  given contexts, resolved the same way `emitAggregate` does (binding
 *  wins, aggregate header is the default).  `sys` is absent in the
 *  legacy single-context entry, so resolution falls back to the
 *  header.  Consumed by `renderDbContext` to route each aggregate's
 *  DbSet + configuration. */
function documentAggNames(contexts: EnrichedBoundedContextIR[], sys?: SystemIR): Set<string> {
  const names = new Set<string>();
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      const ds = sys ? resolveDataSourceConfig(agg, ctx, sys) : undefined;
      if (isDocumentShaped(agg, ds)) names.add(agg.name);
    }
  }
  return names;
}

/** Synthesise a repository that includes the user-declared finds
 *  PLUS one parameterless filtered find per matching view.  Lets
 *  every downstream emitter (interface, implementation, find-emit,
 *  CQRS) treat views uniformly with declared finds. */
function mergeViewsAsFinds(
  agg: import("../../ir/types/loom-ir.js").AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): RepositoryIR | undefined {
  const matching = ctx.views.filter((v) => v.aggregateName === agg.name);
  if (matching.length === 0) return repo;
  const arrayReturn: import("../../ir/types/loom-ir.js").TypeIR = {
    kind: "array",
    element: { kind: "entity", name: agg.name },
  };
  const synthesised = matching.map((v) => ({
    name: v.name,
    params: [],
    returnType: arrayReturn,
    filter: v.filter,
  }));
  if (!repo) {
    return {
      name: `${agg.name}Repository`,
      aggregateName: agg.name,
      finds: synthesised,
    };
  }
  return { ...repo, finds: [...repo.finds, ...synthesised] };
}
