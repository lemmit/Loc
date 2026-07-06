import { API_BASE_PATH } from "../util/api-base.js";
import { dispatchFrontendProject } from "./frontend-dispatch.js";
import {
  type ComposeServiceShape,
  type PlatformSurface,
  STATIC_BUNDLE_FRAMEWORKS,
} from "./surface.js";

const reactPlatform: PlatformSurface = {
  name: "react",
  defaultPort: 3001,
  // Frontends are SPAs hitting a peer backend; they own no DB.
  needsDb: false,
  mountsUi: true,
  isFrontend: true,
  // Standalone static-asset host (Vite preview over a built bundle):
  // serves any static-bundle framework.  D-PHOENIX-SURFACE.
  hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
  // React generator only emits API hooks — no per-aggregate
  // repository class.  No find-name collisions are possible.
  reservedRepositoryFindNames: new Set(),
  emitProject({ contexts, sys, deployable, topLevelComponents, sourcemap }): Map<string, string> {
    // Frontend hosts dispatch by the UI's framework — a react/static host can
    // serve a `framework: svelte|vue|angular` ui (any static bundle runs on a
    // static host).  `react` is the native fallback for a ui-less mount.
    return dispatchFrontendProject(deployable.uiFramework, "react", {
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
      injectsApiProxyTarget: true,
    };
  },
};

export default reactPlatform;
