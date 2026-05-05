import { generateTypeScriptForContexts } from "../generator/typescript/index.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

const honoPlatform: PlatformSurface = {
  name: "hono",
  defaultPort: 3000,
  needsDb: true,
  // Hono repository auto-emits these per aggregate — see
  // src/generator/typescript/repository-builder.ts (`async save`,
  // `async findById`, `async getById`).  A user-declared find with
  // one of these names would compile-error with TS2393 "Duplicate
  // function implementation".
  reservedRepositoryFindNames: new Set(["save", "findById", "getById"]),
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
