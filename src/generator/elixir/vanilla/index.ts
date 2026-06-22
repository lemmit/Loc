// ---------------------------------------------------------------------------
// Vanilla Elixir orchestrator — `foundation: vanilla` emit subtree.
//
// Plain Phoenix + Ecto (no Ash.Resource, no AshPhoenix.Form, no
// AshPostgres).  Sibling of the Ash path under `../`; called from
// `../index.ts` when `deployable.foundation === "vanilla"`.
//
// Per docs/plans/vanilla-foundation-tdd-plan.md — built in TDD slices.
//   Slice 0: shell.
//   Slice 1: per-aggregate schema + repository + context module + read
//     controllers + spliced router routes.
//   Slice 2 (current scope): + changeset module + create/update/destroy
//     controller actions + write-path routes.
//   Later slices: policies, ProblemDetails parity, workflows + views, CI.
// ---------------------------------------------------------------------------

import {
  buildPhoenixResourceModules,
  emitPhoenixResourceFiles,
} from "../adapters/resource-clients.js";
import type { ApiRoute } from "../api-emit.js";
import { actorIdKey, emitAuth } from "../auth-emit.js";
import { emitDispatch, emitWorkflowStateSchemas } from "../dispatch-emit.js";
import { emitDomainServices } from "../domain-service-emit.js";
import type { GenerateElixirArgs } from "../index.js";
import { emitMigrations } from "../migrations-emit.js";
import { renderRelEnv, renderRelease, renderRelServer } from "../shell/config.js";
import { renderDockerfile, renderDockerignore } from "../shell/project.js";
import { toModulePrefix, toSnakeApp } from "../shell-emit.js";
import { emitAggregateTests, emitTestHelper } from "../tests-emit.js";
import { emitVanillaApiControllers } from "./api-emit.js";
import { emitVanillaAudit } from "./audit-emit.js";
import { emitVanillaChangesets } from "./changeset-emit.js";
import { emitVanillaContextModule } from "./context-emit.js";
import { emitVanillaEventModules } from "./events-emit.js";
import { emitVanillaEventSourcedFiles } from "./eventsourced-emit.js";
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
import { emitVanillaWorkflowExecution } from "./workflow-execution-emit.js";
import { emitVanillaWorkflowInstances } from "./workflow-instances-emit.js";

export function generateVanillaElixirProject(args: GenerateElixirArgs): Map<string, string> {
  const { contexts, deployable, sys } = args;
  const out = new Map<string, string>();
  const appName = toSnakeApp(deployable.name);
  const appModule = toModulePrefix(appName);

  // Shared cross-controller helper modules (Slice 4).  Emitted once
  // per project; controllers `alias` the public functions.
  out.set(`lib/${appName}_web/problem_details.ex`, renderVanillaProblemDetailsModule(appModule));

  // Resource-adapter helper modules — `lib/<app>/resources/<source_type>.ex`.
  // Foundation-agnostic (just plain Elixir helper fns); reused from the
  // shared Phoenix adapter set.  Workflows' `resource-call` lowering
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
  // The principal id field name a `currentUser` lifecycle stamp resolves to
  // (`current_user.<idKey>`), defaulting to `id` when no `user {}` block — same
  // derivation the Ash path threads into `renderStampChanges`.
  const principalIdKey = actorIdKey(sys.user);
  let hasDomainTests = false;
  for (const ctx of contexts) {
    emitVanillaSchemas(appModule, ctx, out, sys);
    // Value-object collection (`charges: Money[]`) child schemas — one Ecto
    // schema per VO-array field, owning the id-less `<owner>_<field>` child
    // table the parent `has_many`s + `cast_assoc`s.
    emitVanillaValueCollectionSchemas(appModule, ctx, out);
    // Validating value-object constructors (`<VO>.new/1`) for VOs with
    // invariants — enforced at construction (F5) + called by the test suite.
    emitVanillaValueObjects(appModule, ctx, out);
    emitVanillaChangesets(appModule, ctx, out, sys);
    emitVanillaRepositories(appModule, ctx, out, sys, principalIdKey);
    // Event-sourced aggregates (persistedAs(eventLog)) — struct + event-log
    // Ecto schema + fold + event-store repository (D-VANILLA-ES-HOME).  The
    // state emitters above skip them; the context module + controllers branch.
    emitVanillaEventSourcedFiles(appModule, ctx, out);
    emitVanillaContextModule(appModule, ctx, out);
    // Domain services — stateless pure-calculator modules under
    // `<App>.Domain.Services.*` (domain-services.md).  Identical to the Ash
    // path: a domain service touches no persistence, so the module is
    // byte-identical across foundations (the shared `../domain-service-emit`).
    emitDomainServices(appName, appModule, ctx, out);
    // Event struct modules — `lib/<app>/<ctx>/events/<event>.ex`.  The
    // workflow-execution `emit` lowering builds `%Context.Events.<Name>{...}`
    // structs against these (PubSub broadcast), and a future channel-on-
    // vanilla slice reuses the same module path.
    emitVanillaEventModules(appModule, ctx, out);
    const { routes } = emitVanillaApiControllers(appName, appModule, ctx, out, sys);
    apiRoutes.push(...routes);
    // Views — per-context Ecto query modules; controller + routes collected
    // project-wide (one `ViewsController` for all views, matching the ash path).
    emitVanillaViewModules(appName, appModule, ctx, out);
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
    apiRoutes.push(
      ...emitVanillaWorkflowExecution(appName, appModule, ctx, out, resourceModules).routes,
    );
    // Channels-on-vanilla — the in-process Dispatcher fans the workflow's
    // `emit` (which lowers to `Phoenix.PubSub.broadcast`) into per-context
    // channel handler modules.  The dispatcher code is foundation-agnostic
    // (plain Elixir + `${App}.Repo` + `Phoenix.PubSub` + the vanilla context
    // facade fns the handler bodies call into).  Saga state schemas are
    // emitted unconditionally for every correlation-bearing workflow so
    // `WorkflowInstancesController` (the deferred-Phoenix gap closer) has
    // the table to read from even on a command-only saga.
    emitWorkflowStateSchemas(appName, ctx, appModule, out);
    // Event-sourced workflows (workflow-and-applier.md A2-S5b): the per-workflow
    // fold struct + `<wf>_events` Ecto schema + fold + stream IO modules (the
    // saga analogue of the ES aggregate files above).  The dispatcher branches
    // their handlers to fold-on-load + append-own-events.
    emitVanillaEsWorkflowFiles(appName, appModule, ctx, out);
    emitDispatch(appName, ctx, appModule, out, sys, "vanilla");
    // Domain `test "..."` blocks → ExUnit (pure-subset; see tests-emit.ts).
    if (emitAggregateTests(ctx, appModule, "vanilla", out)) hasDomainTests = true;
  }
  if (hasDomainTests) emitTestHelper(out);
  apiRoutes.push(...emitVanillaViewsController(appName, appModule, allViews, out));

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

  // Auth modules — the foundation-agnostic Auth plug (Bearer-JWT → `conn.assigns
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
    // Skip the LiveView `on_mount` hook — it imports `Phoenix.Component` /
    // `Phoenix.LiveView`, which the vanilla foundation has no dep for (it's a
    // JSON API with no live_session).  Dead code here, and it would break
    // `mix compile --warnings-as-errors`.
    if (path.endsWith("/live_auth.ex")) continue;
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
  );

  // Deployment + boot machinery — reused verbatim from the Ash shell because
  // the Elixir release, Dockerfile, and Ecto migrations are foundation-neutral
  // (plain Ecto runs the same generated migrations).  Without these the
  // vanilla project isn't container/k8s-deployable: no image to build, and the
  // per-backend database has no schema on first boot, so every query 500s.
  // `rel/overlays/bin/server` evals `Release.migrate()` before starting, and
  // config/prod.exs sets `server: true` so the released endpoint listens.
  // The `vanilla` foundation tag tunes only the bundled `timestamps()` macro:
  // when an audit capability supplies explicit `updated_at`, the vanilla Ecto
  // schema drops `timestamps()` (it would collide), so the migration must too.
  emitMigrations(appName, args.migrations ?? [], appModule, out, "vanilla");
  out.set("Dockerfile", renderDockerfile(appName));
  out.set(".dockerignore", renderDockerignore());
  out.set("certs/.gitkeep", "");
  out.set("rel/env.sh.eex", renderRelEnv(appName));
  out.set("rel/overlays/bin/server", renderRelServer(appName));
  out.set(`lib/${appName}/release.ex`, renderRelease(appName, appModule));

  return out;
}
