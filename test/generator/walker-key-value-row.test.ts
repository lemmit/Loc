// KeyValueRow primitive.
//
// Two-column row that pairs a fixed-width label with a value.
// Used by the (forthcoming) `aggregate-detail` expander to surface
// each aggregate field in the detail-page card body, matching the
// scaffold renderer's KeyValueRow + per-cell formatter shape.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

async function emit(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      module M { context C { } }
      ui WebApp {
        page P { route: "/p"  body: ${body} }
      }
      deployable api { platform: hono, modules: M, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
    }
  `);
  const tsx = files.get("web/src/pages/p.tsx");
  if (!tsx) throw new Error(`MISSING; keys = ${[...files.keys()].join(", ")}`);
  return tsx;
}

describe("KeyValueRow primitive", () => {
  it('emits <KeyValueRow label="…">child</KeyValueRow> with the runtime helper imported', async () => {
    const tsx = await emit(`KeyValueRow("Status", Text("active"))`);
    expect(tsx).toMatch(/import \{[^}]*\bKeyValueRow\b[^}]*\} from "\.\.\/lib\/format"/);
    expect(tsx).toMatch(/<KeyValueRow label="Status"><Text>active<\/Text><\/KeyValueRow>/);
  });

  it("testid: lands on the root <KeyValueRow>", async () => {
    const tsx = await emit(`KeyValueRow("Status", Text("active"), testid: "row-status")`);
    expect(tsx).toMatch(/<KeyValueRow [^>]*\bdata-testid="row-status"/);
  });

  it("missing value emits a visible placeholder, no crash", async () => {
    const tsx = await emit(`KeyValueRow("Status")`);
    expect(tsx).toMatch(/<KeyValueRow label="Status">\{\/\* missing value \*\/\}<\/KeyValueRow>/);
  });

  it("composes inside a Stack of detail rows", async () => {
    const tsx = await emit(`Stack(
      KeyValueRow("Customer", Text("Acme")),
      KeyValueRow("Status",   Badge("active")),
      KeyValueRow("Placed",   DateDisplay("2026-01-01"))
    )`);
    expect(tsx).toMatch(/<KeyValueRow label="Customer">/);
    expect(tsx).toMatch(/<KeyValueRow label="Status">/);
    expect(tsx).toMatch(/<KeyValueRow label="Placed">/);
  });
});
