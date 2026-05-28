// Tabs primitive in walker stdlib.
//
// Surface:
//
//   Tabs {
//     Tab { "Overview", Stack { Heading { "Stats" } } },
//     Tab { "Settings", Heading { "Profile" } }
//   }
//
// Maps to Mantine's three-piece tab structure:
//
//   <Tabs defaultValue="overview">
//     <Tabs.List>
//       <Tabs.Tab value="overview">Overview</Tabs.Tab>
//       <Tabs.Tab value="settings">Settings</Tabs.Tab>
//     </Tabs.List>
//     <Tabs.Panel value="overview">{body}</Tabs.Panel>
//     <Tabs.Panel value="settings">{body}</Tabs.Panel>
//   </Tabs>
//
// Tab `value` attributes are slugified labels.  defaultValue is
// the first tab's slug.  Tab labels must be string literals in
// v0 (anything else falls back to `tab-N`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("Tabs in walker stdlib", () => {
  it("emits Mantine Tabs with List + Panels and slugged values", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Settings {
            route: "/settings"
            body:  Tabs {
              Tab { "Overview", Heading { "Stats" } },
              Tab { "Profile", Text { "user info" } }
            }
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/settings.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/import \{ Tabs, Text, Title \} from "@mantine\/core";/);
    expect(content).toMatch(/<Tabs defaultValue="overview">/);
    expect(content).toMatch(/<Tabs\.List>/);
    expect(content).toMatch(/<Tabs\.Tab value="overview">Overview<\/Tabs\.Tab>/);
    expect(content).toMatch(/<Tabs\.Tab value="profile">Profile<\/Tabs\.Tab>/);
    expect(content).toMatch(/<Tabs\.Panel value="overview">/);
    expect(content).toMatch(/<Title order=\{2\}>Stats<\/Title>/);
    expect(content).toMatch(/<Tabs\.Panel value="profile">/);
    expect(content).toMatch(/<Text>user info<\/Text>/);
  });

  it("multi-word labels slugify to kebab-case", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body:  Tabs {
              Tab { "User Settings", Text { "a" } },
              Tab { "Audit Log",     Text { "b" } }
            }
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).toMatch(/<Tabs defaultValue="user-settings">/);
    expect(content).toMatch(/<Tabs\.Tab value="user-settings">User Settings<\/Tabs\.Tab>/);
    expect(content).toMatch(/<Tabs\.Tab value="audit-log">Audit Log<\/Tabs\.Tab>/);
  });

  it("nested composition: Stack > Tabs > Stack stays clean", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body:  Stack {
              Heading { "Hello" },
              Tabs {
                Tab { "A", Stack { Heading { "Inner A" }, Text { "body a" } } },
                Tab { "B", Stack { Heading { "Inner B" }, Text { "body b" } } }
              }
            }
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).toMatch(/<Stack>/);
    expect(content).toMatch(/<Tabs defaultValue="a">/);
    // Each panel contains its own Stack subtree.
    expect(content).toMatch(/<Tabs\.Panel value="a">/);
    expect(content).toMatch(/<Title order=\{2\}>Inner A<\/Title>/);
    expect(content).toMatch(/<Tabs\.Panel value="b">/);
    expect(content).toMatch(/<Title order=\{2\}>Inner B<\/Title>/);
  });

  it("non-Tab child in Tabs { ... } renders directly as the panel body with an auto label", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Mixed {
            route: "/mixed"
            body:  Tabs {
              Tab { "Real", Text { "ok" } },
              Heading { "Stray heading" }
            }
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/mixed.tsx")!;
    // First (real) tab still renders.
    expect(content).toMatch(/<Tabs\.Tab value="real">Real<\/Tabs\.Tab>/);
    // Second positional wasn't a Tab {} call → fallback indexed slug + walked body.
    // The Heading expression renders directly inside the auto-labelled panel.
    expect(content).toMatch(/<Tabs\.Tab value="tab-2">Tab 2<\/Tabs\.Tab>/);
    expect(content).toMatch(/Stray heading/);
    expect(content).not.toMatch(/missing tab body/);
  });
});
