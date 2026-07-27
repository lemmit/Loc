// ---------------------------------------------------------------------------
// Vanilla Elixir — event-sourced applier fold statement coverage (M-T6.2).
//
// An `apply(e: E) { … }` fold rebinds in-memory state.  Before M-T6.2 the fold
// renderer handled only `assign` / `let` / `expression` and emitted a silent
// `# unsupported applier statement: <kind>` comment for a `+=` / `-=` — so a
// collection-append or scalar-arithmetic fold compiled GREEN while dropping the
// transition at runtime (data loss).  These assert the mutations now fold, that
// the event param binds (not `_e`) when only a `+=` references it, and that a
// value-object collection folds as a plain map.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const AGG_SRC = `system EsFold {
  subdomain Core {
    context Orders {
      valueobject Money { amount: int  currency: string }
      event Placed { order: Order id, customer: string }
      event Tagged { order: Order id, tag: string }
      event Discounted { order: Order id, amount: int }
      event Charged { order: Order id, amt: int }
      aggregate Order persistedAs: eventLog {
        customer: string
        total: int
        tags: string[]
        charges: Money[]
        create place(customer: string) { emit Placed { order: id, customer: customer } }
        operation tag(tag: string) { emit Tagged { order: id, tag: tag } }
        operation discount(amount: int) { emit Discounted { order: id, amount: amount } }
        operation charge(amt: int) { emit Charged { order: id, amt: amt } }
        apply(e: Placed) { customer := e.customer }
        apply(e: Tagged) { tags += e.tag }
        apply(e: Discounted) { total -= e.amount }
        apply(e: Charged) { charges += Money { amount: e.amt, currency: "USD" } }
      }
      repository Orders for Order {
        find byCustomer(customer: string): Order[] where this.customer == customer
      }
    }
  }
  api OrdersApi from Core
  storage pg { type: postgres }
  resource orderLog { for: Orders, kind: eventLog, use: pg }
  deployable api { platform: elixir, contexts: [Orders], dataSources: [orderLog], serves: OrdersApi, port: 4000 }
}`;

describe("vanilla elixir ES applier fold — collection/scalar mutations", () => {
  it("folds a primitive-collection `+=` as a list append", async () => {
    const fold = (await generateSystemFiles(AGG_SRC)).get("api/lib/api/orders/order_fold.ex")!;
    expect(fold).toContain("state = %{state | tags: (state.tags || []) ++ [e.tag]}");
    // No silent fallthrough left.
    expect(fold).not.toContain("# unsupported applier statement");
  });

  it("folds a scalar `-=` as arithmetic on the folded field", async () => {
    const fold = (await generateSystemFiles(AGG_SRC)).get("api/lib/api/orders/order_fold.ex")!;
    expect(fold).toContain("state = %{state | total: state.total - e.amount}");
  });

  it("binds the event param (not `_e`) when only a `+=`/`-=` references it", async () => {
    const fold = (await generateSystemFiles(AGG_SRC)).get("api/lib/api/orders/order_fold.ex")!;
    // `apply(e: Tagged) { tags += e.tag }` — the ONLY use of `e` is inside the
    // `+=`, so the applier head must bind `e`, not `_e` (else `e.tag` is an
    // unbound-variable compile error under `--warnings-as-errors`).
    expect(fold).toContain("def apply_event(state, %Api.Orders.Events.Tagged{} = e) do");
    expect(fold).not.toContain("%Api.Orders.Events.Tagged{} = _e");
    expect(fold).not.toContain("%Api.Orders.Events.Discounted{} = _e");
  });

  it("folds a value-object collection `+=` as a plain map (no struct module needed)", async () => {
    // Renderer-level fact: a VO `new` lowers to an `object` expression → a plain
    // map, which the ES controller's `serialize_<vo>/1` reads by either key — so
    // the FOLD needs no struct module and is NOT gated.  (A `Money[]` field on an
    // ES aggregate has a separate, applier-independent schema gap — the
    // `<agg>_charges` table-backed schema `belongs_to` the ES struct — so the
    // whole VO-collection-on-ES project doesn't `mix compile` yet; that's why
    // this stays a unit assertion, not a compile fixture.)
    const fold = (await generateSystemFiles(AGG_SRC)).get("api/lib/api/orders/order_fold.ex")!;
    expect(fold).toContain(
      'state = %{state | charges: (state.charges || []) ++ [%{amount: e.amt, currency: "USD"}]}',
    );
  });

  it("keeps a scalar `assign` fold byte-identical", async () => {
    const fold = (await generateSystemFiles(AGG_SRC)).get("api/lib/api/orders/order_fold.ex")!;
    expect(fold).toContain("state = %{state | customer: e.customer}");
  });
});

const WF_SRC = `system EsFoldWf {
  subdomain Fulfillment {
    context Fulfillment {
      event OrderPlaced { order: Order id, at: datetime }
      event LineAdded { order: Order id, sku: string }
      event Refunded { order: Order id, amount: int }
      aggregate Order {
        status: string
        create place() { status := "Placed"  emit OrderPlaced { order: id, at: now() } }
      }
      repository Orders for Order { }
      channel Lifecycle { carries: OrderPlaced, LineAdded, Refunded  delivery: broadcast  retention: ephemeral }
      workflow OrderFulfillment eventSourced {
        orderId: Order id
        skus: string[]
        balance: int
        create(p: OrderPlaced) by p.order { emit LineAdded { order: p.order, sku: "seed" } }
        on(la: LineAdded) by la.order { emit Refunded { order: la.order, amount: 0 } }
        apply(la: LineAdded) { skus += la.sku }
        apply(r: Refunded) { balance -= r.amount }
      }
    }
  }
  api FulfillmentApi from Fulfillment
  storage pg { type: postgres }
  resource fulfillmentState { for: Fulfillment, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Fulfillment], dataSources: [fulfillmentState], serves: FulfillmentApi, port: 4000 }
}`;

describe("vanilla elixir ES workflow applier fold — collection/scalar mutations", () => {
  it("folds workflow-state `+=` / `-=` mutations and binds the param", async () => {
    const fold = (await generateSystemFiles(WF_SRC)).get(
      "api/lib/api/fulfillment/workflows/order_fulfillment_fold.ex",
    )!;
    expect(fold).toContain("state = %{state | skus: (state.skus || []) ++ [la.sku]}");
    expect(fold).toContain("state = %{state | balance: state.balance - r.amount}");
    expect(fold).toContain("def apply_event(state, %Api.Fulfillment.Events.LineAdded{} = la) do");
    expect(fold).not.toContain("# unsupported applier statement");
  });
});
