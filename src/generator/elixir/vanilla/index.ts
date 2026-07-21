// ---------------------------------------------------------------------------
// Elixir orchestrator — the elixir emit subtree.
//
// Plain Phoenix + Ecto.  Called from `../index.ts`.
//
// Per docs/old/plans/vanilla-foundation-tdd-plan.md — built in TDD slices.
//   Slice 0: shell.
//   Slice 1: per-aggregate schema + repository + context module + read
//     controllers + spliced router routes.
//   Slice 2 (current scope): + changeset module + create/update/destroy
//     controller actions + write-path routes.
//   Later slices: policies, ProblemDetails parity, workflows + views, CI.
// ---------------------------------------------------------------------------

import { deriveEventSubscriptions } from "../../../ir/enrich/enrichments.js";
import type { ChannelIR } from "../../../ir/types/loom-ir.js";
import {
  aggregatesHaveUniqueKeys,
  aggregatesNeedConcurrency,
} from "../../../ir/util/aggregate-flags.js";
import { durableEventTypes } from "../../../ir/util/channels.js";
import type { PageNameCtx } from "../../../ir/util/page-kind.js";
import { resolveContextSchema } from "../../../ir/util/resolve-datasource.js";
import { resolveErrorStatus } from "../../../util/error-defaults.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { brokerChannelBindings } from "../../_channels/bindings.js";
import { embedSpaInto } from "../../_frontend/embedded-spa.js";
import { generateReactForContexts } from "../../react/index.js";
import { generateSvelteForContexts } from "../../svelte/index.js";
import { generateVueForContexts } from "../../vue/index.js";
import {
  buildPhoenixResourceModules,
  emitPhoenixResourceFiles,
} from "../adapters/resource-clients.js";
import type { ApiRoute } from "../api-emit.js";
import { toModulePrefix, toSnakeApp } from "../app-naming.js";
import { actorIdKey, emitAuth } from "../auth-emit.js";
import {
  type ElixirChannelsCfg,
  type ElixirConsumerRoute,
  emitElixirChannelFiles,
} from "../channels-emit.js";
import { emitDispatch, emitWorkflowStateSchemas } from "../dispatch-emit.js";
import { emitDomainServices } from "../domain-service-emit.js";
import { renderEventModule } from "../events-emit.js";
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
import { emitExplicitHandlers, emitExplicitRoutesController } from "./explicit-handlers-emit.js";
import { emitVanillaExternModules } from "./extern-emit.js";
import { emitOpenApiSpec } from "./openapi-emit.js";
import { renderVanillaProblemDetailsModule } from "./problem-details-emit.js";
import {
  emitVanillaProjectionSchemas,
  emitVanillaProjectionsController,
  type VanillaProjectionRef,
} from "./projections-emit.js";
import { emitVanillaProvenance } from "./provenance-emit.js";
import {
  emitVanillaQueryProjectionModules,
  emitVanillaQueryProjectionsController,
  type VanillaQueryProjectionRef,
} from "./query-projections-emit.js";
import { emitVanillaRepositories } from "./repository-emit.js";
import { emitVanillaRetrievals } from "./retrieval-emit.js";
import { emitVanillaScheduler } from "./scheduler-emit.js";
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
  const hasUniqueKeys = contexts.some((c) => aggregatesHaveUniqueKeys(c.aggregates));
  // The optimistic-concurrency 409 branch (`conflict_response/1`) is emitted when
  // some in-scope aggregate carries the `versioned` capability OR is
  // event-sourced: the `versioned` write rescues `Ecto.StaleEntryError` and the
  // event-log append rescues a `(stream_id, version)` unique_violation, both to
  // `{:error, :conflict}` → this responder.  A project with neither stays
  // byte-identical (strict additivity).
  const hasConcurrency = contexts.some((c) => aggregatesNeedConcurrency(c.aggregates));
  // App-wide resolved structural-conflict statuses (M-T3.4a) — the same map on
  // every context (folded across every api by `enrichLoomModel`, each defaulting
  // to 409).  Baked into the ProblemDetails responders so their runtime status
  // moves in lockstep with the OpenAPI declaration; a `httpStatus <Conflict>
  // <Code>` override retargets both.  Absent (single-context / no-api lowering)
  // ⇒ `resolveErrorStatus` falls back to the 409 default ⇒ byte-identical.
  const structuralStatuses = contexts.find(
    (c) => c.structuralErrorStatuses,
  )?.structuralErrorStatuses;
  const uniquenessStatus = resolveErrorStatus("UniquenessConflict", structuralStatuses);
  const concurrencyStatus = resolveErrorStatus("ConcurrencyConflict", structuralStatuses);
  out.set(
    `lib/${appName}_web/problem_details.ex`,
    renderVanillaProblemDetailsModule(
      appModule,
      hasUniqueKeys,
      hasConcurrency,
      uniquenessStatus,
      concurrencyStatus,
    ),
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

  // Broker bindings (channels.md; M-T4.4 slices 6c + 7d): the broker-bound
  // channelSources this deployable wires via `channels:` — redis broadcast
  // and rabbitmq queue/work.  A wired-but-foreign channel joins the
  // per-context dispatcher derivation as a stub with its REAL semantics
  // knobs (the Hono/Python/.NET/Java pattern); every broker-carried event
  // routes through the `<App>.Channels` tee at the emit seams.
  const channelBindings = sys ? brokerChannelBindings(deployable, sys) : [];
  const hasChannels = channelBindings.length > 0;
  // Durable-producer split (design §5): HOSTED durable events carried by a
  // wired `queue`/`work` (or future `log`) channel ride the outbox relay,
  // never the inline tee.  Hosted-only on purpose: the module-level
  // migrations back the `__loom_outbox` table and can't see a foreign
  // wiring; a foreign `queue`/`work` consumer relies on broker ack
  // semantics + idempotent reactors (the slice-3 stance).
  const hostedDurable = new Set(contexts.flatMap((c) => [...durableEventTypes(c)]));
  const durableBrokerEvents = new Set(
    channelBindings
      .filter((b) => b.retention === "work" || b.retention === "log")
      .flatMap((b) => b.events)
      .filter((ev) => hostedDurable.has(ev)),
  );
  const hostedChannelNames = new Set(
    contexts.flatMap((c) => c.channels ?? []).map((ch) => ch.name),
  );
  const wiredForeignChannels: ChannelIR[] = channelBindings
    .filter((b) => !hostedChannelNames.has(b.channelName))
    .map((b) => ({
      name: b.channelName,
      carries: b.events,
      delivery: b.delivery,
      retention: b.retention,
    }));
  // Every broker-carried event's OWNING context module — dispatcher/handler
  // pattern-matches qualify structs with the owner (same value as the local
  // context for a co-hosted owner, so the map is safe to consult uniformly).
  const eventOwnerModule = new Map<string, string>();
  const carriedEventIrs: {
    ev: (typeof contexts)[number]["events"][number];
    ctxModule: string;
    ctxName: string;
  }[] = [];
  if (sys) {
    const carriedNames = new Set(channelBindings.flatMap((b) => b.events));
    for (const sub of sys.subdomains) {
      for (const c of sub.contexts) {
        for (const ev of c.events) {
          if (carriedNames.has(ev.name) && !eventOwnerModule.has(ev.name)) {
            eventOwnerModule.set(ev.name, `${appModule}.${upperFirst(c.name)}`);
            carriedEventIrs.push({
              ev,
              ctxModule: `${appModule}.${upperFirst(c.name)}`,
              ctxName: c.name,
            });
          }
        }
      }
    }
  }
  const channelsCfg: ElixirChannelsCfg | undefined = hasChannels
    ? {
        appModule,
        brokerEvents: new Set(channelBindings.flatMap((b) => b.events)),
        foreignEventModules: eventOwnerModule,
      }
    : undefined;

  // Per-context emit: schema, changeset, repository, context module,
  // controllers.  Changeset before Repository so the latter can alias it.
  const apiRoutes: ApiRoute[] = [];
  const allViews: VanillaViewRef[] = [];
  const allProjections: VanillaProjectionRef[] = [];
  const allQueryProjections: VanillaQueryProjectionRef[] = [];
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
    // The shared `<ctx>_events` log lives in the context's Postgres schema
    // (matching the migration `prefix:`), so the `<Agg>EventLog` `@schema_prefix`
    // and the DDL agree at runtime (mirrors the ES-workflow log below).
    emitVanillaEventSourcedFiles(
      appModule,
      ctx,
      out,
      sys ? resolveContextSchema(ctx, sys) : undefined,
      channelsCfg,
      wiredForeignChannels,
    );
    emitVanillaContextModule(
      appModule,
      ctx,
      out,
      sys,
      sourcemap,
      channelsCfg,
      wiredForeignChannels,
    );
    // Extern seam — a generated behaviour + scaffold-once user-owned impl module
    // per aggregate with an `extern` op (proposal §3a).  The context above
    // delegates each extern op to `<Agg>ExternImpl`.  No-op when no extern ops.
    emitVanillaExternModules(appModule, ctx, out);
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
    emitVanillaViewModules(appName, appModule, ctx, out, sys, sourcemap);
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
    // Explicit application layer (unfoldable-api-derivation.md A2) — one
    // `<App>.<Ctx>.Handlers.<Name>` module per `commandHandler`/`queryHandler`.
    // The transport bindings (`route ... -> <Ctx>.<Handler>`) ride on the served
    // `Api` and are emitted once after the loop (`emitExplicitRoutesController`).
    emitExplicitHandlers(appModule, ctx, out, resourceModules);
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
    // Projection read models (projection.md): the `<Proj>Row` Ecto schema per
    // projection (collected here for the project-wide controller); the fold
    // handlers + dispatcher wiring are emitted by `emitDispatch` below.
    allProjections.push(...emitVanillaProjectionSchemas(appName, appModule, ctx, out, sys));
    // Query-time projections (read-path-architecture.md rev.13): a live read
    // (source find + join bulk-loads + select) — no folded read-model table, so
    // its own `run/1` module here and a `QueryProjectionsController` after the
    // loop (sibling of the folded ProjectionsController).
    allQueryProjections.push(
      ...emitVanillaQueryProjectionModules(appName, appModule, ctx, out, sourcemap),
    );
    emitDispatch(
      appName,
      ctx,
      appModule,
      out,
      sys,
      "vanilla",
      sourcemap,
      channelsCfg,
      wiredForeignChannels,
    );
    // Domain `test "..."` blocks → ExUnit (pure-subset; see tests-emit.ts).
    if (emitAggregateTests(ctx, appModule, "vanilla", out)) hasDomainTests = true;
  }
  if (hasDomainTests) emitTestHelper(out);
  apiRoutes.push(...emitVanillaViewsController(appName, appModule, allViews, out));
  // One deployable-level ProjectionsController over every hosted context's
  // projections (the per-context schema emit above intentionally does NOT write
  // the controller — sibling of ViewsController).
  apiRoutes.push(...emitVanillaProjectionsController(appName, appModule, allProjections, out));
  // One deployable-level QueryProjectionsController over every hosted context's
  // query-time projections (sibling of the folded ProjectionsController; the
  // per-context module emit above intentionally does NOT write the controller).
  apiRoutes.push(
    ...emitVanillaQueryProjectionsController(appName, appModule, allQueryProjections, out),
  );
  // One deployable-level WorkflowsController over every hosted context's command
  // workflows (the per-context emit above intentionally does NOT write it).
  emitVanillaWorkflowsController(appName, appModule, workflowGroups, out);
  // One `<Api>RoutesController` per served api that declares explicit `route`
  // bindings — resolves each `route ... -> <Ctx>.<Handler>` against the hosted
  // contexts' handler modules and splices its POST/GET/... routes into `/api`.
  for (const apiName of deployable.serves ?? []) {
    const api = sys.apis.find((a) => a.name === apiName);
    if (!api || api.routes.length === 0) continue;
    apiRoutes.push(
      ...emitExplicitRoutesController(appName, appModule, apiName, api.routes, contexts, out),
    );
  }

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
  // --- Embedded SPA (fullstack Phoenix) --------------------------------------
  // A `hosts:` React/Vue/Svelte ui means the Phoenix deployable is a JSON-API
  // backend that ALSO serves a client-side SPA.  Emit that SPA under `assets/`
  // — Phoenix's conventional JS home — served at `/app` (so its client-side
  // routes deep-link) by the endpoint `Plug.Static` + router fallback below,
  // and packaged by the multi-stage Dockerfile's `spa-build` stage (which
  // copies the built bundle into `priv/static/app`).  Mirrors the .NET/Java/
  // Python fullstack embed (`generate<Fw>ForContexts` → `embedSpaInto`), with
  // Phoenix's `assets/` prefix + `/app` sub-path instead of `ClientApp/`+root.
  // The SPA hits `/api/*` on its own origin (`apiBaseUrl: "/api"`) — the
  // Phoenix routes already live under `scope "/api"`, so no route-prefix
  // rework is needed (unlike .NET).
  const spaOutDir = deployable.uiFramework === "svelte" ? "build" : "dist";
  if (embedReact && deployable.uiName) {
    const embedOpts = { apiBaseUrl: "/api", pathPrefix: "assets/", basePath: "/app" };
    const uiFw = deployable.uiFramework;
    const spaFiles =
      uiFw === "svelte"
        ? generateSvelteForContexts(contexts, sys, deployable, embedOpts)
        : uiFw === "vue"
          ? generateVueForContexts(contexts, sys, deployable, embedOpts)
          : generateReactForContexts(contexts, sys, deployable, embedOpts);
    // Drop the SPA pack's host-owned root files (Dockerfile / .dockerignore /
    // certs / e2e — Phoenix ships its own at the project root) and emit
    // `assets/.gitignore`; shared with the .NET/Java/Python embed hosts.
    embedSpaInto(out, spaFiles, uiFw, "assets/");
  }
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

  // timerSource scheduling (scheduling.md, M-T4.1) — one GenServer per owned
  // timer under `lib/<app>/scheduler/<timer>.ex`, added to the supervision tree.
  // A `cron:` timer rides a `crontab` hex dep; an `every:`-only (or timer-free)
  // deployable stays byte-identical (no module, no dep, no supervision child).
  const { schedulerChildren, usesCron, usesOban } = emitVanillaScheduler(
    appName,
    appModule,
    contexts,
    deployable,
    sys,
    out,
    channelsCfg,
    wiredForeignChannels,
  );
  // Broker transport files (M-T4.4 slice 6c) — channel-less projects stay
  // byte-identical.  Foreign vocabulary first: a consumed event owned by a
  // non-hosted context emits its struct module under the OWNER's namespace,
  // so dispatcher/handler pattern-matches and the consumer's decode agree.
  let channelChildren: string[] = [];
  if (hasChannels && sys) {
    const hostedCtxNames = new Set(contexts.map((c) => c.name));
    const typesModule = `${appModule}.Types`;
    for (const { ev, ctxModule, ctxName } of carriedEventIrs) {
      if (hostedCtxNames.has(ctxName)) continue;
      out.set(
        `lib/${appName}/${snake(ctxName)}/events/${snake(ev.name)}.ex`,
        renderEventModule(ev, ctxModule, typesModule),
      );
    }
    // Consumer routes: each hosted context whose (widened) subscriptions
    // consume a broker-carried event gets its dispatcher invoked on delivery.
    const brokerEventNames = new Set(channelBindings.flatMap((b) => b.events));
    const routeMap = new Map<string, ElixirConsumerRoute>();
    for (const ctx of contexts) {
      const subs = deriveEventSubscriptions(
        [...(ctx.channels ?? []), ...wiredForeignChannels],
        ctx.workflows,
        ctx.projections ?? [],
      );
      for (const sub of subs) {
        if (!brokerEventNames.has(sub.event)) continue;
        const route = routeMap.get(sub.event) ?? {
          event: sub.event,
          eventCtxModule: eventOwnerModule.get(sub.event) ?? `${appModule}.${upperFirst(ctx.name)}`,
          dispatchers: [],
        };
        const dispatcher = `${appModule}.${upperFirst(ctx.name)}.Dispatcher`;
        if (!route.dispatchers.includes(dispatcher)) route.dispatchers.push(dispatcher);
        routeMap.set(sub.event, route);
      }
    }
    const emission = emitElixirChannelFiles(
      appName,
      appModule,
      channelBindings,
      carriedEventIrs,
      [...routeMap.values()],
      { durableBroker: durableBrokerEvents.size > 0 },
    );
    for (const [path, content] of emission.files) out.set(path, content);
    channelChildren = emission.children;
  }

  // A `cron:` timer rides `crontab` (next-boundary computation) + `oban` (the
  // durable single-fire/retry job store); an `every:`-only timer needs neither.
  const hexDeps = usesCron
    ? { ...resourceEmission.hexDeps, crontab: '"~> 1.1"', oban: '"~> 2.19"' }
    : resourceEmission.hexDeps;
  // Channel drivers, wiring-gated so a channel-less mix.exs stays
  // byte-identical: Redix (MIT — design §6a) for redis pub/sub; the hex
  // `amqp` client (MIT, wrapping the official RabbitMQ Erlang client) for
  // rabbitmq — same `~> 4.0` line the queue resource adapter pins, so a
  // project wiring both never carries two conflicting requirements.
  if (channelBindings.some((b) => b.transport === "redis")) {
    (hexDeps as Record<string, string>).redix = '"~> 1.5"';
  }
  if (channelBindings.some((b) => b.transport === "rabbitmq")) {
    (hexDeps as Record<string, string>).amqp = '"~> 4.0"';
  }
  if (channelBindings.some((b) => b.transport === "kafka")) {
    // brod (Apache 2.0 — Klarna's Erlang kafka client, the plain-driver
    // choice matching Redix/amqp).
    (hexDeps as Record<string, string>).brod = '"~> 4.4"';
  }

  // JWKS strategy (OIDC only): the joken_jwks GenServer that fetches, caches,
  // and periodically refreshes the issuer's signing keys for the Auth.Token
  // verifier — the library analogue of the other backends' JWKS clients.
  //
  // `first_fetch_sync: true` fetches the keys synchronously at start, and the
  // strategy is placed BEFORE the Endpoint in the supervision tree, so
  // `/health` (and every route) comes up only once the signer cache is warm.
  // The other backends fetch the JWKS lazily on the FIRST token verify, so
  // they are always warm by the first request; the joken_jwks poller otherwise
  // warms in the background and a token can arrive within a couple of seconds
  // of the IdP coming up and 401 against a cold cache.  The retry budget
  // (~30s) rides out the IdP's own boot/realm-import; if it is exhausted the
  // strategy starts anyway (never crashes the boot) and the periodic poll
  // heals once the IdP answers.
  const authChildren =
    authEnabled && sys.auth?.oidc
      ? [
          `{${appModule}Web.Auth.JwksStrategy, first_fetch_sync: true, ` +
            `time_interval: 30_000, http_max_retries_per_fetch: 30, http_delay_per_retry: 1_000}`,
        ]
      : [];

  // Shell files — emitted AFTER per-context emit so the router has the
  // collected `apiRoutes` to splice into the `/api` scope.  Resource-adapter
  // hex deps (ex_aws_s3, amqp, req) ride into `mix.exs`.
  emitVanillaShellFiles(
    appName,
    appModule,
    out,
    apiRoutes,
    hexDeps,
    authEnabled,
    !!sys.auth?.oidc,
    liveRoutes,
    hasSidebar,
    // Embedded-SPA host: the endpoint serves `priv/static/app` at `/app`
    // via Plug.Static and the router adds the `/app/*` deep-link fallback
    // + a `/` → `/app` redirect (the SpaController).
    embedReact && !!deployable.uiName,
    [...schedulerChildren, ...channelChildren],
    usesOban,
    authChildren,
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
  out.set(
    "Dockerfile",
    renderDockerfile(
      appName,
      embedReact && !!deployable.uiName,
      spaOutDir,
      channelBindings.some((b) => b.transport === "kafka"),
    ),
  );
  out.set(".dockerignore", renderDockerignore());
  out.set("certs/.gitkeep", "");
  out.set("rel/env.sh.eex", renderRelEnv(appName));
  out.set("rel/overlays/bin/server", renderRelServer(appName));
  out.set(`lib/${appName}/release.ex`, renderRelease(appName, appModule));

  return out;
}
