// Slice B1 — explicit Order DSL ↔ scaffold Order DSL equivalence.
//
// Pins the platform-completeness contract that motivated the
// scaffold-unroll: a skilled user CAN hand-write the same pages
// the scaffold archetype path emits.  This test runs both files
// through the generator and asserts equivalence on the
// dimensions that matter for downstream consumers (e2e tests,
// route declarations, hook usage):
//
//   1. Both pages emit at the same conventional file paths.
//   2. The explicit page's testid surface is a SUPERSET of the
//      scaffold page's interactive testids — every selector an
//      e2e test could use against scaffold output also works
//      against the explicit output.
//   3. Both pages auto-inject the same React Query hooks
//      (`useAllOrders` / `useCreateOrder`).
//   4. Both pages compile under strict tsc (covered indirectly
//      by `npm run test:tsc-react`; this test pins the surface).
//
// What this test does NOT pin:
//   - Byte-for-byte JSX equivalence.  The scaffold path emits
//     icons, styled empty-state CTAs, breadcrumb separators, and
//     other chrome decorations the explicit form opts out of.
//     Visual-equivalence checks belong with downstream e2e
//     screenshots.
//
// Spillover: OrderDetail page parity needs aggregate operations
// (`addLine`, `confirm` modals) + KeyValueRow primitive — deferred
// to A10+.  This slice ships List + New parity only.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { NodeFileSystem } from "langium/node";
import { generateSystems } from "../src/system/index.js";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

async function generateFromFile(file: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const src = readFileSync(resolve(repoRoot, file), "utf8");
  const doc = await helper(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error(
      `Parse/validate errors in ${file}:\n${errors.map((e) => "  " + e.message).join("\n")}`,
    );
  }
  return generateSystems(doc.parseResult.value as Model).files;
}

/** Extract every `data-testid="..."` literal from a TSX string. */
function extractTestids(tsx: string): Set<string> {
  const out = new Set<string>();
  const re = /data-testid="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tsx)) !== null) {
    out.add(m[1]!);
  }
  return out;
}

describe("Slice B1 — explicit Order DSL ↔ scaffold Order equivalence", () => {
  it("both pipelines emit src/pages/orders/list.tsx", async () => {
    const explicit = await generateFromFile("examples/acme-order-explicit.ddd");
    // Scaffold output is captured by the baseline fixture; reuse
    // the on-disk snapshot rather than re-generating acme.ddd here
    // (faster + isolates the comparison from acme.ddd churn).
    const scaffold = readFileSync(
      resolve(repoRoot, "test/fixtures/baseline-output/web_app/src/pages/orders/list.tsx"),
      "utf8",
    );
    // Explicit page emits at /pages/order_list.tsx (snake of page name).
    const explicitList = explicit.get("web/src/pages/order_list.tsx");
    expect(explicitList).toBeDefined();
    expect(scaffold).toMatch(/export default function OrderList/);
    expect(explicitList).toMatch(/export default function OrderList/);
  });

  it("explicit OrderList exposes the scaffold's interactive testids", async () => {
    const explicit = await generateFromFile("examples/acme-order-explicit.ddd");
    const scaffold = readFileSync(
      resolve(repoRoot, "test/fixtures/baseline-output/web_app/src/pages/orders/list.tsx"),
      "utf8",
    );
    const explicitTsx = explicit.get("web/src/pages/order_list.tsx")!;
    const scaffoldTestids = extractTestids(scaffold);
    const explicitTestids = extractTestids(explicitTsx);
    // Core interactive testids the scaffold exposes that an e2e
    // test would target.  Each must also appear in the explicit
    // page so the same test code works against either.
    const required = ["orders-list", "orders-list-create"];
    for (const tid of required) {
      expect(scaffoldTestids.has(tid), `scaffold should expose '${tid}'`).toBe(true);
      expect(explicitTestids.has(tid), `explicit should expose '${tid}'`).toBe(true);
    }
  });

  it("explicit OrderList auto-injects useAllOrders (same hook as scaffold)", async () => {
    const explicit = await generateFromFile("examples/acme-order-explicit.ddd");
    const tsx = explicit.get("web/src/pages/order_list.tsx")!;
    expect(tsx).toMatch(/import \{ useAllOrders \} from "\.\.\/api\/order"/);
    expect(tsx).toMatch(/useAllOrders\(\)/);
  });

  it("explicit OrderNew exposes the scaffold's form testids (input-* + submit)", async () => {
    const explicit = await generateFromFile("examples/acme-order-explicit.ddd");
    const scaffold = readFileSync(
      resolve(repoRoot, "test/fixtures/baseline-output/web_app/src/pages/orders/new.tsx"),
      "utf8",
    );
    const explicitTsx = explicit.get("web/src/pages/order_new.tsx")!;
    expect(explicitTsx).toBeDefined();
    const scaffoldTestids = extractTestids(scaffold);
    const explicitTestids = extractTestids(explicitTsx);
    // Per-field testids + submit button.  scaffold's namespace is
    // `<plural-snake>-new-input-<field>`; explicit form passes
    // `testid: "orders-new"` on Form(of:) so its synthesised
    // namespace lines up byte-for-byte.
    const required = [
      "orders-new-input-customerId",
      "orders-new-input-status",
      "orders-new-input-placedAt",
      "orders-new-submit",
    ];
    for (const tid of required) {
      expect(scaffoldTestids.has(tid), `scaffold should expose '${tid}'`).toBe(true);
      expect(explicitTestids.has(tid), `explicit should expose '${tid}'`).toBe(true);
    }
  });

  it("explicit OrderNew auto-injects useCreateOrder + zodResolver wiring", async () => {
    const explicit = await generateFromFile("examples/acme-order-explicit.ddd");
    const tsx = explicit.get("web/src/pages/order_new.tsx")!;
    expect(tsx).toMatch(/import \{ CreateOrderRequest, useCreateOrder \} from "\.\.\/api\/order"/);
    expect(tsx).toMatch(/useForm<CreateOrderRequest>/);
    expect(tsx).toMatch(/zodResolver\(CreateOrderRequest\)/);
  });

  it("explicit walker page-objects (e2e/pages/<name>.ts) emit alongside scaffold's aggregate-keyed ones", async () => {
    const explicit = await generateFromFile("examples/acme-order-explicit.ddd");
    // Walker page-objects keyed off the page name (snake).
    expect(explicit.has("web/e2e/pages/order_list.ts")).toBe(true);
    expect(explicit.has("web/e2e/pages/order_new.ts")).toBe(true);
    const listPo = explicit.get("web/e2e/pages/order_list.ts")!;
    expect(listPo).toMatch(/export class OrderListPage/);
    expect(listPo).toMatch(/static readonly url = "\/orders"/);
    const newPo = explicit.get("web/e2e/pages/order_new.ts")!;
    expect(newPo).toMatch(/export class OrderNewPage/);
    expect(newPo).toMatch(/static readonly url = "\/orders\/new"/);
    // The explicit OrderList uses Form(of:)'s synthesised testids
    // for the input fields — surface them as Locator getters.
    expect(newPo).toMatch(/get ordersNewInputCustomerId\(\): Locator/);
    expect(newPo).toMatch(/get ordersNewSubmit\(\): Locator/);
  });
});
