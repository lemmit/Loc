// Angular rendering for MVU Stage 2 — `match await <op>() { Variant b => … }` in
// a frontend action body (async-actions-and-effects.md, Proposal B Stage 2).
//
// Mirrors the React reference (`test/generator/react/variant-match-await.test.ts`).
// The awaited subject is a remote `or`-union-returning operation.  The Angular
// walker emits an async page-action CLASS METHOD (await the hoisted mutation,
// reify a thrown ApiError into the error variant) + a discriminant
// `switch (result.type)`, and the api module's union-op mutation factory binds
// the record id at hook time and resolves with the tagged discriminated union.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// Minimal single-context system: an aggregate with a union-returning
// `operation placeOrder(): Order or Failed`, an ambient (root) error so the UI
// match arm can name it, and a detail page whose `submit` action awaits the op.
const STAGE2 = `
  error Failed { reason: string }
  system Shop {
    api SalesApi from Sales { httpStatus Failed 422 }
    subdomain Sales {
      context Ordering {
        aggregate Order {
          code: string
          operation placeOrder(): Order or Failed {
            return Failed { reason: code }
          }
        }
        repository Orders for Order { }
      }
    }
    storage primarySql { type: postgres }
    resource orderingState { for: Ordering, kind: state, use: primarySql }
    ui Web {
      api Sales: SalesApi
      page OrderDetail {
        route: "/orders/:id"
        state { message: string = "" }
        action submit() {
          match await Sales.Order.placeOrder() {
            Order o => { message := o.code }
            Failed f => { message := f.reason }
          }
        }
        body: Stack { Button { "Place", onClick: submit } }
      }
    }
    deployable api {
      platform: node
      contexts: [Ordering]
      dataSources: [orderingState]
      serves: SalesApi
      port: 3000
    }
    deployable web {
      platform: angular
      targets: api
      ui: Web { Sales: api }
      port: 3001
    }
  }
`;

describe("Angular variant-`match await` (MVU Stage 2)", () => {
  it("emits an async submit method that awaits, reifies the error, and switches on result.type", async () => {
    const files = await generateSystemFiles(STAGE2);
    const comp = files.get("web/src/app/pages/order-detail.component.ts")!;
    expect(comp).toBeDefined();

    // The action handler is a class method, made `async` so it can `await`.
    expect(comp).toContain("async submit() {");
    // The mutation is hoisted off the route id as a class field and awaited via
    // `this.` (class-method scope).
    expect(comp).toContain('readonly orderPlaceOrder = usePlaceOrderOrder(this.id ?? "");');
    expect(comp).toContain("result = await this.orderPlaceOrder.mutateAsync({});");
    // A caught ApiError is reified into the error variant (its `type` re-stamped
    // to the statically-known error tag — the backend overwrote it with the URI).
    expect(comp).toContain("if (e instanceof ApiError) {");
    expect(comp).toContain('type: "Failed" } as PlaceOrderOrderResponse;');
    // Discriminant switch with a case per variant, each binding the narrowed value
    // and writing the page signal (`this.`-prefixed for class-method scope).
    expect(comp).toContain("switch (result.type) {");
    expect(comp).toContain('case "Order": {');
    expect(comp).toContain("const o = result;");
    expect(comp).toContain("this.message.set(o.code);");
    expect(comp).toContain('case "Failed": {');
    expect(comp).toContain("const f = result;");
    expect(comp).toContain("this.message.set(f.reason);");
    // The component imports ApiError + the union response type (paths lifted to
    // the two-hops-deep page location) and binds the route id from ActivatedRoute.
    expect(comp).toContain('import { ApiError } from "../../api/client";');
    expect(comp).toContain('import { PlaceOrderOrderResponse } from "../../api/order";');
    expect(comp).toContain('this.route.snapshot.paramMap.get("id")');
  });

  it("union-op mutation factory binds id at hook time; the api module emits the discriminated DTO", async () => {
    const files = await generateSystemFiles(STAGE2);
    const api = files.get("web/src/api/order.ts")!;
    expect(api).toBeDefined();

    // The union-returning op factory binds the record id at hook time (mirroring
    // the React op-mutation shape the awaiting action expects).
    expect(api).toContain("export function usePlaceOrderOrder(id: string) {");
    expect(api).toContain(
      "mutationFn: (input: PlaceOrderOrderRequest) => firstValueFrom(service.placeOrder(id, input)),",
    );
    // The service method types the response as the discriminated union (the URL
    // template is a runtime string — assert only the union-typed post call).
    expect(api).toContain("return this.http.post<PlaceOrderOrderResponse>(");
    expect(api).toContain("/placeOrder`, input);");
    // The discriminated-union type alias: the success variant intersects its
    // response interface with the tag, the error variant is its own tagged object.
    expect(api).toContain("export type PlaceOrderOrderResponse =");
    expect(api).toContain('| (OrderResponse & { type: "Order" })');
    expect(api).toContain('| { type: "Failed"; reason: string };');
  });
});
