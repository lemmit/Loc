import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack } from "../../src/generator/_packs/loader-fs.js";
import {
  flattenRequired,
  REQUIRED_PRIMITIVES,
} from "../../src/generator/_packs/required-primitives.js";
import { packFormatForBuiltin, parseBuiltinDesignRef } from "../../src/util/builtin-formats.js";

// ---------------------------------------------------------------------------
// Angular pack-format groundwork (angular-frontend-plan.md Slice 2):
// the `angular` format's required-primitive surface, the `ng1` stack, and
// the builtin registry entries for angularMaterial / primeng / spartanNg.
// ---------------------------------------------------------------------------

describe("angular pack format groundwork", () => {
  it("registers angularMaterial / primeng / spartanNg as angular-format builtins", () => {
    expect(parseBuiltinDesignRef("angularMaterial")?.qualified).toBe("angularMaterial@v1");
    expect(parseBuiltinDesignRef("primeng")?.qualified).toBe("primeng@v1");
    expect(parseBuiltinDesignRef("spartanNg")?.qualified).toBe("spartanNg@v1");
    expect(packFormatForBuiltin("angularMaterial")).toBe("angular");
    expect(packFormatForBuiltin("primeng@v1")).toBe("angular");
    expect(packFormatForBuiltin("spartanNg@v1")).toBe("angular");
  });

  it("angular required set is the display surface only — forms/modal render via the walker, not templates", () => {
    const angular = new Set(flattenRequired(REQUIRED_PRIMITIVES.angular));
    const tsx = new Set(flattenRequired(REQUIRED_PRIMITIVES.tsx));
    // Every shared DISPLAY/layout/input primitive the TSX set requires is
    // required for angular too — except the form/modal family, which Angular
    // renders inline via the `renderCreateForm` walker seam (or stubs), so it
    // ships no `form-of` / `field-input-*` / `form-*` / `modal` templates.
    // `realtime-toast` is the exception among the TSX `form` set: Angular DOES
    // require it (each pack renders the live-event toast into the
    // RealtimeHandlersComponent — channels.md Part I), so it is NOT inline.
    const angularRendersInline = (name: string): boolean =>
      name === "primitive-form-of" ||
      name === "primitive-modal" ||
      name.startsWith("field-input-") ||
      name.startsWith("form-") ||
      name === "op-dialog";
    for (const name of tsx) {
      // Angular builds with `ng build`, so it emits `angular-json`
      // instead of the Vite world's `vite-config`.
      if (name === "vite-config") continue;
      if (angularRendersInline(name)) {
        expect(angular.has(name), `angular should NOT require inline-rendered "${name}"`).toBe(
          false,
        );
        continue;
      }
      expect(angular.has(name), `angular set missing tsx-required "${name}"`).toBe(true);
    }
    // The `ng build` shell delta: angular-json in, vite-config out.
    expect(angular.has("angular-json")).toBe(true);
    expect(angular.has("vite-config")).toBe(false);
  });

  it("an angular-format pack loads against the ng1 stack and sees its partials + shared sources", () => {
    // Synthesize a minimal angular pack (validateRequired off — this
    // probes stack/shared-source resolution, not the primitive gate).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-angular-stack-"));
    fs.writeFileSync(
      path.join(dir, "pack.json"),
      JSON.stringify({
        name: "fixture-angular",
        version: "0.0.0",
        format: "angular",
        stack: "ng1",
        emits: { "package-json": "package-json.hbs" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "package-json.hbs"),
      '{ "dependencies": {\n{{> stack-package-deps}}\n}, "devDependencies": {\n{{> stack-package-devdeps}}\n} }',
    );
    const pack = loadPack(dir, { validateRequired: false });
    const rendered = pack.render("package-json", {});
    expect(rendered).toContain('"@angular/core": "^22.0.0"');
    expect(rendered).toContain('"@angular/router"');
    expect(rendered).toContain('"@angular/forms"');
    expect(rendered).toContain('"rxjs"');
    expect(rendered).toContain('"@angular/cli"');
    // TanStack Angular Query backs the server-state layer (caching + invalidation).
    expect(rendered).toContain("@tanstack/angular-query-experimental");
    // The angular format reads `angular/` + `api/` shared dirs: its own
    // `ng build` dockerfile and the framework-neutral api fetch client
    // must both resolve.  `docker/` (the vite two-stage) is NOT included.
    expect(pack.templates.has("dockerfile")).toBe(true);
    expect(pack.templates.has("api-client")).toBe(true);
    // index-html resolves to the ANGULAR shared layer (<app-root>, the
    // CLI injects bundles), not the Vite worlds' manual main script.
    const indexHtml = pack.render("index-html", { title: "t" });
    expect(indexHtml).toContain("<app-root></app-root>");
    expect(indexHtml).toContain('<base href="/" />');
    expect(indexHtml).not.toContain("main.tsx");
    expect(indexHtml).not.toContain("/src/main.ts");
  });
});
