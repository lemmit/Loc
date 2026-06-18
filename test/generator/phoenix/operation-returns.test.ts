// Generator coverage for exception-less operation `or`-union returns on the
// Phoenix/Ash backend (exception-less.md A3, DEBT-03).  A return-dominant
// `operation reserve(): Order or NotFound { return NotFound { … } }` lowers to
// an Ash 3.x *generic action* (an `update` action's result can't carry a
// discriminated union); the controller translates the tagged term to HTTP —
// success → 200 + body, an `error`-payload variant → its RFC-7807
// ProblemDetails status.  The generated project compiles under
// `mix compile --warnings-as-errors`
// (test/e2e/fixtures/phoenix-build/operation-returns.ddd).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Orders {
  subdomain Sales {
    context Reservations {
      error NotFound { resource: string }
      aggregate Order ids guid {
        code: string
        operation reserve(): Order or NotFound {
          return NotFound { resource: code }
        }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Reservations, kind: state, use: primary }
  deployable api {
    platform: phoenix
    contexts: [Reservations]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}
function bySuffix(f: Map<string, string>, suffix: string): string {
  const key = [...f.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return f.get(key)!;
}

describe("phoenix generator — exception-less operation returns (DEBT-03)", () => {
  it("emits the operation as an Ash generic action that loads the record and returns a tagged term", async () => {
    const resource = bySuffix(await files(), "reservations/order.ex");
    // Generic action (not `update :reserve`) with the id + a record-loading run fn.
    expect(resource).toContain("action :reserve, :term do");
    expect(resource).toContain("argument :id, :string, allow_nil?: false");
    expect(resource).toContain("run fn input, _context ->");
    expect(resource).toContain("case Ash.get(__MODULE__, input.arguments.id) do");
    // The run fn must hand Ash a `{:ok, value}` term — the *business* error
    // rides as the `:problem` tag inside that wrapper; absent record → `:not_found`.
    expect(resource).toContain('{:ok, {:problem, "NotFound", %{resource: record.code}}}');
    expect(resource).toContain("{:ok, {:not_found, input.arguments.id}}");
  });

  it("does NOT emit an `update :reserve` action for the returning op", async () => {
    const resource = bySuffix(await files(), "reservations/order.ex");
    expect(resource).not.toContain("update :reserve do");
  });

  it("gives the operation's code interface an `:id`-first argument list", async () => {
    const context = bySuffix(await files(), "reservations.ex");
    expect(context).toContain("define :reserve_order, action: :reserve, args: [:id]");
  });

  it("translates the tagged term in the controller — success → 200, error variant → ProblemDetails", async () => {
    const ctrl = bySuffix(await files(), "controllers/orders_controller.ex");
    // No op params → bind only `id` (an unused `= params` would fail
    // --warnings-as-errors).
    expect(ctrl).toContain('def reserve(conn, %{"id" => id}) do');
    // The Phoenix app module is derived from the deployable name (`api` → `Api`).
    expect(ctrl).toContain("case Api.Reservations.reserve_order(id) do");
    expect(ctrl).toContain("{:ok, {:success, body}} ->");
    expect(ctrl).toContain("json(conn, body)");
    // NotFound's stdlib default status / type / title ride the problem responder.
    expect(ctrl).toContain('{:ok, {:problem, "NotFound", data}} ->');
    expect(ctrl).toContain('problem_variant(conn, 404, "/errors/not-found", "Not Found", data)');
    // Absent record → the shared 404; an action-level failure → 422.
    expect(ctrl).toContain("{:ok, {:not_found, _}} ->");
    expect(ctrl).toContain('ApiWeb.ProblemDetails.not_found_response(conn, "Order", id)');
  });

  it("emits the shared problem_variant/5 responder once per controller with a returning op", async () => {
    const ctrl = bySuffix(await files(), "controllers/orders_controller.ex");
    expect(ctrl).toContain("defp problem_variant(conn, status, type, title, data) do");
    expect(ctrl).toContain('put_resp_content_type("application/problem+json")');
    expect((ctrl.match(/defp problem_variant\(/g) ?? []).length).toBe(1);
  });
});
