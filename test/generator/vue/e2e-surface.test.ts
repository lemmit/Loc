import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Vue e2e surface (vue-frontend-plan.md Slice 6): the framework-
// neutral page objects, the route-driven smoke spec, the Playwright
// harness, and the `test e2e … against <vue-deployable>` → Playwright
// dispatch.  Generates `examples/vue-showcase.ddd`, whose e2e blocks
// target the vue `webApp` deployable.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.resolve(here, "../../../examples/vue-showcase.ddd"), "utf-8");

async function vueFiles(): Promise<Map<string, string>> {
  const all = await generateSystemFiles(SOURCE);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web_app/")) out.set(p.slice("web_app/".length), c);
  }
  return out;
}

describe("vue e2e surface", () => {
  it("emits the Playwright harness + the shared route-driven smoke spec", async () => {
    const files = await vueFiles();
    for (const f of [
      "e2e/fixtures.ts",
      "e2e/playwright.config.ts",
      "e2e/package.json",
      "e2e/tsconfig.json",
      "e2e/smoke.spec.ts",
    ]) {
      expect(files.has(f), `missing ${f}`).toBe(true);
    }
    const smoke = files.get("e2e/smoke.spec.ts")!;
    expect(smoke).toContain('await page.goto("/customers");');
    expect(smoke).toContain("toHaveURL");
    // Route-driven — no page-object imports that may not exist.
    expect(smoke).not.toContain("./pages/");
  });

  it("emits framework-neutral page objects per aggregate / workflow", async () => {
    const files = await vueFiles();
    const customer = files.get("e2e/pages/customer.ts")!;
    expect(customer).toContain("export class CustomerListPage");
    expect(customer).toContain("export class CustomerNewPage");
    expect(customer).toContain("export class CustomerDetailPage");
    // The testids the page object drives are the SAME ones the
    // vuetify templates emit (`customers-list-create`,
    // `customers-row-…`) — the cross-framework testid contract.
    expect(customer).toContain("customers-list-create");
    expect(files.has("e2e/pages/workflows/place_order.ts")).toBe(true);
  });

  it("`test e2e … against <vue-deployable>` dispatches to a Playwright ui spec", async () => {
    const files = await vueFiles();
    const spec = files.get("e2e/AcmeVue.ui.spec.ts")!;
    expect(spec).toContain(`import { test, expect } from "./fixtures";`);
    expect(spec).toContain("OrderListPage");
    expect(spec).toContain("PlaceOrderWorkflowPage");
  });

  it("vue page testids line up with the page objects' locators", async () => {
    const files = await vueFiles();
    const listVue = files.get("src/pages/customers/list.vue")!;
    const pageObject = files.get("e2e/pages/customer.ts")!;
    // Both sides carry the row testid prefix + the create button id.
    expect(listVue).toContain('"customers-row-"');
    expect(pageObject).toContain("customers-row-");
    expect(listVue).toContain('data-testid="customers-list-create"');
  });
});
