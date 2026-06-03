import type {
  BoundedContextIR,
  DeployableIR,
  EnrichedBoundedContextIR,
  SystemIR,
} from "../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../ir/types/migrations-ir.js";
import type { EmitCtx, StyleAdapter } from "../_adapters/index.js";
import { ashStyleAdapter } from "./adapters/ash-style.js";
import { emitPhoenixResourceFiles } from "./adapters/resource-clients.js";
import type { ApiRoute } from "./api-emit.js";
import { renderDialyzerIgnoreExs } from "./dialyzer-ignore-emit.js";
import { renderJasonCamelCaseModule } from "./jason-camel-emit.js";
import type { LiveRoute } from "./liveview-emit.js";
import { renderProblemDetailsModule } from "./problem-details-emit.js";
import { contextsHaveSeeds, renderSeedsExs } from "./seeds-emit.js";
import {
  renderConfigExs,
  renderDevExs,
  renderProdExs,
  renderRelEnv,
  renderRelServer,
  renderRuntimeExs,
} from "./shell/config.js";
import {
  renderDockerfile,
  renderDockerignore,
  renderFormatterExs,
  renderMixExs,
} from "./shell/project.js";
import {
  renderApplication,
  renderEndpoint,
  renderLogFormatter,
  renderRepo,
  renderRouter,
} from "./shell/runtime.js";
import {
  renderAppLayout,
  renderCoreComponents,
  renderErrorHtml,
  renderErrorJson,
  renderLayouts,
  renderRootLayout,
  renderWebModule,
} from "./shell/web.js";
import { renderTelemetry } from "./telemetry-emit.js";

// renderSpaController lives with the other web-shell renderers; re-exported
// here so the orchestrator (./index.ts) keeps a single shell entry point.
export { renderSpaController } from "./shell/web.js";

// ---------------------------------------------------------------------------
// Shell files — Phoenix boilerplate.  This module is the orchestrator: it
// owns `emitShellFiles`, which maps every generated path to the output of a
// per-file renderer.  The renderers themselves live in `./shell/` grouped
// by concern — project scaffold (project.ts), OTP/runtime (runtime.ts),
// web shell (web.ts), and config/release (config.ts).
// ---------------------------------------------------------------------------

export function emitShellFiles(
  appName: string,
  appModule: string,
  deployable: DeployableIR,
  sys: SystemIR,
  contexts: BoundedContextIR[],
  liveRoutes: LiveRoute[],
  apiRoutes: ApiRoute[],
  authEnabled: boolean,
  emitTrace: boolean | undefined,
  out: Map<string, string>,
  migrations: MigrationsIR[],
  styleAdapter?: StyleAdapter,
): void {
  const port = deployable.port ?? 4000;
  // D-PHOENIX-SURFACE phase 6b: when the deployable embeds a React SPA
  // (its hosted ui is `framework: react`), the shell files gain the
  // serve-wiring that makes the built bundle reachable — a multi-stage
  // Dockerfile that runs the SPA's Vite build, a `Plug.Static` that
  // serves it from `priv/static`, and a router catch-all serving
  // `index.html` for client-side deep links.  Same flag the orchestrator
  // uses for the emit branch.
  const embedReact = deployable.uiFramework === "react";

  // Resource client modules (objectStore / queue / api) + their Hex
  // deps (Phase 4c).  Empty when the deployable wires no consumable
  // resources — mix.exs stays byte-identical.
  const resourceEmission = emitPhoenixResourceFiles(sys, appName, appModule);
  for (const [path, content] of resourceEmission.files) out.set(path, content);
  out.set(
    "mix.exs",
    renderMixExs(appName, appModule, resourceEmission.hexDeps, contextsHaveSeeds(contexts)),
  );
  out.set(".formatter.exs", renderFormatterExs());
  // .dialyzer_ignore.exs template — paired with the mix.exs `dialyzer:`
  // config block.  Inert until Dialyxir is added as a dep (Tier 4 of
  // the Phoenix ladder in docs/proposals/cross-stack-static-analysis.md);
  // shipping it now future-proofs the project.
  out.set(".dialyzer_ignore.exs", renderDialyzerIgnoreExs(appName));
  out.set("Dockerfile", renderDockerfile(appName, embedReact));
  out.set(".dockerignore", renderDockerignore());
  // certs/ is the CA-bake landing slot — see the COPY in renderDockerfile.
  // .gitkeep keeps the dir present in git so the COPY is a no-op when
  // no proxy CAs are configured.
  out.set("certs/.gitkeep", "");

  // lib/<app>/repo.ex
  out.set(`lib/${appName}/repo.ex`, renderRepo(appName, appModule));

  // lib/<app>/jason_camel_case.ex — shared helper that resource modules'
  // `defimpl Jason.Encoder` delegates to.  Translates an Ash struct's
  // snake_case atom keys into camelCase JSON keys, matching the Hono /
  // .NET wire shape.  Emitted once per project.
  out.set(`lib/${appName}/jason_camel_case.ex`, renderJasonCamelCaseModule(appModule));

  // lib/<app>_web/problem_details.ex — shared RFC 7807 ProblemDetails
  // responders used by both the per-aggregate controllers (Plug.ErrorHandler
  // arm for Ash.Error.Invalid → 422 + errors[] extension) and the
  // workflows controller (extended error_response/2 for Ash.Error.Invalid
  // tuples).  See docs/proposals/validation-error-extension.md (Phase C).
  out.set(`lib/${appName}_web/problem_details.ex`, renderProblemDetailsModule(appModule));

  // lib/<app>/telemetry.ex — :telemetry handlers that translate Phoenix
  // endpoint events into the neutral log-event catalog identity.
  out.set(`lib/${appName}/telemetry.ex`, renderTelemetry({ appName, appModule, emitTrace }));

  // lib/<app>/log_formatter.ex — JSON-per-line Logger formatter that
  // preserves structured metadata (event, request_id, method, path,
  // status, duration_ms, etc.) so the cross-backend log envelope is
  // parseable upstream the same way Hono's pino and .NET's
  // AddJsonConsole emit.
  out.set(`lib/${appName}/log_formatter.ex`, renderLogFormatter(appModule));

  // lib/<app>/application.ex
  out.set(`lib/${appName}/application.ex`, renderApplication(appName, appModule));

  // lib/<app>_web.ex
  out.set(`lib/${appName}_web.ex`, renderWebModule(appName, appModule));

  // lib/<app>_web/endpoint.ex
  out.set(`lib/${appName}_web/endpoint.ex`, renderEndpoint(appName, appModule, embedReact));

  // lib/<app>_web/router.ex
  out.set(
    `lib/${appName}_web/router.ex`,
    renderRouter(appName, appModule, liveRoutes, apiRoutes, authEnabled, embedReact),
  );

  // lib/<app>_web/components/core_components.ex — minimal stub so
  // the html_helpers macro's `import ...CoreComponents` resolves.
  // Standard Phoenix 1.7 generators ship a much richer module; an
  // empty wrapper suffices because generated LiveView pages reference
  // components by full module path, not the imported aliases.
  out.set(`lib/${appName}_web/components/core_components.ex`, renderCoreComponents(appModule));

  // lib/<app>_web/components/layouts.ex
  out.set(`lib/${appName}_web/components/layouts.ex`, renderLayouts(appName, appModule));

  // lib/<app>_web/components/layouts/root.html.heex
  out.set(`lib/${appName}_web/components/layouts/root.html.heex`, renderRootLayout(appName));

  // lib/<app>_web/components/layouts/app.html.heex
  out.set(`lib/${appName}_web/components/layouts/app.html.heex`, renderAppLayout());

  // Error views — the endpoint config wires these as the render_errors
  // formats so a 500 in (say) the openapi controller renders a JSON
  // body instead of crashing the cowboy adapter on a missing
  // ErrorView module.
  out.set(`lib/${appName}_web/controllers/error_json.ex`, renderErrorJson(appModule));
  out.set(`lib/${appName}_web/controllers/error_html.ex`, renderErrorHtml(appModule));

  // Config — `config/config.exs` includes the `config :<app>,
  // ash_domains: [...]` registration block.  Phoenix is always
  // system-mode (the generator entry takes deployable + sys), so we
  // can ALWAYS dispatch through the `ashStyleAdapter.emitDi` here.
  // The shell helper widened its `contexts` parameter to
  // `BoundedContextIR[]` years ago; the caller always passes the
  // enriched flavour, so this `as` keeps the EmitCtx contract honest
  // without touching every shell-helper signature.
  const emitCtx: EmitCtx = {
    deployable,
    contexts: contexts as EnrichedBoundedContextIR[],
    sys,
    migrations,
    emitTrace,
    styleAdapter,
  };
  // Resolved style selection (D-REALIZATION-AXES) when threaded in; the
  // sibling default otherwise.  `ash` is the only real style, so the
  // resolved adapter IS `ashStyleAdapter` → byte-identical.
  const style = emitCtx.styleAdapter ?? ashStyleAdapter;
  out.set(
    "config/config.exs",
    renderConfigExs(appName, appModule, contexts, style.emitDi(emitCtx)),
  );
  out.set("config/dev.exs", renderDevExs(appName, appModule, port));
  out.set("config/prod.exs", renderProdExs(appName, appModule));
  out.set("config/runtime.exs", renderRuntimeExs(appName, appModule));

  // Priv — first-boot seed data (database-seeding.md, Phase 3b).  Through the
  // domain create action (D-SEED-PATH), ship-once per dataset
  // (D-SEED-IDEMPOTENCY); an empty stub when no `seed` block is declared.
  out.set("priv/repo/seeds.exs", renderSeedsExs(appModule, contexts));

  // Release
  out.set("rel/env.sh.eex", renderRelEnv(appName));
  out.set("rel/overlays/bin/server", renderRelServer(appName));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toSnakeApp(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .toLowerCase();
}

export function toModulePrefix(snakeName: string): string {
  return snakeName
    .split("_")
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
}
