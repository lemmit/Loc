import { generateDotnetForContexts } from "../generator/dotnet/index.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

const dotnetPlatform: PlatformSurface = {
  name: "dotnet",
  defaultPort: 8080,
  needsDb: true,
  isFrontend: false,
  // .NET admits an embedded React SPA via static-files middleware +
  // SPA fallback route — see the fullstack branch in
  // `generator/dotnet/index.ts` that fires when `deployable.uiName`
  // is set.  Backend-only dotnet deployables (no `ui:`) stay
  // unaffected; the deployable validator only errors when
  // `hasUiBinding && !platformMountsUi`, which never fires absent
  // an explicit `ui:` declaration.
  mountsUi: true,
  // .NET repository auto-emits `SaveAsync` and `GetByIdAsync`.  Find
  // names are Pascal-cased on the C# side, so a DSL find named
  // `saveAsync` lowers to `SaveAsync()` colliding with the auto
  // method.  Plain `save` (→ `Save()`) doesn't collide on .NET, but
  // it DOES on Hono — the validator takes the union across all
  // platforms (see `validateLoomModel`).
  reservedRepositoryFindNames: new Set(["saveAsync", "getByIdAsync"]),
  emitProject({ contexts, deployable, sys, migrations }): Map<string, string> {
    const namespace = deployable.name[0]!.toUpperCase() + deployable.name.slice(1);
    // The orchestrator dispatches per-aggregate CQRS emission + byLayer
    // path routing through adapters when given a pair.  Passing them
    // explicitly here (rather than resolving via the registry) avoids
    // a load-time cycle: adapter-registry ← cqrs-style ← cqrs-emit ←
    // dto-mapping ← ir/enrich/enrichments ← platform/registry ←
    // platform/dotnet.  The generator imports its own adapters
    // directly from sibling files (`src/generator/dotnet/adapters/`)
    // — that's not a layering violation because both live under
    // `src/generator/dotnet/`.  Future per-deployable
    // `persistence:` / `style:` / `layout:` overrides will resolve
    // through the registry at this seam.
    return generateDotnetForContexts(contexts, namespace, { deployable, sys, migrations });
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
      // Compose healthcheck → /ready (DB-aware).  Sets the service
      // `healthy` only once the app can reach its DB, so dependent
      // services / smoke tests don't race the schema bootstrap.
      // /health stays for cheap liveness probing (k8s livenessProbe).
      healthPath: "/ready",
      internalPort: 8080,
    };
  },
};

export default dotnetPlatform;
