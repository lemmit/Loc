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
import { emitDispatch, emitWorkflowStateSchemas } from "../dispatch-emit.js";
import type { GenerateElixirArgs } from "../index.js";
import { toModulePrefix, toSnakeApp } from "../shell-emit.js";
import { emitVanillaApiControllers } from "./api-emit.js";
import { emitVanillaChangesets } from "./changeset-emit.js";
import { emitVanillaContextModule } from "./context-emit.js";
import { emitVanillaEventModules } from "./events-emit.js";
import { emitVanillaEventSourcedFiles } from "./eventsourced-emit.js";
import { renderVanillaProblemDetailsModule } from "./problem-details-emit.js";
import { emitVanillaRepositories } from "./repository-emit.js";
import { emitVanillaRetrievals } from "./retrieval-emit.js";
import { emitVanillaSchemas } from "./schema-emit.js";
import { emitVanillaShellFiles } from "./shell-emit.js";
import {
  emitVanillaViewModules,
  emitVanillaViewsController,
  type VanillaViewRef,
} from "./view-emit.js";
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
  for (const ctx of contexts) {
    emitVanillaSchemas(appModule, ctx, out);
    emitVanillaChangesets(appModule, ctx, out);
    emitVanillaRepositories(appModule, ctx, out);
    // Event-sourced aggregates (persistedAs(eventLog)) — struct + event-log
    // Ecto schema + fold + event-store repository (D-VANILLA-ES-HOME).  The
    // state emitters above skip them; the context module + controllers branch.
    emitVanillaEventSourcedFiles(appModule, ctx, out);
    emitVanillaContextModule(appModule, ctx, out);
    // Event struct modules — `lib/<app>/<ctx>/events/<event>.ex`.  The
    // workflow-execution `emit` lowering builds `%Context.Events.<Name>{...}`
    // structs against these (PubSub broadcast), and a future channel-on-
    // vanilla slice reuses the same module path.
    emitVanillaEventModules(appModule, ctx, out);
    const { routes } = emitVanillaApiControllers(appName, appModule, ctx, out);
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
    emitDispatch(appName, ctx, appModule, out, sys, "vanilla");
  }
  apiRoutes.push(...emitVanillaViewsController(appName, appModule, allViews, out));

  // Shell files — emitted AFTER per-context emit so the router has the
  // collected `apiRoutes` to splice into the `/api` scope.  Resource-adapter
  // hex deps (ex_aws_s3, amqp, req) ride into `mix.exs`.
  emitVanillaShellFiles(appName, appModule, out, apiRoutes, resourceEmission.hexDeps);

  return out;
}
