// Toolbar + Empty primitives in walker stdlib.
//
//   Toolbar { Heading { "Orders" }, Button { "Add", to: "/orders/new" } }
//     → Mantine <Group justify="space-between"> push apart layout
//
//   Empty { "No orders yet" }
//     → centered dimmed-text empty-state placeholder

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("Toolbar + Empty in walker stdlib", () => {
  it('Toolbar { ... } emits Mantine <Group justify="space-between">', async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Orders {
            route: "/orders"
            body:  Toolbar {
              Heading { "Orders" },
              Button { "Add", to: "/orders/new" }
            }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/orders.tsx")!;
    expect(content).toBeDefined();
    // Toolbar imports through Group (no separate Toolbar specifier).
    expect(content).toMatch(/import \{ Button, Group, Title \} from "@mantine\/core";/);
    // Toolbar is a labelled ARIA toolbar (a11y contract).
    expect(content).toMatch(/<Group justify="space-between" role="toolbar" aria-label="Actions">/);
    expect(content).toMatch(/<Title order=\{2\}>Orders<\/Title>/);
    expect(content).toMatch(
      /<Button onClick=\{\(\) => navigate\("\/orders\/new"\)\}>Add<\/Button>/,
    );
  });

  it("empty Toolbar {} self-closes with the same justify attr", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body:  Toolbar {}
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).toMatch(/<Group justify="space-between" role="toolbar" aria-label="Actions" \/>/);
  });

  it('Empty { "No orders yet" } emits centered dimmed-text placeholder', async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page List {
            route: "/list"
            body:  Empty { "No orders yet" }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/list.tsx")!;
    expect(content).toMatch(/import \{ Center, Text \} from "@mantine\/core";/);
    expect(content).toMatch(/<Center mih=\{200\}><Text c="dimmed">No orders yet<\/Text><\/Center>/);
  });

  it("Empty {} with no message falls back to default", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body:  Empty {}
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).toMatch(/<Center mih=\{200\}><Text c="dimmed">No results\.<\/Text><\/Center>/);
  });

  it("Empty accepts a binary-op message (state interpolation)", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state { kind: string = "items" }
            body:  Empty { "No " + kind + " here" }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).toMatch(/<Text c="dimmed">\{\(\("No " \+ kind\) \+ " here"\)\}<\/Text>/);
    expect(content).toMatch(/const \[kind, setKind\]/);
  });
});
