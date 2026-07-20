import { generateFlutterForContexts } from "../generator/flutter/index.js";
import { API_BASE_PATH } from "../util/api-base.js";
import type { ComposeServiceShape, PlatformSurface } from "./surface.js";

// ---------------------------------------------------------------------------
// Flutter frontend platform — a self-hosting Dart/Flutter (Material) app
// (flutter-mobile-frontend.md).  Unlike the vite-only static frontends
// (react/svelte/vue/angular), a Flutter bundle is built by the Flutter SDK
// (`flutter build web`, or a native artifact), so — exactly like Feliz — it is
// NOT a drop-in static-bundle host: it can only host its own
// `framework: flutter` (no other static host knows how to run the Flutter
// build, and it doesn't serve foreign vite bundles).  That's why it's absent
// from `STATIC_BUNDLE_FRAMEWORKS` / `FRONTEND_GENERATORS` and dispatches to its
// own generator directly.
//
// Deployable contract mirrors `react`: `targets:` a backend, inherits its
// contexts via enrichment, owns no database.
//
// `composeService` serves the web surface: the generator emits a real
// `flutter build web` → nginx Dockerfile (see `generator/flutter/index.ts`
// DOCKERFILE), and this shape (structurally identical to Feliz's) wires it
// into the compose stack on :3000 behind the API proxy.  The same emitted
// project also builds native Android/iOS via its Makefile (`make apk`/`ipa`),
// which compose does not serve — mobile artifacts aren't a compose concern.
// ---------------------------------------------------------------------------

const flutterPlatform: PlatformSurface = {
  name: "flutter",
  defaultPort: 3006,
  needsDb: false,
  mountsUi: true,
  isFrontend: true,
  // Flutter hosts ONLY flutter — its SDK build is not the vite-only pipeline
  // the static-bundle hosts share.  Must equal the metadata descriptor.
  hostableFrameworks: new Set(["flutter"]),
  reservedRepositoryFindNames: new Set(),
  emitProject({ contexts, sys, deployable }): Map<string, string> {
    return generateFlutterForContexts(contexts, sys, deployable);
  },
  composeService({ deployable, sys }): ComposeServiceShape {
    const target = sys.deployables.find((t) => t.name === deployable.targetName);
    return {
      env: [["API_BASE_URL", `http://localhost:${target?.port ?? 8080}${API_BASE_PATH}`]],
      dependsOnDb: false,
      healthPath: "/",
      internalPort: 3000,
      injectsApiProxyTarget: true,
    };
  },
};

export default flutterPlatform;
