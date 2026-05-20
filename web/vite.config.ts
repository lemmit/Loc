import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const browserPackLoader = fileURLToPath(
  new URL("./src/build/loader-vfs.ts", import.meta.url),
);

// Vite plugin that swaps `_packs/loader-fs.js` (Node fs-bound)
// for the VFS-backed browser loader.  We use a custom resolver
// instead of `resolve.alias` because Rollup's alias plugin applies
// the regex via `id.replace`, which mangles the absolute id path;
// resolving by suffix-match here keeps the swap surgical.
const loomLoaderShim = (): Plugin => ({
  name: "loom-loader-shim",
  enforce: "pre",
  resolveId(source) {
    if (source.endsWith("/_packs/loader-fs.js")) {
      return browserPackLoader;
    }
    return null;
  },
});

// The web app imports the Loom toolchain straight from `../src` — the
// language services, IR lowering, and generators are pure TS with no
// Node-only APIs (the only Node seams are in `src/cli/` and
// `src/language/main.ts`, neither of which we import).  Vite's bundler
// handles the `.js`-extension import specifiers used throughout `src/`.
//
// One exception: the React generator's pack loader has a Node-bound
// variant (`loader-fs.ts`) that pulls templates off disk via `node:fs`.
// We swap it for `loader-vfs.ts`, which reads pack templates from a
// worker-local in-memory VFS.  The VFS is seeded at worker boot from
// `template-bundled.ts` (the same Vite eager-glob that used to be the
// loader, now demoted to seeder).  Phase 1 of the IDE refactor —
// see `web/src/vfs/types.ts` for the design rationale.
export default defineConfig({
  // Relative base so the build is portable across deploy paths.
  // The CI workflow drops the build under `docs/_site/playground/`
  // on GitHub Pages; relative URLs let the same artifact run from
  // a sub-path or the root of any host.
  base: "./",
  plugins: [loomLoaderShim(), react()],
  // `resolve.alias` previously claimed the whole `@loom/*` namespace
  // as a path alias to `../src`, but nothing in the repo ever imported
  // through it (`grep -rn 'from "@loom/'` is empty).  Removing it
  // unblocks packaging-split P3: workspace packages with real
  // `@loom/*` npm names (`@loom/backend-hono-v4`, future `@loom/core`,
  // `@loom/cli`) would otherwise be intercepted by Vite's resolver
  // and rewritten to `../src/...`.  When a published `@loom/core`
  // becomes the playground's toolchain dependency, a narrowly-scoped
  // alias (just `@loom/core` → `../src`) replaces this if needed.
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  build: {
    rollupOptions: {
      output: {
        // Vendor splitting: Monaco is the main chunk's heaviest
        // dep (~600 KB gzip; 88% of pre-split index-*.js) and
        // changes rarely.  Splitting it into its own chunk lets
        // returning users skip the re-download on every app
        // deploy — they only pay for whatever the app code
        // genuinely changed.  Same logic for the Mantine UI kit
        // and React + React-DOM.
        //
        // Patterns are anchored on `/node_modules/<pkg>/` so a
        // sibling like `@floating-ui/react` (Mantine's positioning
        // engine) doesn't land in the React chunk by accident.
        // `@floating-ui` is co-located with Mantine since that's
        // the only consumer; updates ship together.
        //
        // Trade-off: more, smaller chunks add HTTP round-trips on
        // a cold first paint (HTTP/2 multiplexes them — the cost
        // is small).  We come out ahead on every subsequent
        // deploy because the vendor chunks stay cached.
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return undefined;
          if (id.includes("/node_modules/monaco-editor/")) return "monaco";
          if (
            id.includes("/node_modules/@mantine/") ||
            id.includes("/node_modules/@floating-ui/")
          ) {
            return "mantine";
          }
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/")
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
  worker: {
    format: "es",
    // The build worker (`src/build/build.worker.ts`) imports the React
    // generator, which transitively pulls in `loader-fs.ts`.  Worker
    // bundles run their own plugin pipeline, so the loader-shim
    // needs to be registered here as well — without it, the worker
    // would try to bundle `node:fs` and crash.
    plugins: () => [loomLoaderShim()],
  },
  optimizeDeps: {
    // Monaco ships ESM that Vite scans fine; pre-bundle it to avoid a
    // long cold start on first edit.
    include: ["monaco-editor"],
  },
});
