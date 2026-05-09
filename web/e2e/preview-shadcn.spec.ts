// Smoke test for the shadcn pack inside the playground preview.
//
// PR #48 wired the Tailwind Play CDN into the iframe and PR #51
// made the pack loader bundle without `node:fs`.  Without an
// end-to-end check, either fix can silently regress — this spec
// drives the playground through Generate → Bundle → Boot →
// Preview against a `design: shadcn` deployable and asserts the
// iframe renders.
//
// The Generate step alone covers PR #51's regression surface (the
// build worker imports the React generator which transitively
// imports the loader; if the bundled-template glob breaks, Generate
// throws inside the worker).  Bundle/Boot/Preview cover PR #48's
// surface (Tailwind Play CDN injection) and require esm.sh +
// jsdelivr — those steps self-skip when the browser can't reach
// esm.sh, just like runtime.spec.ts.

import { expect, test } from "@playwright/test";
import { browserCanReachEsmSh, waitForPlaygroundReady } from "./_helpers";

test("editor → shadcn-design system → preview boots", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto("/");
  await waitForPlaygroundReady(page);

  await test.step("Inject `design: shadcn` into the webApp deployable", async () => {
    // Mutate the source through the editor exactly the way a user
    // would: open Find, jump to the anchor line, then type the new
    // slot in.  Going through the editor (rather than poking the
    // Monaco model directly) keeps the test honest about real-user
    // behaviour and avoids depending on `monaco-editor` being on
    // `window` (it isn't — the playground imports it as an ES
    // module so the bundler can tree-shake).
    const editor = page.locator(".monaco-editor").first();
    await editor.click();
    await page.keyboard.press("Control+f");
    const findInput = page
      .locator(".monaco-editor .find-widget .find-part textarea, .monaco-editor .find-widget .find-part input")
      .first();
    await findInput.fill("port: 3001");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    // Cursor is now on the matched line.  Move to end of line, add a
    // newline + the new slot.  Indentation matches the existing
    // `port:` line in the example (4 spaces).
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("design: shadcn");
    // Wait for the LSP to re-parse and re-validate.  `0 errors` means
    // the lowerer accepted the new `design:` slot.
    await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 10_000 });
  });

  await test.step("Generate (build worker imports the bundled template loader)", async () => {
    // This is the regression check for PR #51 specifically: the build
    // worker imports the React generator, which transitively imports
    // `loader-fs.js`.  Without the Vite-glob shim, the worker would
    // crash on first Generate with "node:fs externalised".  No
    // network access required.
    await page.getByTestId("btn-generate").click();
    await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });
  });

  if (!(await browserCanReachEsmSh(page))) {
    test.skip(true, "browser cannot reach esm.sh — Bundle/Boot/Preview steps need network");
  }

  await test.step("Bundle", async () => {
    await page.getByTestId("btn-bundle").click();
    await expect(page.getByText(/bundled .*KB in \d+ ms \(\d+ deps fetched\)/)).toBeVisible({
      timeout: 180_000,
    });
  });

  await test.step("Boot", async () => {
    await page.getByTestId("btn-boot").click();
    await expect(page.getByTestId("backend-status")).toHaveText("booted", {
      timeout: 180_000,
    });
  });

  await test.step("Preview renders shadcn output", async () => {
    await page.getByTestId("right-pane-tabs").locator("text=Preview").click();
    const iframe = page.frameLocator('[data-testid="preview-iframe"]');
    // First wait for the iframe to render anything — link copy is
    // shared between packs (both emit "Products"/"Orders"/"Home"
    // labels), so this only proves the bundle booted.
    await expect(iframe.getByText(/Products|Orders|Home/i).first()).toBeVisible({
      timeout: 60_000,
    });
    // Now prove it's *shadcn*, not Mantine: shadcn's app-shell wraps
    // the layout in Tailwind utility classes (`min-h-screen flex …`).
    // Mantine uses its own AppShell component that emits no Tailwind
    // utilities.  Asserting on a Tailwind class directly catches
    // silent fallback-to-Mantine — e.g. if the lowerer ever defaulted
    // an unknown `design:` to `"mantine"` instead of erroring.
    const root = iframe.locator("body > div").first();
    await expect(root).toHaveClass(/min-h-screen/);
  });

  // Same noise filter as runtime.spec.ts.
  const fatal = consoleErrors.filter(
    (m) =>
      !/Fetch failed \(503\)/.test(m) &&
      !/passive event listener/i.test(m) &&
      !/Using direct eval/i.test(m),
  );
  expect(fatal, "browser console errors during shadcn preview run").toEqual([]);
});
