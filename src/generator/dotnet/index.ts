import { enrichLoomModel } from "../../ir/enrich/enrichments.js";
import { lowerModel } from "../../ir/lower/lower.js";
import { unionInstanceName } from "../../ir/stdlib/unions.js";
import type {
  BoundedContextIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
  SystemIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../ir/types/migrations-ir.js";
import type { OriginRef } from "../../ir/types/origin.js";
import { aggHasAuditedTarget } from "../../ir/util/audit-capability.js";
import { durableEventTypes } from "../../ir/util/channels.js";
import { isTpcBase, isTphBase, tableOwnerName, tphConcretesOf } from "../../ir/util/inheritance.js";
import {
  aggregateIsEventSourced,
  effectiveSavingShape,
  isDocumentShaped,
  isEmbeddedShaped,
  resolveContextSchema,
  resolveDataSourceConfig,
} from "../../ir/util/resolve-datasource.js";
import { aggregateIsVersioned } from "../../ir/util/versioned-capability.js";
import type { Model } from "../../language/generated/ast.js";
import { apiRoutePrefix } from "../../util/api-base.js";
import { dedupeByName } from "../../util/dedupe.js";
import { plural, upperFirst } from "../../util/naming.js";
import type { EmitCtx, LayoutAdapter, StyleAdapter } from "../_adapters/index.js";
import { unionMembers } from "../_payload/union-wire.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { generateReactForContexts } from "../react/index.js";
import { generateSvelteForContexts } from "../svelte/index.js";
import { generateVueForContexts } from "../vue/index.js";
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
import { domainUnionFiles } from "./cqrs/dtos.js";
import { emitCqrs } from "./cqrs-emit.js";
import { canEmitToExpressionFor, emitCriteria } from "./criteria-emit.js";
import {
  renderAuditRecord,
  renderAuditRecordConfiguration,
  renderAuditWriter,
  renderAuditWriterInterface,
} from "./emit/audit.js";
import {
  renderDapperEventSourcedRepository,
  renderDapperRepository,
  renderDapperSchema,
} from "./emit/dapper.js";
import { renderDomainLog, renderExecutionContextBehavior } from "./emit/domain-log.js";
import { emitDomainServices } from "./emit/domain-service.js";
import type { OpFragment } from "./emit/entity.js";
import { emitDotnetMigrations, emitDotnetProvenanceAuditMigration } from "./emit/migrations.js";
import {
  renderOutboxDelivery,
  renderOutboxDispatcher,
  renderOutboxMessage,
  renderOutboxRelay,
} from "./emit/outbox.js";
import {
  contextsHaveProvenance,
  renderProvenanceRecord,
  renderProvenanceRecordConfiguration,
  renderProvLineage,
} from "./emit/provenance.js";
import { renderRequestContext } from "./emit/request-context.js";
import { renderRequestContextMiddleware } from "./emit/request-context-middleware.js";
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
  renderEventRecordConfiguration,
  renderEventRecordPoco,
  renderEventSourcedRepositoryImpl,
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
import { rewriteNamespacesForLayout } from "./layout-namespaces.js";
import { emitRetrievalSpecs, renderPagingExtension } from "./spec-emit.js";
import { hasAnyWireValidator, renderValidationBehavior } from "./validator-emit.js";
import { emitViews } from "./view-emit.js";
import { emitDispatchHandlers, emitWorkflowInstanceReads, emitWorkflows } from "./workflow-emit.js";
import { emitEventSourcedWorkflowFiles } from "./workflow-eventsourced-emit.js";
import { emitWorkflowStatePersistence } from "./workflow-state-emit.js";

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
  options: { emitTrace?: boolean; sourcemap?: SourceMapRecorder } = {},
): Map<string, string> {
  const out = new Map<string, string>();
  const emitTrace = !!options.emitTrace;
  if (namespace !== undefined) {
    // Single project containing all the given contexts under one namespace.
    emitProjectFromContexts(contexts, namespace, out, system, emitTrace, options.sourcemap);
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
  sourcemap?: SourceMapRecorder,
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
  // Domain controllers always live under `/api/*` (the shared API base
  // path); `hasEmbeddedSpa` separately drives SPA static-file embedding.
  const routePrefix = apiRoutePrefix();
  // Common files written once per project, regardless of how many
  // contexts contribute their domain code.
  // In-process dispatch (channels.md): does any hosted context have a
  // channel-routed event subscription?  Gates the Mediator-notification
  // dispatcher, the `IDomainEvent : INotification` upgrade, the reactor /
  // starter `INotificationHandler`s, and the Program.cs registration.
  const hasSubscriptions = contexts.some((c) => c.eventSubscriptions.length > 0);
  emitCommon(ns, out);
  emitDispatcher(ns, out, hasSubscriptions);
  out.set("Domain/Events/IDomainEvent.cs", renderIDomainEvent(ns, hasSubscriptions));
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
      const evPath = `Domain/Events/${ev.name}.cs`;
      const evContent = renderEvent(ev, ns);
      out.set(evPath, evContent);
      sourcemap?.file(evPath, evContent, ev.origin, `${ctx.name}.${ev.name}`);
    }
    for (const agg of ctx.aggregates) {
      emitAggregate(agg, ctx, ns, out, routePrefix, emitTrace, emitCtx, sourcemap);
    }
    emitBaseReaders(ctx, ns, out, sourcemap);
    // Domain services (domain-services.md) — stateless pure calculators, one
    // `public static class` per `domainService` + its `or`-union return records.
    emitDomainServices(ctx, ns, out);
    emitWorkflows(ctx, ns, out, { routePrefix, sys: system?.sys, sourcemap });
    emitWorkflowInstanceReads(ctx, ns, out, { routePrefix });
    emitViews(ctx, ns, out, { routePrefix, sourcemap });
  }
  // DbContext + project shell are emitted once, with all aggregates
  // collected from the union of contexts.
  const merged: EnrichedBoundedContextIR = {
    name: ns,
    // Ambient root-level enums / VOs are folded into every context by
    // enrichment, so a plain union across hosted contexts would emit them
    // once per context (duplicate enum / class declarations).  Dedupe by
    // name to collapse the ambient copies.
    enums: dedupeByName(contexts.flatMap((c) => c.enums)),
    valueObjects: dedupeByName(contexts.flatMap((c) => c.valueObjects)),
    events: contexts.flatMap((c) => c.events),
    payloads: contexts.flatMap((c) => c.payloads),
    aggregates: contexts.flatMap((c) => c.aggregates),
    repositories: contexts.flatMap((c) => c.repositories),
    workflows: contexts.flatMap((c) => c.workflows),
    views: contexts.flatMap((c) => c.views),
    criteria: contexts.flatMap((c) => c.criteria),
    domainServices: contexts.flatMap((c) => c.domainServices ?? []),
    channels: contexts.flatMap((c) => c.channels),
    projections: contexts.flatMap((c) => c.projections ?? []),
    retrievals: contexts.flatMap((c) => c.retrievals),
    seeds: contexts.flatMap((c) => c.seeds),
    eventSubscriptions: contexts.flatMap((c) => c.eventSubscriptions),
  };
  // In-process dispatch (channels.md): one `INotificationHandler<TEvent>` per
  // channel-routed reactor / event-create, derived over the merged context so
  // a reactor in one hosted context can route off another's channel.
  if (hasSubscriptions) {
    emitDispatchHandlers(merged, ns, out, system?.sys);
  }
  // Transactional outbox (dispatch-delivery-semantics.md): durable channels
  // (`retention: log | work`) record their events in __loom_outbox (EF
  // entity over the MigrationsIR-owned table) and a relay BackgroundService
  // delivers them at-least-once.  EF persistence only — the Dapper outbox is
  // a follow-up slice.
  const durableTypes = [...new Set(contexts.flatMap((c) => [...durableEventTypes(c)]))].sort();
  const hasOutbox =
    hasSubscriptions && system?.deployable.persistence !== "dapper" && durableTypes.length > 0;
  if (hasOutbox) {
    out.set("Domain/Common/OutboxDelivery.cs", renderOutboxDelivery(ns));
    out.set("Infrastructure/Persistence/OutboxMessage.cs", renderOutboxMessage(ns));
    out.set(
      "Infrastructure/Events/OutboxDomainEventDispatcher.cs",
      renderOutboxDispatcher(ns, durableTypes),
    );
    out.set("Infrastructure/Events/OutboxRelayService.cs", renderOutboxRelay(ns, durableTypes));
  }
  // Auth files — emitted only when the deployable opts in
  // via `auth: required` AND the system declares a user block (the
  // validator already rejects the half-state).  Computed first
  // because the capability-interface emitter needs to know whether
  // the auditable interceptor can rely on ICurrentUserAccessor.
  const authRequired = !!(system?.deployable.auth?.required && system.sys.user);
  if (authRequired && system?.sys) {
    emitAuthFiles(system.sys, ns, out);
  }
  // The principal's id property on the User record (PascalCased; the claim
  // named `id`, else the first field).  Drives the carrier's ActorId accessor
  // (audit/provenance "who computed") AND `currentUser` lifecycle stamps, which
  // resolve the principal id from the ambient RequestContext.  Undefined
  // without auth.
  const userFields = authRequired ? system?.sys.user?.fields : undefined;
  const actorIdField = userFields?.find((f) => f.name === "id") ?? userFields?.[0];
  const actorIdProp = actorIdField ? upperFirst(actorIdField.name) : undefined;
  // SaveChangesInterceptor — emitted only when at least one
  // aggregate has stamping rules contributed by macros.  Driven by
  // a per-entity-type switch built from each aggregate's
  // `contextStamps` IR; a `currentUser` stamp resolves the principal
  // id from the ambient RequestContext (so `actorIdProp` is threaded).
  emitStampingInterceptor(merged, ns, out, actorIdProp);
  // Reified `criterion` specifications (evaluate face) — additive, not yet
  // wired into invariants/preconditions (see criteria-emit.ts).
  emitCriteria(merged, ns, out);
  const usesStamping = merged.aggregates.some((a) => (a.contextStamps?.length ?? 0) > 0);
  // Persistence selection (D-REALIZATION-AXES `persistence:`): `dapper` replaces
  // the EF Core DbContext + model-derived migrations with an Npgsql/Dapper
  // connection + a self-applied `DbSchema` (CREATE TABLE IF NOT EXISTS).  The
  // validator gates dapper to the supported subset, so the EF-only branches
  // below stay byte-identical for the default `efcore`.
  const usingDapper = system?.deployable.persistence === "dapper";
  // Provenance (provenance.md) + per-operation audit (audit-and-logging.md)
  // runtimes — EF Core only (the dapper path is a follow-up).  `hasProvenance`
  // drives the lineage SDK + history table + co-located columns; `hasAudit`
  // drives the audit table + writer + per-handler instrumentation.
  const hasProvenance = !usingDapper && contextsHaveProvenance(contexts);
  // Audit table/writer/DbSet emission is gated on the SHARED predicate
  // (operations ∪ creates ∪ destroys) so a lifecycle-only-audited aggregate
  // — `create(...) audited` / `destroy audited` with no audited operation —
  // still gets the audit_records table + IAuditWriter seam.
  const hasAudit = !usingDapper && merged.aggregates.some(aggHasAuditedTarget);
  if (usingDapper) {
    out.set("Infrastructure/Persistence/DbSchema.cs", renderDapperSchema(merged.aggregates, ns));
  } else {
    out.set(
      "Infrastructure/Persistence/AppDbContext.cs",
      renderDbContext(
        merged,
        ns,
        documentAggNames(contexts, system?.sys),
        eventSourcedAggNames(contexts),
        embeddedAggNames(contexts, system?.sys),
        hasOutbox,
        hasProvenance,
        hasAudit,
      ),
    );
    // Provenance runtime shared files — the lineage SDK + the append-only
    // history POCO/configuration.  The co-located columns + per-write capture +
    // flush are emitted per aggregate (entity.ts / efcore.ts / repository.ts).
    if (hasProvenance) {
      out.set("Domain/Common/ProvLineage.cs", renderProvLineage(ns));
      out.set("Infrastructure/Persistence/ProvenanceRecord.cs", renderProvenanceRecord(ns));
      out.set(
        "Infrastructure/Persistence/Configurations/ProvenanceRecordConfiguration.cs",
        renderProvenanceRecordConfiguration(ns),
      );
    }
    // Per-operation audit shared files — the append-only audit POCO/configuration
    // + the IAuditWriter staging seam.  Per-handler before/after capture is
    // emitted in cqrs/commands.ts.
    if (hasAudit) {
      out.set("Infrastructure/Persistence/AuditRecord.cs", renderAuditRecord(ns));
      out.set(
        "Infrastructure/Persistence/Configurations/AuditRecordConfiguration.cs",
        renderAuditRecordConfiguration(ns),
      );
      out.set("Application/Common/IAuditWriter.cs", renderAuditWriterInterface(ns));
      out.set("Infrastructure/Persistence/AuditWriter.cs", renderAuditWriter(ns));
    }
    // Persisted workflow-correlation state POCOs + EF configs (one per
    // correlation-bearing workflow); the DbSet/ApplyConfiguration wiring is
    // inside renderDbContext above.  The saga tables live in the workflow's
    // OWNING-context schema (map-back by name over `contexts`, since `merged`
    // unions several), matching the migration DDL.
    const resolveWorkflowSchema = system
      ? (wf: WorkflowIR): string | undefined => {
          const owningCtx = contexts.find((c) => c.workflows.some((w) => w.name === wf.name));
          return owningCtx ? resolveContextSchema(owningCtx, system.sys) : undefined;
        }
      : undefined;
    emitWorkflowStatePersistence(
      merged.workflows,
      ns,
      out,
      durableEventTypes(merged).size > 0,
      resolveWorkflowSchema,
    );
    // Event-sourced workflows (workflow-and-applier.md A2-S5b): the `<Wf>State`
    // fold class + `<Wf>EventRecord` POCO/config (the stream the dispatch
    // handler folds-on-load / appends to).
    emitEventSourcedWorkflowFiles(merged.workflows, ns, out, resolveWorkflowSchema);
  }
  // FluentValidation pipeline — emit the generic
  // ValidationBehavior + the csproj package ref + the
  // Program.cs registrations only when at least one aggregate
  // has wire-translatable invariants / preconditions.  Computed
  // before the exception filter render so its FluentValidation
  // arm is gated on the same flag.
  const usesValidators = merged.aggregates.some(hasAnyWireValidator);
  // Only emit the 23505 → 409 arm when some aggregate declares a `unique (...)`
  // key — a unique-free project stays byte-identical (strict additivity).
  const hasUniqueKeys = merged.aggregates.some((a) => (a.uniqueKeys?.length ?? 0) > 0);
  // Only emit the optimistic-concurrency (DbUpdateConcurrencyException → 409)
  // arm when some in-scope aggregate declares the `versioned` capability OR is
  // event-sourced — the EF event-store append translates a `(stream_id,
  // version)` 23505 collision into DbUpdateConcurrencyException, the same
  // exception the guarded write's stale-write raises.  A project with neither
  // stays byte-identical.
  const hasConcurrency = merged.aggregates.some(
    (a) => aggregateIsVersioned(a) || aggregateIsEventSourced(a),
  );
  out.set(
    "Api/DomainExceptionFilter.cs",
    renderExceptionFilter(ns, {
      usesValidators,
      usingDapper,
      hasUniqueKeys,
      hasVersioned: hasConcurrency,
    }),
  );
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
    // The provenance/audit DDL ships as one extra migration sorting after every
    // module's initial migration (so the aggregate tables exist for the
    // co-located-column ALTERs).  Feature-local — not part of MigrationsIR.
    if (hasProvenance || hasAudit) {
      emitDotnetProvenanceAuditMigration(contexts, system?.sys, ns, out, {
        provenance: hasProvenance,
        audit: hasAudit,
      });
    }
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
    actorIdProp,
    usesValidators,
    usesStamping,
    hasEmbeddedSpa,
    spaOutDir: system?.deployable.uiFramework === "svelte" ? "build" : "dist",
    hasMigrations,
    hasSeeds,
    emitTrace,
    usingDapper,
    hasSubscriptions,
    hasOutbox,
    hasAudit,
    hasProvenance,
    resourceNugetDeps: resourceEmission.nugetDeps,
    oidc: !!(authRequired && system?.sys.auth),
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
    // Frontend dispatch by the ui's framework — `framework: svelte` /
    // `framework: vue` embed their static SPAs under ClientApp/
    // exactly like the React embed (same /api origin, same wwwroot
    // serving; only the SPA build output dir differs for svelte —
    // see renderDockerfile).
    const embedOpts = { apiBaseUrl: "/api", pathPrefix: "ClientApp/" };
    const uiFw = system.deployable.uiFramework;
    const embedSvelte = uiFw === "svelte";
    const spaFiles =
      uiFw === "svelte"
        ? generateSvelteForContexts(contexts, system.sys, system.deployable, embedOpts)
        : uiFw === "vue"
          ? generateVueForContexts(contexts, system.sys, system.deployable, embedOpts)
          : generateReactForContexts(contexts, system.sys, system.deployable, embedOpts);
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
    out.set(
      "ClientApp/.gitignore",
      embedSvelte ? "node_modules\nbuild\n.svelte-kit\n" : "node_modules\ndist\n",
    );
  }
  // Layout-aware namespace rewrite (D-REALIZATION-AXES `directoryLayout:`):
  // when the layout adapter relocated files under `Features/`, make each
  // relocated file's C# namespace mirror its folder and fix every
  // `using` / qualified reference project-wide.  No relocation (the
  // byLayer default) → guaranteed no-op, so byLayer stays byte-identical.
  rewriteNamespacesForLayout(out, ns);
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
    // Observable workflows expose GET /workflows/<wf>/instances, whose inline
    // `array<InstanceResponse>` promotes to the named list carrier the other
    // backends emit (`<Wf>InstanceListResponse` — Hono z.array().openapi(),
    // Python RootModel).
    for (const wf of ctx.workflows) {
      if (!wf.instanceWireShape) continue;
      pairs.push({
        element: `${upperFirst(wf.name)}InstanceResponse`,
        wrapper: `${upperFirst(wf.name)}InstanceListResponse`,
      });
    }
    for (const view of ctx.views) {
      if (view.output) {
        pairs.push({
          element: `${upperFirst(view.name)}Row`,
          wrapper: `${upperFirst(view.name)}Response`,
        });
      }
    }
    // Observable workflows expose a named instance-list wrapper
    // (`<Wf>InstanceResponse` → `<Wf>InstanceListResponse`), matching Hono's
    // `z.array(...).openapi("<Wf>InstanceListResponse")` — otherwise Swashbuckle
    // inlines the `IEnumerable<<Wf>InstanceResponse>` list body as a bare array.
    for (const wf of ctx.workflows) {
      if (!wf.instanceWireShape) continue;
      pairs.push({
        element: `${upperFirst(wf.name)}InstanceResponse`,
        wrapper: `${upperFirst(wf.name)}InstanceListResponse`,
      });
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
  const hasSubscriptions = ctx.eventSubscriptions.length > 0;
  // Transactional outbox (dispatch-delivery-semantics.md) — see the
  // system-mode twin above for the design.
  const durableTypes = [...durableEventTypes(ctx)].sort();
  const hasOutbox = hasSubscriptions && durableTypes.length > 0;
  if (hasOutbox) {
    out.set("Domain/Common/OutboxDelivery.cs", renderOutboxDelivery(ns));
    out.set("Infrastructure/Persistence/OutboxMessage.cs", renderOutboxMessage(ns));
    out.set(
      "Infrastructure/Events/OutboxDomainEventDispatcher.cs",
      renderOutboxDispatcher(ns, durableTypes),
    );
    out.set("Infrastructure/Events/OutboxRelayService.cs", renderOutboxRelay(ns, durableTypes));
  }
  emitIds(ctx, ns, out);
  emitEnums(ctx, ns, out);
  emitValueObjects(ctx, ns, out);
  emitEvents(ctx, ns, out, hasSubscriptions);
  emitCommon(ns, out);
  emitDispatcher(ns, out, hasSubscriptions);
  for (const agg of ctx.aggregates) {
    emitAggregate(agg, ctx, ns, out, undefined, emitTrace);
  }
  emitBaseReaders(ctx, ns, out);
  // Domain services (domain-services.md) — see the system-mode twin above.
  emitDomainServices(ctx, ns, out);
  emitWorkflows(ctx, ns, out);
  emitWorkflowInstanceReads(ctx, ns, out);
  if (hasSubscriptions) emitDispatchHandlers(ctx, ns, out, undefined);
  emitViews(ctx, ns, out);
  // Reified `criterion` specifications (evaluate face) — additive, not yet
  // wired into invariants/preconditions (see criteria-emit.ts).
  emitCriteria(ctx, ns, out);
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
  emitProject(ctx, ns, out, {
    usesValidators,
    usesStamping,
    emitTrace,
    hasSeeds,
    hasSubscriptions,
    hasOutbox,
  });
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
  /** Source-map recorder (docs/plans/source-map-debug-kickoff.md) — present
   *  only in system-mode emit, same discipline as `emitCtx`.  No-op when
   *  absent (legacy single-context path), so output stays byte-identical. */
  sourcemap?: SourceMapRecorder,
): void {
  const aggFolder = plural(agg.name);
  const construct = `${ctx.name}.${agg.name}`;
  // Per-aggregate placement (D-REALIZATION-AXES `directoryLayout:`): route the
  // aggregate's domain + persistence files through the deployable's RESOLVED
  // layout adapter (threaded via emitCtx), falling back to byLayer in the
  // legacy single-context path.  byLayer reproduces the historical inline
  // paths byte-for-byte; byFeature rehomes them under `Features/<Plural>/`
  // (namespaces follow via `rewriteNamespacesForLayout`, post-emit).  The
  // adapters ignore the EmitCtx arg for path routing, so an empty stand-in is
  // fine when there's no system context.
  const layout = emitCtx?.layoutAdapter ?? byLayerLayoutAdapter;
  const place = (
    name: string,
    category: DotnetArtifactCategory,
    content: string,
    origin?: OriginRef,
    opFragments?: OpFragment[],
  ): void => {
    const path = layout.pathFor(
      { name, content, category, aggregateName: agg.name } as DotnetArtifact,
      emitCtx ?? ({} as EmitCtx),
    );
    out.set(path, content);
    sourcemap?.file(path, content, origin, construct);
    // Statement-granular sub-regions (source-map Milestone 3) — layered onto
    // the whole-file region just recorded above, anchored by exact-text
    // search against this SAME final content, so they land at the right
    // absolute lines regardless of what the layout adapter did to the path.
    if (sourcemap && opFragments) {
      for (const frag of opFragments) {
        sourcemap.fragment(path, content, frag.fragmentText, frag.subRegions);
      }
    }
  };
  // An abstract base owns no repository / routes.  A TPC (`ownTable`) base owns
  // no table either — emit just the class (Ignore<Base>()d at the DbContext) so
  // the polymorphic reader + concretes have a C# base.  A TPH (`sharedTable`)
  // base, by contrast, IS the table owner: emit the mapped class (owns the
  // shared Id) + its EF configuration (ToTable + HasDiscriminator over the
  // concretes).  Either way, stop — everything below is per concrete aggregate.
  if (agg.isAbstract) {
    if (isTphBase(agg, ctx.aggregates)) {
      place(
        `${agg.name}.cs`,
        "entity",
        renderAbstractBaseEntity(agg, ns, { tph: true }),
        agg.origin,
      );
      place(
        `${agg.name}Configuration.cs`,
        "ef-configuration",
        renderConfiguration(agg, ns, ctx, {
          tph: { role: "base", concretes: tphConcretesOf(agg, ctx.aggregates) },
        }),
        agg.origin,
      );
    } else {
      place(`${agg.name}.cs`, "entity", renderAbstractBaseEntity(agg, ns), agg.origin);
    }
    return;
  }
  // A concrete subtype inherits the abstract base's fields from the base class
  // instead of re-declaring them; thread the base name + its field set through
  // so renderEntity emits `: <Base>` and skips the inherited fields.  A TPH
  // concrete additionally shares the base's single-table Id (`sharesIdentity`),
  // so it declares no `Id` of its own and mints the inherited `<Base>Id`.
  const tpcBase = agg.extendsAggregate
    ? ctx.aggregates.find((a) => a.name === agg.extendsAggregate && isTpcBase(a, ctx.aggregates))
    : undefined;
  const tphBase = agg.extendsAggregate
    ? ctx.aggregates.find((a) => a.name === agg.extendsAggregate && isTphBase(a, ctx.aggregates))
    : undefined;
  const inheritedBase = tpcBase ?? tphBase;
  const superType = inheritedBase
    ? {
        name: inheritedBase.name,
        fieldNames: new Set(inheritedBase.fields.map((f) => f.name)),
        derivedNames: new Set(inheritedBase.derived.map((d) => d.name)),
        sharesIdentity: !!tphBase,
        idValueType: tphBase?.idValueType,
      }
    : undefined;
  // The strongly-typed id class for this aggregate's key.  `tableOwnerName`
  // resolves a TPH concrete to its base (the shared single-table key it
  // inherits); a standalone aggregate / TPC concrete keeps its own `<Agg>Id`,
  // so this is byte-identical off the TPH path.  Threaded through the
  // repository + CQRS emitters so every id surface names the right class.
  const idClass = `${tableOwnerName(agg, ctx.aggregates)}Id`;
  const repo = findRepoFor(ctx, agg.name);
  // Repository-shaped artifacts (interface + impl) prefer the RepositoryIR's
  // own origin (the `repository X for Y { }` declaration) when the model has
  // one, falling back to the owning aggregate's origin otherwise.
  const repoOrigin = repo?.origin ?? agg.origin;
  // dataSource resolution drives BOTH the table-mapping knobs (schema /
  // tablePrefix) and the saving SHAPE.  `isDoc` (shape(document))
  // switches this aggregate onto the document-persistence path: a
  // single JSONB column + STJ round-trip, no normalised entity table,
  // no join tables.  In the legacy single-context entry there's no
  // emitCtx/sys, so resolution falls back to the aggregate header's
  // `normalised(…)` (the default).
  const ds = emitCtx ? resolveDataSourceConfig(agg, ctx, emitCtx.sys) : undefined;
  const shape = effectiveSavingShape(agg, ds);
  // Event-sourced (`persistedAs(eventLog)`) wins over the saving-shape axis:
  // the aggregate persists to a `<agg>_events` stream (an EF event-record
  // entity), folded on load — no state table, no document, no join tables.
  const isEs = agg.persistedAs === "eventLog";
  const isDoc = !isEs && shape === "document";
  const isEmbedded = !isEs && shape === "embedded";

  for (const part of agg.parts) {
    place(
      `${part.name}.cs`,
      "entity",
      renderEntity(part, false, ns, agg.name, emitTrace, isDoc),
      agg.origin,
    );
  }
  // Exception-less operation returns (exception-less.md): precompute opName →
  // Domain union name + variant members where the bounded context is in scope,
  // so the entity emitter can type the method + thread the variant order.
  const operationReturnUnions = new Map<
    string,
    { name: string; members: ReturnType<typeof unionMembers> }
  >();
  for (const op of agg.operations) {
    if (op.returnType?.kind !== "union") continue;
    operationReturnUnions.set(op.name, {
      name: unionInstanceName(op.returnType.variants),
      members: unionMembers(op.returnType.variants, ctx),
    });
  }
  // Only collected when a recorder is actually threaded in — a no-sourcemap
  // run pays no per-statement bookkeeping cost.
  const opFragments: OpFragment[] | undefined = sourcemap ? [] : undefined;
  place(
    `${agg.name}.cs`,
    "entity",
    renderEntity(
      agg,
      true,
      ns,
      agg.name,
      emitTrace,
      isDoc,
      superType,
      operationReturnUnions,
      opFragments,
      construct,
    ),
    agg.origin,
    opFragments,
  );
  // Pure Domain union types for exception-less operation returns — Domain-layer
  // artifacts (the aggregate method produces them), placed alongside the entity.
  for (const f of domainUnionFiles(agg, ctx, ns)) {
    place(f.name, "entity", f.content, agg.origin);
  }
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
    renderRepositoryInterface(agg, repoWithViews, ns, aggRetrievals, idClass),
    repoOrigin,
  );
  // Each retrieval emits an Ardalis `Specification<T>` (where + sort) the
  // EF repository's `Run<Name>Async` consumes via `.WithSpecification(...)`.
  // EF-only: the Dapper repository renders retrievals as parameterised SQL
  // (no Ardalis dependency on that persistence axis).
  if (emitCtx?.deployable.persistence !== "dapper") {
    emitRetrievalSpecs(agg, aggRetrievals, ctx, ns, out);
  }
  // A find with a `where` expression that lowers to `Regex.IsMatch`
  // declares its System.Text.RegularExpressions dependency; the
  // repository impl emitter then adds the using.  Retrieval `where`
  // predicates contribute the same way.
  const repoImplUsings = collectFindBodyUsings(repoWithViews);
  collectRetrievalBodyUsings(aggRetrievals, repoImplUsings);
  // A retrieval/find whose `where` is a reified criterion consumes its
  // `Criterion` class's `ToExpression()` (Slice 2b) → needs Domain.Criteria.
  const consumesCriterion =
    aggRetrievals.some(
      (r) => r.criterionRef && canEmitToExpressionFor(r.criterionRef.name, ctx, agg.name),
    ) ||
    (repoWithViews?.finds ?? []).some(
      (f) => f.criterionRef && canEmitToExpressionFor(f.criterionRef.name, ctx, agg.name),
    );
  if (consumesCriterion) {
    repoImplUsings.add(`${ns}.Domain.Criteria`);
  }
  const findBodies = buildFindBodies(agg, repoWithViews, ctx);
  const retrievalBodies = buildRetrievalBodies(agg, aggRetrievals, ctx);
  // Persistence selection (D-REALIZATION-AXES `persistence:`): `dapper`
  // emits an Npgsql/Dapper repository (and no EF configuration / document /
  // join-table files — the validator gates those features out for dapper);
  // `efcore` (default) keeps the EF Core repository + configuration path
  // byte-identical.
  const usingDapper = emitCtx?.deployable.persistence === "dapper";
  if (usingDapper) {
    // Dapper event store (persistedAs(eventLog)) reuses the persistence-agnostic
    // domain fold + CQRS create chain; only the repository is Dapper-specific.
    // The `<agg>_events` table ships in DbSchema.cs (renderDapperSchema).
    place(
      `${agg.name}Repository.cs`,
      "repository-impl",
      isEs
        ? renderDapperEventSourcedRepository(agg, repoWithViews, ns, findBodies)
        : renderDapperRepository(agg, repoWithViews, ns, aggRetrievals),
      repoOrigin,
    );
  } else if (isEs) {
    // Event-sourced: the `<agg>_events` stream repository (fold on load,
    // append on save) + the EF event-record entity & configuration.  No
    // normalised entity configuration, no document, no join tables.
    place(
      `${agg.name}Repository.cs`,
      "repository-impl",
      renderEventSourcedRepositoryImpl(agg, repoWithViews, ns, findBodies, {
        extraUsings: [...repoImplUsings].sort(),
        idClass,
      }),
      repoOrigin,
    );
    place(
      `${agg.name}EventRecord.cs`,
      "event-record-poco",
      renderEventRecordPoco(agg.name, ns),
      agg.origin,
    );
    place(
      `${agg.name}EventRecordConfiguration.cs`,
      "ef-configuration",
      renderEventRecordConfiguration(agg.name, ns),
      agg.origin,
    );
  } else {
    place(
      `${agg.name}Repository.cs`,
      "repository-impl",
      isDoc
        ? renderDocumentRepositoryImpl(agg, repoWithViews, ns, findBodies, {
            extraUsings: [...repoImplUsings].sort(),
            idClass,
          })
        : renderRepositoryImpl(agg, repoWithViews, ns, findBodies, {
            extraUsings: [...repoImplUsings].sort(),
            emitTrace,
            retrievals: aggRetrievals,
            retrievalBodies,
            idClass,
            embedded: isEmbedded,
          }),
      repoOrigin,
    );
    if (isDoc) {
      // Document-shaped persistence: a `<Agg>Document` record (one JSONB
      // column) + its EF configuration + the snapshot DTOs the repository
      // (de)serialises.  No normalised entity configuration, no join
      // tables — contained parts + references fold into the document.
      place(`${agg.name}Document.cs`, "document-poco", renderDocumentPoco(agg, ns), agg.origin);
      place(
        `${agg.name}DocumentConfiguration.cs`,
        "ef-configuration",
        renderDocumentConfiguration(agg, ns, { schema: ds?.schema, tablePrefix: ds?.tablePrefix }),
        agg.origin,
      );
      place(`${agg.name}Snapshots.cs`, "entity", renderSnapshots(agg, ns), agg.origin);
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
          // A TPH concrete configures only its OWN columns; ToTable/HasKey/Id
          // are inherited from the base config (the shared table owner).
          ...(tphBase ? { tph: { role: "concrete" as const, base: tphBase } } : {}),
        }),
        agg.origin,
      );
      // One file per reference-collection association: the join entity
      // class + its EF Core configuration (composite PK, FK converters).
      // Skipped for embedded (reference collections fold into a JSONB
      // column) and when the aggregate has no `Id<T>[]` fields.
      if (!isEmbedded) {
        for (const assoc of agg.associations) {
          const cls = joinEntityName(assoc);
          place(`${cls}.cs`, "join-entity", renderJoinEntity(assoc, ns), agg.origin);
          place(
            `${cls}Configuration.cs`,
            "join-entity-configuration",
            renderJoinEntityConfiguration(assoc, ns),
            agg.origin,
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
      const path = layout.pathFor(artifact, emitCtx);
      out.set(path, artifact.content);
      sourcemap?.file(path, artifact.content, agg.origin, construct);
    }
  } else {
    emitCqrs(agg, repo, ctx, ns, out, { routePrefix, emitTrace });
  }
  const testsFile = renderTestsFile(agg, ctx, ns);
  if (testsFile) {
    const testsPath = `Tests/${ns}.Tests/${aggFolder}/${agg.name}Tests.cs`;
    out.set(testsPath, testsFile);
    sourcemap?.file(testsPath, testsFile, agg.origin, construct);
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
  const hasOutbox = ctx.eventSubscriptions.length > 0 && durableEventTypes(ctx).size > 0;
  out.set(
    "Infrastructure/Persistence/AppDbContext.cs",
    renderDbContext(
      ctx,
      ns,
      documentAggNames([ctx]),
      eventSourcedAggNames([ctx]),
      embeddedAggNames([ctx]),
      hasOutbox,
    ),
  );
  emitWorkflowStatePersistence(ctx.workflows, ns, out, durableEventTypes(ctx).size > 0);
  emitEventSourcedWorkflowFiles(ctx.workflows, ns, out);
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
    spaOutDir?: "dist" | "build";
    hasMigrations?: boolean;
    hasSeeds?: boolean;
    emitTrace?: boolean;
    usingDapper?: boolean;
    hasSubscriptions?: boolean;
    /** Transactional outbox (dispatch-delivery-semantics.md): registers the
     *  outbox-wrapping dispatcher + the relay BackgroundService. */
    hasOutbox?: boolean;
    /** Per-operation audit (audit-and-logging.md): registers the scoped
     *  `IAuditWriter` → `AuditWriter` the audited command handlers depend on. */
    hasAudit?: boolean;
    /** Field-level provenance (provenance.md): the lineage history table +
     *  co-located columns.  Together with `hasAudit` it forces the ambient
     *  RequestContext to exist so audit/provenance rows can stamp the request
     *  correlation id + scope id. */
    hasProvenance?: boolean;
    /** The `User` record's id property (PascalCased), so the carrier's
     *  `ActorId` accessor can project the principal's id for audit/provenance
     *  "who computed".  Undefined when the deployable has no auth. */
    actorIdProp?: string;
    resourceNugetDeps?: Record<string, string>;
    /** OIDC turnkey auth (D-AUTH-OIDC): the system declares `auth { oidc }`,
     *  so emit the generated verifier registration + its NuGet refs. */
    oidc?: boolean;
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
      hasSubscriptions: !!options?.hasSubscriptions,
      hasOutbox: !!options?.hasOutbox,
      hasAudit: !!options?.hasAudit,
      oidc: !!options?.oidc,
      hasProvenance: !!options?.hasProvenance,
    }),
  );
  // Ardalis.Specification ships only when a retrieval exists (EF Core path;
  // gated against dapper inside renderCsproj) — reified retrieval specs.
  const usesSpecifications = (ctx.retrievals ?? []).length > 0;
  // Shared paging extension consumed by every `Run<Name>Async`.
  if (usesSpecifications && !usingDapper) {
    out.set("Infrastructure/Persistence/QueryablePagingExtensions.cs", renderPagingExtension(ns));
  }
  out.set(
    `${ns}.csproj`,
    renderCsproj(
      ns,
      hasExtern,
      usesValidators,
      options?.resourceNugetDeps,
      usingDapper,
      usesSpecifications,
      !!options?.oidc,
    ),
  );
  out.set("Dockerfile", renderDockerfile(ns, { hasEmbeddedSpa, spaOutDir: options?.spaOutDir }));
  out.set(".dockerignore", renderDockerignore());
  out.set("certs/.gitkeep", "");
  // Catalog-identity request log — always-on.  Cross-backend parity
  // with Phoenix's <App>.Telemetry and Hono's pino access log.
  out.set("Middleware/RequestLoggingMiddleware.cs", renderRequestLoggingMiddleware(ns));
  // Ambient execution context (docs/architecture/request-context.md) — the one
  // AsyncLocal carrier the principal slice (auth), the request-logger slice
  // (--trace), and the audit/provenance correlation stamps all ride.  ALWAYS
  // emitted: the request log (RequestLoggingMiddleware, always mounted) carries
  // `scope_id` from the root frame, matching the cross-backend observability
  // envelope (Hono/Python/Java/Elixir all ride scope_id by default).  The auth
  // / logger slices are layered on via the render options below; the bare
  // carrier (no auth, no --trace) still compiles with `ActorId => null`.
  const authRequired = !!options?.authRequired;
  // Optimistic concurrency (`versioned`): the ambient carrier grows a settable
  // `ExpectedVersion` (from the request's `If-Match` header) that the versioned
  // repository save reads.  Gated so a version-free project is byte-identical.
  const hasVersioned = ctx.aggregates.some(aggregateIsVersioned);
  out.set(
    "Domain/Common/RequestContext.cs",
    renderRequestContext(ns, {
      hasAuth: authRequired,
      hasLogger: emitTrace,
      actorIdProp: options?.actorIdProp,
      hasVersioned,
    }),
  );
  out.set(
    "Middleware/RequestContextMiddleware.cs",
    renderRequestContextMiddleware(ns, { hasVersioned }),
  );
  if (emitTrace) {
    // Domain-layer logger plumbing — emitted only on --trace so the
    // default artefact stays free of the DomainLog shim.
    out.set("Domain/Common/DomainLog.cs", renderDomainLog(ns));
  }
  // The per-dispatch frame opener is needed whenever a consumer reads the
  // frame's scope / parent ids: --trace (logger slice) OR audit / provenance
  // (the call-structure stamp on each row).  Without it those rows would all
  // read the root frame (degenerate scope id, null parent id).  The logger
  // binding stays trace-gated inside the behaviour.
  const opensFrames = emitTrace || !!options?.hasAudit || !!options?.hasProvenance;
  if (opensFrames) {
    out.set(
      "Application/Common/ExecutionContextBehavior.cs",
      renderExecutionContextBehavior(ns, { hasLogger: emitTrace }),
    );
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
      if (agg.persistedAs === "eventLog") continue; // event sourcing wins over the shape axis
      const ds = sys ? resolveDataSourceConfig(agg, ctx, sys) : undefined;
      if (isDocumentShaped(agg, ds)) names.add(agg.name);
    }
  }
  return names;
}

/** Names of event-sourced (`persistedAs(eventLog)`) aggregates across the
 *  given contexts.  Consumed by `renderDbContext` to route each to a
 *  `DbSet<<Agg>EventRecord>` + the event-record configuration (the
 *  `<agg>_events` stream) instead of the normalised entity DbSet. */
function eventSourcedAggNames(contexts: EnrichedBoundedContextIR[]): Set<string> {
  const names = new Set<string>();
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      if (agg.persistedAs === "eventLog") names.add(agg.name);
    }
  }
  return names;
}

/** Names of embedded-shaped (`shape(embedded)`) aggregates across the given
 *  contexts, resolved the same way `emitAggregate` does (binding wins, header
 *  default).  Consumed by `renderDbContext` to drop their reference-collection
 *  associations from the join-entity DbSet/configuration set — an embedded
 *  ref-collection folds into a JSONB column on the root, not a join table. */
function embeddedAggNames(contexts: EnrichedBoundedContextIR[], sys?: SystemIR): Set<string> {
  const names = new Set<string>();
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      if (agg.persistedAs === "eventLog") continue; // event sourcing wins over the shape axis
      const ds = sys ? resolveDataSourceConfig(agg, ctx, sys) : undefined;
      if (isEmbeddedShaped(agg, ds)) names.add(agg.name);
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
  const matching = ctx.views.filter(
    (v) => v.source.kind === "aggregate" && v.source.name === agg.name,
  );
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
    // Carry the view's `ignoring` filter-bypass clause (named-filter-bypass.md
    // §11) onto the synthesized find so the shared find emitter renders the
    // view read's `.IgnoreQueryFilters(...)` exactly like a repository find.
    ...(v.bypassAll ? { bypassAll: v.bypassAll } : {}),
    ...(v.bypassCaps ? { bypassCaps: v.bypassCaps } : {}),
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
