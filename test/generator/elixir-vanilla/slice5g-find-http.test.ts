import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Vanilla custom-find HTTP surface — `GET /<plural>/<find>` per repository
// `find`, matching the Ash path (same `.ddd` → same OpenAPI).  Literal find
// routes register before `/:id`; list finds map each result, single finds
// serialise one-or-nil; param-less finds bind `_params`.  Union finds stay
// internal-only (no route) pending the absence-producer slice.
// ---------------------------------------------------------------------------

const SRC = `
system S {
  subdomain Core {
    context Shop {
      aggregate Order with crudish { customerId: string  total: int }
      repository Orders for Order {
        find byCustomer(customerId: string): Order[] where this.customerId == customerId
        find latest(): Order?
      }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource st { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir contexts: [Shop] dataSources: [st] serves: A port: 4000 }
}
`;

const get = (m: Map<string, string>, suffix: string) =>
  m.get([...m.keys()].find((k) => k.endsWith(suffix))!)!;

describe("vanilla — custom-find HTTP surface", () => {
  it("registers find routes before /:id", async () => {
    const router = get(await generateSystemFiles(SRC), "/router.ex");
    const byCustomer = router.indexOf('get "/orders/by_customer"');
    const latest = router.indexOf('get "/orders/latest"');
    const show = router.indexOf('get "/orders/:id"');
    expect(byCustomer).toBeGreaterThan(-1);
    expect(latest).toBeGreaterThan(-1);
    expect(byCustomer).toBeLessThan(show);
    expect(latest).toBeLessThan(show);
  });

  it("emits list / single / param-less find actions", async () => {
    const ctl = get(await generateSystemFiles(SRC), "/controllers/order_controller.ex");
    // list → map each element
    expect(ctl).toContain("def by_customer(conn, params) do");
    expect(ctl).toContain('with {:ok, records} <- Shop.by_customer_order(params["customerId"]) do');
    expect(ctl).toContain("json(conn, Enum.map(records, &serialize/1))");
    // single → one-or-nil
    expect(ctl).toContain("def latest(conn, _params) do");
    expect(ctl).toContain("{:ok, nil} -> json(conn, nil)");
  });
});
