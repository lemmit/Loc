import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The showcase is deployed under `<site>/showcase/` on GitHub Pages
// alongside the playground (`<site>/playground/`).  Relative `base`
// keeps the bundle portable so it works under any deploy path —
// including `localhost:4173/showcase/` from `vite preview` for
// local sanity checks.
//
// The Vite build outputs to `dist/`; the CI workflow then copies
// `dist/*` into `docs/_site/showcase/` *alongside* the
// pre-generated `iframes/<story>/<pack>/` directories the
// build-showcase.mjs script produced.  Both live under the same
// `/showcase/` URL prefix so the runtime fetch of `manifest.json`
// resolves cleanly.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5174,
    host: "127.0.0.1",
  },
});
