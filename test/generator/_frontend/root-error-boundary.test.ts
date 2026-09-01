// M-T1.8 — a root RENDER-TIME error boundary.
//
// React has shipped one since `src/ErrorBoundary.tsx`: a component that throws
// while rendering shows a readable fallback and logs, instead of tearing the
// whole app down to a blank page.  Svelte and Angular shipped none —
// `grep -rilE 'errorboundary|onErrorCaptured|svelte:boundary|ErrorHandler'
// designs/` matched only the tsx packs plus shadcnVue and vuetify, and no
// `loom.*` code covered the gap.
//
//   svelte  → `<svelte:boundary>` with a `failed` snippet, in the shared
//             `sveltekit/root-layout.hbs` (one file, both Svelte packs).
//             Needs Svelte >= 5.3, so the sv1 stack floor moved with it.
//   angular → no component-level boundary exists, and the DEFAULT
//             `ErrorHandler` only logs.  A `LoomErrorHandler` records the
//             error in a signal, `app.config.ts` provides it as the app's
//             `ErrorHandler`, and the shell renders it as a banner.
//
// Feliz, Flutter and HEEx are the remaining three of the row's five targets;
// they live in other packets' trees and are untouched here.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function project(platform: string, pack: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui Web { page P { route: "/p" body: Text { "hi" } } }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: ${platform}, design: "${pack}", targets: api, ui: Web, port: 3001 }
    }
  `);
}

describe("root render-time error boundary", () => {
  for (const pack of ["shadcnSvelte", "flowbite"]) {
    it(`svelte/${pack}: the root layout wraps the app in <svelte:boundary>`, async () => {
      const files = await project("svelte", pack);
      const layout = files.get("web/src/routes/+layout.svelte")!;
      expect(layout).toBeTruthy();
      expect(layout).toContain("<svelte:boundary");
      // A boundary with no `failed` snippet still swallows the error and
      // renders NOTHING — the blank page this row is about.
      expect(layout).toContain("{#snippet failed(error)}");
      expect(layout).toContain('role="alert"');
      // …and it logs, so the playground App-log stream / Playwright console
      // capture see it.
      expect(layout).toContain('console.error("Uncaught render error:"');
      // The children still render inside the boundary.
      expect(layout).toContain("{@render children()}");
    });
  }

  it("svelte: the boundary heading is BOUND to the chrome catalog, not raw", async () => {
    // The heading is pack chrome.  `chrome.rootErrorTitle` (with the full
    // stop) is the STANDALONE-root-module key — React's src/ErrorBoundary.tsx
    // and, structurally, Svelte's root +layout.svelte, both mounted outside the
    // app shell.  The IN-shell banner (Angular's) uses
    // `chrome.somethingWentWrong` instead; mixing them leaves a raw string
    // bound to the wrong key, which pack-chrome-i18n.test.ts refuses.
    const files = await project("svelte", "shadcnSvelte");
    const layout = files.get("web/src/routes/+layout.svelte")!;
    expect(layout).toContain('t("chrome.rootErrorTitle", "Something went wrong.")');
    expect(layout).toContain('import { t } from "$lib/i18n";');
    expect(files.get("web/src/lib/locales/en.json")!).toContain("rootErrorTitle");
  });

  it("angular: the banner heading uses the IN-SHELL chrome key", async () => {
    const files = await project("angular", "angularMaterial");
    const shell = files.get("web/src/app/app.component.ts")!;
    expect(shell).toContain('t("chrome.somethingWentWrong", "Something went wrong")');
  });

  it("svelte: the stack floor covers <svelte:boundary> (Svelte >= 5.3)", async () => {
    const files = await project("svelte", "shadcnSvelte");
    expect(files.get("web/package.json")!).toContain('"svelte": "^5.3.0"');
  });

  for (const pack of ["angularMaterial", "primeng", "spartanNg"]) {
    it(`angular/${pack}: a LoomErrorHandler is emitted, provided and rendered`, async () => {
      const files = await project("angular", pack);
      const handler = files.get("web/src/app/error-handler.ts")!;
      expect(handler).toBeTruthy();
      expect(handler).toContain("export class LoomErrorHandler implements ErrorHandler {");
      expect(handler).toContain("readonly lastError = signal<Error | null>(null);");
      expect(handler).toContain('console.error("Uncaught render error:", err);');

      // Provided as THE app's ErrorHandler — otherwise it records nothing.
      const config = files.get("web/src/app/app.config.ts")!;
      expect(config).toContain("{ provide: ErrorHandler, useExisting: LoomErrorHandler }");
      expect(config).toContain('import { LoomErrorHandler } from "./error-handler";');

      // …and the shell RENDERS it: a handler that only logs is the default
      // Angular behaviour this row exists to replace.
      const shell = files.get("web/src/app/app.component.ts")!;
      expect(shell).toContain("readonly errors = inject(LoomErrorHandler);");
      expect(shell).toContain("@if (errors.lastError(); as err) {");
      expect(shell).toContain('data-testid="root-error"');
      expect(shell).toContain("{{ err.message }}");
    });
  }
});
