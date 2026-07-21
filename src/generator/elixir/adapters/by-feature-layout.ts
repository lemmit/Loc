// ---------------------------------------------------------------------------
// byFeature — the real LayoutAdapter for the phoenixLiveView platform.
// Captures the path conventions the existing Phoenix orchestrator
// (`src/generator/elixir/index.ts` + sibling `*-emit.ts`)
// spells out inline at every `out.set(...)` call site.  Today the
// orchestrator hard-codes these paths; this adapter exposes them as a
// single pure `pathFor()` so the eventual rewire (F7d) can drop the
// inline strings and dispatch through the adapter.
//
// Phoenix's stock layout groups files by FEATURE (per-context
// subfolders for domain modules; per-page Live modules under
// `lib/<app>_web/live/`).  Called `byFeature` to mirror the dotnet
// `byFeature` adapter slot name even though Phoenix doesn't ship a
// `byLayer` alternative today — the categorisation IS the layout.
//
// All paths are deployable-relative.  The system orchestrator splices
// the deployable's slug (e.g. `phoenix_app/`) when composing the final
// system-wide tree.
// ---------------------------------------------------------------------------

import type { EmitCtx, EmittedArtifact, LayoutAdapter } from "../../_adapters/index.js";
import { toModulePrefix, toSnakeApp } from "../app-naming.js";

/** Categories every phoenix artifact carries.  Adding a new file kind
 *  = add a new arm here + the matching string at the emit site. */
export type PhoenixArtifactCategory =
  // lib/<app>/ — app-level modules
  | "application" // lib/<app>/application.ex
  | "repo" // lib/<app>/repo.ex (Ecto.Repo — persistence adapter owns content; layout owns path)
  | "telemetry" // lib/<app>/telemetry.ex
  | "log-formatter" // lib/<app>/log_formatter.ex
  | "jason-camel-case" // lib/<app>/jason_camel_case.ex
  // lib/<app>/<context_snake>/ — per-context bounded-context module
  | "domain-module" // lib/<app>/<ctx>.ex (plain context module)
  | "ash-resource" // lib/<app>/<ctx>/<agg>.ex (root + part Ecto schema)
  | "event-module" // lib/<app>/<ctx>/events/<event>.ex
  | "value-object-module" // lib/<app>/<ctx>/<vo>.ex
  | "enum-module" // lib/<app>/<ctx>/<enum>.ex
  | "workflow-module" // lib/<app>/<ctx>/workflows/<workflow>.ex
  // lib/<app>_web/ — web shell
  | "web-shell" // lib/<app>_web.ex
  | "endpoint" // lib/<app>_web/endpoint.ex
  | "router" // lib/<app>_web/router.ex
  | "problem-details" // lib/<app>_web/problem_details.ex
  // lib/<app>_web/components/ — UI components
  | "core-components" // components/core_components.ex
  | "sidebar-component" // components/sidebar.ex
  | "layouts-module" // components/layouts.ex
  | "layout-app-heex" // components/layouts/app.html.heex
  | "layout-root-heex" // components/layouts/root.html.heex
  // lib/<app>_web/live/ — LiveView pages
  | "live-page" // lib/<app>_web/live/<page>_live.ex
  // lib/<app>_web/controllers/ — HTTP controllers + error responders
  | "controller" // lib/<app>_web/controllers/<name>_controller.ex
  | "error-html" // controllers/error_html.ex
  | "error-json" // controllers/error_json.ex
  | "health-controller" // controllers/health_controller.ex
  | "openapi-controller" // controllers/openapi_controller.ex
  // lib/<app>_web/api/ — OpenAPI spec + schema modules
  | "api-spec" // lib/<app>_web/api/<ctx_snake>_api_spec.ex
  | "api-schema" // lib/<app>_web/api/schemas/<schema>.ex
  // config/
  | "config" // config/<name>.exs (config, dev, prod, runtime)
  // priv/
  | "migration" // priv/repo/migrations/<name>.exs
  | "seeds" // priv/repo/seeds.exs
  | "static-asset" // priv/static/assets/<name>
  // rel/
  | "release-env" // rel/env.sh.eex
  | "release-overlay" // rel/overlays/<path>
  // e2e/
  | "e2e-page-object" // e2e/pages/<page>.ts
  // <root>/
  | "mix-exs" // mix.exs
  | "formatter-exs" // .formatter.exs
  | "dockerfile" // Dockerfile
  | "dockerignore" // .dockerignore
  | "certs-marker"; // certs/<name>

/** Extension of the shared EmittedArtifact for phoenix routing. */
export interface PhoenixArtifact extends EmittedArtifact {
  category: PhoenixArtifactCategory;
  /** Snake-case context name for per-context categories
   *  (`storefront`, `orders`, …).  Required for any
   *  `lib/<app>/<context>/` placement. */
  contextSnake?: string;
  /** Snake-case aggregate / part name for per-aggregate categories. */
  aggregateSnake?: string;
}

function appNameOf(ctx: EmitCtx): string {
  return toSnakeApp(ctx.deployable.name);
}

function webPath(app: string, rest: string): string {
  return `lib/${app}_web/${rest}`;
}

function libPath(app: string, rest: string): string {
  return `lib/${app}/${rest}`;
}

function pathForCategory(artifact: PhoenixArtifact, ctx: EmitCtx): string {
  const cat = artifact.category;
  const name = artifact.name;
  const ctxSnake = artifact.contextSnake;
  const aggSnake = artifact.aggregateSnake;
  const app = appNameOf(ctx);
  void toModulePrefix; // re-exported for cross-adapter use; not needed in path routing
  switch (cat) {
    case "application":
      return libPath(app, `application.ex`);
    case "repo":
      return libPath(app, `repo.ex`);
    case "telemetry":
      return libPath(app, `telemetry.ex`);
    case "log-formatter":
      return libPath(app, `log_formatter.ex`);
    case "jason-camel-case":
      return libPath(app, `jason_camel_case.ex`);
    case "domain-module":
      if (!ctxSnake) throw new Error(`byFeature.pathFor: 'domain-module' missing contextSnake`);
      return libPath(app, `${ctxSnake}.ex`);
    case "ash-resource":
      if (!ctxSnake || !aggSnake)
        throw new Error(`byFeature.pathFor: 'ash-resource' missing contextSnake/aggregateSnake`);
      return libPath(app, `${ctxSnake}/${aggSnake}.ex`);
    case "event-module":
      if (!ctxSnake) throw new Error(`byFeature.pathFor: 'event-module' missing contextSnake`);
      return libPath(app, `${ctxSnake}/events/${name}`);
    case "value-object-module":
      if (!ctxSnake)
        throw new Error(`byFeature.pathFor: 'value-object-module' missing contextSnake`);
      return libPath(app, `${ctxSnake}/${name}`);
    case "enum-module":
      if (!ctxSnake) throw new Error(`byFeature.pathFor: 'enum-module' missing contextSnake`);
      return libPath(app, `${ctxSnake}/${name}`);
    case "workflow-module":
      if (!ctxSnake) throw new Error(`byFeature.pathFor: 'workflow-module' missing contextSnake`);
      return libPath(app, `${ctxSnake}/workflows/${name}`);
    case "web-shell":
      return `lib/${app}_web.ex`;
    case "endpoint":
      return webPath(app, `endpoint.ex`);
    case "router":
      return webPath(app, `router.ex`);
    case "problem-details":
      return webPath(app, `problem_details.ex`);
    case "core-components":
      return webPath(app, `components/core_components.ex`);
    case "sidebar-component":
      return webPath(app, `components/sidebar.ex`);
    case "layouts-module":
      return webPath(app, `components/layouts.ex`);
    case "layout-app-heex":
      return webPath(app, `components/layouts/app.html.heex`);
    case "layout-root-heex":
      return webPath(app, `components/layouts/root.html.heex`);
    case "live-page":
      return webPath(app, `live/${name}`);
    case "controller":
      return webPath(app, `controllers/${name}`);
    case "error-html":
      return webPath(app, `controllers/error_html.ex`);
    case "error-json":
      return webPath(app, `controllers/error_json.ex`);
    case "health-controller":
      return webPath(app, `controllers/health_controller.ex`);
    case "openapi-controller":
      return webPath(app, `controllers/openapi_controller.ex`);
    case "api-spec":
      // The orchestrator currently names this `<app_or_context>_api_spec.ex`
      // — caller passes the full bare file name.
      return webPath(app, `api/${name}`);
    case "api-schema":
      return webPath(app, `api/schemas/${name}`);
    case "config":
      return `config/${name}`;
    case "migration":
      return `priv/repo/migrations/${name}`;
    case "seeds":
      return `priv/repo/seeds.exs`;
    case "static-asset":
      return `priv/static/assets/${name}`;
    case "release-env":
      return `rel/env.sh.eex`;
    case "release-overlay":
      // Caller passes the relative path UNDER rel/overlays/ — e.g.
      // `bin/server`.
      return `rel/overlays/${name}`;
    case "e2e-page-object":
      return `e2e/pages/${name}`;
    case "mix-exs":
      return `mix.exs`;
    case "formatter-exs":
      return `.formatter.exs`;
    case "dockerfile":
      return `Dockerfile`;
    case "dockerignore":
      return `.dockerignore`;
    case "certs-marker":
      return `certs/${name}`;
  }
}

export const byFeatureLayoutAdapter: LayoutAdapter = {
  name: "byFeature",

  pathFor(artifact: EmittedArtifact, ctx: EmitCtx): string {
    if (!(artifact as PhoenixArtifact).category) {
      throw new Error(
        `byFeature.pathFor: artifact '${artifact.name}' is missing a category (PhoenixArtifactCategory).  ` +
          `Every phoenix emit site must tag its artifact with the right category before dispatching through the layout adapter.`,
      );
    }
    return pathForCategory(artifact as PhoenixArtifact, ctx);
  },
};
