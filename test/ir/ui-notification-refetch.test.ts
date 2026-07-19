// `on <channel>.<Event>(e) { … }` handler-body lowering — the
// `refetch(<Aggregate>)` action (channels.md Part I, "richer handler
// bodies").  A handler body admits `toast(<expr>)` and
// `refetch(<Aggregate>[, …])`; the refetch lowers to a fully-resolved
// `RefetchTargetIR` carrying the query-key tag (`snake(plural(name))`)
// the frontend api modules register under, so backends never re-derive.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { parseValid } from "../_helpers/parse.js";

/** A realtime Shop whose `WebApp` ui subscribes to `Fulfillment.Lifecycle`;
 *  `handlerBody` splices into the single `on Orders.OrderPlaced(e)` handler. */
function shop(handlerBody: string): string {
  return `
    system RealtimeShop {
      subdomain Shipping {
        context Fulfillment {
          aggregate Order { customerId: string  status: string }
          repository Orders for Order { }
          aggregate Customer { name: string }
          repository Customers for Customer { }
          event OrderPlaced { order: Order id, at: datetime }
          channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
          workflow W { orderId: Order id  create(p: OrderPlaced) by p.order { } }
        }
      }
      api FulfillmentApi from Shipping
      ui WebApp {
        api Fulfillment: FulfillmentApi
        channel Orders: Fulfillment.Lifecycle
        on Orders.OrderPlaced(e) { ${handlerBody} }
        page Home { route: "/" body: Heading { "hi" } }
      }
      deployable backend { platform: node  contexts: [Fulfillment]  serves: FulfillmentApi  port: 3000 }
    }`;
}

async function notification(handlerBody: string) {
  const model = lowerModel(await parseValid(shop(handlerBody)));
  const ui = model.systems[0].uis.find((u) => u.name === "WebApp");
  const n = ui?.notifications?.[0];
  if (!n) throw new Error("no notification lowered");
  return n;
}

describe("UiNotificationIR — refetch lowering", () => {
  it("lowers `refetch(Order)` to a resolved query-tag target", async () => {
    const n = await notification('toast("hi") refetch(Order)');
    expect(n.toasts).toHaveLength(1);
    expect(n.refetches).toEqual([{ aggregate: "Order", queryTag: "orders" }]);
  });

  it("lowers a multi-target `refetch(Order, Customer)`", async () => {
    const n = await notification("refetch(Order, Customer)");
    expect(n.toasts).toEqual([]);
    expect(n.refetches).toEqual([
      { aggregate: "Order", queryTag: "orders" },
      { aggregate: "Customer", queryTag: "customers" },
    ]);
  });

  it("omits `refetches` for a toast-only handler", async () => {
    const n = await notification('toast("hi")');
    expect(n.refetches).toBeUndefined();
  });
});
