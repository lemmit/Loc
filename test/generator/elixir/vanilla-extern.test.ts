// Extern operation seam on the vanilla Phoenix/Ecto backend
// (docs/proposals/extern-domain-extension-point.md, Slice 1).
//
// Before this slice an `operation X() extern { precondition … }` emitted a
// context function that ran the preconditions and then persisted an EMPTY
// changeset (`Ecto.Changeset.change(%{})` with no `put_change`/`force_change`),
// silently returning HTTP 204 for a no-op (§1b — a real bug).  This slice gives
// it a real seam: a generated `@behaviour` + a scaffold-once user-owned impl
// module that `raise`s until filled in, delegated to from the context.

import { describe, expect, it } from "vitest";
import { isScaffoldOnce } from "../../../src/util/scaffold-once.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = `
system S {
  subdomain M {
    context C {
      enum OrderStatus { Draft, Confirmed, Cancelled }
      aggregate Order {
        customerId: string
        status: OrderStatus
        riskScore: int
        invariant riskScore >= 0
        function isMutable(): bool = status == OrderStatus.Draft
        operation confirm() extern {
          precondition isMutable()
          precondition riskScore < 80
        }
        operation flag(score: int) extern { precondition score >= 0 }
        operation cancel() { precondition isMutable()  status := OrderStatus.Cancelled }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from M
  storage primary { type: postgres }
  resource ordersState { for: C, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [C]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

describe("vanilla extern seam", () => {
  it("emits a generated behaviour module — one @callback per extern op", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const behaviour = files.get("api/lib/api/c/order_extern.ex");
    expect(behaviour).toBeDefined();
    expect(behaviour).toContain("defmodule Api.C.OrderExtern do");
    expect(behaviour).toContain(
      "@callback confirm(Api.C.Order.t(), map()) ::\n              {:ok, Api.C.Order.t()} | {:error, term()}",
    );
    expect(behaviour).toContain("@callback flag(Api.C.Order.t(), map())");
    // Non-extern ops (`cancel`) get NO callback — they run their own body.
    expect(behaviour).not.toContain("@callback cancel");
  });

  it("scaffolds a user-owned impl module that raises loudly and is preserved on regen", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const impl = files.get("api/lib/api/c/order_extern_impl.ex");
    expect(impl).toBeDefined();
    // Scaffold-once marker on line 1 → the CLI writer preserves it across regen.
    expect(isScaffoldOnce(impl!)).toBe(true);
    expect(impl).toContain("defmodule Api.C.OrderExternImpl do");
    expect(impl).toContain("@behaviour Api.C.OrderExtern");
    expect(impl).toContain("@impl true");
    // Loud failure when unimplemented — NOT a silent success.
    expect(impl).toContain('raise "extern operation `confirm` on Order is not implemented');
    expect(impl).toContain('raise "extern operation `flag` on Order is not implemented');
  });

  it("delegates the extern op from the context and persists the mutated struct", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const ctx = files.get("api/lib/api/c.ex")!;
    // Preconditions still run, THEN delegate to the user impl (rebinding record),
    // THEN persist every scalar column off the returned struct.
    expect(ctx).toContain("with :ok <- ensure(is_mutable(record), :precondition_failed),");
    expect(ctx).toContain("{:ok, record} <- Api.C.OrderExternImpl.confirm(record, params) do");
    expect(ctx).toContain("|> Ecto.Changeset.force_change(:status, record.status)");
    expect(ctx).toContain("|> Ecto.Changeset.force_change(:risk_score, record.risk_score)");
    // A param the precondition reads is bound before the `with`.
    expect(ctx).toContain('score = Map.get(params, "score")');
  });

  it("no longer emits the empty-changeset no-op for the extern op (regression pin)", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const ctx = files.get("api/lib/api/c.ex")!;
    // Isolate the confirm_order/2 clause and assert it does NOT persist a bare
    // `change(%{})` with no force_change — the old silent-204 shape.
    const start = ctx.indexOf("def confirm_order(%Api.C.Order{}");
    const end = ctx.indexOf("\n  end", start);
    const clause = ctx.slice(start, end);
    expect(clause).toContain("OrderExternImpl.confirm");
    // The empty changeset only ever appears immediately followed by a
    // force_change pipe now — never as the whole persist body.
    expect(clause).toContain("|> Ecto.Changeset.force_change(");
    expect(clause).not.toMatch(
      /change\(%\{\}\)\s*\n\s*\|>\s*Api\.C\.OrderRepository\.persist_change\(\)/,
    );
  });
});
