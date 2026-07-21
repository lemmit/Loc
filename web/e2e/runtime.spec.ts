// Full pipeline E2E: Bundle → Boot → dispatch HTTP requests against
// the in-browser Hono backend.  Requires real internet because the
// in-browser npm install fetches ~150 module tarballs from the npm
// registry and the runtime worker fetches PGlite's WASM + .data from
// jsdelivr.
//
// The spec self-skips if the test browser can't reach the npm registry —
// some sandbox environments allow Node-side network but block
// browser-context cross-origin fetches.  GitHub Pages deploys and
// any normal dev box pass this probe trivially.

import { expect, test } from "@playwright/test";
import {
  browserCanReachNetwork,
  fatalConsoleErrors,
  selectExample,
  waitForBundle,
  waitForPlaygroundReady,
} from "./_helpers";

// #1242 (fixed): the bundle toast asserted "…KB…" but the Hono bundle is
// MB-scale, so the KB-only regex never matched — read as a 600s "stall".  The
// matcher below is unit-agnostic ([\d.]+ [KM]?B).
// #1468 (fixed): the boot click then timed out at 45s — not boot-button gating
// but the boot button being *absent*.  The four-region dock defaults to the
// Output tab; `btn-boot` only mounts on the Runtime ("backend") tab, so the
// click waited forever for an element that was never rendered.  Switch to the
// Runtime tab before booting (same idiom as workspace-history.spec.ts).
test("editor → generate → bundle → boot → dispatch", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto("/");
  await waitForPlaygroundReady(page);
  // Pin sales-system explicitly — the default example moved when
  // the storybook entries were added at the top of the dropdown.
  await selectExample(page, /Sales System/);

  if (!(await browserCanReachNetwork(page))) {
    test.skip(true, "browser cannot reach the npm registry from this environment");
  }

  await test.step("Generate", async () => {
    await page.getByTestId("btn-generate").click();
    await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });
  });

  await test.step("Bundle", async () => {
    await page.getByTestId("btn-bundle").click();
    await waitForBundle(page);
  });

  await test.step("Boot", async () => {
    // The boot button lives on the dock's Runtime tab, which isn't the
    // default (Output) — switch to it so btn-boot is actually mounted.
    await page.getByTestId("devtools-tab-backend").click();
    await page.getByTestId("btn-boot").click();
    await expect(page.getByTestId("backend-status")).toHaveText("booted", {
      timeout: 600_000,
    });
  });

  await test.step("GET /products → 200 empty page", async () => {
    await page.getByTestId("btn-send").click();
    try {
      await expect(page.getByTestId("resp-status")).toContainText("200", { timeout: 30_000 });
    } catch (e) {
      // The dispatch resolves the status badge but never to "200" in CI —
      // surface what it *did* return (status + body) so the next run shows
      // whether the in-browser Hono/PGlite backend errored, 404'd, or hung.
      const status = await page.getByTestId("resp-status").innerText().catch(() => "<none>");
      const body = await page.getByTestId("resp-body").innerText().catch(() => "<none>");
      console.log(`[runtime] GET /products did not return 200 — resp-status="${status}" resp-body=${body.slice(0, 400)}`);
      console.log(`[runtime] captured console/page errors:\n${consoleErrors.map((m) => "  " + m.slice(0, 300)).join("\n")}`);
      throw e;
    }
    // The implicit `all` find is paged-by-default (M-T2.6, DEBT-28): the
    // relational Product findAll returns the `{items,page,pageSize,total,
    // totalPages}` envelope, not a bare `[]`.  Empty table → `items:[]`.
    await expect(page.getByTestId("resp-body")).toHaveText(/"items":\s*\[\]/);
  });

  await test.step("Endpoint picker discovers the OpenAPI contract", async () => {
    // The picker is populated from the booted backend's /openapi.json.
    // Selecting the create operation flips method → POST and reveals
    // the body editor with a Generate-example affordance.
    await page.getByTestId("req-endpoint").click();
    // Tolerant of the `/api` route prefix the generated backend mounts under
    // (the option label is verb + the OpenAPI path); selecting it sets `reqPath`
    // to whatever concrete path the picker carries, so the dispatch below hits
    // the real route regardless of the prefix.
    await page.getByRole("option", { name: /^POST \/(api\/)?products$/ }).click();
    // `req-method` is a readonly Mantine <input> — its verb lives in `value`,
    // not text content, so assert on the value (toContainText reads "").
    await expect(page.getByTestId("req-method")).toHaveValue("POST");
    await expect(page.getByTestId("btn-gen-example")).toBeVisible();
  });

  await test.step("POST /products → 201", async () => {
    // req-body is a Monaco editor (a div, not a textarea).  Set its content
    // via the `__loomSetRequestBody` automation seam (model.setValue, fires
    // onChange) rather than keystrokes: the picker prefilled a schema example,
    // and the playground's VS Code-based editor build doesn't wire Ctrl+A
    // select-all for standalone editors, so select-all+insertText silently
    // *appended* the new object to the example → two concatenated JSON objects
    // → "Malformed JSON in request body" (a deterministic 500).  setValue
    // replaces atomically and sidesteps that.
    const body = page.getByTestId("req-body");
    await expect(body).toBeVisible();
    // Wait for the editor's automation seam to register (set in its mount
    // effect, which can lag the container becoming visible).
    await page.waitForFunction(
      () => typeof (window as unknown as { __loomSetRequestBody?: unknown }).__loomSetRequestBody === "function",
    );
    await page.evaluate(
      (json) =>
        (window as unknown as { __loomSetRequestBody?: (t: string) => void }).__loomSetRequestBody?.(
          json,
        ),
      JSON.stringify({ sku: "PW-1", price: { amount: 9.99, currency: "USD" } }),
    );
    // Confirm the model actually holds the new body (single-line compact JSON
    // renders fully in Monaco's DOM) before dispatching.
    await expect(body).toContainText('"sku"');
    await page.getByTestId("btn-send").click();
    try {
      await expect(page.getByTestId("resp-status")).toContainText("201", { timeout: 30_000 });
    } catch (e) {
      // The create dispatch reaches the backend but doesn't 201 in CI — dump
      // the actual status + body (a 500 would carry the server error/stack)
      // and any console errors, so the next run shows the real cause.
      const status = await page.getByTestId("resp-status").innerText().catch(() => "<none>");
      const respBody = await page.getByTestId("resp-body").innerText().catch(() => "<none>");
      console.log(`[runtime] POST create did not return 201 — resp-status="${status}" resp-body=${respBody.slice(0, 800)}`);
      console.log(`[runtime] captured console/page errors:\n${consoleErrors.map((m) => "  " + m.slice(0, 300)).join("\n")}`);
      // The backend sanitizes the 500 body to "internal"; the real err.message
      // is logged (`event: internal_error`) via the worker's pino → the
      // console-tee routes it into the Backend Logs panel, not the page
      // console.  Dump that panel to get the actual exception.
      const backendLog = await page
        .getByTestId("output-backend-log")
        .textContent()
        .catch(() => "<panel not found>");
      console.log(`[runtime] backend log panel:\n${(backendLog ?? "").slice(0, 2500)}`);
      throw e;
    }
    await expect(page.getByTestId("resp-body")).toContainText(/"id":\s*".+"/);
  });

  await test.step("GET /products → returns the inserted product", async () => {
    await page.getByTestId("req-method").click();
    await page.getByRole("option", { name: "GET" }).click();
    await page.getByTestId("btn-send").click();
    await expect(page.getByTestId("resp-status")).toContainText("200", { timeout: 30_000 });
    const text = await page.getByTestId("resp-body").textContent();
    expect(text, "list response body").toBeTruthy();
    // Paged envelope (see the empty-page step above): the product rides in
    // `items`, with `total` reflecting the single inserted row.
    const parsed = JSON.parse(text!);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe(1);
    expect(parsed.items[0].sku).toBe("PW-1");
    expect(parsed.items[0].price.amount).toBe(9.99);
    expect(parsed.items[0].price.currency).toBe("USD");
  });

  await test.step("Database console runs SQL against PGlite", async () => {
    // Switch the Runtime tab to its Database sub-view and run the
    // built-in "List tables" query — exercises the query() RPC end to
    // end. The table_name column header is schema-independent, so it's
    // a stable assertion regardless of the example's aggregates.
    await page.getByTestId("runtime-subview").getByText("Database").click();
    await page.getByTestId("btn-list-tables").click();
    const result = page.getByTestId("sql-result");
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result).toContainText("table_name");
  });

  await test.step("Preview loads the React app via the sandbox bridge", async () => {
    // The Preview tab is only meaningful when the source has a
    // React deployable.  The default Sales System example does;
    // assertions guard against running on a single-context source.
    //
    // In the four-region shell the Preview is always mounted (no tab
    // to click); mounting the iframe loads the static stub from
    // SANDBOX_ORIGIN, the parent hands it the synthesised document +
    // a MessagePort, the stub `document.write`s the app, and the
    // app's API fetches ride the bridge back to the runtime worker.
    // A visible heading proves the document was delivered and booted;
    // the data round-trip is exercised by the app's own list query.
    await expect(page.getByTestId("preview-region")).toBeVisible();

    const iframe = page.frameLocator('[data-testid="preview-iframe"]');
    // Mantine renders into the iframe — wait for any visible heading
    // or the home-page link list the React generator emits.
    await expect(iframe.getByText(/Products|Orders|Home/i).first()).toBeVisible({
      timeout: 60_000,
    });
  });

  // Final guard: surface any uncaught console errors that escaped
  // (Monaco workers, PGlite WASM loader, etc.).  Allow npm registry
  // transient 503s the bundler retries through, and PGlite's
  // direct-eval warnings that have no functional impact.
  const fatal = fatalConsoleErrors(consoleErrors);
  expect(fatal, "browser console errors during full run").toEqual([]);
});
