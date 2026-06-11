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
// Vue pack-format groundwork (vue-frontend-plan.md Slice 2):
// the `vue` format's required-primitive surface, the `vue1` stack,
// and the builtin registry entries for vuetify / shadcnVue.
// ---------------------------------------------------------------------------

describe("vue pack format groundwork", () => {
  it("registers vuetify + shadcnVue as vue-format builtins (vuetify@v3 tracks Vuetify 3)", () => {
    expect(parseBuiltinDesignRef("vuetify")?.qualified).toBe("vuetify@v3");
    expect(parseBuiltinDesignRef("shadcnVue")?.qualified).toBe("shadcnVue@v1");
    expect(packFormatForBuiltin("vuetify")).toBe("vue");
    expect(packFormatForBuiltin("shadcnVue@v1")).toBe("vue");
  });

  it("vue required set mirrors TSX plus the op-dialog wrapper", () => {
    const vue = new Set(flattenRequired(REQUIRED_PRIMITIVES.vue));
    const tsx = new Set(flattenRequired(REQUIRED_PRIMITIVES.tsx));
    for (const name of tsx) {
      expect(vue.has(name), `vue set missing tsx-required "${name}"`).toBe(true);
    }
    // One vue-only addition: the operation-dialog wrapper the page
    // shell renders around op-form fields (TSX renders modals through
    // its pack form-op machinery instead).
    expect(vue.has("op-dialog")).toBe(true);
    expect(vue.size).toBe(tsx.size + 1);
  });

  it("a vue-format pack loads against the vue1 stack and sees its partials + docker shared sources", () => {
    // Synthesize a minimal vue pack (validateRequired off — this
    // probes stack/shared-source resolution, not the primitive gate).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vue-stack-"));
    fs.writeFileSync(
      path.join(dir, "pack.json"),
      JSON.stringify({
        name: "fixture-vue",
        version: "0.0.0",
        format: "vue",
        stack: "vue1",
        emits: { "package-json": "package-json.hbs" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "package-json.hbs"),
      '{ "dependencies": {\n{{> stack-package-deps}}\n}, "devDependencies": {\n{{> stack-package-devdeps}}\n} }',
    );
    const pack = loadPack(dir, { validateRequired: false });
    const rendered = pack.render("package-json", {});
    expect(rendered).toContain('"@tanstack/vue-query"');
    expect(rendered).toContain('"vue": "^3.5.0"');
    expect(rendered).toContain('"vue-router"');
    expect(rendered).toContain('"@vitejs/plugin-vue"');
    expect(rendered).toContain('"vue-tsc"');
    // The vue format reads `vue/` + `api/` + `docker/` shared dirs —
    // docker's dockerfile and the framework-neutral api fetch client
    // must both be visible as shared sources.
    expect(pack.templates.has("dockerfile")).toBe(true);
    expect(pack.templates.has("api-client")).toBe(true);
    // index-html resolves to the VUE shared layer (mounts /src/main.ts
    // into #app), not the React `vite/` one (/src/main.tsx into #root).
    const indexHtml = pack.render("index-html", { title: "t" });
    expect(indexHtml).toContain('<div id="app">');
    expect(indexHtml).toContain("/src/main.ts");
    expect(indexHtml).not.toContain("main.tsx");
  });
});
