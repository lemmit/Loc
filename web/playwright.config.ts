import { defineConfig, devices } from "@playwright/test";

// E2E for the playground.  Drives a real Chromium instance against
// `vite preview`, which serves the production-built `dist/` (the
// same artifact CI deploys to GitHub Pages).  Using `preview`
// rather than `dev` catches issues that only surface post-bundling
// — e.g. the Monaco worker glue, the esbuild WASM URL resolution,
// and the npm-pglite postprocess rewrite all run as they would in
// production.
//
// Heads up: the spec calls `Bundle` which installs real npm tarballs
// from the registry and `Boot` which downloads PGlite's WASM + .data
// from jsdelivr.  Tests need real internet access and generous
// per-action timeouts.

export default defineConfig({
  testDir: "./e2e",
  // Whole-test timeout: bundle + WASM + first dispatch take time.
  // The `*-preview-runtime` specs (chakra-v3, mantine-v9, mui-v7, shadcn)
  // can spend 5+ minutes on the in-browser npm-install bundle on CI —
  // the workload is mostly CPU-bound (esbuild-wasm bundling 200+ modules
  // in a single worker thread). 240s and 480s both fell short. 720s
  // (12 min) gives 10 min for bundle + 10 min for boot per spec without
  // letting a genuinely stuck spec eat unbounded time.
  timeout: 720_000,
  expect: { timeout: 60_000 },
  // No retries by default — we want a clean signal locally.  CI
  // can opt in via PWTEST_RETRIES.
  retries: process.env.CI ? 1 : 0,
  // Single worker, including on CI.  The heavy Bundle/Boot specs that
  // motivated 2-worker parallelism are now quarantined (#1242, #1261), so the
  // wall-time argument is moot — and parallel load was the sole cause of
  // popover/canvas re-render races (the `workspace-create` button and builder
  // canvas nodes detaching mid-click).  1 worker matches the green local run
  // and keeps the suite well under the job cap (~14min).  Tests still use
  // isolated browser contexts.
  workers: 1,
  // `list` is the live signal: when the job is time-capped mid-run the
  // `github` reporter emits nothing until the end, giving zero
  // diagnostic signal.  `list` prints per-spec ok/✘/timing live so a
  // capped run still tells us which specs are slow vs stuck.
  //
  // `html` is the post-mortem artifact.  It writes playwright-report/
  // (with the retained traces embedded) — exactly the path the CI
  // workflow uploads on failure.  Without it that upload step finds
  // nothing, so a failed run shipped zero diagnostics; `open: "never"`
  // stops it spawning a browser in CI.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    // Bound individual actions + navigations.  Playwright's default
    // `actionTimeout`/`navigationTimeout` is 0 (UNBOUNDED) — a `.click()`
    // / `.fill()` whose target never becomes actionable then auto-waits
    // for the WHOLE-TEST `timeout` (720s) before failing.  That turned a
    // missing element (e.g. a file-tree entry that didn't render, or a
    // diagram node that never laid out) into a silent 12-min hang ×2
    // retries that ate the job cap and — because the job ended
    // `cancelled` — flushed no HTML report (#697).  A 45s action cap
    // fails such a spec fast WITH the offending locator named, lets the
    // suite run to COMPLETION, and ships the report.  It does not touch
    // the deliberate long `expect(...).toBeVisible({ timeout })` waits on
    // bundle/boot (those are assertions, not actions).
    actionTimeout: 45_000,
    navigationTimeout: 60_000,
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
