// Slice 11.21 — per-page menuMeta drives the sidebar when no
// explicit `ui.menu { … }` block is declared.
//
//   page Reports {
//     route: "/reports"
//     menu { section: "Reports", label: "Daily Stats" }
//     body: Heading("Reports")
//   }
//
// Without a `ui.menu` block, the sidebar emits with a "Reports"
// section containing a "Daily Stats" link to "/reports".

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { generateSystems } from "../src/system/index.js";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Slice 11.21 — per-page menuMeta drives the sidebar", () => {
  it("walker page with menuMeta lands in App.tsx sidebar nav", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Reports {
            route: "/reports"
            menu { section: "Reports", label: "Daily Stats" }
            body: Heading("Reports")
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const appTsx = files.get("web/src/App.tsx")!;
    expect(appTsx).toBeDefined();
    // Sidebar nav contains the Reports link with the custom label.
    expect(appTsx).toMatch(/Daily Stats/);
    expect(appTsx).toMatch(/to="\/reports"/);
  });

  it("multiple pages group by section", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Daily {
            route: "/daily"
            menu { section: "Reports", label: "Daily" }
            body: Heading("Daily")
          }
          page Weekly {
            route: "/weekly"
            menu { section: "Reports", label: "Weekly" }
            body: Heading("Weekly")
          }
          page Settings {
            route: "/settings"
            menu { section: "Admin", label: "Settings" }
            body: Heading("Settings")
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const appTsx = files.get("web/src/App.tsx")!;
    // Both section labels appear in the rendered sidebar.
    expect(appTsx).toMatch(/Reports/);
    expect(appTsx).toMatch(/Admin/);
    // All three page links present.
    expect(appTsx).toMatch(/Daily/);
    expect(appTsx).toMatch(/Weekly/);
    expect(appTsx).toMatch(/Settings/);
  });

  it("hidden: true skips a page from the sidebar", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Public {
            route: "/p"
            menu { section: "Pages", label: "Public" }
            body: Heading("Public")
          }
          page Secret {
            route: "/s"
            menu { section: "Pages", label: "Secret", hidden: true }
            body: Heading("Secret")
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const appTsx = files.get("web/src/App.tsx")!;
    // Visible page lands in sidebar.
    expect(appTsx).toMatch(/label="Public"|>Public</);
    // Secret is still routable (so the Route exists) but the
    // sidebar navSections doesn't include it.  Look for a nav
    // entry shape that points at /s.
    expect(appTsx).not.toMatch(/to="\/s"/);
  });

  it("order: N sorts within a section", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Z {
            route: "/z"
            menu { section: "S", label: "Z", order: 1 }
            body: Heading("Z")
          }
          page A {
            route: "/a"
            menu { section: "S", label: "A", order: 2 }
            body: Heading("A")
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const appTsx = files.get("web/src/App.tsx")!;
    // Z appears before A (order: 1 < 2) — check positional order.
    const zIdx = appTsx.search(/label="Z"|>Z</);
    const aIdx = appTsx.search(/label="A"|>A</);
    expect(zIdx).toBeGreaterThan(0);
    expect(aIdx).toBeGreaterThan(0);
    expect(zIdx).toBeLessThan(aIdx);
  });

  it("explicit ui.menu block still wins over per-page menuMeta", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            menu { section: "PerPage", label: "Per-page" }
            body: Heading("X")
          }
          menu {
            section "Explicit" {
              link X { label: "Override Label" }
            }
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const appTsx = files.get("web/src/App.tsx")!;
    // Explicit menu wins.
    expect(appTsx).toMatch(/Explicit/);
    expect(appTsx).toMatch(/Override Label/);
    expect(appTsx).not.toMatch(/PerPage/);
    expect(appTsx).not.toMatch(/Per-page/);
  });
});
