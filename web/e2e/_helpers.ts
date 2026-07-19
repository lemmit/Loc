import { type Page, expect } from "@playwright/test";

// Probe the npm registry from the page context so the test can decide
// whether to exercise the network-dependent bundle/boot stages.  The
// playground installs real npm tarballs in-browser, so the registry
// is the first external dependency; some CI / sandbox environments
// allow Node-side network but block browser-context cross-origin
// fetches, in which case we skip the network steps cleanly instead of
// failing the run.  A real CORS GET against a tiny known-good URL
// (registry.npmjs.org sets `access-control-allow-origin: *`), with an
// AbortController cap so the probe can't hang the whole test.
export async function browserCanReachNetwork(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch("https://registry.npmjs.org/react/latest", {
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  });
}

// Wait for the playground to have rendered + the LSP worker to
// have parsed the starter source (visible as the "0 errors" badge).
export async function waitForPlaygroundReady(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: /Loom Playground/i })).toBeVisible();
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });
}

// Console / page-error messages that are known, non-fatal noise — they
// signal neither a broken generated bundle nor a broken editor.  ONE
// allow-list shared by every console-asserting e2e spec.  These filters
// were copy-pasted inline across the specs and DRIFTED: `editor.spec`
// learned to suppress the @codingame/monaco-vscode-api init rejections
// while the six preview-runtime gates never did, so every nightly
// Playground-e2e run went red on host noise the editor smoke already
// treated as expected.  Centralising kills that drift class.
//
// Two families:
//   1. Host playground noise that fires regardless of the preview iframe:
//      - @codingame/monaco-vscode-api lightweight EditorService-mode init
//        rejections.  The playground runs the api without a views service
//        (loom-services.ts); registering the `ddd` grammar extension makes
//        monaco's contribution processing touch the views registry, so it
//        logs `getViewContainersByLocation is not supported` and a service
//        whose `.startup` is missing.  Editor + LSP work regardless; a
//        views-service-override to silence them at the source was tried and
//        *breaks* the editor, so they're the intended lightweight-mode
//        trade-off.  Each surfaces twice — a console "Unhandled promise
//        rejection:" and a window "pageerror:".
//      - The build worker's correctness-preserving respawn (build/client.ts)
//        rejects any in-flight RPC with "Build worker respawned; retry the
//        operation."; it's recovered transparently and is host plumbing,
//        not an iframe runtime error.
//      - esbuild-wasm's direct-eval advisory (PGlite loader), Chrome's
//        passive-listener advisory, vite HMR dynamic-import failures.
//   2. Transient registry / CDN failures while the in-browser bundler
//      fetches deps under load (npm 50x, CORP) — not a bundle defect.
//
// Anchored (with an optional "console: " capture prefix that some specs
// prepend) so a real error that merely *contains* the noise text mid-stack
// can't hide behind an entry.
export const KNOWN_CONSOLE_NOISE: RegExp[] = [
  /Fetch failed \(50[34]\)/,
  /Cross-Origin-Resource-Policy/i,
  /Using direct eval/i,
  /passive event listener/i,
  /Failed to fetch dynamically imported module/i,
  /^(?:console: )?Unhandled promise rejection: TypeError: .*\bstartup is not a function\b/,
  /^pageerror: .*\bstartup is not a function\b/,
  /^(?:console: )?Unhandled promise rejection: Error: Unsupported: .*getViewContainersByLocation is not supported/,
  /^pageerror: Unsupported: .*getViewContainersByLocation is not supported/,
  /^(?:console: )?Unhandled promise rejection: Error: Build worker respawned; retry the operation/,
  /^pageerror: Build worker respawned; retry the operation/,
];

// Drop the known-noise entries from a captured console/page-error list,
// returning only messages that signal a genuinely broken bundle or editor.
export function fatalConsoleErrors(messages: string[]): string[] {
  return messages.filter((m) => !KNOWN_CONSOLE_NOISE.some((re) => re.test(m)));
}

// On a preview-render failure, dump what the in-browser bundle actually
// produced.  The nightly job log otherwise shows only the bare
// `getByText(...).toBeVisible` timeout — never WHY the generated app didn't
// mount.  Surfaces two things the trace artifact would otherwise be the only
// source of:
//   1. the RAW captured console/page errors (UNfiltered — the real iframe
//      React crash hides among the host noise `fatalConsoleErrors`
//      allow-lists, so we print everything here);
//   2. the preview iframe's own `<body>` HTML — an error-boundary message or
//      an empty root tells us mount-vs-blank at a glance.
// Best-effort: never throws (callers rethrow the original assertion error).
export async function dumpPreviewDiagnostics(
  page: Page,
  captured: string[],
  label: string,
): Promise<void> {
  console.log(
    `[${label}] preview iframe did not render — ${captured.length} captured console/page error(s):`,
  );
  for (const m of captured) console.log(`  ${m.slice(0, 400)}`);
  const body = page.frameLocator('[data-testid="preview-iframe"]').locator("body");
  // Visible innerText is the decisive signal: it tells us whether the app
  // actually rendered content (and, if the target nav/landing text is present
  // at all, whether it's merely off-screen / in a collapsed drawer vs absent).
  try {
    const text = await body.innerText({ timeout: 5_000 });
    console.log(`[${label}] preview iframe innerText (first 1500 chars):\n${text.slice(0, 1500)}`);
  } catch (e) {
    console.log(`[${label}] could not read preview iframe innerText: ${(e as Error).message}`);
  }
  // Does the gate's target text exist in the DOM at all, and is any match
  // visible?  Distinguishes "not rendered" from "rendered but not visible".
  try {
    const target = page
      .frameLocator('[data-testid="preview-iframe"]')
      .getByText(/Welcome/i);
    const total = await target.count();
    let visible = 0;
    for (let i = 0; i < total; i++) {
      if (await target.nth(i).isVisible().catch(() => false)) visible++;
    }
    console.log(`[${label}] target-text matches: ${total} in DOM, ${visible} visible`);
  } catch (e) {
    console.log(`[${label}] could not probe target text: ${(e as Error).message}`);
  }
  try {
    const html = await body.innerHTML({ timeout: 5_000 });
    console.log(`[${label}] preview iframe <body> (first 2000 chars):\n${html.slice(0, 2000)}`);
  } catch (e) {
    console.log(`[${label}] could not read preview iframe <body>: ${(e as Error).message}`);
  }
}

// Open a specific example.  Examples are now starting points for
// workspaces (not a destructive "replace active" dropdown), so this
// creates a NEW workspace seeded from `label` via the WorkspaceSwitcher
// "+" popover: open it, choose the example, Create.  Tests that rely on
// a particular starter source call this after `waitForPlaygroundReady`.
//
// We target `role="textbox"` with the accessible name (not `getByLabel`)
// because Mantine threads the same `aria-label` onto both the `<input>`
// AND the listbox container; `getByRole("textbox")` limits to the input.
export async function selectExample(page: Page, label: string | RegExp): Promise<void> {
  await page.getByTestId("workspace-new").click();
  await page.getByRole("textbox", { name: "Choose example" }).click();
  await page.getByRole("option", { name: label }).first().click();
  await clickWorkspaceCreate(page);
  // Re-wait for the LSP "0 errors" badge — the new workspace remounts
  // the editor and re-parses the source, so the badge momentarily
  // flickers to "—" before the new source validates.
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });
}

// Click the "Create workspace" button in the new-workspace popover, robustly.
//
// Call this AFTER the example option has been chosen.  The create popover is
// held open across the option pick by `closeOnClickOutside={false}` on the
// Mantine Popover (see WorkspaceSwitcher.tsx) — that's what stops it
// auto-dismissing when the portal'd example option is clicked.  This retry is
// the belt-and-braces for any remaining transient (a click landing mid
// re-render): re-find the button each attempt and stop once the popover
// closes (`workspace-create` is absent once the workspace is created).
export async function clickWorkspaceCreate(page: Page): Promise<void> {
  const create = page.getByTestId("workspace-create");
  await expect(async () => {
    await create.click({ timeout: 5_000 });
    await expect(create).toBeHidden({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

// Wait for the in-browser Hono bundle to settle, racing the success banner
// against the footer's error state.
//
// Why not just `expect(successBanner).toBeVisible({ timeout: 600_000 })`:
// the bundler worker already caps a single run at 180s (RUN_TIMEOUT_MS in
// vfs-bundler-client.ts) and, on any failure — an esbuild error, a dep that
// won't resolve, or a network stall that trips that cap — settles the result
// to `{ ok: false }`.  The footer then reads `bundle: N error(s)` and the
// Files pane shows the worker's message.  A success-only wait ignores that
// settled failure and burns the whole 600s before reporting a useless
// "locator not found", hiding *why* the bundle broke.  Racing the two states
// fails fast with the real message while keeping the generous ceiling for a
// legitimately-slow cold npm install on the happy path.
export async function waitForBundle(page: Page, timeout = 600_000): Promise<void> {
  const ok = page.getByText(/bundled [\d.]+ [KM]?B in \d+ ms \(\d+ deps fetched\)/);
  const failed = page.getByText(/bundle: \d+ error\(s\)/);
  await expect(ok.or(failed).first()).toBeVisible({ timeout });
  if (await failed.isVisible()) {
    // Surface the worker's actual diagnostic (the auto-rendered bundle-error
    // drawer in the Files pane) so the failure is actionable, not just a count.
    const drawer = page.getByTestId("bundle-errors");
    const detail = (await drawer.count()) ? await drawer.innerText().catch(() => "") : "";
    throw new Error(`In-browser bundle failed (${await failed.innerText()}).\n${detail}`.trim());
  }
}
