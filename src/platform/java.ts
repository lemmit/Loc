import type { PlatformAdapterDefaults, PlatformAdapters } from "../generator/_adapters/index.js";
import { byFeatureLayoutAdapter } from "../generator/java/adapters/by-feature-layout.js";
import { byLayerLayoutAdapter } from "../generator/java/adapters/by-layer-layout.js";
import { jpaPersistenceAdapter } from "../generator/java/adapters/jpa-persistence.js";
import { layeredStyleAdapter } from "../generator/java/adapters/layered-style.js";
import { generateJavaForContexts } from "../generator/java/index.js";
import {
  type ComposeServiceShape,
  type PlatformSurface,
  STATIC_BUNDLE_FRAMEWORKS,
} from "./surface.js";

// ---------------------------------------------------------------------------
// Java platform — Spring Boot 3 / Spring Data JPA (Hibernate) / Postgres.
// Backend-only like `dotnet`, and dual-mode the same way: a `ui:` binding
// turns the deployable into a fullstack host serving an embedded React
// SPA from Spring's static resources.  All project emission lives under
// `../generator/java/`; this module is the thin `PlatformSurface` wiring.
// See docs/plans/java-backend-implementation.md for the slice plan.
// ---------------------------------------------------------------------------

const javaPlatform: PlatformSurface = {
  name: "java",
  // 8080 is the Spring convention but collides with dotnet's default in
  // mixed systems, so the host-mapped default steps aside; the container-
  // internal listener stays 8080.
  defaultPort: 8081,
  needsDb: true,
  isFrontend: false,
  // Static-asset host (embeds a SPA via /app/ui + an SPA fallback) —
  // serves any static-bundle framework, like dotnet: the Dockerfile's
  // spa stage copies the framework's build output (Vite `dist/`,
  // SvelteKit `build/`) into the serving dir.
  mountsUi: true,
  // Static-asset host (embeds a SPA via /app/ui + an SPA fallback) —
  // serves any static-bundle framework (react / svelte / vue): the
  // Dockerfile spa stage copies the framework's build output (Vite
  // `dist/`, SvelteKit `build/`) into the serving dir.
  hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
  // The java repository auto-emits `save`, `findById`, `getById`,
  // `delete`, and `findAll` (Spring Data conventions).  All but
  // `findAll` are already reserved by the Hono surface; the union
  // across platforms (see `validateFindNameCollisions`) picks up the
  // difference.
  reservedRepositoryFindNames: new Set(["save", "findById", "getById", "delete", "findAll"]),
  emitProject({
    contexts,
    deployable,
    sys,
    migrations,
    emitTrace,
    styleAdapter,
    layoutAdapter,
    sourcemap,
  }): Map<string, string> {
    return generateJavaForContexts(
      contexts,
      deployable.name,
      { deployable, sys, migrations, styleAdapter, layoutAdapter },
      { emitTrace, sourcemap },
    );
  },
  composeService({ slug }): ComposeServiceShape {
    return {
      env: [
        ["SPRING_DATASOURCE_URL", `jdbc:postgresql://db:5432/${slug}`],
        ["SPRING_DATASOURCE_USERNAME", "postgres"],
        ["SPRING_DATASOURCE_PASSWORD", "postgres"],
      ],
      // The DB password is sensitive — keep it out of any plaintext k8s
      // ConfigMap (the emitter routes it to a Secret).  The URL is handled
      // via dependsOnDb; the username stays plain config.
      secretEnvKeys: ["SPRING_DATASOURCE_PASSWORD"],
      dependsOnDb: true,
      // Compose healthcheck → /ready (DB-aware); /health stays for cheap
      // liveness probing.  Mirrors dotnet.
      healthPath: "/ready",
      internalPort: 8080,
    };
  },
  // java — JPA persistence; `layered` is the Spring style (controller →
  // service → repository); byLayer / byFeature layout.
  adapters(): PlatformAdapters {
    const menu: PlatformAdapters = {
      persistence: {
        jpa: jpaPersistenceAdapter,
      },
      styles: {
        layered: layeredStyleAdapter,
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
      // eventLog → `jpa`: JPA hosts the real event-sourced store (it declares
      // `["state","eventLog"]` and emits the fold/append repository).
      persistence: { state: "jpa", eventLog: "jpa" },
      style: "layered",
      // Package-by-feature is the idiomatic Spring arrangement
      // (java-backend.md adapter menu).
      layout: "byFeature",
    };
  },
};

export default javaPlatform;
