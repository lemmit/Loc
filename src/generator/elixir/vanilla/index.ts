// ---------------------------------------------------------------------------
// Elixir orchestrator — the elixir emit subtree.
//
// Plain Phoenix + Ecto.  Called from `../index.ts`.
//
// Per docs/plans/vanilla-foundation-tdd-plan.md — built in TDD slices.
//   Slice 0: shell.
//   Slice 1: per-aggregate schema + repository + context module + read
//     controllers + spliced router routes.
//   Slice 2 (current scope): + changeset module + create/update/destroy
//     controller actions + write-path routes.
//   Later slices: policies, ProblemDetails parity, workflows + views, CI.
// ---------------------------------------------------------------------------

import type { PageNameCtx } from "../../../ir/util/page-kind.js";
import {
  aggregateIsEventSourced,
  resolveContextSchema,
} from "../../../ir/util/resolve-datasource.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import {
  buildPhoenixResourceModules,
  emitPhoenixResourceFiles,
} from "../adapters/resource-clients.js";
import type { ApiRoute } from "../api-emit.js";
import { toModulePrefix, toSnakeApp } from "../app-naming.js";
import { actorIdKey, emitAuth } from "../auth-emit.js";
import { emitDispatch, emitWorkflowStateSchemas } from "../dispatch-emit.js";
import { emitDomainServices } from "../domain-service-emit.js";
import type { GenerateElixirArgs } from "../index.js";
import { emitLiveViewPages, type LiveRoute } from "../liveview-emit.js";
import { emitMigrations } from "../migrations-emit.js";
import { renderRelEnv, renderRelease, renderRelServer } from "../shell/config.js";
import { renderDockerfile, renderDockerignore } from "../shell/project.js";
import { renderSidebarComponent } from "../sidebar-emit.js";
import { emitAggregateTests, emitTestHelper } from "../tests-emit.js";
import { renderThemeCss } from "../theme-emit.js";
import { emitVanillaApiControllers } from "./api-emit.js";
import { emitVanillaAudit } from "./audit-emit.js";
import { emitVanillaChangesets } from "./changeset-emit.js";
import { emitVanillaContextModule } from "./context-emit.js";
import { emitVanillaEventModules } from "./events-emit.js";
import { emitVanillaEventSourcedFiles } from "./eventsourced-emit.js";
import { emitOpenApiSpec } from "./openapi-emit.js";
import { renderVanillaProblemDetailsModule } from "./problem-details-emit.js";
import { emitVanillaProvenance } from "./provenance-emit.js";
import { emitVanillaRepositories } from "./repository-emit.js";
import { emitVanillaRetrievals } from "./retrieval-emit.js";
import { emitVanillaSchemas } from "./schema-emit.js";
import { emitVanillaShellFiles } from "./shell-emit.js";
import { emitVanillaValueCollectionSchemas } from "./value-collection-schema-emit.js";
import { emitVanillaValueObjects } from "./valueobject-emit.js";
import {
  emitVanillaViewModules,
  emitVanillaViewsController,
  type VanillaViewRef,
} from "./view-emit.js";
import { emitVanillaEsWorkflowFiles } from "./workflow-eventsourced-emit.js";
import {
  emitVanillaWorkflowExecution,
  emitVanillaWorkflowsController,
  type WorkflowControllerGroup,
} from "./workflow-execution-emit.js";
import { emitVanillaWorkflowInstances } from "./workflow-instances-emit.js";

export function generateVanillaElixirProject(args: GenerateElixirArgs): Map<string, string> {
  const { contexts, deployable, sys, sourcemap } = args;
  const out = new Map<string, string>();
  const appName = toSnakeApp(deployable.name);
  const appModule = toModulePrefix(appName);

  // Shared cross-controller helper modules (Slice 4).  Emitted once
  // per project; controllers `alias` the public functions.  The 23505 → 409
  // conflict branch is emitted only when some aggregate declares a `unique (...)`
  // key, so a unique-free project stays byte-identical (strict additivity).
  const hasUniqueKeys = contexts.some((c) =>
    c.aggregates.some((a) => (a.uniqueKeys?.length ?? 0) > 0),
  );
  // The optimistic-concurrency 409 branch (`conflict_response/1`) is emitted when
  // some in-scope aggregate carries the `versioned` capability OR is
  // event-sourced: the `versioned` write rescues `Ecto.StaleEntryError` and the
  // event-log append rescues a `(stream_id, version)` unique_violation, both to
  // `{:error, :conflict}` → this responder.  A project with neither stays
  // byte-identical (strict additivity).
  const hasConcurrency = contexts.some((c) =>
    c.aggregates.some((a) => aggregateIsVersioned(a) || aggregateIsEventSourced(a)),
  );
  out.set(
    `lib/${appName}_web/problem_details.ex`,
    renderVanillaProblemDetailsModule(appModule, hasUniqueKeys, hasConcurrency),
  );

  // Resource-adapter helper modules — `lib/<app>/resources/<source_type>.ex`.
  // Plain Elixir helper fns from the shared Phoenix adapter set.  Workflows'
  // `resource-call` lowering
  // resolves `<resource>.verb(args)` against the per-resource module map.
  // Some legacy test paths construct a SystemIR without `dataSources`/`storages`
  // populated; guard the call so an under-shaped sys yields an empty resource
  // set rather than throwing.
  const sysWithSources =
    sys?.dataSources && sys?.storages
      ? { dataSources: sys.dataSources, storages: sys.storages }
      : undefined;
  const resourceEmission = emitPhoenixResourceFiles(sysWithSources, appName, appModule);
  for (const [path, content] of resourceEmission.files) out.set(path, content);
  const resourceModules = buildPhoenixResourceModules(sysWithSources, appModule);

  // Per-context emit: schema, changeset, repository, context module,
  // controllers.  Changeset before Repository so the latter can alias it.
  const apiRoutes: ApiRoute[] = [];
  const allViews: VanillaViewRef[] = [];
  const workflowGroups: WorkflowControllerGroup[] = [];
  // The principal id field name a `currentUser` lifecycle stamp resolves to
  // (`current_user.<idKey>`), defaulting to `id` when no `user {}` block —
  // threaded into `renderStampChanges`.
  const principalIdKey = actorIdKey(sys.user);
  let hasDomainTests = false;
  for (const ctx of contexts) {
    emitVanillaSchemas(appModule, ctx, out, sys, sourcemap);
    // Value-object collection (`charges: Money[]`) child schemas — one Ecto
    // schema per VO-array field, owning the id-less `<owner>_<field>` child
    // table the parent `has_many`s + `cast_assoc`s.
    emitVanillaValueCollectionSchemas(appModule, ctx, out);
    // Validating value-object constructors (`<VO>.new/1`) for VOs with
    // invariants — enforced at construction (F5) + called by the test suite.
    emitVanillaValueObjects(appModule, ctx, out);
    emitVanillaChangesets(appModule, ctx, out, sys);
    emitVanillaRepositories(appModule, ctx, out, sys, principalIdKey, sourcemap);
    // Event-sourced aggregates (persistedAs(eventLog)) — struct + event-log
    // Ecto schema + fold + event-store repository (D-VANILLA-ES-HOME).  The
    // state emitters above skip them; the context module + controllers branch.
    emitVanillaEventSourcedFiles(appModule, ctx, out);
    emitVanillaContextModule(appModule, ctx, out, sys, sourcemap);
    // Domain services — stateless pure-calculator modules under
    // `<App>.Domain.Services.*` (domain-services.md).  A domain service touches
    // no persistence (the shared `../domain-service-emit`).
    emitDomainServices(appName, appModule, ctx, out);
    // Event struct modules — `lib/<app>/<ctx>/events/<event>.ex`.  The
    // workflow-execution `emit` lowering builds `%Context.Events.<Name>{...}`
    // structs against these (PubSub broadcast), and a future channel-on-
    // vanilla slice reuses the same module path.
    emitVanillaEventModules(appModule, ctx, out);
    const { routes } = emitVanillaApiControllers(appName, appModule, ctx, out, sys, sourcemap);
    apiRoutes.push(...routes);
    // Views — per-context Ecto query modules; controller + routes collected
    // project-wide (one `ViewsController` for all views).
    emitVanillaViewModules(appName, appModule, ctx, out, sourcemap);
    for (const view of ctx.views) allViews.push({ ctx, view });
    // Retrievals — per-context Ecto query modules at
    // `lib/<app>/<ctx>/retrievals/<name>.ex` plus a matching
    // `defdelegate run_<ret>_<agg>` on the context facade (emitted by
    // `context-emit.ts`).  Consumed by a workflow's `repo-run` lowering
    // (a separate follow-up slice).
    emitVanillaRetrievals(appName, appModule, ctx, out);
    // Workflow-instance read endpoints — saga-state Ecto schema + a
    // read-only WorkflowInstancesController (the deferred-Phoenix gap closer).
    apiRoutes.push(...emitVanillaWorkflowInstances(appName, appModule, ctx, out));
    // Workflow EXECUTION — `run/1` modules per command-triggered workflow +
    // a project-wide `WorkflowsController` + POST /workflows/<name> routes.
    // Body lowering covers every WorkflowStmtIR kind; the optional
    // `Repo.transaction` wrap is driven by `wf.transactional`.
    const wfExec = emitVanillaWorkflowExecution(
      appName,
      appModule,
      ctx,
      out,
      resourceModules,
      sys,
      sourcemap,
    );
    apiRoutes.push(...wfExec.routes);
    // Collect this context's command workflows; the single deployable-level
    // `WorkflowsController` aggregating every hosted context is emitted ONCE
    // after the loop (sibling of `emitVanillaViewsController` — one controller
    // per app, not per context).
    if (wfExec.commandWorkflows.length > 0) {
      workflowGroups.push({ ctx, workflows: wfExec.commandWorkflows });
    }
    // Channels-on-vanilla — the in-process Dispatcher fans the workflow's
    // `emit` (which lowers to `Phoenix.PubSub.broadcast`) into per-context
    // channel handler modules.  The dispatcher code is plain Elixir +
    // `${App}.Repo` + `Phoenix.PubSub` + the context facade fns the handler
    // bodies call into.  Saga state schemas are
    // emitted unconditionally for every correlation-bearing workflow so
    // `WorkflowInstancesController` (the deferred-Phoenix gap closer) has
    // the table to read from even on a command-only saga.
    // Saga tables live in the context's schema (matching the migration
    // `prefix:`), so the Ecto `@schema_prefix` and the DDL agree at runtime.
    const wfSchema = sys ? resolveContextSchema(ctx, sys) : undefined;
    emitWorkflowStateSchemas(appName, ctx, appModule, out, wfSchema);
    // Event-sourced workflows (workflow-and-applier.md A2-S5b): the per-workflow
    // fold struct + `<wf>_events` Ecto schema + fold + stream IO modules (the
    // saga analogue of the ES aggregate files above).  The dispatcher branches
    // their handlers to fold-on-load + append-own-events.
    emitVanillaEsWorkflowFiles(appName, appModule, ctx, out, wfSchema, sourcemap);
    emitDispatch(appName, ctx, appModule, out, sys, "vanilla", sourcemap);
    // Domain `test "..."` blocks → ExUnit (pure-subset; see tests-emit.ts).
    if (emitAggregateTests(ctx, appModule, "vanilla", out)) hasDomainTests = true;
  }
  if (hasDomainTests) emitTestHelper(out);
  apiRoutes.push(...emitVanillaViewsController(appName, appModule, allViews, out));
  // One deployable-level WorkflowsController over every hosted context's command
  // workflows (the per-context emit above intentionally does NOT write it).
  emitVanillaWorkflowsController(appName, appModule, workflowGroups, out);

  // --- OpenAPI spec ----------------------------------------------------------
  // Emits the <Api>Spec module, per-aggregate/workflow/view schema modules, and
  // the OpenapiController, plus a `!root:/openapi.json` route entry spliced into
  // the router ROOT (not under /api) so the spec sits at /openapi.json on every
  // backend — joining the 5-backend conformance-parity diff.  The generated
  // Auth plug already bypasses /openapi.json so it serves without a token.
  const { files: openApiFiles, routes: openApiRoutes } = emitOpenApiSpec({
    contexts,
    deployable,
    sys,
    appName,
    appModule,
  });
  for (const [path, content] of openApiFiles) out.set(path, content);
  apiRoutes.push(...openApiRoutes);

  // Provenance runtime — the `<App>.Provenance` SDK (trace buffer + history
  // flush + the `Json` Ecto type + `Record` schema) plus the migration that
  // adds the co-located `<field>_provenance` columns + the `provenance_records`
  // table.  No-op unless a provenanced field exists (DEBT-06).
  emitVanillaProvenance(appName, appModule, contexts, out, sys);

  // Audit runtime — the `<App>.Audit` sink (Record schema + the `Json` Ecto
  // type + the transactional `record/2` insert) plus the late migration that
  // creates `audit_records`.  No-op unless an aggregate carries an audited
  // command action (operation / create / destroy) (audit-and-logging.md).
  emitVanillaAudit(appName, appModule, contexts, out);

  // --- LiveView pages --------------------------------------------------------
  // A deployable that mounts a HEEx `ui:` (not an embedded SPA) emits Phoenix
  // LiveView pages over the plain-Ecto context API — `emitLiveViewPages` reads
  // through the `list_<agg>s()` / `get_<agg>(id)` tuple-returning fetches.
  // The collected `liveRoutes` are spliced into the
  // router's `live_session` by `emitVanillaShellFiles` below.  An embedded-SPA
  // (`framework: react|vue|svelte`) ui owns its own UI, so no LiveView pages.
  const embedReact =
    deployable.uiFramework === "react" ||
    deployable.uiFramework === "vue" ||
    deployable.uiFramework === "svelte";
  const liveRoutes: LiveRoute[] = [];
  let hasSidebar = false;
  if (deployable.uiName && !embedReact) {
    const { files: liveFiles, routes } = emitLiveViewPages({
      contexts,
      deployable,
      sys,
      appName,
      appModule,
      foundation: "vanilla",
      sourcemap,
    });
    for (const [path, content] of liveFiles) out.set(path, content);
    liveRoutes.push(...routes);

    // Sidebar + theme — the sidebar derivation + theme renderer.
    const ui = sys.uis.find((u) => u.name === deployable.uiName);
    if (ui) {
      const nameCtx: PageNameCtx = {
        aggregateNames: contexts.flatMap((c) => c.aggregates.map((a) => a.name)),
        workflowNames: contexts.flatMap((c) => c.workflows.map((w) => w.name)),
        viewNames: contexts.flatMap((c) => c.views.map((v) => v.name)),
      };
      out.set(
        `lib/${appName}_web/components/sidebar.ex`,
        renderSidebarComponent({
          ui,
          appName,
          appModule,
          nameCtx,
          authEnabled: deployable.auth?.required === true,
        }),
      );
      hasSidebar = true;
      out.set("priv/static/assets/theme.css", renderThemeCss(sys.theme));
    }
  }
  const hasLiveView = liveRoutes.length > 0 || hasSidebar;

  // Auth modules — the Auth plug (Bearer-JWT → `conn.assigns
  // .current_user`), LiveAuth on_mount, and /auth controller.  Emitted when the
  // deployable requires auth — the request principal a tenancy (principal)
  // `filter` scopes reads by.  The plug + /auth scope are spliced into the
  // router below via `authEnabled`.
  const { files: authFiles, enabled: authEnabled } = emitAuth({
    sys,
    deployable,
    appName,
    appModule,
  });
  for (const [path, content] of authFiles) {
    // The LiveView `on_mount` hook imports `Phoenix.Component` /
    // `Phoenix.LiveView` — only available once the deployable mounts a HEEx
    // `ui:` (which pulls in the `phoenix_live_view` dep + a `live_session`).
    // A JSON-API-only deployable has no LiveView dep, so the hook would
    // be dead code that breaks `mix compile --warnings-as-errors`; skip it
    // there.  When LiveView IS emitted, keep it (the live_session can mount it).
    if (path.endsWith("/live_auth.ex") && !hasLiveView) continue;
    out.set(path, content);
  }

  // Shell files — emitted AFTER per-context emit so the router has the
  // collected `apiRoutes` to splice into the `/api` scope.  Resource-adapter
  // hex deps (ex_aws_s3, amqp, req) ride into `mix.exs`.
  emitVanillaShellFiles(
    appName,
    appModule,
    out,
    apiRoutes,
    resourceEmission.hexDeps,
    authEnabled,
    !!sys.auth?.oidc,
    liveRoutes,
    hasSidebar,
  );

  // Deployment + boot machinery — the Elixir release, Dockerfile, and Ecto
  // migrations.  Without these the project isn't container/k8s-deployable: no
  // image to build, and the per-backend database has no schema on first boot,
  // so every query 500s.  `rel/overlays/bin/server` evals `Release.migrate()`
  // before starting, and config/prod.exs sets `server: true` so the released
  // endpoint listens.  When an audit capability supplies explicit `updated_at`,
  // the Ecto schema drops the bundled `timestamps()` macro (it would collide),
  // so the migration must too.
  emitMigrations(appName, args.migrations ?? [], appModule, out);
  out.set("Dockerfile", renderDockerfile(appName));
  out.set(".dockerignore", renderDockerignore());
  out.set("certs/.gitkeep", "");
  out.set("rel/env.sh.eex", renderRelEnv(appName));
  out.set("rel/overlays/bin/server", renderRelServer(appName));
  out.set(`lib/${appName}/release.ex`, renderRelease(appName, appModule));

  return out;
}
