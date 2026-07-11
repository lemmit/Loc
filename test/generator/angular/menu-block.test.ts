// Explicit `menu { … }` on an Angular frontend (parity fix).  The Angular
// orchestrator used to hand-roll the sidebar from `pages.map(...)` and ignored
// `ui.menu` entirely — the sole frontend that dropped a declared menu.  It now
// flows through the shared `deriveSidebarFromUi` (the same driver react / vue /
// svelte use), so a menu's sections, labels and external links render on
// Angular too.  With no menu the deriver returns `undefined` and the default
// single-section sidebar is emitted unchanged.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYS = (menu: string) => `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish { total: int }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  api SalesApi from Sales
  deployable api { platform: node contexts: [Orders] serves: SalesApi dataSources: [st] port: 8080 }
  ui WebApp {
    page Home { route: "/" body: Heading { "Home" } }
    page OrdersList { route: "/orders" body: Heading { "Orders" } }
${menu}  }
  deployable web { platform: angular targets: api ui: WebApp port: 3004 }
}
`;

function shellOf(files: Map<string, string>): string {
  for (const [k, v] of files) if (k.endsWith("web/src/app/app.component.ts")) return v;
  throw new Error("no app.component.ts");
}

describe("angular explicit menu block", () => {
  it("renders the declared section, per-link label, and external link", async () => {
    const menu = `
    menu {
      section "Main" {
        link Home { label: "Dashboard" }
        link "Docs" -> "https://loom.dev/docs"
      }
    }
`;
    const shell = shellOf(await generateSystemFiles(SYS(menu)));
    // Section subheader comes from the menu, not the system name.
    expect(shell).toContain("<h3 matSubheader>Main</h3>");
    expect(shell).not.toContain("<h3 matSubheader>Shop</h3>");
    // Internal link: the menu's `label:` override + a routerLink to the route.
    expect(shell).toContain(
      '<a mat-list-item routerLink="/" routerLinkActive="loom-active" data-testid="nav-home">Dashboard</a>',
    );
    // External link renders as a real anchor (target/_blank), not a routerLink.
    expect(shell).toContain(
      '<a mat-list-item href="https://loom.dev/docs" target="_blank" rel="noopener" data-testid="nav-ext-docs">Docs</a>',
    );
  });

  it("falls back to the default single section when no menu is declared", async () => {
    const shell = shellOf(await generateSystemFiles(SYS("")));
    // Default section is labelled with the (humanised) system name; every
    // routed page gets one internal link.
    expect(shell).toContain("<h3 matSubheader>Shop</h3>");
    expect(shell).toContain('routerLink="/orders"');
    expect(shell).not.toContain('target="_blank"');
  });
});
