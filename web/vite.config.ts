import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const bundledTemplateLoader = fileURLToPath(
  new URL("./src/build/template-bundled.ts", import.meta.url),
);

// Vite plugin that swaps `templating/loader-fs.js` (Node fs-bound) for
// the browser-friendly `template-bundled.ts` shim.  We use a custom
// resolver instead of `resolve.alias` because Rollup's alias plugin
// applies the regex via `id.replace`, which mangles the absolute id
// path; resolving by suffix-match here keeps the swap surgical.
const loomLoaderShim = (): Plugin => ({
  name: "loom-loader-shim",
  enforce: "pre",
  async resolveId(source, importer) {
    if (source.endsWith("/templating/loader-fs.js")) {
      return bundledTemplateLoader;
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
// We swap it for a Vite-glob-backed equivalent under `src/build/` so
// every theme's `.hbs` files inline into the worker bundle at build
// time.  See `web/src/build/template-bundled.ts`.
export default defineConfig({
  // Relative base so the build is portable across deploy paths.
  // The CI workflow drops the build under `docs/_site/playground/`
  // on GitHub Pages; relative URLs let the same artifact run from
  // a sub-path or the root of any host.
  base: "./",
  plugins: [loomLoaderShim(), react()],
  resolve: {
    alias: {
      "@loom": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
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
