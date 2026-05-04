import { generateReactForContexts } from "../generator/react/index.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

const reactPlatform: PlatformSurface = {
  name: "react",
  defaultPort: 3001,
  // Frontends are SPAs hitting a peer backend; they own no DB.
  needsDb: false,
  emitProject({ contexts, sys, deployable }): Map<string, string> {
    return generateReactForContexts(contexts, sys, deployable);
  },
  composeService({ deployable, sys }): ComposeServiceShape {
    const target = sys.deployables.find((t) => t.name === deployable.targetName);
    return {
      env: [
        [
          "VITE_API_BASE_URL",
          `http://localhost:${target?.port ?? 8080}`,
        ],
      ],
      dependsOnDb: false,
      healthPath: "/",
      internalPort: 3000,
    };
  },
};

export default reactPlatform;
