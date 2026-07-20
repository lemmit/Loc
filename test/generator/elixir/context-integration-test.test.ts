import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Context integration test emission on the Elixir/vanilla-Phoenix backend
// (test-placement.md, Phase 3b). A `context`-nested `test` (no `for`) emits an
// ExUnit module `test/<ctx>_integration_test.exs` that persists→reads through the
// plain CONTEXT MODULE against the live Ecto repo (Sandbox-isolated). A create →
// `{:ok, o} = <Ctx>.create_<agg>(%{...})`; a find → `{:ok, f} = <Ctx>.get_<agg>(id)`;
// a mutating op → `{:ok, o} = <Ctx>.<op>_<agg>(o, %{})`.
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
  subdomain Sales { context Ordering {
    aggregate Order { code: string  qty: int }
    repository Orders for Order { }
    test "persists and reads back an order" {
      let o = Order.create({ code: "abc", qty: 2 })
      let found = Order.findById(o.id)
      expect(found.qty).toBe(2)
    }
  } }
  api ShopApi from Sales
  storage db { type: postgres }
  resource st { for: Ordering, kind: state, use: db }
  deployable api { platform: elixir contexts: [Ordering] serves: ShopApi dataSources: [st] port: 8080 }
}`;

const get = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];

describe("elixir: context integration test emission (Phase 3b)", () => {
  it("emits test/<ctx>_integration_test.exs with the Sandbox setup + context-module persist/read", async () => {
    const files = await generateSystemFiles(SRC);
    const f = get(files, "test/ordering_integration_test.exs");
    expect(f, "ordering_integration_test.exs").toBeDefined();
    expect(f).toContain("defmodule Api.OrderingIntegrationTest do");
    expect(f).toContain("use ExUnit.Case, async: false");
    expect(f).toContain("Ecto.Adapters.SQL.Sandbox.checkout(Api.Repo)");
    expect(f).toContain("Ecto.Adapters.SQL.Sandbox.mode(Api.Repo, {:shared, self()})");
  });

  it("renders create→{:ok, o}, find→{:ok, found} = get_order, and the assertion", async () => {
    const f = (await generateSystemFiles(SRC)).get("api/test/ordering_integration_test.exs") ?? "";
    expect(f).toContain('{:ok, o} = Api.Ordering.create_order(%{code: "abc", qty: 2})');
    expect(f).toContain("{:ok, found} = Api.Ordering.get_order(o.id)");
    expect(f).toContain("assert found.qty == 2");
  });

  it("emits nothing for a context with no integration test", async () => {
    const files = await generateSystemFiles(SRC.replace(/test "persists[\s\S]*?\}\n/, ""));
    expect(get(files, "integration_test.exs")).toBeUndefined();
  });

  it("op-transition context renders {:ok, o} = <op>_<agg>(o, %{})", async () => {
    const withOp = `
system Ship {
  subdomain F { context Fulfillment {
    aggregate Order {
      customerId: string  status: string
      operation place() { precondition status == "Draft"  status := "Placed" }
    }
    repository Orders for Order { }
    test "placing transitions to Placed" {
      let o = Order.create({ customerId: "c1", status: "Draft" })
      o.place()
      let found = Order.findById(o.id)
      expect(found.status).toBe("Placed")
    }
  } }
  api FApi from F
  storage pg { type: postgres }
  resource st { for: Fulfillment, kind: state, use: pg }
  deployable d { platform: elixir contexts: [Fulfillment] serves: FApi dataSources: [st] port: 4000 }
}`;
    const f = get(await generateSystemFiles(withOp), "test/fulfillment_integration_test.exs");
    expect(f, "fulfillment_integration_test.exs").toBeDefined();
    expect(f).toContain("{:ok, o} = D.Fulfillment.place_order(o, %{})");
  });
});
