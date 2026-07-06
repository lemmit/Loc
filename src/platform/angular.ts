import { API_BASE_PATH } from "../util/api-base.js";
import { dispatchFrontendProject } from "./frontend-dispatch.js";
import {
  type ComposeServiceShape,
  type PlatformSurface,
  STATIC_BUNDLE_FRAMEWORKS,
} from "./surface.js";

// ---------------------------------------------------------------------------
// Angular frontend platform — the fourth frontend-only platform after
// `react`, `svelte`, and `vue`.  Generated projects are Angular
// standalone-component apps (signals, `provideRouter`, typed `@Injectable`
// services + `HttpClient`/`toSignal`) rendered against an angular-format
// design pack (`angularMaterial` / `primeng` / `spartanNg`).  Unlike the
// Vite frontends, Angular builds with `ng build` to a static
// `dist/<app>/browser` bundle, served by a static server in the docker
// runtime stage.
//
// Deployable contract mirrors `react`: `targets:` a backend, inherits its
// contexts via enrichment, owns no database.
// See docs/plans/angular-frontend-plan.md.
// ---------------------------------------------------------------------------

const angularPlatform: PlatformSurface = {
  name: "angular",
  defaultPort: 3004,
  // Frontends are SPAs hitting a peer backend; they own no DB.
  needsDb: false,
  mountsUi: true,
  isFrontend: true,
  // Standalone static-asset host (a static server over the built
  // bundle): serves any static-bundle framework.  D-PHOENIX-SURFACE.
  hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
  // Angular generator only emits API call services — no per-aggregate
  // repository class.  No find-name collisions are possible.
  reservedRepositoryFindNames: new Set(),
  emitProject({ contexts, sys, deployable, topLevelComponents, sourcemap }): Map<string, string> {
    // Frontend hosts dispatch by the UI's framework, not the platform keyword —
    // an angular host can serve a `framework: react|svelte|vue` ui (any static
    // bundle runs on a static host).  `angular` is the native fallback.
    return dispatchFrontendProject(deployable.uiFramework, "angular", {
      contexts,
      sys,
      deployable,
      topLevelComponents,
      sourcemap,
    });
  },
  composeService({ deployable, sys }): ComposeServiceShape {
    const target = sys.deployables.find((t) => t.name === deployable.targetName);
    return {
      env: [["VITE_API_BASE_URL", `http://localhost:${target?.port ?? 8080}${API_BASE_PATH}`]],
      dependsOnDb: false,
      healthPath: "/",
      internalPort: 3000,
      // Served by the emitted `server.mjs` (a static host with a same-origin
      // `/api` reverse proxy) reading VITE_API_PROXY_TARGET — so the bundle's
      // relative `/api` reaches the backend service under compose.
      injectsApiProxyTarget: true,
    };
  },
};

export default angularPlatform;
