import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// The `when` canCommand state gate (criterion.md use site 2) on the vanilla
// (plain Ecto/Phoenix) backend — B6.  An `operation … when <pred>` evaluates the
// predicate against the LOADED aggregate before the body mutates; a false
// predicate must reject with 409 Conflict (parity with Hono/​.NET/​Java/​Python's
// DisallowedError → 409), NOT run the op unconditionally.  Elixir previously
// dropped the gate entirely (the op resolved in every state).  The gate lowers to
// a leading `:ok <- ensure(<pred>, :disallowed)` with-clause; the controller maps
// `{:error, :disallowed}` to a 409 ProblemDetails.  Boot-verified (behavioral
// `state-gate`): cancelling a Shipped order now 409s.
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft, Shipped, Cancelled }
      aggregate Order with crudish {
        code: string
        status: OrderStatus
        operation cancel() when this.status != OrderStatus.Shipped && this.status != OrderStatus.Cancelled {
          status := OrderStatus.Cancelled
        }
      }
      repository Orders for Order { }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Orders], dataSources: [ordersState], serves: ShopApi, port: 4000 }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla operation `when` state gate (B6)", () => {
  it("hoists the `when` predicate into a leading `ensure(..., :disallowed)` guard", async () => {
    const facade = file(await generateSystemFiles(SRC), "/orders.ex");
    const cancel = facade.slice(facade.indexOf("def cancel_order("));
    // The gate short-circuits BEFORE the mutation/persist runs.
    expect(cancel).toContain(
      "with :ok <- ensure(record.status != :Shipped and record.status != :Cancelled, :disallowed) do",
    );
    // The shared ensure/2 helper must be emitted (else the with-clause is undefined).
    expect(facade).toContain("defp ensure(false, reason), do: {:error, reason}");
  });

  it("maps the `{:error, :disallowed}` denial to a 409 Conflict in the controller", async () => {
    const controller = file(await generateSystemFiles(SRC), "/order_controller.ex");
    expect(controller).toContain("{:error, :disallowed} ->");
    expect(controller).toContain(
      'ProblemDetails.problem_response(conn, 409, "Conflict", "Operation not allowed in the current state")',
    );
  });
});
