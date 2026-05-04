import { generateTypeScriptForContexts } from "../generator/typescript/index.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

const honoPlatform: PlatformSurface = {
  name: "hono",
  defaultPort: 3000,
  needsDb: true,
  emitProject({ contexts }): Map<string, string> {
    return generateTypeScriptForContexts(contexts);
  },
  composeService({ slug }): ComposeServiceShape {
    return {
      env: [
        ["DATABASE_URL", `postgres://postgres:postgres@db:5432/${slug}`],
      ],
      dependsOnDb: true,
      healthPath: "/health",
      internalPort: 3000,
    };
  },
};

export default honoPlatform;
