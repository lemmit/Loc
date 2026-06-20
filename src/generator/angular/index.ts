import type {
  AggregateIR,
  BoundedContextIR,
  ComponentIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  SystemIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { contextUsesMoney } from "../../ir/types/loom-ir.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { humanize, lowerFirst } from "../../util/naming.js";
import { AUTH_GATE_ANGULAR, AUTH_SESSION_SERVICE_ANGULAR } from "../_frontend/auth-ui.js";
import { prepareThemeVM } from "../_frontend/theme-preparer.js";
import { loadPack, resolvePackDir } from "../_packs/loader-fs.js";
import { walkBody } from "../_walker/walker-core.js";
import { buildAngularApiModule } from "./api-module.js";
import { type AngularRouteDesc, renderAngularRoutes, routePath } from "./routes-emitter.js";
import { angularTarget } from "./walker/angular-target.js";
import {
  pageComponentName,
  pageNeedsDeferredFeatures,
  pageSlug,
  renderAngularPage,
  renderAngularPageStub,
} from "./walker/page-shell.js";

// ---------------------------------------------------------------------------
// Angular frontend generator — orchestrator (angular-frontend-plan.md
// Slice 3, walking skeleton).
//
// Emits a complete, `ng build`-able empty Angular project: the project
// shell (package.json / angular.json / tsconfig[.app].json), the standalone
// bootstrap (main.ts + app.config.ts), the Material app shell, an empty
// route table (Home + wildcard NotFound), the DI-native api client/config,
// theme, format helpers, and the docker stage.  Page walking + the
// primitive/field/form tiers + per-aggregate @Injectable services land in
// Slice 4 — at which point the pack's required-primitive surface is
// complete and the `validateRequired: false` below flips on.
// ---------------------------------------------------------------------------

export interface GenerateAngularOptions {
  apiBaseUrl?: string;
  basePath?: string;
  topLevelComponents?: ComponentIR[];
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
  // `src/app/pages/`.  Bodies needing api services / forms are stubbed
  // until those Slice 4b batches land.
  const ui = deployable.uiName ? sys.uis.find((u) => u.name === deployable.uiName) : undefined;
  const pages = (ui?.pages ?? []).filter((p) => p.route);

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

  const routeDescs: AngularRouteDesc[] = [];
  for (const page of pages) {
    const slug = pageSlug(page);
    let content: string;
    if (!page.body) {
      content = renderAngularPageStub(page);
    } else {
      const result = walkBody(
        page.body,
        angularTarget,
        pack,
        new Set(page.params.map((p) => p.name)),
        new Set(page.state.map((s) => s.name)),
        new Map(),
        ui?.apiParams ?? [],
        aggregatesIRByName,
        bcByAggregate,
        workflowsByName,
        bcByWorkflow,
        new Map(),
        pageRoutes,
        new Set(),
        new Set(page.derived.map((d) => d.name)),
      );
      content = pageNeedsDeferredFeatures(result)
        ? renderAngularPageStub(page)
        : renderAngularPage({ page, result, derived: page.derived, pack });
    }
    out.set(`src/app/pages/${slug}.component.ts`, content);
    routeDescs.push({ route: page.route!, component: pageComponentName(page), slug });
  }

  // Nav sidebar — one entry per routed page (routerLink keeps the
  // leading-slash absolute path; the route table strips it).
  const navEntries = pages.map((p) => ({
    to: p.route!,
    label: humanize(p.name),
    testId: `nav-${pageSlug(p)}`,
  }));
  const navSections =
    navEntries.length > 0 ? [{ label: humanize(sys.name), entries: navEntries }] : [];

  // The app shell (Material toolbar + sidenav).
  out.set(
    "src/app/app.component.ts",
    pack.render("app-shell", {
      systemNameHuman: humanize(sys.name),
      navSections,
      hasNav: navEntries.length > 0,
      authUi,
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
    out.set(`src/api/${lowerFirst(agg.name)}.ts`, buildAngularApiModule(agg));
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
