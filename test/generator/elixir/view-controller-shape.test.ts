// Regression: the Phoenix `ViewsController` must agree with the view query
// modules' `run/1` return shape.
//
// A view module's `run/1` returns a BARE LIST — both foundations build it that
// way (`Ash.read!()` on ash, `Repo.all()` on vanilla) and the generated
// LiveView consumes it as a list (`Views.X.run(current_user) |> Enum.map(...)`,
// vanilla/view-emit.ts).  The shared `ViewsController`, however, used to wrap
// the call in `case ...run(...) do {:ok, records} -> ...`, which a bare list can
// never match → `CaseClauseError` (500) on EVERY view request, on BOTH
// foundations.  There was no test covering the ash view/controller path at all
// (only `vanilla-view-emit.test.ts`), so the mismatch shipped silently.
//
// A second, masked defect: the controller piped every record through
// `Map.from_struct/1`.  That is correct for a SHORTHAND view (returns aggregate
// structs) but raises for a FULL-FORM view (its `run/1` already projects to
// plain maps via `Enum.map`).  The `CaseClauseError` hid it because the `{:ok,
// _}` arm never ran.
//
// This test pins the contract: `run/1` stays a bare list, the controller binds
// it directly (no `{:ok, records}` tuple match), and only shorthand actions call
// `Map.from_struct/1`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = `
system S {
  subdomain M {
    context Sales {
      aggregate Order with crudish {
        customerId: string
        total: int
      }
      repository Orders for Order { }

      // Shorthand view — returns aggregate structs.
      view ActiveOrders = Order where total > 0

      // Full-form view — projects to plain maps via bind.
      view OrderSummary {
        orderId: Order id
        total: int

        from Order where total > 0
        bind orderId = id,
             total = total
      }
    }
  }
  api SalesApi from M
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 4000
  }
}
`;

/** Slice one controller action body out of the concatenated source, from its
 *  `def <snake>(conn` header to the next `def ` (or end of module). */
function action(controller: string, snake: string): string {
  const start = controller.indexOf(`def ${snake}(conn`);
  if (start < 0) throw new Error(`no action ${snake} in controller`);
  const rest = controller.slice(start + 1);
  const next = rest.indexOf("\n  def ");
  return next < 0 ? rest : rest.slice(0, next);
}

describe("phoenix (ash) — ViewsController agrees with view run/1 return shape", () => {
  it("view modules' run/1 returns a bare list (the LiveView/controller contract)", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const shorthand = files.get("api/lib/api/sales/views/active_orders.ex");
    const fullForm = files.get("api/lib/api/sales/views/order_summary.ex");
    expect(shorthand, "shorthand view module").toBeDefined();
    expect(fullForm, "full-form view module").toBeDefined();
    // Bare list: ends in Repo.all()/Enum.map, never wrapped in an {:ok, _} tuple.
    expect(shorthand).toContain("Repo.all()");
    expect(shorthand).not.toContain("{:ok,");
    expect(fullForm).toContain("Repo.all()");
    expect(fullForm).not.toContain("{:ok,");
    // Full-form binds project under their declared camelCase name (an atom map
    // key Jason encodes verbatim — `:orderId` → "orderId"), the canonical wire.
    expect(fullForm).toContain("orderId: record.id");
    expect(fullForm).not.toContain("order_id:");
  });

  it("controller binds run/1 directly — no {:ok, records} tuple match (CaseClauseError)", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const ctrl = files.get("api/lib/api_web/controllers/views_controller.ex");
    expect(ctrl, "views controller").toBeDefined();
    // The bug: a bare list pattern-matched against {:ok, records}.
    expect(ctrl).not.toContain("{:ok, records}");
    // The fix: each action binds the list and maps over it.
    expect(ctrl).toContain(".run(current_user)");
    // B13: the view route returns a BARE array (`json(conn, data)`), matching
    // the declared `type: :array` OrderListResponse and every other backend —
    // NOT an `%{data: data}` envelope (which made `bigs.length` undefined and
    // diverged the wire shape from node/java/python/dotnet).
    expect(ctrl).toContain("json(conn, data)");
    expect(ctrl).not.toContain("json(conn, %{data: data})");
  });

  it("a shared serialize/1 handles structs (shorthand) and maps (full-form) uniformly", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const ctrl = files.get("api/lib/api_web/controllers/views_controller.ex")!;
    // Both actions delegate row projection to the shared `serialize/1` helper.
    expect(action(ctrl, "active_orders")).toContain("Enum.map(&serialize/1)");
    expect(action(ctrl, "order_summary")).toContain("Enum.map(&serialize/1)");
    // serialize/1 projects a struct (shorthand view) through the aggregate's
    // wireShape — camelCase keys (`customerId`), no `Map.from_struct` snake dump
    // / timestamp leak; a plain map (full-form view) passes straight through.
    expect(ctrl).toContain("defp serialize(%Api.Sales.Order{} = record) do");
    expect(ctrl).toContain('"customerId" => record.customer_id');
    expect(ctrl).not.toContain("Map.from_struct()");
    expect(ctrl).toContain("defp serialize(record) when is_map(record), do: record");
  });
});
