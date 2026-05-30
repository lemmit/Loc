import { generateReactForContexts } from "../generator/react/index.js";
import { platformFor } from "./registry.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

// The API base path a standalone react frontend must target on its
// backend, relative to the service origin.  Read off the target's
// `PlatformSurface.apiBasePath` (e.g. `/api` for phoenixLiveView, `""`
// for hono).  `platformFor` is a hoisted function declaration and is
// only *called* here at emit/compose time — never at module-eval —
// so the registry↔react import cycle resolves without a load-time TDZ.
function targetApiBasePath(
  deployable: { targetName?: string },
  sys: { deployables: Array<{ name: string; platform: Parameters<typeof platformFor>[0] }> },
): string {
  const target = sys.deployables.find((t) => t.name === deployable.targetName);
  return target ? platformFor(target.platform).apiBasePath : "";
}

const reactPlatform: PlatformSurface = {
  name: "react",
  defaultPort: 3001,
  // Frontends are SPAs hitting a peer backend; they own no DB.
  needsDb: false,
  mountsUi: true,
  isFrontend: true,
  // React generator only emits API hooks — no per-aggregate
  // repository class.  No find-name collisions are possible.
  reservedRepositoryFindNames: new Set(),
  // Frontend-only — serves no API surface of its own.
  apiBasePath: "",
  emitProject({ contexts, sys, deployable, topLevelComponents }): Map<string, string> {
    return generateReactForContexts(contexts, sys, deployable, {
      topLevelComponents,
      apiBasePath: targetApiBasePath(deployable, sys),
    });
  },
  composeService({ deployable, sys }): ComposeServiceShape {
    const target = sys.deployables.find((t) => t.name === deployable.targetName);
    const basePath = targetApiBasePath(deployable, sys);
    return {
      env: [["VITE_API_BASE_URL", `http://localhost:${target?.port ?? 8080}${basePath}`]],
      dependsOnDb: false,
      healthPath: "/",
      internalPort: 3000,
    };
  },
};

export default reactPlatform;
