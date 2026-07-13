import type {
  AggregateIR,
  BoundedContextIR,
  ComponentIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
  SystemIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { contextUsesMoney } from "../../ir/types/loom-ir.js";
import { type PageNameCtx, pageConstructId } from "../../ir/util/page-kind.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { humanize, lowerFirst } from "../../util/naming.js";
import { AUTH_GATE_ANGULAR, AUTH_SESSION_SERVICE_ANGULAR } from "../_frontend/auth-ui.js";
import {
  E2E_FIXTURES_TS,
  E2E_PACKAGE_JSON_ANGULAR,
  E2E_TSCONFIG_JSON,
  PLAYWRIGHT_CONFIG_TS,
} from "../_frontend/e2e-harness.js";
import {
  buildExternFunctionShim,
  buildExternFunctionSignature,
} from "../_frontend/extern-functions.js";
import { renderGateExpr } from "../_frontend/gate-expr.js";
import { deriveSidebarFromUi } from "../_frontend/menu-emitter.js";
import { smokeSpec } from "../_frontend/smoke-spec.js";
import { prepareThemeVM } from "../_frontend/theme-preparer.js";
import { hasAnyView } from "../_frontend/views-module.js";
import { hasAnyWorkflow } from "../_frontend/workflows-module.js";
import { loadPack, resolvePackDir } from "../_packs/loader-fs.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { walkBody } from "../_walker/walker-core.js";
import { emitPageObjectsForUi } from "../react/pages-emitter.js";
import { buildAngularApiModule } from "./api-module.js";
import {
  renderAngularExternComponentProps,
  renderAngularExternComponentShim,
} from "./extern-components.js";
import { type AngularRouteDesc, renderAngularRoutes, routePath } from "./routes-emitter.js";
import { renderAngularStoreModule, storeFileSlug } from "./store-builder.js";
import { buildAngularViewsModule } from "./views-module.js";
import { angularTarget } from "./walker/angular-target.js";
import {
  pageComponentName,
  pageNeedsDeferredFeatures,
  pageSlug,
  renderAngularPage,
  renderAngularPageStub,
} from "./walker/page-shell.js";
import { buildAngularWorkflowsModule } from "./workflows-module.js";

// ---------------------------------------------------------------------------
// Angular frontend generator — orchestrator (angular-frontend-plan.md).
//
// Emits a complete, `ng build`-able standalone Angular project: the project
// shell (package.json / angular.json / tsconfig[.app].json), the standalone
// bootstrap (main.ts + app.config.ts), the Material app shell, the route
// table (one component per page + wildcard NotFound), the DI-native api
// client/config + per-aggregate @Injectable services, theme, format helpers,
// the docker stage, and the emitted Playwright e2e suite.  Pages walk through
// the shared markup walker with `angularTarget`; the primitive/field/form
// tiers are fully wired (forms render inline via the Reactive-Form seams), so
// `validateRequired` is on (see below).
// ---------------------------------------------------------------------------

export interface GenerateAngularOptions {
  apiBaseUrl?: string;
  basePath?: string;
  topLevelComponents?: ComponentIR[];
  /** Generate-time source-map recorder (`--sourcemap`) — see
   *  `PlatformSurface.emitProject`'s doc comment.  Records whole-file
   *  page regions alongside their `out.set(...)`.  Angular has no
   *  per-component emission today (user components in page bodies
   *  aren't rendered — see `pages/route` loop below), so there is no
   *  component-loop counterpart to wire here. */
  sourcemap?: SourceMapRecorder;
}

const DEFAULT_DESIGN = "angularMaterial@v1";

export function generateAngularForContexts(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
  options: GenerateAngularOptions = {},
): Map<string, string> {
  const out = new Map<string, string>();

  // The angularMaterial pack satisfies the (Angular-specific) required-primitive
  // surface in `required-primitives.ts` — display / layout / input templates;
  // forms render inline via the walker seam, so `form-of` / `field-input-*` /
  // `modal` are deliberately not pack templates.  Required-validation is on.
  const pack = loadPack(resolvePackDir(deployable.design ?? DEFAULT_DESIGN));

  const target = sys.deployables.find((d) => d.name === deployable.targetName);
  const apiBaseUrl = options.apiBaseUrl ?? API_BASE_PATH;
  // Dev fallback for the static server's `/api` reverse proxy.  Compose
  // overrides it with VITE_API_PROXY_TARGET (→ the backend SERVICE); a local
  // `node server.mjs` falls back to the backend on localhost.
  const apiProxyTarget = `http://localhost:${target?.port ?? 8080}`;

  const aggregates: Array<{ agg: EnrichedAggregateIR; ctx: EnrichedBoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) aggregates.push({ agg, ctx });
  }
  // Per-aggregate repository (carries the parameterised finds the api module
  // emits a `use<Find><Agg>` factory for).  A plain aggregate without a
  // declared `repository` has only the enriched auto-`all` find.
  const repoByAggregate = new Map<string, RepositoryIR>();
  for (const ctx of contexts) {
    for (const repo of ctx.repositories) repoByAggregate.set(repo.aggregateName, repo);
  }
  const hasDelete = aggregates.some((a) => !!a.agg.canonicalDestroy);
  const usesMoney = contexts.some(contextUsesMoney);
  const authUi = !!(deployable.auth?.ui && target?.auth?.required && sys.user);

  // --- Project shell (pack-emitted) -----------------------------------
  out.set("package.json", pack.render("package-json", { usesMoney }));
  out.set("angular.json", pack.render("angular-json", {}));
  out.set("tsconfig.json", pack.render("tsconfig", {}));
  out.set("tsconfig.app.json", pack.render("tsconfig-app", {}));
  out.set("src/main.ts", pack.render("main", {}));
  out.set("src/styles.css", pack.render("theme", prepareThemeVM(sys.theme)));
  out.set("src/lib/format.ts", pack.render("format-helpers", {}));

  // --- Pages — bodies walk through the SHARED markup walker with
  // `angularTarget`; the angularMaterial pack templates own the markup
  // the primitives emit.  Each page becomes a standalone component under
  // `src/app/pages/`.  Forms / actions / reads render real bodies via the
  // Angular Reactive-Form + signal walker seams; only a route/title-only
  // page (no body) renders a title stub.
  const ui = deployable.uiName ? sys.uis.find((u) => u.name === deployable.uiName) : undefined;
  const pages = (ui?.pages ?? []).filter((p) => p.route);

  // Extern frontend functions (extern-function-hook-escape-hatch.md §3): the
  // same two machine-owned files react / svelte emit — the wire-DTO-typed
  // signature (`src/lib/extern/<name>.signature.ts`; the Angular api modules
  // live at `src/api/`, so the default `../../api` root resolves) and the
  // conformance shim (`src/lib/<name>.ts`).  Body calls register through
  // `externFunctionNames`; the page shell imports each used shim and re-exposes
  // it as a component member so an Angular template interpolation resolves it
  // against the instance (Angular evaluates template expressions against the
  // component, never a free import — the same lift `FORMAT_HELPERS` uses).
  const externFunctionNames = new Set<string>();
  for (const fn of ui?.functions ?? []) {
    externFunctionNames.add(fn.name);
    out.set(`src/lib/extern/${fn.name}.signature.ts`, buildExternFunctionSignature(fn));
    out.set(`src/lib/${fn.name}.ts`, buildExternFunctionShim(fn));
  }

  // Extern frontend components (extern-component-escape-hatch.md): each
  // `component <Name>(…) extern from "<path>"` (ui-scope or top-level) gets a
  // typed props interface + a class re-export shim under `src/components/`, and
  // is threaded into the walker's `userComponents` map so a body call renders
  // through `angularTarget.renderUserComponent` (an `NgComponentOutlet`
  // container).  Only EXTERN components are supported on Angular today —
  // non-extern user components have no walked-component emit here, so they stay
  // out of the map and fall through unchanged.  A component is `extern`, so it
  // carries no body/state/derived to walk.
  const externComponents = [
    ...(options.topLevelComponents ?? []),
    ...(ui?.components ?? []),
  ].filter((c) => c.extern);
  const externComponentParams = new Map<string, ComponentIR["params"]>();
  for (const c of externComponents) {
    externComponentParams.set(c.name, c.params);
    out.set(
      `src/components/${c.name}.props.ts`,
      renderAngularExternComponentProps(c.name, c.params),
    );
    out.set(
      `src/components/${c.name}.ts`,
      renderAngularExternComponentShim(c.name, c.externPath ?? ""),
    );
  }

  // Walk context shared across every page: the aggregate / BC / workflow
  // lookups + the ui's api params power the shared walker's api-hook
  // detection (`<handle>.<Agg>.all` → `useAll<Agg>s`) and form/IdLink
  // resolution.  Mirrors the React/Vue generators' assembly.
  const aggregatesIRByName = new Map<string, AggregateIR>();
  const bcByAggregate = new Map<string, BoundedContextIR>();
  const workflowsByName = new Map<string, WorkflowIR>();
  const bcByWorkflow = new Map<string, BoundedContextIR>();
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      aggregatesIRByName.set(agg.name, agg);
      bcByAggregate.set(agg.name, ctx);
    }
    for (const wf of ctx.workflows) {
      workflowsByName.set(wf.name, wf);
      bcByWorkflow.set(wf.name, ctx);
    }
  }
  const pageRoutes = new Map<string, string>();
  for (const page of pages) pageRoutes.set(page.name, page.route!);
  // Name-context for the page's emitted identifier (slice 3c — replaces origin).
  const pageCtx: PageNameCtx = {
    aggregateNames: contexts.flatMap((c) => c.aggregates.map((a) => a.name)),
    workflowNames: contexts.flatMap((c) => c.workflows.map((w) => w.name)),
    viewNames: contexts.flatMap((c) => c.views.map((v) => v.name)),
  };

  const routeDescs: AngularRouteDesc[] = [];
  for (const page of pages) {
    const slug = pageSlug(page, pageCtx);
    let content: string;
    if (!page.body) {
      content = renderAngularPageStub(page, pageCtx, authUi);
    } else {
      const result = walkBody(
        page.body,
        angularTarget,
        pack,
        new Set(page.params.map((p) => p.name)),
        new Set(page.state.map((s) => s.name)),
        externComponentParams,
        ui?.apiParams ?? [],
        aggregatesIRByName,
        bcByAggregate,
        workflowsByName,
        bcByWorkflow,
        new Map(),
        pageRoutes,
        externFunctionNames,
        new Set(page.derived.map((d) => d.name)),
        authUi,
      );
      content = pageNeedsDeferredFeatures(result)
        ? renderAngularPageStub(page, pageCtx, authUi)
        : renderAngularPage({
            page,
            result,
            derived: page.derived,
            pack,
            authUi,
            nameCtx: pageCtx,
            apiParams: ui?.apiParams ?? [],
            aggregatesByName: aggregatesIRByName,
            bcByAggregate,
            workflowsByName,
            bcByWorkflow,
            externFunctions: externFunctionNames,
          });
    }
    const pagePath = `src/app/pages/${slug}.component.ts`;
    out.set(pagePath, content);
    // `ui` is guaranteed defined here: `pages` (the loop source) is derived
    // from `ui?.pages ?? []`, so a non-empty iteration implies `ui` exists.
    options.sourcemap?.file(pagePath, content, page.origin, pageConstructId(ui!.name, page));
    routeDescs.push({ route: page.route!, component: pageComponentName(page, pageCtx), slug });
  }

  // Store modules (named-actions-and-stores.md §3, Stage 5) — one injectable
  // signal service per `store Cart { … }` at `src/app/stores/<dasherized>.store.ts`.
  // Page shells `inject()` these (`../stores/cart.store`) per used store.  Like
  // React's index, the module is emitted here directly (not via the optional
  // `WalkerTarget.renderStoreModule` seam) so the store-builder ↔ target import
  // stays one-directional.
  for (const store of ui?.stores ?? []) {
    out.set(
      `src/app/stores/${storeFileSlug(store.name)}.store.ts`,
      renderAngularStoreModule(store),
    );
  }

  // Nav sidebar.  When the `ui` declares an explicit `menu { … }` block (or
  // custom pages carrying `menu { … }` metadata), honour it via the shared
  // `deriveSidebarFromUi` — the same driver react / vue / svelte use, so a
  // menu's sections / labels / order render identically across frontends
  // (external `link "L" -> "url"` entries render as `<a href target=_blank>`).
  // With no menu the deriver returns `undefined` and we fall back to the
  // default single section: one entry per routed page (byte-identical to the
  // pre-menu behaviour).  On an `auth: ui` frontend a page carrying a
  // currentUser-only `requires` gate gets a `requiresJs` condition the
  // app-shell `@if`-hides — the nav-side mirror of the page body guard.  The
  // gate validator guarantees a page `requires` is currentUser-only, so
  // `renderGateExpr` can't throw here (same assumption the page guard in
  // page-shell.ts relies on).
  const sidebarOverride = ui ? deriveSidebarFromUi(ui, pageCtx, authUi) : undefined;
  const navSections = sidebarOverride
    ? sidebarOverride.map((s) => ({
        label: s.label,
        entries: s.entries.map((e) => ({
          to: e.to,
          label: e.label,
          testId: e.testId,
          requiresJs: e.requiresJs,
          external: !!e.external,
          href: e.href,
        })),
      }))
    : pages.length > 0
      ? [
          {
            label: humanize(sys.name),
            entries: pages.map((p) => ({
              to: p.route!,
              label: humanize(p.name),
              testId: `nav-${pageSlug(p, pageCtx)}`,
              requiresJs:
                authUi && p.requires ? renderGateExpr(p.requires, "currentUser") : undefined,
              external: false,
              href: undefined as string | undefined,
            })),
          },
        ]
      : [];

  // Bind the session user in the app shell only when a nav entry is actually
  // gated — an unused injected member would be an `ng build` strict error.
  const navUsesSession = navSections.some((s) => s.entries.some((e) => !!e.requiresJs));

  // The app shell (Material toolbar + sidenav).
  out.set(
    "src/app/app.component.ts",
    pack.render("app-shell", {
      systemNameHuman: humanize(sys.name),
      navSections,
      hasNav: navSections.some((s) => s.entries.length > 0),
      authUi,
      navUsesSession,
    }),
  );
  out.set("src/app/app.config.ts", pack.render("app-config", {}));

  // --- Frontend auth (`auth: ui`) ------------------------------------
  // The session service owns the /auth/me probe + sign-in/out redirects (and
  // exposes the verified `user` signal a future page guard reads); the
  // pack-agnostic AuthGate component wraps <router-outlet /> in the app shell.
  // Gated entirely behind `authUi` — a non-auth app emits neither file and an
  // unchanged app shell.
  if (authUi) {
    out.set("src/app/auth/session.service.ts", AUTH_SESSION_SERVICE_ANGULAR);
    out.set("src/app/auth/auth-gate.component.ts", AUTH_GATE_ANGULAR);
  }

  // Routes: one per page; a synthetic Home only when no page owns the
  // index route; a wildcard NotFound always.
  const hasIndex = routeDescs.some((d) => routePath(d.route) === "");
  out.set("src/app/app.routes.ts", renderAngularRoutes(routeDescs, !hasIndex));
  out.set("src/app/not-found.component.ts", NOT_FOUND_COMPONENT);
  if (!hasIndex) out.set("src/app/home.component.ts", HOME_COMPONENT);

  // --- Shared neutral sources (angular/ + api/) ----------------------
  out.set(
    "src/index.html",
    pack.render("index-html", {
      title: humanize(sys.name),
      description: undefined,
      ogImage: undefined,
      canonical: undefined,
      favicon: undefined,
      usesCodeBlock: false,
    }),
  );
  out.set("src/api/client.ts", pack.render("api-client", { hasDelete, hasAuthUi: authUi }));
  out.set("src/api/config.ts", pack.render("api-config", { apiBaseUrl }));

  // Per-aggregate API modules — the idiomatic-Angular `@Injectable` service +
  // signal-backed `use<Op><Agg>` read factory (data-path sub-slice A; the
  // QueryView read path that consumes them lands in the next sub-slice).
  for (const { agg } of aggregates) {
    out.set(
      `src/api/${lowerFirst(agg.name)}.ts`,
      buildAngularApiModule(agg, repoByAggregate.get(agg.name), bcByAggregate.get(agg.name)),
    );
  }
  // Views / workflows API modules — the Angular-native sibling of the
  // React/Vue zod modules: TanStack `injectQuery` / `injectMutation` off an
  // `@Injectable` service.  Emitted only when the served contexts declare any
  // view / workflow, so a plain project's tree is unchanged.
  if (hasAnyView(contexts)) {
    out.set("src/api/views.ts", buildAngularViewsModule(contexts));
  }
  if (hasAnyWorkflow(contexts)) {
    out.set("src/api/workflows.ts", buildAngularWorkflowsModule(contexts));
  }

  // --- Playwright e2e harness (angular-frontend-plan.md Slice 6) -------
  // Page objects + smoke spec are framework-neutral — they drive the
  // browser through the SAME testid-keyed runtime React/Vue/Svelte use, so
  // the SHARED `_frontend/` emitters produce them verbatim.  Angular
  // Material's `<mat-select>` is an overlay/portal combobox (ARIA
  // `role="listbox"` + `role="option"`), so the page objects use the
  // default `selectStyle: "combobox"` gesture (same as React) — no
  // Angular-specific page-object fork.  The smoke spec navigates every
  // param-less route; the `ui.spec.ts` driving the page objects is emitted
  // by the system orchestrator (`mountsUi`) when `test e2e ui` blocks
  // target this deployable.  Emitted only when the deployable mounts a ui.
  if (ui) {
    const pageObjects = emitPageObjectsForUi(
      ui,
      {
        sys,
        deployable,
        aggregatesByName: aggregatesIRByName,
        contextsByName: new Map(contexts.map((c) => [c.name, c])),
        pack,
        topLevelComponents: options.topLevelComponents ?? [],
      },
      // No walker-driven custom-page objects: Angular forms render inline
      // (no pack form templates), so the shared React TSX walker would throw
      // against the angularMaterial pack.  Scaffold-archetype page objects
      // (framework-neutral) still emit.
      false,
    );
    for (const [p, content] of pageObjects) out.set(p, content);
    out.set("e2e/smoke.spec.ts", smokeSpec(ui, pageCtx));
    out.set("e2e/fixtures.ts", E2E_FIXTURES_TS);
    out.set("e2e/playwright.config.ts", PLAYWRIGHT_CONFIG_TS);
    out.set("e2e/package.json", E2E_PACKAGE_JSON_ANGULAR);
    out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);
  }

  out.set("src/logger.ts", pack.render("logger", {}));
  // Static host for the built bundle (SPA fallback) + a same-origin `/api`
  // reverse proxy.  Replaces a bare static server (`serve`, which cannot
  // proxy) so the bundle's RELATIVE `/api` reaches the backend — proxied here
  // because under compose / k8s the backend is a peer SERVICE, not this
  // origin.  See the Dockerfile (runs `node server.mjs`).
  out.set("server.mjs", renderAngularServerMjs(apiProxyTarget));
  out.set("Dockerfile", pack.render("dockerfile", {}));
  out.set(".dockerignore", pack.render("dockerignore", {}));
  out.set("certs/.gitkeep", "");

  return out;
}

const HOME_COMPONENT = `// Auto-generated.
import { Component } from "@angular/core";

@Component({
  selector: "app-home",
  imports: [],
  template: \`
    <section data-testid="page-home">
      <h2>Welcome</h2>
      <p>This app's pages render here once the ui declares them.</p>
    </section>
  \`,
})
export class HomeComponent {}
`;

const NOT_FOUND_COMPONENT = `// Auto-generated.
import { Component } from "@angular/core";
import { RouterLink } from "@angular/router";

@Component({
  selector: "app-not-found",
  imports: [RouterLink],
  template: \`
    <section data-testid="not-found" style="padding: 16px">
      <h2>Not found</h2>
      <a routerLink="/">&larr; Back to home</a>
    </section>
  \`,
})
export class NotFoundComponent {}
`;

/**
 * A dependency-free Node static host for the built bundle (SPA fallback) with
 * a same-origin `/api` reverse proxy.  `devTarget` is the baked dev fallback;
 * `VITE_API_PROXY_TARGET` (set by the compose orchestrator → the backend
 * service) overrides it at runtime.  Kept template-literal-free internally so
 * it embeds cleanly here.
 */
function renderAngularServerMjs(devTarget: string): string {
  return `// Auto-generated.
// Static host for the built Angular bundle (SPA fallback) + a same-origin
// "/api" reverse proxy.  The bundle fetches /api RELATIVE; under compose / k8s
// the backend is a peer SERVICE, so those calls are proxied here rather than
// hitting this server's own origin.  Target: VITE_API_PROXY_TARGET (the compose
// orchestrator points it at the backend service); local runs fall back to the
// baked dev target.
import { createServer, request as proxyRequest } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./browser/", import.meta.url));
const PORT = Number(process.env.PORT ?? "3000");
const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? ${JSON.stringify(devTarget)};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function serveFile(res, path) {
  return stat(path)
    .then((s) => {
      if (!s.isFile()) return false;
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
      createReadStream(path).pipe(res);
      return true;
    })
    .catch(() => false);
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  // Same-origin API proxy.
  if (url === "/api" || url.startsWith("/api/")) {
    const target = new URL(API_TARGET);
    const upstream = proxyRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: url,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("Bad Gateway");
    });
    req.pipe(upstream);
    return;
  }
  // Static file, then SPA fallback to index.html.
  const rel = normalize(decodeURIComponent(url.split("?")[0])).replace(/^(\\.\\.[/\\\\])+/, "");
  const filePath = join(ROOT, rel);
  Promise.resolve(filePath.startsWith(ROOT) ? serveFile(res, filePath) : false).then((served) => {
    if (served) return;
    serveFile(res, join(ROOT, "index.html")).then((ok) => {
      if (ok) return;
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
    });
  });
});

server.listen(PORT, () => console.log("serving ./browser on :" + PORT + " (api -> " + API_TARGET + ")"));
`;
}
