// React rendering for MVU Stage 2 — `match await <op>() { Variant b => … }` in
// a frontend action body (async-actions-and-effects.md, Proposal B Stage 2).
//
// The awaited subject is a remote `or`-union-returning operation.  The walker
// emits an async envelope (await the hoisted mutation, reify a thrown ApiError
// into the error variant) + a discriminant `switch (result.type)`, and the api
// module's mutation hook returns the parsed discriminated union.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

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
      platform: react
      targets: api
      ui: Web { Sales: api }
      port: 3001
    }
  }
`;

describe("React variant-`match await` (MVU Stage 2)", () => {
  it("emits an async submit handler that awaits, reifies the error, and switches on result.type", async () => {
    const files = await generateSystemFiles(STAGE2);
    const tsx = files.get("web/src/pages/order_detail.tsx")!;
    expect(tsx).toBeDefined();

    // The handler is async so it can `await`.
    expect(tsx).toContain("const submit = async () =>");
    // The mutation is hoisted off the route id and awaited.
    expect(tsx).toContain('const orderPlaceOrder = usePlaceOrderOrder(id ?? "");');
    expect(tsx).toContain("result = await orderPlaceOrder.mutateAsync({});");
    // A caught ApiError is reified into the error variant (its `type` re-stamped
    // to the statically-known error tag — the backend overwrote it with the URI).
    expect(tsx).toContain("if (e instanceof ApiError) {");
    expect(tsx).toContain('type: "Failed" } as PlaceOrderOrderResponse;');
    // Discriminant switch with a case per variant, each binding the narrowed value.
    expect(tsx).toContain("switch (result.type) {");
    expect(tsx).toContain('case "Order": {');
    expect(tsx).toContain("const o = result;");
    expect(tsx).toContain("setMessage(o.code);");
    expect(tsx).toContain('case "Failed": {');
    expect(tsx).toContain("const f = result;");
    expect(tsx).toContain("setMessage(f.reason);");
    // The page imports ApiError + the union response type, and binds the route id.
    expect(tsx).toContain('import { ApiError } from "../api/client";');
    expect(tsx).toContain('import { PlaceOrderOrderResponse } from "../api/order";');
    expect(tsx).toContain("const { id } = useParams");
  });

  it("mutation hook returns the parsed union; the api module emits the discriminated DTO", async () => {
    const files = await generateSystemFiles(STAGE2);
    const api = files.get("web/src/api/order.ts")!;
    expect(api).toBeDefined();

    // The union-returning op hook parses + RETURNS the discriminated union.
    expect(api).toContain("export function usePlaceOrderOrder(id: string) {");
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

// Multi-error reification (async-actions-and-effects.md Stage 2 — error side).
// A union with TWO error variants, both declared CONTEXT-LOCAL (so the arm-scope
// widening in ddd-scope.ts is exercised alongside the reify).  The reify must map
// the caught ProblemDetails `type` URI back to the matching tag, not blindly
// re-stamp one.
const MULTI = `
  system Shop {
    api SalesApi from Sales
    subdomain Sales {
      context Ordering {
        error Failed { reason: string }
        error Declined { code: int }
        aggregate Order {
          name: string
          operation confirm(): Order or Failed or Declined {
            return Failed { reason: name }
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
          match await Sales.Order.confirm() {
            Order o    => { message := o.name }
            Failed f   => { message := f.reason }
            Declined d => { message := "declined" }
          }
        }
        body: Stack { Button { "Go", onClick: submit } }
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
      platform: react
      targets: api
      ui: Web { Sales: api }
      port: 3001
    }
  }
`;

describe("React variant-`match await` — multiple error variants", () => {
  it("maps the caught ProblemDetails `type` URI back to the matching error tag", async () => {
    const files = await generateSystemFiles(MULTI);
    const tsx = files.get("web/src/pages/order_detail.tsx")!;
    expect(tsx).toBeDefined();

    // The reify inspects the ProblemDetails `type` URI and selects the tag — NOT
    // a single blind re-stamp — so both error arms route correctly.
    expect(tsx).toContain("const __t = (e.body as Record<string, unknown>)?.type;");
    expect(tsx).toContain('const __tag = __t === "/errors/failed" ? "Failed" : "Declined";');
    expect(tsx).toContain("type: __tag } as ConfirmOrderResponse;");
    // Every variant (success + both errors) gets a switch case.
    expect(tsx).toContain('case "Order": {');
    expect(tsx).toContain('case "Failed": {');
    expect(tsx).toContain('case "Declined": {');
  });
});
