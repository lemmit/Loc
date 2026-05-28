// three more v0 layout primitives in the body
// walker: Stat (label + value headline card), Badge, Divider.
//
// Stat composes two stacked Mantine Texts (dimmed label + bold
// value) since Mantine has no dedicated Stat component.  Badge
// and Divider map to their Mantine namesakes.  Divider takes an
// optional `label:` named arg.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("Stat / Badge / Divider in walker stdlib", () => {
  it("Stat { label, value } emits a two-line stack with dimmed label + bold value", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Dashboard {
            route: "/dashboard"
            body:  Stat { "Active orders", "47" }
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
    const content = files.get("web/src/pages/dashboard.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/import \{ Stack, Text \} from "@mantine\/core";/);
    expect(content).toMatch(/<Text size="sm" c="dimmed">Active orders<\/Text>/);
    expect(content).toMatch(/<Text fw=\{700\} size="xl">47<\/Text>/);
  });

  it("Stat accepts route-param refs in either slot", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Stats(label: string, value: string) {
            route: "/stats/:label/:value"
            body:  Stat { label, value }
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
    const content = files.get("web/src/pages/stats.tsx")!;
    expect(content).toMatch(/<Text size="sm" c="dimmed">\{label\}<\/Text>/);
    expect(content).toMatch(/<Text fw=\{700\} size="xl">\{value\}<\/Text>/);
    // Both params consumed → both destructured in the shell.
    expect(content).toMatch(/const \{ label, value \} = useParams/);
  });

  it('Badge { "label" } emits Mantine Badge', async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Stack { Heading { "Status" }, Badge { "Live" } }
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
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toMatch(/import \{ Badge, Stack, Title \} from "@mantine\/core";/);
    expect(content).toMatch(/<Badge>Live<\/Badge>/);
  });

  it("Divider {} emits a self-closing Divider", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Stack { Heading { "A" }, Divider {}, Heading { "B" } }
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
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toMatch(/import \{ Divider, Stack, Title \} from "@mantine\/core";/);
    expect(content).toMatch(/<Divider \/>/);
  });

  it('Divider { label: "Section" } emits labelled inline divider', async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Divider { label: "Section break" }
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
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toMatch(/<Divider label="Section break" labelPosition="center" \/>/);
  });

  it("Stack composes Stat / Badge / Divider together cleanly", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Dashboard {
            route: "/dashboard"
            body:  Stack {
              Heading { "Dashboard" },
              Stat { "Revenue", "$12.5k" },
              Divider {},
              Badge { "Live" }
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
    const content = files.get("web/src/pages/dashboard.tsx")!;
    // All three primitives plus Stack + Heading deduped into one
    // sorted Mantine import line.
    expect(content).toMatch(
      /import \{ Badge, Divider, Stack, Text, Title \} from "@mantine\/core";/,
    );
    expect(content).toMatch(/<Title order=\{2\}>Dashboard<\/Title>/);
    expect(content).toMatch(/<Text fw=\{700\} size="xl">\$12\.5k<\/Text>/);
    expect(content).toMatch(/<Divider \/>/);
    expect(content).toMatch(/<Badge>Live<\/Badge>/);
  });
});
