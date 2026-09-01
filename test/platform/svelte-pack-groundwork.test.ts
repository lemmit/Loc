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
// Svelte pack-format groundwork (svelte-frontend-plan.md Slice 3):
// the `svelte` format's required-primitive surface, the `sv1` stack,
// and the builtin registry entries for shadcnSvelte / flowbite.
// ---------------------------------------------------------------------------

describe("svelte pack format groundwork", () => {
  it("registers shadcnSvelte + flowbite as svelte-format builtins with v1 defaults", () => {
    expect(parseBuiltinDesignRef("shadcnSvelte")?.qualified).toBe("shadcnSvelte@v1");
    expect(parseBuiltinDesignRef("flowbite")?.qualified).toBe("flowbite@v1");
    expect(packFormatForBuiltin("shadcnSvelte")).toBe("svelte");
    expect(packFormatForBuiltin("flowbite@v1")).toBe("svelte");
  });

  it("svelte required set mirrors TSX (forms + field inputs owned by the pack) plus svelte-config", () => {
    const svelte = new Set(flattenRequired(REQUIRED_PRIMITIVES.svelte));
    const tsx = new Set(flattenRequired(REQUIRED_PRIMITIVES.tsx));
    // `primitive-chart` is TSX-ONLY (M-T1.3 Phase 5): each react pack binds its
    // own charting library, and no svelte pack ships a chart template — `Chart`
    // stays an honest `loom.chart-unsupported-target` gap here.
    tsx.delete("primitive-chart");
    for (const name of tsx) {
      expect(svelte.has(name), `svelte set missing tsx-required "${name}"`).toBe(true);
    }
    expect(svelte.has("svelte-config")).toBe(true);
    expect(svelte.size).toBe(tsx.size + 1);
  });

  it("a svelte-format pack loads against the sv1 stack and sees its partials + docker shared sources", () => {
    // Synthesize a minimal svelte pack (validateRequired off — this
    // probes stack/shared-source resolution, not the primitive gate).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-svelte-stack-"));
    fs.writeFileSync(
      path.join(dir, "pack.json"),
      JSON.stringify({
        name: "fixture-svelte",
        version: "0.0.0",
        format: "svelte",
        stack: "sv1",
        emits: { "package-json": "package-json.hbs" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "package-json.hbs"),
      '{ "dependencies": {\n{{> stack-package-deps}}\n}, "devDependencies": {\n{{> stack-package-devdeps}}\n} }',
    );
    const pack = loadPack(dir, { validateRequired: false });
    const rendered = pack.render("package-json", {});
    expect(rendered).toContain('"@tanstack/svelte-query"');
    // 5.3 is the floor for `<svelte:boundary>`, which the root layout uses
    // for the render-time error boundary (M-T1.8).
    expect(rendered).toContain('"svelte": "^5.3.0"');
    expect(rendered).toContain('"@sveltejs/adapter-static"');
    // The svelte format reads only the `sveltekit/` shared dir — its
    // own dockerfile + api-client (the SvelteKit preview server needs
    // the kit project context; the client throws ApiError with the
    // parsed problem body for the runes form helper).
    expect(pack.templates.has("dockerfile")).toBe(true);
    expect(pack.templates.has("api-client")).toBe(true);
    expect(pack.render("dockerfile", {})).toContain("vite preview");
    // …and the TSX-only shared dirs must NOT leak in (vite/).
    expect(pack.templates.has("index-html")).toBe(false);
    expect(pack.templates.has("error-boundary")).toBe(false);
  });
});
