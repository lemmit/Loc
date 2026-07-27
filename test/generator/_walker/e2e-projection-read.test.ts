// E2E projection-read surface (projection.md, M-T4.2 runtime parity).
//
// A `test e2e` body reads a folded projection's read model through two verbs on
// the magic `api` root:
//
//   api.<proj>.byKey(k)  → GET /api/projections/<snake(name)>/{key}
//   api.<proj>.list()    → GET /api/projections/<snake(name)>
//
// The emitted `.e2e.test.ts` is backend-agnostic HTTP (one assertion replays
// against every compatible backend), so this is the render half of the
// folded-projection runtime proof the behavioural tier boots.  The IR-validate
// half (`test-checks.ts`) accepts the read verbs and rejects unknown ones.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/index.js";
import { parseString } from "../../_helpers/parse.js";

const SYS = `
  system Shop {
    subdomain Orders {
      context Orders {
        enum BoardStatus { Placed Shipped }
        aggregate Order with crudish {
          status: string
          operation place() {
            precondition status == "Draft"
            status := "Placed"
            emit OrderPlaced { order: id }
          }
        }
        repository Orders for Order { }
        event OrderPlaced { order: Order id }
        channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
        projection OrderBoard keyed by order {
          order: Order id
          status: BoardStatus
          on(e: OrderPlaced) { order := e.order  status := Placed }
        }
      }
    }
    api OrdersApi from Orders
    storage pg { type: postgres }
    resource s { for: Orders, kind: state, use: pg }
    deployable d {
      platform: node
      contexts: [Orders]
      dataSources: [s]
      serves: OrdersApi
      port: 4000
    }
    test e2e "read the folded row by key and as a list" against d {
      let ord = api.orders.create({ status: "Draft" })
      api.orders.place(ord)
      let one = api.orderBoard.byKey(ord)
      expect(one.status).toBe("Placed")
      let all = api.orderBoard.list()
      expect(all.length).toBeGreaterThanOrEqual(1)
    }
  }
`;

describe("e2e projection-read surface", () => {
  it("byKey renders GET /api/projections/<snake>/{key} with the correlation id", async () => {
    const files = await generateSystemFiles(SYS);
    const e2e = files.get("e2e/Shop.e2e.test.ts")!;
    expect(e2e).toContain("await __get(`${base}/api/projections/order_board/${ord.id}`)");
  });

  it("list renders GET /api/projections/<snake> (no key)", async () => {
    const files = await generateSystemFiles(SYS);
    const e2e = files.get("e2e/Shop.e2e.test.ts")!;
    expect(e2e).toContain("await __get(`${base}/api/projections/order_board`)");
  });

  it("the projection read is not mistaken for an aggregate call", async () => {
    const files = await generateSystemFiles(SYS);
    const e2e = files.get("e2e/Shop.e2e.test.ts")!;
    // No `/api/order_board` (the aggregate-route shape) — only the projection path.
    expect(e2e).not.toContain("/api/order_boards");
  });

  it("validation accepts byKey/list but rejects an unknown projection verb", async () => {
    const bad = SYS.replace("api.orderBoard.byKey(ord)", "api.orderBoard.frobnicate(ord)");
    const { model } = await parseString(bad, { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    expect(
      diags.some(
        (d) => d.code === "loom.e2e-unknown-method" && /projection read.*frobnicate/.test(d.message),
      ),
    ).toBe(true);
  });
});
