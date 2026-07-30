// Crash boundaries + crash reporting (M-T8.14).
//
// The error boundaries had NO e2e coverage before this: `builder-page.spec.ts`
// can only assert the fallback *doesn't* appear, which passes just as well
// when the boundary is broken.  Covering it needs a deliberate throw, and it
// has to survive bundling — `playwright.config.ts` runs `vite build` + `vite
// preview`, so an `import.meta.env.DEV`-gated trigger would be compiled out.
// Hence the unconditional `?crash=app|pane` query parameter (see
// `web/src/CrashTestHooks.tsx`), which doubles as a user-facing self-test.
//
// Network-free: nothing here bundles, boots, or fetches — the whole spec is
// DOM + localStorage, so it belongs to the per-PR no-network lane.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("?crash=app renders the ROOT fallback with working report actions", async ({ page }) => {
  await page.goto("/?crash=app");

  const fallback = page.getByTestId("app-crash-fallback");
  await expect(fallback).toBeVisible();
  // The escape hatches the fallback has always offered stay reachable.
  await expect(page.getByTestId("app-crash-reload")).toBeVisible();
  await expect(page.getByTestId("app-crash-reset")).toBeVisible();

  // The crash reached the ring WITH its payload — the whole point of slice 1.
  const ring = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("loom.diag") ?? "[]"),
  );
  const crash = ring.find((s: { reason: string }) => s.reason === "react-error");
  expect(crash).toBeTruthy();
  expect(crash.detail.message).toContain("Forced crash (app)");
  expect(crash.detail.stack.length).toBeGreaterThan(0);
  expect(crash.detail.componentStack.length).toBeGreaterThan(0);
  // Build identity — a `vite build` always injects one (a git SHA here).
  expect(typeof crash.build.sha).toBe("string");
  expect(crash.build.sha.length).toBeGreaterThan(0);

  // "Report on GitHub" resolves to a well-formed, budget-respecting issue-form
  // URL prefilled BY FIELD ID (an issue form ignores `?body=`).
  const github = fallback.getByTestId("crash-report-github");
  await expect(github).toBeEnabled();
  const href = await github.getAttribute("href");
  expect(href).toBeTruthy();
  const url = new URL(href!);
  expect(url.origin + url.pathname).toBe("https://github.com/lemmit/Loc/issues/new");
  expect(url.searchParams.get("template")).toBe("crash-report.yml");
  expect(url.searchParams.get("labels")).toBe("crash-report");
  expect(url.searchParams.get("body")).toBeNull();
  expect(url.searchParams.get("report")).toContain("Loom playground crash report");
  expect(href!.length).toBeLessThanOrEqual(6000);

  // Copy renders exactly what it put on the clipboard, so the user can read
  // it before sharing (and so this assertion needs no clipboard permission).
  await fallback.getByTestId("crash-report-copy").click();
  const preview = fallback.getByTestId("crash-report-preview");
  await expect(preview).toBeVisible();
  const report = (await preview.textContent()) ?? "";
  expect(report).toContain("Loom playground crash report");
  expect(report).toContain("react-error");
  expect(report).toContain("Forced crash (app)");
  expect(report).toContain("| build |");
});

test("?crash=pane CONTAINS the crash to the pane", async ({ page }) => {
  await page.goto("/?crash=pane");

  // The pane fallback is up …
  const pane = page.getByTestId("pane-crash-fallback");
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("Crash self-test");
  // … the root one is not, and the rest of the playground booted normally.
  await expect(page.getByTestId("app-crash-fallback")).toHaveCount(0);
  await waitForPlaygroundReady(page);

  // The ring attributes it to the pane — a contained crash must not be
  // indistinguishable from a whole-app one.
  const ring = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("loom.diag") ?? "[]"),
  );
  const crash = ring.find((s: { reason: string }) => s.reason === "react-error-pane");
  expect(crash).toBeTruthy();
  expect(crash.detail.pane).toBe("Crash self-test");
  expect(crash.detail.message).toContain("Forced crash (pane)");

  await expect(pane.getByTestId("crash-report-github")).toBeEnabled();
});

test("the next boot says the last session crashed, and dismiss clears it", async ({ page }) => {
  // Crash once …
  await page.goto("/?crash=app");
  await expect(page.getByTestId("app-crash-fallback")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("loom.diag.lastCrash")))
    .not.toBeNull();

  // … then reload CLEAN: the notice is the boot-time signal that a report is
  // worth filing (nothing read the ring on boot before slice 2).
  await page.goto("/");
  const notice = page.getByTestId("last-crash-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("react-error");
  await expect(notice.getByTestId("crash-report-copy")).toBeVisible();

  await notice.getByTestId("last-crash-dismiss").click();
  await expect(notice).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("loom.diag.lastCrash")),
  ).toBeNull();

  // Dismissed is dismissed — it must not come back on the next load.
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await expect(page.getByTestId("last-crash-notice")).toHaveCount(0);
});

test("the Diagnostics stream exposes the same report actions", async ({ page }) => {
  await page.goto("/?crash=pane");
  await waitForPlaygroundReady(page);

  await page.getByTestId("devtools-tab-output").click();
  await page.getByTestId("output-stream-select").click();
  await page.getByRole("option", { name: "Diagnostics" }).click();

  // The ring row now carries the message, not just the reason badge.
  const list = page.getByTestId("output-diag-list");
  await expect(list).toBeVisible();
  await expect(list).toContainText("react-error-pane");
  await expect(list).toContainText("Forced crash (pane)");

  await page.getByTestId("output-diag-refresh").click();
  // Scoped: the pane fallback is still on screen with its own copy of the
  // buttons — which is the point (same component, same report, three homes).
  const actions = page.getByTestId("output-diag-report");
  await expect(actions.getByTestId("crash-report-github")).toBeEnabled();
  await actions.getByTestId("crash-report-copy").click();
  await expect(actions.getByTestId("crash-report-preview")).toContainText(
    "Loom playground crash report",
  );
});
