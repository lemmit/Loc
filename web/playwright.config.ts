import { defineConfig, devices } from "@playwright/test";

// E2E for the playground.  Drives a real Chromium instance against
// `vite preview`, which serves the production-built `dist/` (the
// same artifact CI deploys to GitHub Pages).  Using `preview`
// rather than `dev` catches issues that only surface post-bundling
// — e.g. the Monaco worker glue, the esbuild WASM URL resolution,
// and our `postProcessBundle` rewrite all run as they would in
// production.
//
// Heads up: the spec calls `Bundle` which fetches ~150 modules
// from esm.sh and `Boot` which downloads PGlite's WASM + .data
// from jsdelivr.  Tests need real internet access and generous
// per-action timeouts.

export default defineConfig({
  testDir: "./e2e",
  // Whole-test timeout: bundle + WASM + first dispatch take time.
  timeout: 240_000,
  expect: { timeout: 60_000 },
  // No retries by default — we want a clean signal locally.  CI
  // can opt in via PWTEST_RETRIES.
  retries: process.env.CI ? 1 : 0,
  // CI runs Playwright with 2 workers to halve wall time on the
  // Bundle/Boot specs (each spends 2-3min fetching esm.sh /
  // jsdelivr).  Locally workers=1 keeps test output linear when a
  // developer is iterating on a single spec.  Tests use isolated
  // browser contexts so per-worker IDB / cookies don't collide.
  workers: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? "github" : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    trace: "retain-on-failure",
    // Video deliberately disabled: it is by far the heaviest CI
    // artifact and counts against the 500MB storage quota.  The
    // retained trace already carries DOM snapshots, per-action
    // screenshots, console and network, which is enough to triage
    // a failing spec.
    video: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
