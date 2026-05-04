import { generateDotnetForContexts } from "../generator/dotnet/index.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

const dotnetPlatform: PlatformSurface = {
  name: "dotnet",
  defaultPort: 8080,
  needsDb: true,
  emitProject({ contexts, deployable }): Map<string, string> {
    const namespace = deployable.name[0]!.toUpperCase() + deployable.name.slice(1);
    return generateDotnetForContexts(contexts, namespace);
  },
  composeService({ slug }): ComposeServiceShape {
    return {
      env: [
        [
          "ConnectionStrings__Default",
          `Host=db;Port=5432;Database=${slug};Username=postgres;Password=postgres`,
        ],
      ],
      dependsOnDb: true,
      healthPath: "/health",
      internalPort: 8080,
    };
  },
};

export default dotnetPlatform;
