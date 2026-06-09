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

import type { ApiRoute } from "../api-emit.js";
import type { GenerateElixirArgs } from "../index.js";
import { toModulePrefix, toSnakeApp } from "../shell-emit.js";
import { emitVanillaApiControllers } from "./api-emit.js";
import { emitVanillaChangesets } from "./changeset-emit.js";
import { emitVanillaContextModule } from "./context-emit.js";
import { renderVanillaProblemDetailsModule } from "./problem-details-emit.js";
import { emitVanillaRepositories } from "./repository-emit.js";
import { emitVanillaSchemas } from "./schema-emit.js";
import { emitVanillaShellFiles } from "./shell-emit.js";
import {
  emitVanillaViewModules,
  emitVanillaViewsController,
  type VanillaViewRef,
} from "./view-emit.js";

export function generateVanillaElixirProject(args: GenerateElixirArgs): Map<string, string> {
  const { contexts, deployable } = args;
  const out = new Map<string, string>();
  const appName = toSnakeApp(deployable.name);
  const appModule = toModulePrefix(appName);

  // Shared cross-controller helper modules (Slice 4).  Emitted once
  // per project; controllers `alias` the public functions.
  out.set(`lib/${appName}_web/problem_details.ex`, renderVanillaProblemDetailsModule(appModule));

  // Per-context emit: schema, changeset, repository, context module,
  // controllers.  Changeset before Repository so the latter can alias it.
  const apiRoutes: ApiRoute[] = [];
  const allViews: VanillaViewRef[] = [];
  for (const ctx of contexts) {
    emitVanillaSchemas(appModule, ctx, out);
    emitVanillaChangesets(appModule, ctx, out);
    emitVanillaRepositories(appModule, ctx, out);
    emitVanillaContextModule(appModule, ctx, out);
    const { routes } = emitVanillaApiControllers(appName, appModule, ctx, out);
    apiRoutes.push(...routes);
    // Views — per-context Ecto query modules; controller + routes collected
    // project-wide (one `ViewsController` for all views, matching the ash path).
    emitVanillaViewModules(appName, appModule, ctx, out);
    for (const view of ctx.views) allViews.push({ ctx, view });
  }
  apiRoutes.push(...emitVanillaViewsController(appName, appModule, allViews, out));

  // Shell files — emitted AFTER per-context emit so the router has the
  // collected `apiRoutes` to splice into the `/api` scope.
  emitVanillaShellFiles(appName, appModule, out, apiRoutes);

  return out;
}
