// The `when` canCommand state gate on Phoenix/Ash (criterion.md, use site 2).
//
// A `when`-gated operation loads the record, evaluates the predicate, and
// returns 409 Disallowed before mutating — mirroring the Hono/.NET/Python
// "gate in the route" shape.  It also auto-exposes a side-effect-free
// `GET /<plural>/:id/can_<op>` companion returning `{ allowed }`, and declares
// both the 409 (on the op) and the can-route in the generated OpenAPI spec so
// the conformance parity gate compares equal.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft, Shipped, Cancelled }
      aggregate Order ids guid {
        code: string
        status: OrderStatus
        operation cancel() when this.status != Shipped && this.status != Cancelled {
          status := Cancelled
        }
      }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  ui WebApp {}
  deployable api {
    platform: phoenix
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    ui: WebApp
    port: 4000
  }
}
`;

async function gen(): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(SRC))).files;
}

function find(files: Map<string, string>, pred: (k: string) => boolean, label: string): string {
  const key = [...files.keys()].find(pred);
  expect(key, `${label} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("Phoenix `when` gate + can-query", () => {
  it("gates the operation: loads the record, 409s when the predicate is false", async () => {
    const ctrl = find(await gen(), (k) => k.endsWith("orders_controller.ex"), "controller");
    expect(ctrl).toContain("record = Api.Orders.get_order!(id)");
    // Enum values resolve to Ash atoms (`:shipped`), not free calls.
    expect(ctrl).toContain("if record.status != :shipped and record.status != :cancelled do");
    expect(ctrl).toContain('ApiWeb.ProblemDetails.problem_response(conn, 409, "Disallowed",');
  });

  it("auto-exposes the side-effect-free can_<op> companion returning { allowed }", async () => {
    const ctrl = find(await gen(), (k) => k.endsWith("orders_controller.ex"), "controller");
    expect(ctrl).toContain('def can_cancel(conn, %{"id" => id}) do');
    expect(ctrl).toContain(
      "json(conn, %{allowed: record.status != :shipped and record.status != :cancelled})",
    );
  });

  it("registers the can_<op> GET route", async () => {
    const router = find(await gen(), (k) => k.endsWith("router.ex"), "router");
    expect(router).toContain('get "/orders/:id/can_cancel", OrdersController, :can_cancel');
  });

  it("declares the 409 on the op path and the can-route + CanResponse in OpenAPI", async () => {
    const files = await gen();
    const spec = find(files, (k) => k.endsWith("_spec.ex"), "openapi spec");
    // The op path gains a 409 response (the when-gate's Disallowed outcome).
    const opBlock = spec.slice(
      spec.indexOf('"/orders/{id}/cancel"'),
      spec.indexOf('"/orders/{id}/can_cancel"'),
    );
    expect(opBlock).toContain("409 => %OpenApiSpex.Response{");
    // The can path: GET → 200 CanResponse + 404.
    expect(spec).toContain('"/orders/{id}/can_cancel" => %OpenApiSpex.PathItem{');
    expect(spec).toContain("schema: ApiWeb.Api.Schemas.CanResponse");
    // The shared CanResponse schema module is emitted.
    expect([...files.keys()].some((k) => k.endsWith("can_response.ex"))).toBe(true);
  });
});
