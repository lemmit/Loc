import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { NodeFileSystem } from "langium/node";
import { createDddServices } from "../src/language/ddd-module.js";
import { generateSystems } from "../src/system/index.js";
import type { Model } from "../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Per-(example × design pack) snapshots for the React frontend
// generator's templating layer.  Augments the regex assertions in
// test/generator-react.test.ts: regex pins the wire/API contract
// (pack-invariant); these snapshots pin the visual output (per-pack).
// When a second pack lands in main, snapshot diffs make pack-driven
// drift visible at PR time without trying to read 200-line generated
// TSX files line by line.
//
// Phase 0 covers only the list page (the only one routed through the
// templating layer); subsequent phases add detail/new/workflow/view
// snapshots as their builders move over.
// ---------------------------------------------------------------------------

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

async function generateFromSource(source: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const helper = (await import("langium/test")).parseHelper(services.Ddd);
  const doc = await helper(source, { validation: false });
  const model = doc.parseResult.value as Model;
  return generateSystems(model).files;
}

describe("react generator template-pack output (snapshots)", () => {
  // A minimal system that exercises the list-page cell repertoire:
  // - id (Customer.id, the leading row link)
  // - id-link (Order.customerId via *Id heuristic → Customer detail)
  // - datetime (Order.placedAt)
  // - bool (Customer.vip)
  // - number (Customer.age — int)
  // - decimal (Customer.balance — decimal)
  // - enum (Order.status)
  // - string (Customer.email — fallback)
  const SOURCE = `
    system Sample {
      module M {
        context Sales {
          enum OrderStatus { Draft, Confirmed, Shipped }
          aggregate Customer {
            username: string display
            email: string
            age: int
            balance: decimal
            vip: bool
          }
          repository Customers for Customer { }
          aggregate Order {
            customerId: string
            status: OrderStatus
            placedAt: datetime
          }
          repository Orders for Order { }
        }
      }
      deployable api { platform: dotnet, modules: M, port: 8080 }
      deployable webMantine { platform: react, targets: api, port: 3001 }
      deployable webShadcn { platform: react, targets: api, port: 3002, design: shadcn }
    }
  `;

  it("Mantine pack — theme.ts snapshot", async () => {
    const files = await generateFromSource(SOURCE);
    const theme = files.get("web_mantine/src/theme.ts");
    expect(theme).toBeDefined();
    await expect(theme).toMatchFileSnapshot(
      path.join(repoRoot, "test/__snapshots__/pack-mantine-theme.ts"),
    );
  });

  it("Mantine pack — App.tsx snapshot", async () => {
    const files = await generateFromSource(SOURCE);
    const app = files.get("web_mantine/src/App.tsx");
    expect(app).toBeDefined();
    await expect(app).toMatchFileSnapshot(
      path.join(repoRoot, "test/__snapshots__/pack-mantine-app.tsx"),
    );
  });

  it("Mantine pack — main.tsx snapshot", async () => {
    const files = await generateFromSource(SOURCE);
    const main = files.get("web_mantine/src/main.tsx");
    expect(main).toBeDefined();
    await expect(main).toMatchFileSnapshot(
      path.join(repoRoot, "test/__snapshots__/pack-mantine-main.tsx"),
    );
  });

  it("Mantine pack — home.tsx snapshot", async () => {
    const files = await generateFromSource(SOURCE);
    const home = files.get("web_mantine/src/pages/home.tsx");
    expect(home).toBeDefined();
    await expect(home).toMatchFileSnapshot(
      path.join(repoRoot, "test/__snapshots__/pack-mantine-home.tsx"),
    );
  });

  it("Mantine pack — new page snapshot", async () => {
    const files = await generateFromSource(SOURCE);
    const newPage = files.get("web_mantine/src/pages/customers/new.tsx");
    expect(newPage).toBeDefined();
    await expect(newPage).toMatchFileSnapshot(
      path.join(repoRoot, "test/__snapshots__/pack-mantine-customer-new.tsx"),
    );
  });

  it("Mantine pack — detail page snapshot", async () => {
    const files = await generateFromSource(SOURCE);
    const detail = files.get("web_mantine/src/pages/customers/detail.tsx");
    expect(detail).toBeDefined();
    await expect(detail).toMatchFileSnapshot(
      path.join(repoRoot, "test/__snapshots__/pack-mantine-customer-detail.tsx"),
    );
  });

  it("Mantine pack — list page snapshot", async () => {
    const files = await generateFromSource(SOURCE);
    const list = files.get("web_mantine/src/pages/customers/list.tsx");
    expect(list).toBeDefined();
    await expect(list).toMatchFileSnapshot(
      path.join(repoRoot, "test/__snapshots__/pack-mantine-customer-list.tsx"),
    );
  });

  it("shadcn pack — list page snapshot", async () => {
    const files = await generateFromSource(SOURCE);
    const list = files.get("web_shadcn/src/pages/customers/list.tsx");
    expect(list).toBeDefined();
    await expect(list).toMatchFileSnapshot(
      path.join(repoRoot, "test/__snapshots__/pack-shadcn-customer-list.tsx"),
    );
  });

  it("same VM produces structurally distinct output across packs", async () => {
    // Sanity check the architecture: both packs must produce different
    // text (otherwise the spike isn't proving anything), but both must
    // contain the same testid skeleton (the pack-invariant data layer).
    const files = await generateFromSource(SOURCE);
    const mantine = files.get("web_mantine/src/pages/customers/list.tsx")!;
    const shadcn = files.get("web_shadcn/src/pages/customers/list.tsx")!;
    expect(mantine).not.toBe(shadcn);

    // testids are layer-2 view-model concerns and pack-invariant by
    // construction.  Both packs MUST emit them identically.
    const sharedTestIds = [
      'data-testid="customers-list"',
      'data-testid="customers-list-create"',
      'data-testid="customers-list-empty"',
      "customers-row-${row.id}-link",
      "customers-row-${row.id}-username",
      "customers-row-${row.id}-email",
      "customers-row-${row.id}-age",
      "customers-row-${row.id}-balance",
      "customers-row-${row.id}-vip",
    ];
    for (const testId of sharedTestIds) {
      expect(mantine, `mantine missing ${testId}`).toContain(testId);
      expect(shadcn, `shadcn missing ${testId}`).toContain(testId);
    }

    // Pack-specific markers — proves the rendering is genuinely
    // different at the JSX-component level, not just a recoloured
    // copy of the same Mantine elements.
    expect(mantine).toContain("@mantine/core");
    expect(mantine).toContain("<Table.Th>");
    expect(shadcn).not.toContain("@mantine/core");
    expect(shadcn).toContain('className="');
    expect(shadcn).toContain("<table");
  });
});

