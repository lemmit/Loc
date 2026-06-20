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
    // Absent record → 404 via the Ash ProblemDetails `problem_response/4`
    // (the Ash module has no `not_found_response/3` — that's vanilla-only).
    expect(ctrl).toContain("{:ok, {:not_found, _}} ->");
    expect(ctrl).toContain(
      'ApiWeb.ProblemDetails.problem_response(conn, 404, "Not Found", "Order not found")',
    );
  });

  it("emits the shared problem_variant/5 responder once per controller with a returning op", async () => {
    const ctrl = bySuffix(await files(), "controllers/orders_controller.ex");
    expect(ctrl).toContain("defp problem_variant(conn, status, type, title, data) do");
    expect(ctrl).toContain('put_resp_content_type("application/problem+json")');
    expect((ctrl.match(/defp problem_variant\(/g) ?? []).length).toBe(1);
  });
});

// DEBT-03 (mutation/guard slice) — a returning op whose body mutates (`assign`)
// and guards (`precondition`/`requires`).  The generic action's run fn
// struct-updates the loaded record in place and the guards raise; crucially the
// op must NOT also emit the normal Ash policy-check / validate (whose
// changeset/actor context doesn't carry the run fn's binds).
const MUT_SRC = `
system Inventory {
  subdomain Ops {
    context Stock {
      error NotFound { resource: string }
      aggregate Item ids guid {
        sku: string
        quantity: int
        operation adjust(delta: int): Item or NotFound {
          precondition delta != 0
          requires quantity + delta >= 0
          quantity := quantity + delta
        }
      }
      repository Items for Item { }
    }
  }
  api InventoryApi from Ops
  storage primary { type: postgres }
  resource itemState { for: Stock, kind: state, use: primary }
  deployable api {
    platform: phoenix
    contexts: [Stock]
    dataSources: [itemState]
    serves: InventoryApi
    port: 4000
  }
}
`;

describe("phoenix generator — exception-less mutation/guard bodies (DEBT-03)", () => {
  it("renders guards (raise) + in-place struct mutation in the generic action run fn", async () => {
    const resource = bySuffix(await generateSystemFiles(MUT_SRC), "stock/item.ex");
    expect(resource).toContain("action :adjust, :term do");
    // The param the guards/assign use is bound from the action arguments.
    expect(resource).toContain("delta = input.arguments.delta");
    // Guards raise; the assign struct-updates the loaded record in place.
    expect(resource).toContain(
      'if not (delta != 0), do: raise(ArgumentError, "Precondition failed: delta != 0")',
    );
    expect(resource).toContain(
      'if not (record.quantity + delta >= 0), do: raise(ArgumentError, "Forbidden: quantity + delta >= 0")',
    );
    expect(resource).toContain("record = %{record | quantity: record.quantity + delta}");
    // Fall-through success serialises the MUTATED record.
    expect(resource).toContain(
      "{:ok, {:success, %{id: record.id, sku: record.sku, quantity: record.quantity}}}",
    );
  });

  it("does NOT emit a policy check / authorizer for the returning op's `requires`", async () => {
    const resource = bySuffix(await generateSystemFiles(MUT_SRC), "stock/item.ex");
    // The generic action handles `requires` inline (raise) — no Ash policy block,
    // no SimpleCheck module, no authorizer (which would reference unbound vars).
    expect(resource).not.toContain("Ash.Policy.Authorizer");
    expect(resource).not.toContain("Checks.Adjust");
    expect(resource).not.toContain("policy action(:adjust)");
  });
});
