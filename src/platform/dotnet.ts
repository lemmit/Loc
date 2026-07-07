import type { PlatformAdapterDefaults, PlatformAdapters } from "../generator/_adapters/index.js";
import { byFeatureLayoutAdapter } from "../generator/dotnet/adapters/by-feature-layout.js";
import { byLayerLayoutAdapter } from "../generator/dotnet/adapters/by-layer-layout.js";
import { cqrsStyleAdapter } from "../generator/dotnet/adapters/cqrs-style.js";
import { dapperPersistenceAdapter } from "../generator/dotnet/adapters/dapper-persistence.js";
import { efcorePersistenceAdapter } from "../generator/dotnet/adapters/efcore-persistence.js";
import { generateDotnetForContexts } from "../generator/dotnet/index.js";
import {
  type ComposeServiceShape,
  type PlatformSurface,
  STATIC_BUNDLE_FRAMEWORKS,
} from "./surface.js";

const dotnetPlatform: PlatformSurface = {
  name: "dotnet",
  defaultPort: 8080,
  needsDb: true,
  isFrontend: false,
  // Static-asset host (embeds a SPA via wwwroot + SPA fallback):
  // serves any static-bundle framework.  D-PHOENIX-SURFACE.
  hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
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
  emitProject({
    contexts,
    deployable,
    sys,
    migrations,
    styleAdapter,
    layoutAdapter,
    emitTrace,
    sourcemap,
    sourceTexts,
  }): Map<string, string> {
    const namespace = deployable.name[0]!.toUpperCase() + deployable.name.slice(1);
    // The orchestrator (`generator/dotnet/index.ts`) dispatches
    // per-aggregate CQRS emission + byLayer path routing through the
    // deployable's RESOLVED style / layout adapters
    // (D-REALIZATION-AXES `application:` / `directoryLayout:`).  The
    // resolution itself happens at the system orchestrator (`src/system/`,
    // which may import `platform/resolve-adapters.ts`); we just FORWARD the
    // resolved adapters into the generator.  This keeps the generator free
    // of any `src/generator/* → src/platform/*` edge (the backend-packages
    // layering invariant) and avoids re-entering the load-time cycle
    // (registry → platform/dotnet → generator/dotnet/index → ir/enrich →
    // platformFor → registry).  When the orchestrator passes none (legacy
    // single-context generate mode), the generator falls back to its own
    // sibling adapters — byte-identical under the size-1 real menus.
    return generateDotnetForContexts(
      contexts,
      namespace,
      {
        deployable,
        sys,
        migrations,
        styleAdapter,
        layoutAdapter,
      },
      { emitTrace, sourcemap, sourceTexts },
    );
  },
  composeService({ slug }): ComposeServiceShape {
    return {
      env: [
        [
          "ConnectionStrings__Default",
          `Host=db;Port=5432;Database=${slug};Username=postgres;Password=postgres`,
        ],
        // Runtime log-level knob (default info; overridable here / in k8s).
        ["LOG_LEVEL", "info"],
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
  // .NET — EF Core + Dapper persistence; CQRS emission style (fixed, not a
  // user knob); byLayer + byFeature layout.  Built lazily (see
  // PlatformSurface.adapters jsdoc) so the adapter bindings are read after
  // init, not during the load-time cycle.
  adapters(): PlatformAdapters {
    const menu: PlatformAdapters = {
      persistence: {
        efcore: efcorePersistenceAdapter,
        dapper: dapperPersistenceAdapter,
      },
      styles: {
        cqrs: cqrsStyleAdapter,
      },
      layouts: {
        byLayer: byLayerLayoutAdapter,
        byFeature: byFeatureLayoutAdapter,
      },
    };
    return menu;
  },
  adapterDefaults(): PlatformAdapterDefaults {
    return {
      // eventLog → `efcore`: EF Core hosts the real event-sourced store (it
      // declares `["state","eventLog"]` and emits the append/fold repository).
      persistence: { state: "efcore", eventLog: "efcore" },
      style: "cqrs",
      layout: "byLayer",
    };
  },
};

export default dotnetPlatform;
