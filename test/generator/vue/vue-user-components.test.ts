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
    deployable api { platform: node, contexts: [C], port: 3000 }
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

  it("an extern component emits a typed props file + a re-export shim, no walked body", async () => {
    const files = await vueFiles(
      sys(`
      component OrderChart(caption: string) extern from "widgets/order-chart"
      page Home { route: "/" body: Heading { "hi" } }`),
    );
    const props = files.get("src/components/OrderChart.props.ts")!;
    expect(props).toContain("export interface OrderChartProps {");
    expect(props).toContain("caption: string;");
    const shim = files.get("src/components/OrderChart.ts")!;
    expect(shim).toContain('export { default } from "../widgets/order-chart";');
    expect(shim).toContain('export type { OrderChartProps } from "./OrderChart.props";');
    // No walked SFC for an extern component.
    expect(files.has("src/components/OrderChart.vue")).toBe(false);
  });

  it("an aggregate-typed extern prop pulls in the wire DTO", async () => {
    const files = await vueFiles(`
      system S {
        subdomain M { context C { aggregate Order { customerId: string } } }
        ui WebApp {
          component OrderChart(order: Order, caption: string) extern from "widgets/order-chart"
          page Home { route: "/" body: Heading { "hi" } }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: vue, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const props = files.get("src/components/OrderChart.props.ts")!;
    expect(props).toContain('import type { OrderResponse } from "../api/order";');
    expect(props).toContain("order: OrderResponse;");
  });

  it("a call site imports the extern shim without the .vue extension", async () => {
    const files = await vueFiles(
      sys(`
      component Banner(text: string) extern from "widgets/banner"
      page Home { route: "/" body: Banner(text: "hello") }`),
    );
    const home = files.get("src/pages/home.vue")!;
    expect(home).toContain('import Banner from "../components/Banner";');
    expect(home).toContain('<Banner text="hello" />');
  });

  it("a slot param on an extern component maps to a typed Slots contract (not a prop)", async () => {
    const files = await vueFiles(
      sys(`
      component Fancy(name: string, aside: slot?) extern from "widgets/fancy"
      page Home { route: "/" body: Heading { "hi" } }`),
    );
    const props = files.get("src/components/Fancy.props.ts")!;
    // The data param stays a prop; the slot param is kept OUT of Props
    // and surfaced as a `<Name>Slots` contract for `defineSlots`.
    expect(props).toContain("export interface FancyProps {");
    expect(props).toContain("name: string;");
    expect(props).not.toMatch(/FancyProps \{[^}]*aside/s);
    expect(props).toContain("export interface FancySlots {");
    expect(props).toContain("aside?(): unknown;");
    // The shim re-exports both types.
    const shim = files.get("src/components/Fancy.ts")!;
    expect(shim).toContain('export type { FancyProps, FancySlots } from "./Fancy.props";');
  });

  it("a walked component with slot + action params renders <slot> and a callback prop", async () => {
    // A NON-extern component with a `slot` param (`Slot { }` in the body) and an
    // `action(T)` param. Previously threw `unsupported prop type kind 'slot'`;
    // now mirrors the React/Svelte frontends: the slot is template content, the
    // action is a callback prop.
    const files = await vueFiles(`
      system S {
        subdomain M { context C { aggregate Order { id: string } } }
        ui WebApp {
          component Panel(head: slot, onPick: action(Order)) {
            body: Stack { Slot { "head" }, Button { "Pick" } }
          }
          page Home { route: "/" body: Heading { "home" } }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: vue, targets: api, ui: WebApp, port: 3001 }
      }`);
    const comp = files.get("src/components/Panel.vue")!;
    expect(comp).toBeDefined();
    // The slot param renders as Vue's default `<slot>` in the template — NOT a
    // JSX `{children}` and NOT a prop.
    expect(comp).toContain("<slot />");
    expect(comp).not.toMatch(/defineProps<\{[^}]*head/s);
    // The `action(Order)` param becomes a typed callback prop.
    expect(comp).toContain("onPick: (arg: OrderResponse) => void;");
    expect(comp).toContain('import type { OrderResponse } from "../api/order";');
  });
});
