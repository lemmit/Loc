import type {
  AggregateIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  SystemIR,
} from "../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../ir/types/migrations-ir.js";
import { resolveDataSourceConfig } from "../../ir/util/resolve-datasource.js";
import type { StyleAdapter } from "../_adapters/index.js";
import { generateReactForContexts } from "../react/index.js";
import { emitApiControllers } from "./api-emit.js";
import { emitAuth } from "./auth-emit.js";
import { emitContext } from "./context-emit.js";
import { emitLiveViewPages, type LiveRoute } from "./liveview-emit.js";
import { emitMigrations } from "./migrations-emit.js";
import { emitOpenApiSpec } from "./openapi-emit.js";
import { emitShellFiles, renderSpaController, toModulePrefix, toSnakeApp } from "./shell-emit.js";
import { renderSidebarComponent } from "./sidebar-emit.js";
import { renderThemeCss } from "./theme-emit.js";
import { emitViews } from "./view-emit.js";
import { emitWorkflows } from "./workflow-emit.js";

// ---------------------------------------------------------------------------
// Phoenix LiveView / Ash generator orchestrator.
//
// `generatePhoenixLiveViewProject` is the single entry point called by
// the platform's `emitProject`.  It mirrors dotnet/index.ts's shape:
//
//   - Iterates contexts, aggregates, workflows, views.
//   - Calls per-emitter functions (workflow-emit, view-emit, etc.).
//   - Emits Phoenix/Ash shell files: mix.exs, config/*, lib/<app>/*, etc.
//
// File layout:
//   lib/<app>/<ctx>/<agg>.ex                  — Ash.Resource modules
//   lib/<app>/<ctx>/workflows/<wf>.ex          — workflow modules
//   lib/<app>/<ctx>/views/<view>.ex            — view query modules
//   lib/<app>/<ctx>.ex                         — Ash.Domain per context
//   lib/<app>/repo.ex                          — Ecto.Repo
//   lib/<app>/application.ex                   — supervision tree
//   lib/<app>_web.ex                           — __using__ macro
//   lib/<app>_web/endpoint.ex                  — Phoenix.Endpoint
//   lib/<app>_web/router.ex                    — minimal router scaffold
//   lib/<app>_web/components/layouts.ex        — layout components
//   lib/<app>_web/components/layouts/root.html.heex
//   lib/<app>_web/components/layouts/app.html.heex
//   config/config.exs, dev.exs, prod.exs, runtime.exs
//   priv/repo/migrations/<ts>_create_<table>.exs
//   priv/repo/seeds.exs
//   rel/env.sh.eex, rel/overlays/bin/server
//   mix.exs, .formatter.exs, Dockerfile, .dockerignore
// ---------------------------------------------------------------------------

export interface GeneratePhoenixLiveViewArgs {
  contexts: EnrichedBoundedContextIR[];
  deployable: DeployableIR;
  sys: SystemIR;
  /** Per-deployable slice of `buildMigrations(sys, snapshots)` — only the
   *  modules this deployable owns (via `module.migrationsOwner ===
   *  deployable.name`).  Empty array when this deployable owns no
   *  migrations or the system orchestrator was invoked without a
   *  snapshot store; in either case the emitter is a no-op. */
  migrations?: MigrationsIR[];
  /** Compile-time --trace switch.  When true, the AggregatesController
   *  emits a `wire_in` Logger.debug line at each CRUD action entry so
   *  the parsed `params` key set surfaces on the structured stream —
   *  mirroring Hono Phase 6d / .NET v6 wire_in's intent.  Domain-level
   *  trace events (value_computed / precondition_evaluated /
   *  invariant_evaluated) don't have a clean Phoenix seam (Ash
   *  resources are declarative), so they stay deferred. */
  emitTrace?: boolean;
  /** The deployable's resolved STYLE adapter (D-REALIZATION-AXES
   *  `application:` → the Ash action surface).  The system orchestrator
   *  resolves it from `deployable.application` via `resolveStyle` and
   *  threads it in; `ashStyleAdapter.emitDi` dispatches through it.
   *  Absent in legacy single-context mode → falls back to the sibling
   *  `ashStyleAdapter` (byte-identical: `ash` is the only real style). */
  styleAdapter?: StyleAdapter;
}

export function generatePhoenixLiveViewProject(
  args: GeneratePhoenixLiveViewArgs,
): Map<string, string> {
  const { contexts, deployable, sys, migrations, emitTrace, styleAdapter } = args;
  const out = new Map<string, string>();

  const appName = toSnakeApp(deployable.name);
  const appModule = toModulePrefix(appName);

  // D-PHOENIX-SURFACE phase 6: a Phoenix deployable whose hosted `ui`
  // declares `framework: react` is a JSON-API backend that *embeds* a
  // React SPA (served from `priv/static`), not a LiveView/HEEx app.  In
  // that mode the LiveView pages + HEEx sidebar are not emitted; the
  // React project is generated under `assets/` instead (phase 6a wires
  // the emit; the endpoint/router/Dockerfile serve-wiring is phase 6b).
  // Dormant until an example uses it: no current source pairs
  // `platform: phoenix` with a `framework: react` ui, so output is
  // unchanged.  The Ash domain + `/api` controllers + OpenAPI are
  // emitted in either mode.
  const embedReact = deployable.uiFramework === "react";

  // Per-aggregate dataSource lookup — feeds `postgres do schema "…"
  // end` + `tablePrefix` routing in each Ash.Resource's `postgres`
  // block.  Returns `undefined` for systems without a matching
  // binding, which falls back to the existing default-shape emit.
  const resolveDataSource = (agg: AggregateIR) => {
    const owningCtx = contexts.find((c) => c.aggregates.some((a) => a.name === agg.name));
    return owningCtx
      ? resolveDataSourceConfig(agg as EnrichedAggregateIR, owningCtx, sys)
      : undefined;
  };

  // --- Per-context domain files -------------------------------------------
  for (const ctx of contexts) {
    emitContext(appName, ctx, appModule, out, { resolveDataSource });
  }

  // --- Workflow + view files -----------------------------------------------
  for (const ctx of contexts) {
    emitWorkflows(appName, ctx, appModule, out, sys);
    emitViews(appName, ctx, appModule, out);
  }

  // --- Migrations -----------------------------------------------------------
  // Consumes `migrations: MigrationsIR[]` from the system orchestrator
  // (one entry per module this deployable owns).  When the orchestrator
  // invoked us without a snapshot store, `migrations` is undefined —
  // emit no migration files in that case (the legacy ".loom-less"
  // entry point used by some integration tests).
  emitMigrations(appName, migrations ?? [], appModule, out);

  // --- LiveView pages --------------------------------------------
  // Per PageIR in the deployable's `ui:` block: one
  // lib/<app>_web/live/<page>_live.ex module + a router entry the
  // shell renderer splices into router.ex.  Skipped in embedded-react
  // mode — the SPA owns the UI; no HEEx pages or live routes.
  const { files: liveFiles, routes: liveRoutes } = embedReact
    ? { files: new Map<string, string>(), routes: [] as LiveRoute[] }
    : emitLiveViewPages({
        contexts,
        deployable,
        sys,
        appName,
        appModule,
      });
  for (const [path, content] of liveFiles) out.set(path, content);

  // --- API controllers -------------------------------------------
  // Workflows / Views / Health controllers + their router entries.
  // Workflows / Views are only emitted when `serves:` is populated;
  // Health is always emitted (router references it unconditionally).
  const { files: apiFiles, apiRoutes: baseApiRoutes } = emitApiControllers({
    contexts,
    deployable,
    sys,
    appName,
    appModule,
    emitTrace,
  });
  for (const [path, content] of apiFiles) out.set(path, content);

  // --- OpenAPI spec ----------------------------------------------
  // Emits <Api>Spec module, per-aggregate/workflow/view schema modules,
  // OpenapiController, and a GET /api/openapi.json route entry.
  const { files: openApiFiles, routes: openApiRoutes } = emitOpenApiSpec({
    contexts,
    deployable,
    sys,
    appName,
    appModule,
  });
  for (const [path, content] of openApiFiles) out.set(path, content);
  const apiRoutes = [...baseApiRoutes, ...openApiRoutes];

  // --- Auth modules ----------------------------------------------
  // Emits Auth plug + LiveAuth on_mount when deployable.auth?.required.
  const { files: authFiles, enabled: authEnabled } = emitAuth({
    sys,
    deployable,
    appName,
    appModule,
  });
  for (const [path, content] of authFiles) out.set(path, content);

  // --- Sidebar component -----------------------------------------
  // Emitted when the deployable mounts a `ui:` — derived from
  // MenuBlockIR or per-page menuMeta, identical structure to the
  // React generator's sidebar.  Skipped in embedded-react mode (the
  // HEEx sidebar belongs to the LiveView shell, which the SPA replaces).
  if (deployable.uiName && !embedReact) {
    const ui = sys.uis.find((u) => u.name === deployable.uiName);
    if (ui) {
      out.set(
        `lib/${appName}_web/components/sidebar.ex`,
        renderSidebarComponent({ ui, appName, appModule }),
      );
    }
  }

  // --- Embedded React SPA (D-PHOENIX-SURFACE phase 6a) ------------
  // When the hosted ui is `framework: react`, generate the React
  // project under `assets/` (its own Vite build), calling the same
  // `/api` surface this backend serves.  Mirrors the .NET fullstack
  // embed (`dotnet/index.ts`): same React generator, same
  // `apiBaseUrl: "/api"`, same skip of duplicate shell files the
  // Phoenix project owns.  The endpoint/router/Dockerfile wiring that
  // *serves* the built bundle from `priv/static` is phase 6b.
  if (embedReact) {
    const spaFiles = generateReactForContexts(contexts, sys, deployable, {
      apiBaseUrl: "/api",
      pathPrefix: "assets/",
    });
    for (const [path, content] of spaFiles) {
      // Skip the standalone-react shell files the Phoenix project owns
      // (Dockerfile / .dockerignore / certs) or that don't apply in
      // embedded mode (the e2e harness).  Mirrors the dotnet filter.
      if (
        path === "assets/Dockerfile" ||
        path === "assets/.dockerignore" ||
        path === "assets/certs/.gitkeep" ||
        path.startsWith("assets/e2e/")
      )
        continue;
      out.set(path, content);
    }
    out.set("assets/.gitignore", "node_modules\ndist\n");

    // SpaController — serves the built SPA's index.html for any client-side
    // `/app/*` deep link (the router catch-all, phase 6b).  Reads the file
    // the Dockerfile dropped at `priv/static/app/index.html`.
    out.set(
      `lib/${appName}_web/controllers/spa_controller.ex`,
      renderSpaController(appName, appModule),
    );
  }

  // --- Theme CSS -------------------------------------------------
  // System-level `theme { primary: ..., neutral: ..., radius: ... }`
  // tokens lower to CSS custom properties consumable from any
  // generated layout.  Always emit (empty theme produces a stub).
  out.set(`priv/static/assets/theme.css`, renderThemeCss(sys.theme));

  // --- Shell files ----------------------------------------------------------
  emitShellFiles(
    appName,
    appModule,
    deployable,
    sys,
    contexts,
    liveRoutes,
    apiRoutes,
    authEnabled,
    emitTrace,
    out,
    migrations ?? [],
    styleAdapter,
  );

  return out;
}
