import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Vue `Tabs { }` — the vuetify pack v-models a controlled `__loomTab`, so the
// page setup must declare `const __loomTab = ref(<first tab value>)`. The
// emitter used to leave a `TODO(vue-tabs)` in the template with no declaration,
// so the generated SFC referenced an undeclared binding and failed vue-tsc.
// ---------------------------------------------------------------------------

async function pageVue(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain M { context C { } }
      ui WebApp {
        page Home {
          route: "/"
          body: ${body}
        }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: vue, targets: api, ui: WebApp, port: 3001 }
    }`);
  for (const [p, c] of files) {
    if (p.endsWith("src/pages/home.vue")) return c;
  }
  throw new Error("home.vue not emitted");
}

describe("vue Tabs controlled state", () => {
  it("declares `const __loomTab = ref(...)` and imports ref when the body has Tabs", async () => {
    const vue = await pageVue(
      `Tabs { Tab { "Overview", Text { "a" } }, Tab { "Settings", Text { "b" } } }`,
    );
    // The controlled model is declared in setup, defaulting to the first tab.
    expect(vue).toContain('const __loomTab = ref("overview");');
    expect(vue).toMatch(/import \{[^}]*\bref\b[^}]*\} from "vue";/);
    // Template v-models it; the stale TODO placeholder is gone.
    expect(vue).toContain('<v-tabs v-model="__loomTab">');
    expect(vue).not.toContain("TODO(vue-tabs)");
  });

  it("does not declare __loomTab when the body has no Tabs", async () => {
    const vue = await pageVue(`Stack { Heading { "hi", level: 1 } }`);
    expect(vue).not.toContain("__loomTab");
  });
});
