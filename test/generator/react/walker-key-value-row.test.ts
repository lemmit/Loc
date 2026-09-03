// KeyValueRow primitive.
//
// Two-column row that pairs a fixed-width label with a value.
// Used by the (forthcoming) `aggregate-detail` expander to surface
// each aggregate field in the detail-page card body, matching the
// scaffold renderer's KeyValueRow + per-cell formatter shape.

// The label is a user-visible slot (`keyValue`), so it binds through the
// translation runtime like every other one.  These assertions used to pin the
// RAW form (`label="Status"`) — and the very first one pinned the child as
// translated in the same breath, so the asymmetry that shipped the label in
// English at every locale was written into the fixture rather than caught by it.
//
// The child was translated because it is markup; the label was not because the
// packs render it as a component PROP and the emitter read the raw literal.
// See `localizedPositionalAttr` (i18n-emit.ts).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function emit(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain M { context C { } }
      ui WebApp {
        page P { route: "/p"  body: ${body} }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
    }
  `);
  const tsx = files.get("web/src/pages/p.tsx");
  if (!tsx) throw new Error(`MISSING; keys = ${[...files.keys()].join(", ")}`);
  return tsx;
}

describe("KeyValueRow primitive", () => {
  it('emits <KeyValueRow label="…">child</KeyValueRow> with the runtime helper imported', async () => {
    const tsx = await emit(`KeyValueRow { "Status", Text { "active" } }`);
    expect(tsx).toMatch(/import \{[^}]*\bKeyValueRow\b[^}]*\} from "\.\.\/lib\/format"/);
    expect(tsx).toMatch(
      /<KeyValueRow label=\{t\("[^"]*", "Status"\)\}><Text>\{t\("[^"]*", "active"\)\}<\/Text><\/KeyValueRow>/,
    );
  });

  it("keys the label to the catalog entry a translator works from", async () => {
    const files = await generateSystemFiles(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page P { route: "/p"  body: KeyValueRow { "Status", Text { "active" } } }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const catalog = JSON.parse(files.get(".loom/messages.en.json")!) as Record<string, string>;
    const key = Object.entries(catalog).find(([, m]) => m === "Status")?.[0];
    // The whole point of the fix: the page resolves the SAME key the catalog
    // offers the translator.  A raw-English render carries no key at all.
    expect(key).toBeDefined();
    expect(files.get("web/src/pages/p.tsx")).toContain(`label={t("${key}", "Status")}`);
  });

  it("testid: lands on the root <KeyValueRow>", async () => {
    const tsx = await emit(`KeyValueRow { "Status", Text { "active" }, testid: "row-status" }`);
    expect(tsx).toMatch(/<KeyValueRow [^>]*\bdata-testid="row-status"/);
  });

  it("loom:unrendered missing value emits a visible placeholder, no crash", async () => {
    const tsx = await emit(`KeyValueRow { "Status" }`);
    expect(tsx).toMatch(
      /<KeyValueRow label=\{t\("[^"]*", "Status"\)\}>\{\/\* loom:unrendered missing value \*\/\}<\/KeyValueRow>/,
    );
  });

  it("composes inside a Stack of detail rows", async () => {
    const tsx = await emit(`Stack {
      KeyValueRow { "Customer", Text { "Acme" } },
      KeyValueRow { "Status",   Badge { "active" } },
      KeyValueRow { "Placed",   DateDisplay { "2026-01-01" } }
    }`);
    expect(tsx).toMatch(/<KeyValueRow label=\{t\("[^"]*", "Customer"\)\}>/);
    expect(tsx).toMatch(/<KeyValueRow label=\{t\("[^"]*", "Status"\)\}>/);
    expect(tsx).toMatch(/<KeyValueRow label=\{t\("[^"]*", "Placed"\)\}>/);
  });
});
