// Feliz stateless leaf/layout primitives — Icon + Tabs.  Both dispatch to the
// procedural pack (no MVU state), so a page using them previously emitted a
// `(* no renderer *)` comment that breaks `dotnet fable`.  This pins that Icon
// renders an inline SVG via `dangerouslySetInnerHTML` and Tabs renders daisyUI's
// CSS-only radio-tabs.  The emitted F# is proven to compile via `dotnet fable`
// + `vite build`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const APP = `
system Demo {
  subdomain S { context C { } }
  ui WebApp {
    framework: feliz
    page Home {
      route: "/"
      body: Stack {
        Icon { name: "settings", size: "md" },
        Icon { name: "check", size: "sm" },
        Icon { svg: "<svg viewBox='0 0 24 24'><circle cx='12' cy='12' r='10'/></svg>" },
        Tabs {
          Tab { "Overview", Card { "Info", Text { "over" } } },
          Tab { "Details", Text { "det" } }
        }
      }
    }
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}
`;

async function appFs(): Promise<string> {
  const files = await generateSystemFiles(APP);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz stateless primitives (Icon / Tabs)", () => {
  it("renders every primitive — no `no renderer` placeholders leak", async () => {
    const app = await appFs();
    expect(app).not.toContain("no renderer");
  });

  it("renders Icon as an inline SVG span via dangerouslySetInnerHTML", async () => {
    const app = await appFs();
    // A named registry icon → the looked-up SVG, sized `md` (h-5 w-5), injected raw.
    expect(app).toContain(
      'Html.span [ prop.className "loom-icon inline-flex h-5 w-5 [&>svg]:h-full [&>svg]:w-full"; prop.dangerouslySetInnerHTML """<svg viewBox="0 0 24 24"',
    );
    // `size: "sm"` → h-4 w-4.
    expect(app).toContain('prop.className "loom-icon inline-flex h-4 w-4');
    // A user `svg:` literal passes through verbatim (escape hatch).
    expect(app).toContain(
      "prop.dangerouslySetInnerHTML \"\"\"<svg viewBox='0 0 24 24'><circle cx='12' cy='12' r='10'/></svg>\"\"\"",
    );
  });

  it("renders Tabs as daisyUI CSS-only radio-tabs", async () => {
    const app = await appFs();
    // The tablist container + a shared radio group name derived from the values.
    expect(app).toContain('Html.div [ prop.role "tablist"; prop.className "tabs tabs-bordered"');
    expect(app).toContain('prop.name "loom_tabs_overview_details"');
    // Each tab: a radio input (aria-label = tab text) + a tab-content panel.
    expect(app).toContain(
      'Html.input [ prop.type\'.radio; prop.name "loom_tabs_overview_details"; prop.role "tab"; prop.className "tab"; prop.ariaLabel "Overview"; prop.defaultChecked true ]',
    );
    expect(app).toContain('prop.ariaLabel "Details"');
    expect(app).toContain('Html.div [ prop.role "tabpanel"; prop.className "tab-content p-4"');
    // The panel bodies are the walked children (Card + Text).
    expect(app).toContain('prop.className "card bg-base-100 shadow"');
    // Only the first tab is default-checked (exactly one active).
    expect(app.match(/prop\.defaultChecked true/g)?.length).toBe(1);
  });

  it("an empty Tabs renders nothing (Html.none), not a dead tablist", async () => {
    const files = await generateSystemFiles(`
system D {
  subdomain S { context C { } }
  ui W { framework: feliz  page Home { route: "/"  body: Tabs { } } }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: W port: 3005 }
}
`);
    const app = [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
    expect(app).not.toContain('prop.role "tablist"');
  });
});
