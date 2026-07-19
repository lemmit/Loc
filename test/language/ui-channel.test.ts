// UI channel subscription + live-event handlers — parse / scope /
// validation (channels.md Part I, ui surface).
//
//   channel Orders: Fulfillment.Lifecycle
//   on Orders.OrderPlaced(e) { toast("Order " + e.order + " placed") }
//
// The channel segment resolves within the named context; the event
// resolves within the param's channel `carries:` list; v1 handler
// bodies admit only `toast(<expr>)` (loom.ui-handler-unsupported).

import { describe, expect, it } from "vitest";
import { parseString } from "../_helpers/index.js";

/** A system with one broadcast channel; `uiMembers` splices into the ui. */
const sys = (uiMembers: string, channelKnobs = "delivery: broadcast  retention: ephemeral") => `
system Shop {
  subdomain Shipping {
    context Fulfillment {
      aggregate Order { status: string }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      event OrderArchived { order: Order id }
      channel Lifecycle {
        carries: OrderPlaced
        ${channelKnobs}
      }
      workflow W { orderId: Order id  create(p: OrderPlaced) by p.order { } }
    }
  }
  api FulfillmentApi from Shipping
  ui WebApp {
    api Fulfillment: FulfillmentApi
    ${uiMembers}
    page Home { route: "/" body: Heading { "hi" } }
  }
  deployable backend { platform: node  contexts: [Fulfillment]  serves: FulfillmentApi  port: 3000 }
}
`;

describe("ui channel subscription — parse / scope", () => {
  it("parses a channel param + on handler with no errors", async () => {
    const { errors } = await parseString(
      sys(`
        channel Orders: Fulfillment.Lifecycle
        on Orders.OrderPlaced(e) { toast("Order " + e.order + " placed") }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("rejects a channel param naming an undeclared channel", async () => {
    const { errors } = await parseString(sys("channel Orders: Fulfillment.Nope"));
    expect(errors.some((e) => /Nope/.test(e))).toBe(true);
  });

  it("rejects an `on` handler for an event the channel does not carry", async () => {
    const { errors } = await parseString(
      sys(`
        channel Orders: Fulfillment.Lifecycle
        on Orders.OrderArchived(e) { toast("gone") }
      `),
    );
    // OrderArchived exists in the context but isn't in `carries:` —
    // the scope provider offers carried events only, so this is a
    // resolution error rather than a later semantic one.
    expect(errors.some((e) => /OrderArchived/.test(e))).toBe(true);
  });
});

describe("ui channel subscription — validation", () => {
  it("rejects subscribing to a `delivery: queue` channel", async () => {
    const { errors } = await parseString(
      sys("channel Orders: Fulfillment.Lifecycle", "delivery: queue  retention: work"),
    );
    expect(
      errors.some((e) => /Only 'delivery: broadcast' channels are UI-observable/.test(e)),
    ).toBe(true);
  });

  it("rejects a duplicate parameter name (shared namespace with api params)", async () => {
    const { errors } = await parseString(sys("channel Fulfillment: Fulfillment.Lifecycle"));
    expect(errors.some((e) => /declares parameter 'Fulfillment' more than once/.test(e))).toBe(
      true,
    );
  });

  it("rejects a non-toast/non-refetch statement in an `on` handler body", async () => {
    const { errors } = await parseString(
      sys(`
        channel Orders: Fulfillment.Lifecycle
        on Orders.OrderPlaced(e) { navigate("/orders") }
      `),
    );
    // The unsupported-statement diagnostic keeps its `loom.ui-handler-unsupported`
    // code and now lists both supported actions.
    expect(errors.some((e) => /supports 'toast\(.*\) and 'refetch\(/.test(e))).toBe(true);
  });

  it("accepts a `refetch(<Aggregate>)` action alongside a toast", async () => {
    const { errors } = await parseString(
      sys(`
        channel Orders: Fulfillment.Lifecycle
        on Orders.OrderPlaced(e) { toast("shipped") refetch(Order) }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("rejects a `refetch(<Unknown>)` naming no declared aggregate", async () => {
    const { errors } = await parseString(
      sys(`
        channel Orders: Fulfillment.Lifecycle
        on Orders.OrderPlaced(e) { refetch(Nope) }
      `),
    );
    expect(errors.some((e) => /Unknown refetch target 'Nope'/.test(e))).toBe(true);
  });

  it("rejects an argument-less `refetch()`", async () => {
    const { errors } = await parseString(
      sys(`
        channel Orders: Fulfillment.Lifecycle
        on Orders.OrderPlaced(e) { refetch() }
      `),
    );
    expect(errors.some((e) => /needs at least one aggregate to refetch/.test(e))).toBe(true);
  });
});
