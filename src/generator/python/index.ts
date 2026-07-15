import { pagedReturn } from "../../ir/stdlib/generics.js";
import { unionInstanceName } from "../../ir/stdlib/unions.js";
import type {
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedSystemIR,
  SystemIR,
} from "../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../ir/types/migrations-ir.js";
import {
  aggregatesHaveUniqueKeys,
  aggregatesNeedConcurrency,
} from "../../ir/util/aggregate-flags.js";
import { durableEventTypes } from "../../ir/util/channels.js";
import { mergeContexts } from "../../ir/util/merge-contexts.js";
import {
  effectiveSavingShape,
  resolveContextSchema,
  resolveDataSourceConfig,
} from "../../ir/util/resolve-datasource.js";
import { hierarchyRegistry } from "../../ir/util/tenant-stance.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { lines } from "../../util/code-builder.js";
import { resolveErrorStatus } from "../../util/error-defaults.js";
import { plural, snake } from "../../util/naming.js";
import { embedSpaInto } from "../_frontend/embedded-spa.js";
import { unionJsonSchema } from "../_payload/union-wire.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { generateReactForContexts } from "../react/index.js";
import { actorIdAttr, emitPyAuthFiles, renderPyStubUserKwargs } from "./auth-emit.js";
import {
  abstractBasesOf,
  buildPyBaseReaderFile,
  buildPyBaseUnionFile,
  concretesOf,
} from "./base-reader-builder.js";
import { buildPyDispatchFile, dispatchSubscriptionsOf } from "./dispatch-builder.js";
import { type OpFragment, renderPyAggregate } from "./emit/aggregate.js";
import { emitPyAudit } from "./emit/audit.js";
import { renderPyDomainServices } from "./emit/domain-service.js";
import { errorsPy } from "./emit/errors.js";
import { renderPyEvents } from "./emit/events.js";
import { renderPyWireModels } from "./emit/http-models.js";
import { renderPyIds } from "./emit/ids.js";
import {
  emitPythonAuditMigration,
  emitPythonMigrations,
  emitPythonProvenanceMigration,
  MIGRATE_PY,
} from "./emit/migrations.js";
import { OBS_LOG_PY, OBS_MIDDLEWARE_PY } from "./emit/obs.js";
import { emitPyProvenance } from "./emit/provenance.js";
import { renderPySchema } from "./emit/schema.js";
import { buildPySeedFile } from "./emit/seed.js";
import { renderPyTestsFile } from "./emit/tests.js";
import { renderPyEnumsAndValueObjects } from "./emit/value-objects.js";
import { emitPyExplicitHandlers, emitPyExplicitRouteRouter } from "./explicit-handlers-emit.js";
import { buildPyExternHookModule, externHookModulePath } from "./extern-builder.js";
import { PYTHON_PINS } from "./pins.js";
import { buildPyProjectionsFile } from "./projections-builder.js";
import { buildPyRepositoryFile } from "./repository-builder.js";
import { buildPyDocumentRepositoryFile } from "./repository-document-builder.js";
import { buildPyEmbeddedRepositoryFile } from "./repository-embedded-builder.js";
import { buildPyEventSourcedRepositoryFile } from "./repository-eventsourced-builder.js";
import {
  PORT_POOL_PATH as PY_PORT_POOL_PATH,
  type RepoPortSpec as PyRepoPortSpec,
  portMembersFromSource as pyPortMembersFromSource,
  renderRepositoryPortsFile as renderPyRepositoryPortsFile,
} from "./repository-port-builder.js";
import { emitPyResourceFiles } from "./resource-clients.js";
import { buildPyRoutesFile } from "./routes-builder.js";
import { buildPyViewsFile } from "./views-builder.js";
import {
  buildPyWorkflowsFile,
  commandWorkflowsOf,
  observableWorkflowsOf,
} from "./workflows-builder.js";

// ---------------------------------------------------------------------------
// Python / FastAPI generator orchestrator.
//
// `generatePythonForContexts` is the single entry point called by the
// platform's `emitProject` (src/platform/python.ts).  It mirrors
// dotnet/index.ts's shape: iterate contexts → call per-emitter
// functions → add the project shell.
//
// File layout (grows slice by slice — docs/old/plans/python-backend-plan.md):
//   pyproject.toml                  — uv-managed project + tool config
//   Dockerfile, .dockerignore       — python:3.13-slim + uv image
//   certs/.gitkeep                  — proxy-CA escape hatch
//   app/main.py                     — FastAPI app: CORS, /health, /ready
//   app/settings.py                 — DATABASE_URL from env
//   app/db/engine.py                — async engine + session factory
//   app/db/transaction.py           — per-request tx boundary (commit-before-send)
//   app/domain/…                    — ids / VOs / events / aggregates (S3+)
//   app/db/schema.py, repositories/ — SQLAlchemy models + repos (S6)
//   app/http/…                      — Pydantic DTOs + APIRouters (S7)
//   migrations/…                    — Alembic over MigrationsIR (S9)
// ---------------------------------------------------------------------------

export interface GeneratePythonArgs {
  contexts: EnrichedBoundedContextIR[];
  deployable: DeployableIR;
  sys: SystemIR;
  /** Per-deployable slice of `buildMigrations(sys, snapshots)`.
   *  Consumed by the Alembic emitter (S9); ignored until then. */
  migrations?: MigrationsIR[];
  /** Generate-time observability switch (S17). */
  emitTrace?: boolean;
  /** Generate-time source-map recorder (`--sourcemap`) — arrives already
   *  scoped to this deployable's output folder.  Undefined by default;
   *  every `.file(...)` call is a no-op when the origin is absent, so an
   *  unset recorder never changes output. */
  sourcemap?: SourceMapRecorder;
}

export function generatePythonForContexts(args: GeneratePythonArgs): Map<string, string> {
  const out = new Map<string, string>();
  const slug = pythonProjectName(args.deployable.name);
  const merged = mergeContexts(args.contexts);
  const sourcemap = args.sourcemap;

  // Fullstack-python branch (dotnet parity): a `ui:` mount embeds the
  // React SPA — routers move under /api/*, main.py serves wwwroot/ with
  // an index.html fallback, the Dockerfile becomes multi-stage, and the
  // React project is generated under ClientApp/.
  const hasEmbeddedSpa = !!args.deployable.uiName;
  // Resource verb clients (resources.md): async client modules for the
  // objectStore / queue / api resources this deployable wires.  Workflow
  // / saga `resource-call`s import the verb helpers from these.
  const resources = emitPyResourceFiles(args.sys, args.deployable.dataSourceNames);
  for (const [path, content] of resources.files) out.set(path, content);
  // PyJWT (with the `crypto` extra for RS256/ES256 JWKS verification) ships
  // in pyproject only under an `auth { oidc }` block.
  const oidcDeps = args.deployable.auth?.required && args.sys.auth ? ["pyjwt[crypto]>=2.9,<3"] : [];
  out.set(
    "pyproject.toml",
    renderPyproject(slug, [...resources.deps, ...oidcDeps], [...resources.devDeps]),
  );
  out.set("Dockerfile", hasEmbeddedSpa ? DOCKERFILE_PY_FULLSTACK : DOCKERFILE_PY);
  out.set(".dockerignore", DOCKERIGNORE_PY);
  out.set("certs/.gitkeep", "");
  out.set("app/__init__.py", "");
  out.set("app/settings.py", renderSettings(slug));
  out.set("app/db/__init__.py", "");
  out.set("app/db/engine.py", ENGINE_PY);
  out.set("app/db/transaction.py", TRANSACTION_PY);
  out.set("app/obs/__init__.py", "");
  out.set("app/obs/log.py", OBS_LOG_PY);
  out.set("app/obs/middleware.py", OBS_MIDDLEWARE_PY);
  const routedAggs = args.contexts.flatMap((c) =>
    c.aggregates.filter((a) => !a.isAbstract).map((a) => a.name),
  );
  // A workflow-sourced view is observable only when its source workflow has an
  // `instanceWireShape` (correlation-bearing, state-table-backed).
  const wfHasInstanceShape = new Map(merged.workflows.map((w) => [w.name, w.instanceWireShape]));
  const projHasShape = new Map(merged.projections.map((p) => [p.name, p.wireShape]));
  const hasViews = merged.views.some(
    (v) =>
      v.source.kind === "aggregate" ||
      (v.source.kind === "workflow" && wfHasInstanceShape.get(v.source.name) != null) ||
      (v.source.kind === "projection" && projHasShape.get(v.source.name) != null),
  );
  // A command workflow gets a POST route; an observable (correlation-bearing)
  // workflow gets read-only instance endpoints — either means `workflows_routes`
  // exists and `main` mounts it (an event-triggered-only saga is still
  // observable, parity with Hono / .NET).
  const hasWorkflows =
    commandWorkflowsOf(merged).length > 0 || observableWorkflowsOf(merged).length > 0;
  const hasProjections = merged.projections.length > 0;
  const resolveDs = (agg: import("../../ir/types/loom-ir.js").AggregateIR) => {
    const owning = args.contexts.find((c) => c.aggregates.some((a) => a.name === agg.name));
    return owning
      ? resolveDataSourceConfig(agg as EnrichedAggregateIR, owning, args.sys)
      : undefined;
  };
  // Per-workflow saga-table schema — resolved from the workflow's OWNING
  // context (map-back by name, since `merged` unions several), so its
  // correlation-state / event-log table lands in the context schema.
  const resolveWorkflowSchema = (wf: import("../../ir/types/loom-ir.js").WorkflowIR) => {
    const owning = args.contexts.find((c) => c.workflows.some((w) => w.name === wf.name));
    return owning ? resolveContextSchema(owning, args.sys) : undefined;
  };
  // Per-projection read-model-table schema — same owning-context map-back.
  const resolveProjectionSchema = (proj: import("../../ir/types/loom-ir.js").ProjectionIR) => {
    const owning = args.contexts.find((c) => c.projections.some((p) => p.name === proj.name));
    return owning ? resolveContextSchema(owning, args.sys) : undefined;
  };
  // Per-stream OWNING-context name — maps an event-sourced aggregate / workflow
  // to the context that declares it, so the merged multi-context schema names
  // each `<ctx>_events` model after its owner (matching the per-aggregate
  // repository + migrations), not the merged context name.
  const resolveStreamContext = (streamName: string): string | undefined =>
    args.contexts.find(
      (c) =>
        c.aggregates.some((a) => a.name === streamName) ||
        c.workflows.some((w) => w.name === streamName),
    )?.name;
  // Auth scaffolding (docs/auth.md): only an `auth: required` deployable
  // (whose system declares a `user { ... }` block) carries the verifier
  // registry + middleware — anonymous deployables stay byte-identical.
  const authRequired = !!(args.deployable.auth?.required && args.sys.user);
  // The principal's id attribute — a bare `currentUser` lifecycle-stamp value
  // resolves to `current_user.<attr>`.  Only meaningful under auth; principal
  // stamps without auth are gated upstream (loom.python-stamp-unsupported).
  const principalIdAttr = authRequired && args.sys.user ? actorIdAttr(args.sys.user) : undefined;
  // An `auth { oidc }` block drives the generated OIDC verifier + handshake;
  // absent it, the dev stub keeps a fresh stack callable out of the box.
  const oidc = authRequired ? args.sys.auth : undefined;
  // Hierarchy (multi-tenancy P2.2): when the tenant registry opts into
  // `tenantRegistry` (a `data_key` column exists), `currentUser.orgPath`
  // resolves from that registry's table.  Pass the schema-qualified table so
  // the auth middleware can `SELECT data_key … WHERE id = <claim>`; `undefined`
  // for flat tenancy keeps the P2.1 claim-copy.
  const orgPathRegistryTable = authRequired
    ? (() => {
        const reg = hierarchyRegistry(args.sys);
        if (!reg) return undefined;
        const owning = args.contexts.find((c) => c.aggregates.some((a) => a.name === reg.name));
        const ds = owning
          ? resolveDataSourceConfig(reg as EnrichedAggregateIR, owning, args.sys)
          : undefined;
        const table = `${ds?.tablePrefix ?? ""}${snake(plural(reg.name))}`;
        return ds?.schema ? `${ds.schema}.${table}` : table;
      })()
    : undefined;
  if (authRequired && args.sys.user)
    emitPyAuthFiles(args.sys.user, out, oidc, args.sys.tenancy?.claimField, orgPathRegistryTable);
  // First-boot seeding (database-seeding.md): emitted only when a
  // dataset survives filtering (rows on concrete aggregates); the
  // lifespan runs seeds right after migrations (Hono/.NET boot order).
  const seedFile = buildPySeedFile(merged, (aggName) => {
    const agg = merged.aggregates.find((a) => a.name === aggName);
    return agg ? resolveDs(agg)?.schema : undefined;
  });
  const hasSeeds = seedFile != null;
  // Durable-channel outbox relay (dispatch-delivery-semantics.md): only
  // when a durable channel carries a *subscribed* event does `app/dispatch.py`
  // ship `start_outbox_relay`, which the lifespan kicks off as a background
  // task.  No durable channel / no subscription → byte-identical boot.
  const startsRelay =
    durableEventTypes(merged).size > 0 && dispatchSubscriptionsOf(merged).length > 0;
  // Explicit transport layer (unfoldable-api-derivation.md, A2): one APIRouter
  // per served api whose `route` list resolves to a hosted handler, dispatching
  // each route to its `app/application/<handler>.py` function.  Emitted before
  // renderMain so main can `include_router` the ones that landed (the router
  // files themselves need no dispatcher — only the handler modules do, emitted
  // below once `hasDispatch` is known).  Routes to non-hosted contexts skip.
  const explicitRouteApis: string[] = [];
  for (const apiName of args.deployable.serves) {
    const api = args.sys.apis.find((a) => a.name === apiName);
    if (api && emitPyExplicitRouteRouter(api.name, api.routes, args.contexts, out)) {
      explicitRouteApis.push(api.name);
    }
  }
  out.set(
    "app/main.py",
    renderMain(
      args.sys.name,
      routedAggs,
      hasViews,
      hasWorkflows,
      hasProjections,
      authRequired ? args.sys.user : undefined,
      hasSeeds,
      hasEmbeddedSpa,
      startsRelay,
      !!oidc,
      explicitRouteApis,
    ),
  );
  if (hasEmbeddedSpa) {
    const spaFiles = generateReactForContexts(args.contexts, args.sys, args.deployable, {
      apiBaseUrl: "/api",
      pathPrefix: "ClientApp/",
    });
    // Python embeds React only, so the SPA build dir is Vite's `dist/`
    // (`"react"` never takes the svelte `.gitignore` branch).  Drop the SPA
    // pack's host-owned root files and emit ClientApp/.gitignore — shared with
    // the dotnet / java embed hosts (see embedded-spa.ts).
    embedSpaInto(out, spaFiles, "react");
  }

  out.set("app/domain/__init__.py", "");
  out.set("app/domain/ids.py", renderPyIds(merged));
  // `ConcurrencyError` (+ its 409 handler) rides on either the `versioned`
  // guarded write's stale-write rejection or an event-sourced aggregate's
  // append-time `(stream_id, version)` 23505 collision — a concurrency-free app
  // omits both and stays byte-identical.
  const hasConcurrency = aggregatesNeedConcurrency(merged.aggregates);
  out.set("app/domain/errors.py", errorsPy(hasConcurrency));
  out.set("app/domain/value_objects.py", renderPyEnumsAndValueObjects(merged));
  out.set("app/domain/events.py", renderPyEvents(merged));

  out.set(
    "app/db/schema.py",
    renderPySchema(
      merged,
      resolveDs,
      resolveWorkflowSchema,
      resolveProjectionSchema,
      resolveStreamContext,
    ),
  );
  out.set("app/db/wire.py", WIRE_PY);
  out.set("app/db/migrate.py", MIGRATE_PY);
  const hasPaged = merged.repositories.some((r) =>
    r.finds.some((f) => pagedReturn(f.returnType) != null),
  );
  // The paged carrier lives in the DOMAIN layer (not app.db) so the ORM-neutral
  // repository Protocol can reference it without importing the db package.
  if (hasPaged) out.set("app/domain/paging.py", PAGING_PY);
  out.set("app/db/repositories/__init__.py", "");
  // The runner globs migrations/ at boot; .gitkeep keeps the Docker
  // COPY valid on systems whose snapshot is already up to date.
  out.set("migrations/.gitkeep", "");
  emitPythonMigrations(args.migrations ?? [], out);
  // Provenance runtime (provenance.md): the SDK modules + the LATE
  // hand-emitted migration (co-located `<field>_provenance` columns +
  // `provenance_records`).  No-op when no aggregate declares a provenanced
  // field, so non-provenance projects stay byte-identical.
  emitPyProvenance(args.contexts, out);
  emitPythonProvenanceMigration(args.contexts, out, args.sys);
  // Per-operation audit runtime (audit-and-logging.md): the AuditRecordRow
  // model + the LATE hand-emitted migration (`audit_records`).  No-op when no
  // aggregate declares an `audited` op, so non-audit projects stay
  // byte-identical.  The per-op capture + the record_audit helper are wired by
  // routes-builder.ts / repository-builder.ts.
  emitPyAudit(args.contexts, out);
  emitPythonAuditMigration(args.contexts, out);
  if (seedFile != null) out.set("app/db/seed.py", seedFile);

  // In-process event dispatch (channels.md): only when a channel routes
  // a subscribed event does `app/dispatch.py` exist — and then every
  // repository constructed by routes/views/workflows takes the live
  // dispatcher instead of the Noop (mirrors Hono's createApp default).
  // Only collected when a recorder is actually threaded in — a
  // no-sourcemap run pays no per-statement bookkeeping cost.  Milestone 12:
  // `app/dispatch.py` pools every reactor / event-create handler, so it
  // never gets a whole-file region — only these fragment-only statement
  // regions (mirrors `workflows_routes.py` at Milestone 11).
  const dispatchOpFragments: OpFragment[] | undefined = sourcemap ? [] : undefined;
  const dispatchFile = buildPyDispatchFile(
    merged,
    args.sys,
    dispatchOpFragments,
    resolveStreamContext,
  );
  const hasDispatch = dispatchFile != null;
  if (dispatchFile != null) {
    out.set("app/dispatch.py", dispatchFile);
    if (sourcemap && dispatchOpFragments) {
      for (const frag of dispatchOpFragments) {
        sourcemap.fragment("app/dispatch.py", dispatchFile, frag.fragmentText, frag.subRegions);
      }
    }
  }

  out.set("app/http/__init__.py", "");
  out.set(
    "app/http/problem.py",
    renderProblemPy(
      collectOpUnions([merged]),
      aggregatesHaveUniqueKeys(merged.aggregates),
      hasConcurrency,
      // App-wide structural-conflict statuses (M-T3.4a): the enriched system
      // carries the map folded across every api's `httpStatus`. The global
      // exception handlers have no per-context tag, so they read it here.
      (args.sys as EnrichedSystemIR).structuralErrorStatuses,
    ),
  );
  out.set("app/http/wire_models.py", renderPyWireModels(merged));
  const viewsFile = buildPyViewsFile(merged, hasDispatch);
  if (viewsFile != null) out.set("app/http/views_routes.py", viewsFile);
  const projectionsFile = buildPyProjectionsFile(merged);
  if (projectionsFile != null) out.set("app/http/projections_routes.py", projectionsFile);
  // Only collected when a recorder is actually threaded in — a
  // no-sourcemap run pays no per-statement bookkeeping cost.  Milestone 11:
  // `app/http/workflows_routes.py` pools every command workflow, so it
  // never gets a whole-file region — only these fragment-only statement
  // regions.
  const workflowOpFragments: OpFragment[] | undefined = sourcemap ? [] : undefined;
  const workflowsFile = buildPyWorkflowsFile(merged, hasDispatch, args.sys, workflowOpFragments);
  if (workflowsFile != null) {
    out.set("app/http/workflows_routes.py", workflowsFile);
    if (sourcemap && workflowOpFragments) {
      for (const frag of workflowOpFragments) {
        sourcemap.fragment(
          "app/http/workflows_routes.py",
          workflowsFile,
          frag.fragmentText,
          frag.subRegions,
        );
      }
    }
  }

  // Per-aggregate emission stays per-context — each aggregate module is
  // emitted in the context that owns it.  An abstract base owns no
  // instantiable domain module; it gets the polymorphic union alias +
  // read-only reader instead.
  // Domain services (domain-services.md): one module of stateless pure
  // functions per `domainService`, under app/domain/services/.  Emitted
  // off the merged context so a multi-context deployable gets every
  // service once (the package marker only when at least one exists).
  const serviceFiles = renderPyDomainServices(merged);
  if (serviceFiles.length > 0) {
    out.set("app/domain/services/__init__.py", "");
    for (const f of serviceFiles) out.set(f.path, f.content);
  }

  // Domain-side repository PORTS (audit S7) — the `<Agg>RepositoryPort`
  // Protocols the domain services depend on (in place of the concrete
  // `app.db.repositories.*` class).  Members are DERIVED from each concrete
  // repo's own public async method headers as it is emitted, then pooled.
  const pyPortSpecs: PyRepoPortSpec[] = [];
  for (const ctx of args.contexts) {
    for (const base of abstractBasesOf(ctx)) {
      const concretes = concretesOf(base, ctx);
      if (concretes.length === 0) continue;
      const baseConstruct = `${ctx.name}.${base.name}`;
      const baseDomainPath = `app/domain/${snake(base.name)}.py`;
      const baseDomainContent = buildPyBaseUnionFile(base, concretes);
      out.set(baseDomainPath, baseDomainContent);
      sourcemap?.file(baseDomainPath, baseDomainContent, base.origin, baseConstruct);
      const baseRepoPath = `app/db/repositories/${snake(base.name)}_repository.py`;
      const baseRepoContent = buildPyBaseReaderFile(base, concretes, ctx);
      out.set(baseRepoPath, baseRepoContent);
      sourcemap?.file(baseRepoPath, baseRepoContent, base.origin, baseConstruct);
    }
    for (const agg of ctx.aggregates) {
      if (agg.isAbstract) continue;
      const construct = `${ctx.name}.${agg.name}`;
      const domainPath = `app/domain/${snake(agg.name)}.py`;
      // Only collected when a recorder is actually threaded in — a
      // no-sourcemap run pays no per-statement bookkeeping cost.
      const opFragments: OpFragment[] | undefined = sourcemap ? [] : undefined;
      const domainContent = renderPyAggregate(
        agg,
        ctx,
        args.emitTrace,
        principalIdAttr,
        opFragments,
      );
      out.set(domainPath, domainContent);
      sourcemap?.file(domainPath, domainContent, agg.origin, construct);
      // Statement-granular sub-regions (source-map Milestone 3) — layered
      // onto the whole-file region just recorded above, anchored by
      // exact-text search against this SAME final content.
      if (sourcemap && opFragments) {
        for (const frag of opFragments) {
          sourcemap.fragment(domainPath, domainContent, frag.fragmentText, frag.subRegions);
        }
      }
      // Extern (b) Phase 2 (docs/extern.md): the scaffold-once, user-owned hook
      // module the aggregate's extern-op bodies delegate to.  It carries the
      // `loom:scaffold-once` marker, so the CLI writer PRESERVES the filled-in
      // copy on regen (the sourcemap deliberately does NOT anchor it — it is
      // user-owned, not regenerated).
      const externHook = buildPyExternHookModule(agg);
      if (externHook != null) {
        out.set("app/domain/extern/__init__.py", "");
        out.set(externHookModulePath(agg.name), externHook);
      }
      const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
      const repoPath = `app/db/repositories/${snake(agg.name)}_repository.py`;
      const repoContent =
        agg.persistedAs === "eventLog"
          ? buildPyEventSourcedRepositoryFile(agg, repo, ctx)
          : effectiveSavingShape(agg, resolveDs(agg)) === "document"
            ? buildPyDocumentRepositoryFile(agg, repo, ctx)
            : effectiveSavingShape(agg, resolveDs(agg)) === "embedded"
              ? buildPyEmbeddedRepositoryFile(agg, repo, ctx)
              : buildPyRepositoryFile(agg, repo, ctx);
      out.set(repoPath, repoContent);
      sourcemap?.file(repoPath, repoContent, repo?.origin ?? agg.origin, construct);
      pyPortSpecs.push({ aggName: agg.name, members: pyPortMembersFromSource(repoContent) });
      const routesPath = `app/http/${snake(agg.name)}_routes.py`;
      const routesContent = buildPyRoutesFile(agg, repo, ctx, hasDispatch);
      out.set(routesPath, routesContent);
      sourcemap?.file(routesPath, routesContent, agg.origin, construct);
      const tests = renderPyTestsFile(agg, ctx);
      if (tests != null) {
        const testsPath = `tests/test_${snake(agg.name)}.py`;
        out.set(testsPath, tests);
        sourcemap?.file(testsPath, tests, agg.origin, construct);
      }
    }
  }
  // Pooled domain-side repository PORTS (audit S7).
  const pyPortsFile = renderPyRepositoryPortsFile(pyPortSpecs, merged);
  if (pyPortsFile) out.set(PY_PORT_POOL_PATH, pyPortsFile);
  // Explicit application layer (unfoldable-api-derivation.md, A2): commandHandler
  // / queryHandler → app/application/<name>.py.  Per-context (handlers live on a
  // context); no-op for a deployable with none.  The served-api routers that
  // call these were emitted before renderMain.
  for (const ctx of args.contexts) emitPyExplicitHandlers(ctx, out, hasDispatch);
  return out;
}

/** PEP 508-safe project name — same camelCase→snake folding the system
 *  orchestrator's `serviceSlug` applies to the deployable folder /
 *  database name, so the three stay aligned. */
export function pythonProjectName(deployableName: string): string {
  return deployableName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function renderPyproject(
  slug: string,
  extraDeps: readonly string[] = [],
  extraDevDeps: readonly string[] = [],
): string {
  const dep = (r: string) => `  "${r}",`;
  return lines(
    "# Auto-generated by Loom.  Pin via .loomignore to customise.",
    "[project]",
    `name = "${slug}"`,
    `version = "0.1.0"`,
    `requires-python = ">=3.13"`,
    "dependencies = [",
    [...PYTHON_PINS.dependencies, ...extraDeps].map(dep),
    "]",
    "",
    "[dependency-groups]",
    "dev = [",
    [...PYTHON_PINS.devDependencies, ...extraDevDeps].map(dep),
    "]",
    "",
    "# Application project, not a distributable package — uv installs the",
    "# dependency set without building/installing the project itself.",
    "[tool.uv]",
    "package = false",
    "",
    "[tool.ruff]",
    "line-length = 100",
    `target-version = "py313"`,
    "",
    "# E741: DSL-authored lambda params (idiomatically `l` for lines) flow",
    "# into the generated source verbatim.  E711/E712: DSL equality against",
    "# null/true renders structurally — and in SQLAlchemy predicates",
    "# `== True` / `!= None` are the operator-overloaded forms, not style",
    "# slips.",
    "[tool.ruff.lint]",
    `ignore = ["E711", "E712", "E741"]`,
    "",
    "[tool.mypy]",
    `python_version = "3.13"`,
    "strict = true",
    "",
    "[tool.pytest.ini_options]",
    `asyncio_mode = "auto"`,
    `pythonpath = ["."]`,
    "",
  );
}

function renderSettings(slug: string): string {
  return lines(
    `"""Application settings, sourced from the environment.`,
    "",
    "Auto-generated by Loom.  Pin via .loomignore to customise.",
    `"""`,
    "",
    "import os",
    "",
    "DATABASE_URL = os.environ.get(",
    `    "DATABASE_URL",`,
    `    "postgresql+asyncpg://postgres:postgres@localhost:5432/${slug}",`,
    ")",
    "",
  );
}

const ENGINE_PY = lines(
  `"""Async SQLAlchemy engine + per-request session factory."""`,
  "",
  "from collections.abc import AsyncIterator",
  "from contextvars import ContextVar",
  "",
  "from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine",
  "",
  "from app.settings import DATABASE_URL",
  "",
  "engine = create_async_engine(DATABASE_URL)",
  "session_factory = async_sessionmaker(engine, expire_on_commit=False)",
  "",
  "# The request-scoped session, owned + committed by TransactionMiddleware",
  "# (app/db/transaction.py) BEFORE the response starts, so a client that reads",
  "# its own write (read-after-create) can't race the commit.",
  "request_session: ContextVar[AsyncSession | None] = ContextVar(",
  '    "loom_request_session", default=None',
  ")",
  "",
  "",
  "async def get_session() -> AsyncIterator[AsyncSession]:",
  `    """One session — and exactly one transaction — per request.`,
  "",
  "    Repositories flush; the commit is done by TransactionMiddleware just",
  "    before the response starts — NOT in this dependency's teardown, which",
  "    FastAPI runs AFTER the response is sent (the read-after-create race).",
  "    Off the request path (seeds, CLI) there is no middleware, so fall back",
  "    to owning the session and committing on exit.",
  `    """`,
  "    existing = request_session.get()",
  "    if existing is not None:",
  "        yield existing",
  "        return",
  "    async with session_factory() as session:",
  "        yield session",
  "        await session.commit()",
  "",
);

const TRANSACTION_PY = `"""Per-request transaction boundary (pure-ASGI).  Auto-generated.

Owns exactly one session/transaction per HTTP request and commits it
*before* the response starts — not in a FastAPI \`yield\`-dependency
teardown, which runs AFTER the response is sent and lets a client racing
a read against its own just-committed write see a 404 / stale FK.

On a success status (< 400) the session is committed before the first
response byte leaves; on an error status (or an exception) it is rolled
back.  Repositories/handlers pull this session via \`get_session\`
(app/db/engine.py) off the \`request_session\` ContextVar.
"""

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.db.engine import request_session, session_factory


class TransactionMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async with session_factory() as session:
            token = request_session.set(session)
            finalized = False

            async def send_wrapper(message: Message) -> None:
                nonlocal finalized
                if message["type"] == "http.response.start" and not finalized:
                    finalized = True
                    if message["status"] < 400:
                        await session.commit()
                    else:
                        await session.rollback()
                await send(message)

            try:
                await self.app(scope, receive, send_wrapper)
            except BaseException:
                if not finalized:
                    await session.rollback()
                raise
            finally:
                request_session.reset(token)
`;

function renderMain(
  systemName: string,
  routerAggs: string[],
  hasViews = false,
  hasWorkflows = false,
  hasProjections = false,
  authUser: import("../../ir/types/loom-ir.js").UserIR | undefined = undefined,
  hasSeeds = false,
  hasEmbeddedSpa = false,
  startsRelay = false,
  oidc = false,
  explicitRouteApis: string[] = [],
): string {
  // Every router mounts under the shared API base path (`/api/*`) so the
  // SPA's root path namespace stays free for client-side routing.
  const routerArgs = `, prefix="${API_BASE_PATH}"`;
  const authRequired = authUser != null;
  // Dev-stub verifier (Hono index.ts parity): accepts every request as
  // a built-in admin user with EMPTY permissions so the generated
  // stack boots out of the box, while permission-guarded surfaces
  // still deny.  REPLACE in production via register_user_verifier.
  const stubKwargs = authUser ? renderPyStubUserKwargs(authUser) : "";
  const stubIds = [...new Set(stubKwargs.match(/\b\w+Id(?=\()/g) ?? [])].sort();
  // Dev-claims override (x-loom-dev-claims): keyed by the DECLARED field name
  // (e.g. `tenantId`), written onto the User's snake_case attribute
  // (`tenant_id`) — the header contract is the declared name, matching the
  // node/java (camelCase) and dotnet/elixir (explicit-map) stubs.  String
  // claims only; skipped entirely when the user has no string field.
  const pyClaimStringFields = (authUser?.fields ?? []).filter(
    (f) => f.type.kind === "primitive" && f.type.name === "string",
  );
  const pyDevClaims = authRequired && !oidc && pyClaimStringFields.length > 0;
  return lines(
    `"""FastAPI application entrypoint.`,
    "",
    "Auto-generated by Loom.  Pin via .loomignore to customise.",
    `"""`,
    "",
    pyDevClaims ? "import base64" : null,
    pyDevClaims ? "import json" : null,
    "import os",
    "from collections.abc import AsyncIterator",
    "from contextlib import asynccontextmanager",
    pyDevClaims ? "from dataclasses import replace" : null,
    hasEmbeddedSpa ? "from pathlib import Path as FilePath" : null,
    stubKwargs.includes("datetime.") ? "from datetime import UTC, datetime" : null,
    stubKwargs.includes("Decimal(") ? "from decimal import Decimal" : null,
    pyDevClaims ? "from typing import Any" : null,
    "",
    `from fastapi import FastAPI${authRequired && !oidc ? ", Request" : ""}`,
    "from fastapi.middleware.cors import CORSMiddleware",
    hasEmbeddedSpa ? "from fastapi.responses import FileResponse" : null,
    "from sqlalchemy import text",
    "",
    authRequired ? "from app.auth.middleware import AuthMiddleware" : null,
    authRequired ? "from app.auth.routes import router as auth_router" : null,
    authRequired && !oidc ? "from app.auth.user import User" : null,
    authRequired && !oidc
      ? "from app.auth.verifier import assert_user_verifier_registered, register_user_verifier"
      : null,
    oidc ? "from app.auth.oidc import register_oidc_verifier" : null,
    oidc ? "from app.auth.oidc import router as auth_oidc_router" : null,
    oidc ? "from app.auth.verifier import assert_user_verifier_registered" : null,
    "from app.db.engine import engine",
    "from app.db.migrate import run_migrations",
    "from app.db.transaction import TransactionMiddleware",
    hasSeeds ? "from app.db.seed import run_seeds" : null,
    startsRelay ? "from app.dispatch import start_outbox_relay" : null,
    stubIds.length > 0 ? `from app.domain.ids import ${stubIds.join(", ")}` : null,
    ...routerAggs.map(
      (name) => `from app.http.${snake(name)}_routes import router as ${snake(name)}_router`,
    ),
    "from app.http.problem import install_error_handlers, install_openapi",
    hasViews ? "from app.http.views_routes import router as views_router" : null,
    hasWorkflows ? "from app.http.workflows_routes import router as workflows_router" : null,
    hasProjections ? "from app.http.projections_routes import router as projections_router" : null,
    ...explicitRouteApis.map(
      (name) => `from app.http.${snake(name)}_routes import router as ${snake(name)}_router`,
    ),
    "from app.obs.log import log",
    "from app.obs.middleware import ObservabilityMiddleware",
    "",
    "",
    ...(oidc
      ? [
          "# OIDC verifier (D-AUTH-OIDC) — validates the IdP's tokens against its",
          "# JWKS and maps the configured claims onto User.  Auto-registered here.",
          "register_oidc_verifier()",
          'log("info", "auth_oidc_verifier_registered")',
          "",
          "",
        ]
      : authRequired
        ? [
            "# Dev-stub verifier — accepts every request as a built-in admin user",
            "# (EMPTY permissions, so permission-guarded surfaces still deny).",
            ...(pyDevClaims
              ? [
                  "# Dev-only: override string claims (e.g. tenantId) by sending a",
                  "# base64-encoded JSON object in `x-loom-dev-claims` — the same",
                  "# injection the Hono dev stub honours (dotnet/java/elixir parity).",
                  "# REPLACE for production by calling register_user_verifier(...) with a",
                  "# JWT-decoding implementation, ideally from a non-regenerated module.",
                  "async def _dev_stub_verifier(request: Request) -> User:",
                  `    user = User(${stubKwargs})`,
                  '    injected = request.headers.get("x-loom-dev-claims")',
                  "    if not injected:",
                  "        return user",
                  "    try:",
                  "        claims = json.loads(base64.b64decode(injected))",
                  "    except Exception:",
                  "        return user",
                  "    overrides: dict[str, Any] = {}",
                  // Header key = declared field name; attr = its snake_case form.
                  ...pyClaimStringFields.flatMap((f) => [
                    `    if isinstance((_v := claims.get("${f.name}")), str):`,
                    `        overrides["${snake(f.name)}"] = _v`,
                  ]),
                  "    return replace(user, **overrides) if overrides else user",
                ]
              : [
                  "# REPLACE for production by calling register_user_verifier(...) with a",
                  "# JWT-decoding implementation, ideally from a non-regenerated module.",
                  "async def _dev_stub_verifier(_: Request) -> User:",
                  `    return User(${stubKwargs})`,
                ]),
            "",
            "",
            "register_user_verifier(_dev_stub_verifier)",
            'log("warn", "auth_dev_stub_registered")',
            "",
            "",
          ]
        : []),
    '_PORT = int(os.environ.get("PORT", "8000"))',
    "",
    "",
    "@asynccontextmanager",
    "async def lifespan(_: FastAPI) -> AsyncIterator[None]:",
    '    log("info", "server_starting", port=_PORT)',
    // A missing verifier registration surfaces as a clear boot error
    // instead of a 401 storm on the first request.
    authRequired ? "    assert_user_verifier_registered()" : null,
    "    await run_migrations()",
    hasSeeds ? "    await run_seeds()" : null,
    // Durable-channel relay: at-least-once redelivery of `__loom_outbox`
    // rows, drained on a background task for the process lifetime.
    startsRelay ? "    _outbox_relay = start_outbox_relay()" : null,
    startsRelay ? '    log("info", "outbox_relay_started")' : null,
    '    log("info", "server_listening", port=_PORT)',
    "    yield",
    startsRelay ? "    _outbox_relay.cancel()" : null,
    '    log("info", "server_shutdown", signal="SIGTERM")',
    '    log("info", "server_drained")',
    "",
    "",
    "# Interactive API docs (/docs, /redoc) are gated OFF in production via",
    "# LOOM_OPENAPI_UI=false (the k8s chart sets it); the machine-readable",
    "# /openapi.json spec stays available either way.",
    '_openapi_ui = os.getenv("LOOM_OPENAPI_UI", "true").strip().lower() not in ("false", "0", "off", "no")',
    "app = FastAPI(",
    `    title=${JSON.stringify(systemName)},`,
    '    version="0.1.0",',
    "    lifespan=lifespan,",
    '    docs_url="/docs" if _openapi_ui else None,',
    '    redoc_url="/redoc" if _openapi_ui else None,',
    ")",
    "install_error_handlers(app)",
    "install_openapi(app)",
    "",
    // Starlette runs later-added middleware first, so AuthMiddleware is
    // added BEFORE CORS to keep CORS outermost (auth after CORS — the
    // same ordering the Hono/.NET pipelines mount).
    authRequired ? "app.add_middleware(AuthMiddleware)" : null,
    "# Innermost (added first): owns the per-request DB transaction and commits",
    "# it BEFORE the response starts, so a client's read-after-create can't race",
    "# the commit (a FastAPI yield-dependency commit runs after the response is",
    "# sent).  Inside auth/CORS/obs so their teardown still brackets it.",
    "app.add_middleware(TransactionMiddleware)",
    "# CORS: the compose stack sets CORS_ORIGIN to the frontend origin(s) — a",
    "# comma-separated allowlist.  When set, only those origins are allowed",
    "# (with credentials, so the session cookie flows cross-origin).  When",
    "# unset, the fallback is permissive '*' ONLY for an auth-less system; an",
    "# auth-bearing system denies cross-origin by default.  Pin app/main.py in",
    "# .loomignore to override.",
    '_cors_allowlist = [o.strip() for o in os.environ.get("CORS_ORIGIN", "").split(",") if o.strip()]',
    "app.add_middleware(",
    "    CORSMiddleware,",
    `    allow_origins=_cors_allowlist or ${authRequired ? "[]" : '["*"]'},`,
    "    allow_credentials=bool(_cors_allowlist),",
    `    allow_methods=["*"],`,
    `    allow_headers=["*"],`,
    ")",
    "# Added last so it runs first (Starlette: later-added is outermost) —",
    "# every request is bracketed, including 401s from the auth middleware.",
    "app.add_middleware(ObservabilityMiddleware)",
    ...routerAggs.map((name) => `app.include_router(${snake(name)}_router${routerArgs})`),
    hasViews ? `app.include_router(views_router${routerArgs})` : null,
    hasWorkflows ? `app.include_router(workflows_router${routerArgs})` : null,
    hasProjections ? `app.include_router(projections_router${routerArgs})` : null,
    ...explicitRouteApis.map((name) => `app.include_router(${snake(name)}_router${routerArgs})`),
    // Auth routers mount under the shared API base (`/api/auth`, set by each
    // router's prefix): the frontend guard probes `${API_BASE_URL}/auth/me`
    // and the handshake redirect lands at `/api/auth/callback`.
    authRequired ? "app.include_router(auth_router)" : null,
    oidc ? "app.include_router(auth_oidc_router)" : null,
    "",
    "",
    `@app.get("/health")`,
    "async def health() -> dict[str, str]:",
    `    """Liveness probe — no dependencies.  Body is the cross-backend`,
    `    contract ({"status": "ok"}) the e2e health poll asserts."""`,
    '    log("debug", "health_ok", checks=["app"])',
    `    return {"status": "ok"}`,
    "",
    "",
    `@app.get("/ready")`,
    "async def ready() -> dict[str, str]:",
    `    """Readiness probe — verifies database connectivity."""`,
    "    async with engine.connect() as conn:",
    `        await conn.execute(text("SELECT 1"))`,
    `    return {"status": "ready"}`,
    "",
    ...(hasEmbeddedSpa
      ? [
          "",
          '_WWWROOT = FilePath(__file__).resolve().parent.parent / "wwwroot"',
          "",
          "",
          "# Embedded SPA (wwwroot/, copied in by the Dockerfile's spa-build",
          "# stage).  Registered last so every API route wins; unknown paths",
          "# fall back to index.html for client-side routing.",
          '@app.get("/{spa_path:path}", include_in_schema=False)',
          "async def spa(spa_path: str) -> FileResponse:",
          "    candidate = (_WWWROOT / spa_path).resolve()",
          "    if candidate.is_file() and candidate.is_relative_to(_WWWROOT):",
          "        return FileResponse(candidate)",
          '    return FileResponse(_WWWROOT / "index.html")',
          "",
        ]
      : []),
  );
}

// Single-stage image: uv installs the pinned dependency set into a
// project venv, uvicorn serves.  `uv sync` (not `pip install`): the
// pyproject is the manifest, and uv resolves fast enough that a
// lockfile-less build stays deterministic via the within-major pins.
const DOCKERFILE_PY = `# syntax=docker/dockerfile:1
# Auto-generated.

FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
# wget backs the compose healthcheck (debian-slim ships neither wget
# nor curl); ca-certificates backs the proxy-CA escape hatch below.
RUN apt-get update \\
    && apt-get install -y --no-install-recommends wget ca-certificates \\
    && rm -rf /var/lib/apt/lists/*
# Optional proxy CAs — drop *.crt files into ./certs/ to make uv/pip
# trust them.  The directory always exists (with a .gitkeep), so this
# COPY is a no-op when no CAs are configured.
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates 2>/dev/null || true
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \\
    UV_PROJECT_ENVIRONMENT=/app/.venv
COPY pyproject.toml ./
RUN uv sync --no-dev
COPY app/ ./app/
COPY migrations/ ./migrations/
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
`;

// Fullstack image: stage 1 builds the React SPA under ClientApp/,
// stage 2 is the standard python image with the bundle copied into
// wwwroot/ for main.py's FileResponse fallback (dotnet parity).
const DOCKERFILE_PY_FULLSTACK = `# syntax=docker/dockerfile:1
# Auto-generated — fullstack Python + React (embedded SPA).

FROM node:24-alpine AS spa-build
WORKDIR /spa
COPY ClientApp/package.json ./
RUN npm install --no-audit --no-fund
COPY ClientApp/ ./
RUN npm run build

FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
RUN apt-get update \\
    && apt-get install -y --no-install-recommends wget ca-certificates \\
    && rm -rf /var/lib/apt/lists/*
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates 2>/dev/null || true
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \\
    UV_PROJECT_ENVIRONMENT=/app/.venv
COPY pyproject.toml ./
RUN uv sync --no-dev
COPY app/ ./app/
COPY migrations/ ./migrations/
COPY --from=spa-build /spa/dist ./wwwroot
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
`;

const DOCKERIGNORE_PY = `# Auto-generated.
.venv
__pycache__
*.pyc
.git
.env
.env.*
*.log
.pytest_cache
.mypy_cache
.ruff_cache
`;

// Shared wire-format helpers consumed by every repository's
// `to_wire` projection.
const WIRE_PY = `"""Wire-format helpers shared by repositories.  Auto-generated."""

from datetime import UTC, datetime
from decimal import Decimal


def iso(dt: datetime) -> str:
    """ISO-8601 UTC with a Z suffix — wire parity with the other backends."""
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def money_str(amount: Decimal) -> str:
    """Precise-decimal string with no exponent — wire parity with the other
    backends (money travels as a string in both directions, matching Java's
    \`toPlainString()\` / .NET's invariant decimal).  \`format(d, "f")\` avoids
    the scientific notation bare \`str(Decimal)\` can emit (e.g. \`1E+2\`)."""
    return format(amount, "f")
`;

/** One exception-less op-return union to surface in the OpenAPI spec:
 *  the POST path it answers on, the component name, and the raw oneOf
 *  JSON schema (built by `collectOpUnions`). */
interface PyOpUnion {
  path: string;
  name: string;
  schema: unknown;
}

/** Operation-return unions across the deployable's contexts — the tagged
 *  wire union each exception-less op's 200 carries.  The route handler
 *  already returns the tagged dict; the spec side injects the component +
 *  200 in `install_openapi` (a pydantic Union response_model would
 *  register per-variant components no other backend publishes). */
function collectOpUnions(contexts: readonly EnrichedBoundedContextIR[]): PyOpUnion[] {
  const seen = new Set<string>();
  const out: PyOpUnion[] = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      for (const op of agg.operations) {
        if (op.visibility !== "public" || op.returnType?.kind !== "union") continue;
        const name = unionInstanceName(op.returnType.variants);
        const path = `${API_BASE_PATH}/${snake(plural(agg.name))}/{id}/${snake(op.routeSlug ?? op.name)}`;
        if (seen.has(`${path}|${name}`)) continue;
        seen.add(`${path}|${name}`);
        out.push({ path, name, schema: unionJsonSchema(op.returnType.variants, ctx) });
      }
    }
  }
  return out;
}

// RFC 7807 problem responder + exception handlers — DomainError → 400,
// ForbiddenError → 403, AggregateNotFoundError → 404, and FastAPI's
// RequestValidationError → 422 with the §3.2 `errors[]` extension
// (RFC 6901 pointers), matching the other backends' ProblemDetails.
function renderProblemPy(
  opUnions: PyOpUnion[],
  hasUniqueKeys = false,
  hasVersioned = false,
  /** App-wide resolved HTTP status per structural-conflict built-in
   *  (M-T3.4a). The global exception handlers have no per-context tag, so
   *  their hardcoded 409s resolve through this map (`httpStatus <Conflict>
   *  <Code>` override, defaulting to 409 → byte-identical). */
  structuralErrorStatuses?: Record<string, number>,
): string {
  // Structural-conflict statuses resolved through the `httpStatus` mapper: the
  // 23505 unique-violation handler → UniquenessConflict, the ConcurrencyError
  // handler → ConcurrencyConflict, the DisallowedError (`when`-gate) handler →
  // Disallowed. With no override every value is 409 (byte-identical).
  const uniquenessStatus = resolveErrorStatus("UniquenessConflict", structuralErrorStatuses);
  const concurrencyStatus = resolveErrorStatus("ConcurrencyConflict", structuralErrorStatuses);
  const disallowedStatus = resolveErrorStatus("Disallowed", structuralErrorStatuses);
  // JSON literals are valid Python for the value kinds used here (strings,
  // arrays, objects — no booleans/nulls cross).
  const responsesDict = JSON.stringify(Object.fromEntries(opUnions.map((u) => [u.path, u.name])));
  const componentsDict = JSON.stringify(
    Object.fromEntries(opUnions.map((u) => [u.name, u.schema])),
  );
  // The 23505 → 409 IntegrityError handler (+ its import) is emitted only when
  // some aggregate declares a `unique (...)` key, so a unique-free app stays
  // byte-identical (the proposal's strict-additivity guarantee).
  const integrityImport = hasUniqueKeys ? "\nfrom sqlalchemy.exc import IntegrityError" : "";
  const integrityHandler = hasUniqueKeys
    ? `    @app.exception_handler(IntegrityError)
    async def _integrity(request: Request, err: IntegrityError) -> JSONResponse:
        # A Postgres unique_violation (SQLSTATE 23505) — e.g. a \`unique (...)\`
        # domain invariant breaching its derived DB unique index — maps to a
        # friendly 409 Conflict instead of a raw 500.  Other integrity breaches
        # (FK/check) are conflicts too, so they share the 409.  asyncpg exposes
        # \`.sqlstate\` on the driver error SQLAlchemy wraps in \`.orig\`.
        sqlstate = getattr(getattr(err, "orig", None), "sqlstate", None)
        if sqlstate == "23505":
            log("warn", "disallowed", message=str(err), status=${uniquenessStatus})
            return problem(
                request, ${uniquenessStatus}, "Conflict", "A resource with these values already exists."
            )
        log("warn", "disallowed", message=str(err), status=${uniquenessStatus})
        return problem(request, ${uniquenessStatus}, "Conflict", "The request conflicts with the current state.")

`
    : "";
  // The `versioned` optimistic-concurrency guard raises ConcurrencyError from
  // the repository save when the row's version no longer matches the caller's
  // expected version; it maps to a 409 Conflict (+ its import + a distinct
  // `conflict` catalog event).  Emitted only when some aggregate is versioned,
  // so a concurrency-free app stays byte-identical.
  const versionedImport = hasVersioned ? "    ConcurrencyError,\n" : "";
  const versionedHandler = hasVersioned
    ? `    @app.exception_handler(ConcurrencyError)
    async def _conflict(request: Request, err: ConcurrencyError) -> JSONResponse:
        # An optimistic-concurrency guard (the \`versioned\` capability) found the
        # row's version no longer matched the caller's expected version — a
        # competing write won the race.  Surface a friendly 409 so the client
        # reloads and retries instead of clobbering the newer state.
        log("warn", "conflict", message=str(err), status=${concurrencyStatus})
        return problem(
            request, ${concurrencyStatus}, "Conflict", "The resource was modified by another request; reload and retry."
        )

`
    : "";
  return `"""RFC 7807 problem responses + exception handlers.  Auto-generated."""

from typing import Any, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from pydantic import BaseModel${integrityImport}

from app.domain.errors import (
    AggregateNotFoundError,
${versionedImport}    DisallowedError,
    DomainError,
    ForbiddenError,
)
from app.obs.log import log


class ProblemDetails(BaseModel):
    """RFC 7807 body (+ the §3.2 errors[] extension on 422) — the shared
    cross-backend error component the conformance gate compares."""

    type: str | None = None
    title: str | None = None
    status: int | None = None
    detail: str | None = None
    instance: str | None = None
    errors: list[dict[str, str]] | None = None


# Exception-less op-return unions (path → tagged-union component name, and
# the raw oneOf components) — injected into the spec by install_openapi.
_OP_UNION_RESPONSES: dict[str, str] = ${responsesDict}
_OP_UNION_COMPONENTS: dict[str, Any] = ${componentsDict}


def install_openapi(app: FastAPI) -> None:
    """Post-process the generated OpenAPI for cross-backend parity:
    error responses ride as application/problem+json (the declared
    \`model\` registers the ProblemDetails component under
    application/json), and FastAPI's auto-added 422
    HTTPValidationError responses (+ their components) are dropped —
    routes declare their own 422 where the shared error matrix
    (openapi-errors.ts) says so."""

    def custom_openapi() -> dict[str, Any]:
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
        for item in cast(dict[str, Any], schema.get("paths", {})).values():
            for op in item.values():
                if not isinstance(op, dict):
                    continue
                responses = cast(dict[str, Any], op.get("responses", {}))
                for code in list(responses):
                    if not (code[:1] in "45" and len(code) == 3):
                        continue
                    content = cast(dict[str, Any], responses[code].get("content", {}))
                    ref = (
                        content.get("application/json", {}).get("schema", {}).get("$ref", "")
                    )
                    if ref.endswith("/HTTPValidationError"):
                        del responses[code]
                    elif ref.endswith("/ProblemDetails"):
                        content["application/problem+json"] = content.pop("application/json")
        components = cast(dict[str, Any], schema.get("components", {})).get("schemas", {})
        components.pop("HTTPValidationError", None)
        components.pop("ValidationError", None)
        # Exception-less operation-return unions: the route handler returns
        # the tagged dict (no pydantic response_model — a Union model would
        # register per-variant components no other backend publishes), so the
        # 200 + the named oneOf component are wired here for parity with
        # Hono's discriminatedUnion / .NET's Application union DTO.
        for path, union_name in _OP_UNION_RESPONSES.items():
            post_op = cast(dict[str, Any], schema.get("paths", {})).get(path, {}).get("post")
            if isinstance(post_op, dict):
                cast(dict[str, Any], post_op.setdefault("responses", {}))["200"] = {
                    "description": "OK",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/" + union_name}
                        }
                    },
                }
        components.update(_OP_UNION_COMPONENTS)
        app.openapi_schema = schema
        return schema

    app.openapi = custom_openapi  # type: ignore[method-assign]


def problem(
    request: Request,
    status: int,
    title: str,
    detail: str,
    errors: list[dict[str, str]] | None = None,
) -> JSONResponse:
    body: dict[str, object] = {
        "type": "about:blank",
        "title": title,
        "status": status,
        "detail": detail,
        "instance": request.url.path,
    }
    if errors is not None:
        body["errors"] = errors
    return JSONResponse(body, status_code=status, media_type="application/problem+json")


def _pointer(loc: tuple[object, ...]) -> str:
    """RFC 6901 pointer from a validation-error location (the leading
    source segment — body/query/path — is dropped)."""
    segments = [str(p).replace("~", "~0").replace("/", "~1") for p in loc[1:]]
    return "/" + "/".join(segments) if segments else ""


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ForbiddenError)
    async def _forbidden(request: Request, err: ForbiddenError) -> JSONResponse:
        log("warn", "forbidden", message=str(err), status=403)
        return problem(request, 403, "Forbidden", str(err))

    @app.exception_handler(DisallowedError)
    async def _disallowed(request: Request, err: DisallowedError) -> JSONResponse:
        log("warn", "disallowed", message=str(err), status=${disallowedStatus})
        return problem(request, ${disallowedStatus}, "Conflict", str(err))

    @app.exception_handler(DomainError)
    async def _domain(request: Request, err: DomainError) -> JSONResponse:
        log("warn", "domain_error", message=str(err), status=400)
        return problem(request, 400, "Bad Request", str(err))

${integrityHandler}${versionedHandler}    @app.exception_handler(AggregateNotFoundError)
    async def _not_found(request: Request, err: AggregateNotFoundError) -> JSONResponse:
        log("warn", "not_found", message=str(err), status=404)
        return problem(request, 404, "Not Found", str(err))

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, err: RequestValidationError) -> JSONResponse:
        errors = [
            {"pointer": _pointer(tuple(e["loc"])), "message": str(e["msg"])}
            for e in err.errors()
        ]
        return problem(request, 422, "Unprocessable Entity", "Request validation failed.", errors)

    @app.exception_handler(Exception)
    async def _internal(request: Request, err: Exception) -> JSONResponse:
        # Catch-all fallback for any unhandled exception — logs the catalog
        # internal_error event (matching Hono/.NET/Java/vanilla) and returns a
        # sanitized 500 so the real message stays in the log stream, not on the
        # wire.  The specific handlers above still win via the exception MRO
        # (Starlette looks each exception's type up most-specific-first).
        log("error", "internal_error", error=str(err), status=500)
        return problem(request, 500, "Internal Server Error", "An unexpected error occurred.")
`;
}

// Shared paged-result carrier (P3b) — the domain-side mirror of the
// wire `<Arg>Paged` payload, generic over the item type (PEP 695).
const PAGING_PY = `"""Paged-result carrier shared by repositories.  Auto-generated."""

from dataclasses import dataclass


@dataclass(frozen=True)
class PagedResult[T]:
    items: list[T]
    page: int
    page_size: int
    total: int
    total_pages: int
`;
