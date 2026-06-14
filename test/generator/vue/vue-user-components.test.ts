import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// User-defined components — Vue flavour.  Each `component <Name>(p: T)
// { body: ... }` declaration emits `src/components/<Name>.vue` with a
// typed `defineProps`, and walker pages / sibling components invoke them
// as `<Name :prop="…" />` tags (vueTarget renders the attribute binding;
// the shell imports the SFC).  The Vue mirror of
// test/generator/react/walker-user-components.test.ts and the
// (component-throwing) svelte slice.
// ---------------------------------------------------------------------------

async function vueFiles(src: string): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  }
  return out;
}

const sys = (uiBody: string) => `
  system S {
    subdomain M { context C { } }
    ui WebApp {
${uiBody}
    }
    deployable api { platform: hono, contexts: [C], port: 3000 }
    deployable web { platform: vue, targets: api, ui: WebApp, port: 3001 }
  }
`;

describe("user-defined components — Vue", () => {
  it("a component emits an SFC with typed defineProps and a walked body", async () => {
    const files = await vueFiles(
      sys(`
      component WelcomeBox(name: string) {
        body: Card { "Hello, " + name, Stack { Text { "Welcome!" } } }
      }
      page Home { route: "/" body: Heading { "home" } }`),
    );
    const comp = files.get("src/components/WelcomeBox.vue")!;
    expect(comp).toBeDefined();
    // Typed props; no `const props =` since the body references `name`
    // only in template position (auto-exposed).
    expect(comp).toContain("defineProps<{");
    expect(comp).toContain("name: string;");
    // Body walked through the vuetify pack: card + binary-op interpolation.
    expect(comp).toContain('<v-card variant="outlined"');
    expect(comp).toContain('{{ ("Hello, " + name) }}');
    expect(comp).toContain("<div>Welcome!</div>");
  });

  it("a page invoking a component imports the SFC and renders the tag", async () => {
    const files = await vueFiles(
      sys(`
      component WelcomeBox(name: string) { body: Card { "Hi, " + name } }
      page Home { route: "/" body: WelcomeBox("Alice") }`),
    );
    const home = files.get("src/pages/home.vue")!;
    expect(home).toContain('import WelcomeBox from "../components/WelcomeBox.vue";');
    expect(home).toContain('<WelcomeBox name="Alice" />');
  });

  it("a component invoking another component imports the sibling SFC", async () => {
    const files = await vueFiles(
      sys(`
      component Inner(label: string) { body: Text { label } }
      component Outer(title: string) { body: Card { Inner(title) } }
      page Home { route: "/" body: Outer("hello") }`),
    );
    const outer = files.get("src/components/Outer.vue")!;
    expect(outer).toContain('import Inner from "./Inner.vue";');
    expect(outer).toContain('<Inner :label="title" />');
  });

  it("an extern function called from a component body imports its shim", async () => {
    const files = await vueFiles(
      sys(`
      function shout(s: string): string extern from "./helpers/shout"
      component Banner(label: string) { body: Heading { shout(label) } }
      page Home { route: "/" body: Banner("hi") }`),
    );
    const banner = files.get("src/components/Banner.vue")!;
    expect(banner).toContain('import { shout } from "../lib/shout";');
    expect(banner).toContain("{{ shout(label) }}");
  });

  it("an extern component is rejected loudly (parity follow-up)", async () => {
    await expect(
      vueFiles(
        sys(`
        component Fancy(name: string) extern from "./widgets/Fancy"
        page Home { route: "/" body: Fancy("x") }`),
      ),
    ).rejects.toThrow(/extern component 'Fancy'/);
  });
});
