// two more layout primitives in the body walker:
// Group (horizontal flex row, mirror of Stack) and Grid (column-
// based responsive grid, each child wrapped in <Grid.Col>).
//
// v0 Grid gives every column span="auto" — Mantine fills equally.
// A per-child span knob lands with a future per-arg config slice.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("Group + Grid in walker stdlib", () => {
  it("Group { ...children } emits Mantine <Group> with positional children", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Toolbar {
            route: "/toolbar"
            body:  Group {
              Heading { "Title" },
              Badge { "Live" },
              Button { "Save" }
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
    const content = files.get("web/src/pages/toolbar.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/import \{ Badge, Button, Group, Title \} from "@mantine\/core";/);
    expect(content).toMatch(/<Group>/);
    expect(content).toMatch(/<Title order=\{2\}>Title<\/Title>/);
    expect(content).toMatch(/<Badge>Live<\/Badge>/);
    expect(content).toMatch(/<Button>Save<\/Button>/);
    expect(content).toMatch(/<\/Group>/);
  });

  it("empty Group {} self-closes", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Empty {
            route: "/empty"
            body:  Group {}
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
    const content = files.get("web/src/pages/empty.tsx")!;
    expect(content).toMatch(/<Group \/>/);
  });

  it('Grid { ...children } wraps each child in <Grid.Col span="auto">', async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Dashboard {
            route: "/dashboard"
            body:  Grid {
              Stat { "Revenue", "$10k" },
              Stat { "Users", "240" },
              Stat { "Active", "47" }
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
    const content = files.get("web/src/pages/dashboard.tsx")!;
    expect(content).toMatch(/import \{ Grid, Stack, Text \}/);
    expect(content).toMatch(/<Grid>/);
    // Each child wrapped in its own column.
    const colMatches = content.match(/<Grid\.Col span="auto">/g) ?? [];
    expect(colMatches).toHaveLength(3);
    const closeMatches = content.match(/<\/Grid\.Col>/g) ?? [];
    expect(closeMatches).toHaveLength(3);
    // Children render inside the cols.
    expect(content).toMatch(/Revenue/);
    expect(content).toMatch(/Users/);
    expect(content).toMatch(/Active/);
  });

  it("empty Grid {} self-closes", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Empty {
            route: "/empty"
            body:  Grid {}
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
    const content = files.get("web/src/pages/empty.tsx")!;
    expect(content).toMatch(/<Grid \/>/);
  });

  it("Stack { Group { ... }, Grid { ... } } — composition stays clean", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Layout {
            route: "/layout"
            body:  Stack {
              Group { Heading { "Header" }, Badge { "v1" } },
              Grid { Text { "a" }, Text { "b" } }
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
    const content = files.get("web/src/pages/layout.tsx")!;
    // All four imports deduped + sorted on a single Mantine line.
    expect(content).toMatch(
      /import \{ Badge, Grid, Group, Stack, Text, Title \} from "@mantine\/core";/,
    );
    expect(content).toMatch(/<Stack>/);
    expect(content).toMatch(/<Group>/);
    expect(content).toMatch(/<Grid>/);
  });
});
