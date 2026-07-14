// Svelte rendering for MVU Stage 2 — `match await <op>() { Variant b => … }` in
// a frontend action body (async-actions-and-effects.md, Proposal B Stage 2).
// The Svelte sibling of test/generator/react/variant-match-await.test.ts.
//
// The awaited subject is a remote `or`-union-returning operation.  The walker
// emits an async envelope (await the hoisted svelte-query mutation, reify a
// thrown ApiError into the error variant) + a discriminant `switch (result.type)`,
// and the api module's mutation hook returns the parsed discriminated union.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// Minimal single-context system: an aggregate with a union-returning
// `operation placeOrder(): Order or Failed`, an ambient (root) error so the UI
// match arm can name it, and a detail page whose `submit` action awaits the op.
const STAGE2 = `
  error Failed { reason: string }
  system Shop {
    api SalesApi from Sales { httpStatus Failed -> 422 }
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
      platform: svelte
      targets: api
      ui: Web { Sales: api }
      port: 3001
    }
  }
`;

describe("Svelte variant-`match await` (MVU Stage 2)", () => {
  it("emits an async submit handler that awaits, reifies the error, and switches on result.type", async () => {
    const files = await generateSystemFiles(STAGE2);
    const page = [...files].find(([p]) => p.endsWith("+page.svelte"))?.[1] ?? "";
    expect(page).not.toBe("");

    // The handler is async so it can `await` (walker-core default renderNamedHandler).
    expect(page).toContain("const submit = async () =>");
    // The mutation is hoisted off the route id (svelte-query accessor thunk) and awaited.
    expect(page).toContain('const orderPlaceOrder = usePlaceOrderOrder(() => id ?? "");');
    expect(page).toContain("result = await orderPlaceOrder.mutateAsync({});");
    // A caught ApiError is reified into the error variant (its `type` re-stamped
    // to the statically-known error tag — the backend overwrote it with the URI).
    expect(page).toContain("if (e instanceof ApiError) {");
    expect(page).toContain('type: "Failed" } as PlaceOrderOrderResponse;');
    // Discriminant switch with a case per variant, each binding the narrowed value.
    // Svelte $state writes are bare assignments (no React setter).
    expect(page).toContain("switch (result.type) {");
    expect(page).toContain('case "Order": {');
    expect(page).toContain("const o = result;");
    expect(page).toContain("message = o.code;");
    expect(page).toContain('case "Failed": {');
    expect(page).toContain("const f = result;");
    expect(page).toContain("message = f.reason;");
    // The page imports ApiError + the union response type, and binds the route id.
    expect(page).toContain('import { ApiError } from "$lib/api/client";');
    expect(page).toContain('import { PlaceOrderOrderResponse } from "$lib/api/order";');
    expect(page).toContain('const id = $derived(page.params.id ?? "");');
  });

  it("mutation hook returns the parsed union; the api module emits the discriminated DTO", async () => {
    const files = await generateSystemFiles(STAGE2);
    const api = files.get("web/src/lib/api/order.ts")!;
    expect(api).toBeDefined();

    // The union-returning op hook parses + RETURNS the discriminated union
    // (svelte-query accessor `id: () => string`).
    expect(api).toContain("export function usePlaceOrderOrder(id: () => string) {");
    expect(api).toContain("return PlaceOrderOrderResponse.parse(r);");
    // The discriminated-union DTO: success variant extends its response schema,
    // the error variant is its own tagged object.
    expect(api).toContain('export const PlaceOrderOrderResponse = z.discriminatedUnion("type", [');
    expect(api).toContain('OrderResponse.extend({ type: z.literal("Order") })');
    expect(api).toContain('z.object({ type: z.literal("Failed"), reason: z.string() })');
    expect(api).toContain(
      "export type PlaceOrderOrderResponse = z.infer<typeof PlaceOrderOrderResponse>;",
    );
  });
});
