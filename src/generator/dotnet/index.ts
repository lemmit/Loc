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
import {
  effectiveSavingShape,
  isDocumentShaped,
  resolveDataSourceConfig,
} from "../../ir/util/resolve-datasource.js";
import type { Model } from "../../language/generated/ast.js";
import { plural, upperFirst } from "../../util/naming.js";
import type { EmitCtx } from "../_adapters/index.js";
import { generateReactForContexts } from "../react/index.js";
import { byLayerLayoutAdapter } from "./adapters/by-layer-layout.js";
import { cqrsStyleAdapter } from "./adapters/cqrs-style.js";
import { emitDotnetResourceFiles } from "./adapters/resource-clients.js";
import { emitAuthFiles } from "./auth-emit.js";
import { emitCqrs } from "./cqrs-emit.js";
import { renderDomainLog, renderDomainLogBehavior } from "./emit/domain-log.js";
import { emitDotnetMigrations } from "./emit/migrations.js";
import { renderRequestLoggingMiddleware } from "./emit/request-logging.js";
import {
  joinEntityName,
  renderAuditableInterceptor,
  renderCommon,
  renderConfiguration,
  renderCsproj,
  renderDbContext,
  renderDockerfile,
  renderDockerignore,
  renderDocumentConfiguration,
  renderDocumentPoco,
  renderDocumentRepositoryImpl,
  renderEntity,
  renderEnum,
  renderEvent,
  renderExceptionFilter,
  renderIDomainEvent,
  renderId,
  renderJoinEntity,
  renderJoinEntityConfiguration,
  renderListWrapperFilter,
  renderNoopDispatcher,
  renderProblemDetailsFilter,
  renderProgram,
  renderRepositoryImpl,
  renderRepositoryInterface,
  renderRequiredFromCtorParamFilter,
  renderSnapshots,
  renderTestCsproj,
  renderTestsFile,
  renderValueObject,
} from "./emit.js";
import { buildFindBodies, collectFindBodyUsings } from "./find-emit.js";
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
  system?: { deployable: DeployableIR; sys: SystemIR; migrations?: MigrationsIR[] },
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
  system?: { deployable: DeployableIR; sys: SystemIR; migrations?: MigrationsIR[] },
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
  // The dotnet generator dispatches through its OWN sibling adapters
  // (`./adapters/cqrs-style.js`, `./adapters/by-layer-layout.js`) —
  // sibling imports stay within `src/generator/`, so the backend-
  // packages layering invariant (no `src/generator/* → src/platform/*`
  // edges) holds.  Future per-deployable overrides (`style: layered`,
  // `persistence: dapper`, …) will resolve through the registry at
  // the platform-surface seam (`src/platform/dotnet.ts`).
  const emitCtx: EmitCtx | undefined = system
    ? {
        deployable: system.deployable,
        contexts,
        sys: system.sys,
        migrations: system.migrations,
        emitTrace,
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
  out.set(
    "Infrastructure/Persistence/AppDbContext.cs",
    renderDbContext(merged, ns, documentAggNames(contexts, system?.sys)),
  );
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
  const hasMigrations = !!(system?.migrations && system.migrations.length > 0);
  if (hasMigrations) {
    emitDotnetMigrations(system!.migrations!, ns, out);
  }
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
    emitTrace,
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
  emitProject(ctx, ns, out, { usesValidators, usesStamping, emitTrace });
  emitTestProject(ctx, ns, out);
}

// ---------------------------------------------------------------------------
// Shared / per-context emission helpers
// ---------------------------------------------------------------------------

/** Emit the SaveChangesInterceptor when at least one aggregate
 * contributes stamping rules.  The interceptor is registry-driven
 * — its body is a switch on `entry.Entity.GetType()` built from
 * every aggregate's `contextStamps`.  Adding a new stamping macro
 * (e.g. `lastModifiedBy`, `versionBump`) requires no compiler
 * changes: the new macro contributes more entries to one
 * aggregate's stamps, which become more assignments in that
 * aggregate's switch arm. */
function emitStampingInterceptor(
  merged: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  const anyStamping = merged.aggregates.some((a) => (a.contextStamps?.length ?? 0) > 0);
  if (!anyStamping) return;
  out.set(
    "Infrastructure/Persistence/AuditableInterceptor.cs",
    renderAuditableInterceptor(ns, merged.aggregates),
  );
}

function emitIds(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  for (const agg of ctx.aggregates) {
    out.set(`Domain/Ids/${agg.name}Id.cs`, renderId(agg.name, agg.idValueType, ns));
    for (const part of agg.parts) {
      out.set(`Domain/Ids/${part.name}Id.cs`, renderId(part.name, agg.idValueType, ns));
    }
  }
}

function emitEnums(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  // Always emit a marker so `using <ns>.Domain.Enums;` resolves even
  // when the project has no enums in scope (deployables that include
  // only modules without enums would otherwise fail to compile).
  out.set(
    "Domain/Enums/_namespace.cs",
    `// Auto-generated namespace marker.\nnamespace ${ns}.Domain.Enums;\n`,
  );
  for (const e of ctx.enums) {
    out.set(`Domain/Enums/${e.name}.cs`, renderEnum(e, ns));
  }
}

function emitValueObjects(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  out.set(
    "Domain/ValueObjects/_namespace.cs",
    `// Auto-generated namespace marker.\nnamespace ${ns}.Domain.ValueObjects;\n`,
  );
  for (const vo of ctx.valueObjects) {
    out.set(`Domain/ValueObjects/${vo.name}.cs`, renderValueObject(vo, ns));
  }
}

function emitEvents(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  out.set("Domain/Events/IDomainEvent.cs", renderIDomainEvent(ns));
  for (const ev of ctx.events) {
    out.set(`Domain/Events/${ev.name}.cs`, renderEvent(ev, ns));
  }
}

function emitCommon(ns: string, out: Map<string, string>): void {
  out.set("Domain/Common/DomainException.cs", renderCommon(ns));
}

function emitDispatcher(ns: string, out: Map<string, string>): void {
  out.set("Infrastructure/Events/NoopDomainEventDispatcher.cs", renderNoopDispatcher(ns));
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
    out.set(
      `Domain/${aggFolder}/${part.name}.cs`,
      renderEntity(part, false, ns, agg.name, emitTrace, isDoc),
    );
  }
  out.set(
    `Domain/${aggFolder}/${agg.name}.cs`,
    renderEntity(agg, true, ns, agg.name, emitTrace, isDoc),
  );
  // Views whose source is this aggregate become parameterless,
  // filtered, list-returning finds on the repository.  Synthesised
  // here so all the existing find emission paths (interface,
  // implementation, EF Core configuration) pick them up uniformly.
  const repoWithViews = mergeViewsAsFinds(agg, repo, ctx);
  out.set(
    `Domain/${aggFolder}/I${agg.name}Repository.cs`,
    renderRepositoryInterface(agg, repoWithViews, ns),
  );
  // A find with a `where` expression that lowers to `Regex.IsMatch`
  // declares its System.Text.RegularExpressions dependency; the
  // repository impl emitter then adds the using.
  const repoImplUsings = collectFindBodyUsings(repoWithViews);
  const findBodies = buildFindBodies(agg, repoWithViews);
  out.set(
    `Infrastructure/Repositories/${agg.name}Repository.cs`,
    isDoc
      ? renderDocumentRepositoryImpl(agg, repoWithViews, ns, findBodies, {
          extraUsings: [...repoImplUsings].sort(),
        })
      : renderRepositoryImpl(agg, repoWithViews, ns, findBodies, {
          extraUsings: [...repoImplUsings].sort(),
          emitTrace,
        }),
  );
  if (isDoc) {
    // Document-shaped persistence: a `<Agg>Document` record (one JSONB
    // column) + its EF configuration + the snapshot DTOs the repository
    // (de)serialises.  No normalised entity configuration, no join
    // tables — contained parts + references fold into the document.
    out.set(
      `Infrastructure/Persistence/Documents/${agg.name}Document.cs`,
      renderDocumentPoco(agg, ns),
    );
    out.set(
      `Infrastructure/Persistence/Configurations/${agg.name}DocumentConfiguration.cs`,
      renderDocumentConfiguration(agg, ns, { schema: ds?.schema, tablePrefix: ds?.tablePrefix }),
    );
    out.set(`Domain/${aggFolder}/${agg.name}Snapshots.cs`, renderSnapshots(agg, ns));
  } else {
    // Relational (default) AND embedded both use the normal entity +
    // repository + DbSet<Agg>; they differ only in the EF configuration:
    // `embedded` folds each containment into a JSONB column via owned-
    // types `.ToJson(...)` (no child table), so its `OwnsMany/OwnsOne`
    // calls carry `.ToJson()` and the join tables are skipped.
    // dataSource-driven schema / tablePrefix knobs flow through both.
    out.set(
      `Infrastructure/Persistence/Configurations/${agg.name}Configuration.cs`,
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
        out.set(`Infrastructure/Persistence/JoinTables/${cls}.cs`, renderJoinEntity(assoc, ns));
        out.set(
          `Infrastructure/Persistence/Configurations/${cls}Configuration.cs`,
          renderJoinEntityConfiguration(assoc, ns),
        );
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
    const artifacts = cqrsStyleAdapter.emitForAggregate?.(agg, emitCtx) ?? [];
    for (const artifact of artifacts) {
      out.set(byLayerLayoutAdapter.pathFor(artifact, emitCtx), artifact.content);
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
    emitTrace?: boolean;
    resourceNugetDeps?: Record<string, string>;
  },
): void {
  const hasExtern = ctx.aggregates.some((a) => a.operations.some((o) => o.extern));
  const usesValidators = !!options?.usesValidators;
  const usesStamping = !!options?.usesStamping;
  const hasEmbeddedSpa = !!options?.hasEmbeddedSpa;
  const hasMigrations = !!options?.hasMigrations;
  const emitTrace = !!options?.emitTrace;
  out.set(
    "Program.cs",
    renderProgram(ctx, ns, {
      authRequired: !!options?.authRequired,
      usesValidators,
      usesStamping,
      hasEmbeddedSpa,
      hasMigrations,
      emitTrace,
    }),
  );
  out.set(`${ns}.csproj`, renderCsproj(ns, hasExtern, usesValidators, options?.resourceNugetDeps));
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
