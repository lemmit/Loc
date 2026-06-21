// Domain `test "..."` blocks → ExUnit emission (Phoenix/Elixir parity, F1 of
// docs/audits/test-parity-generated-backends.md).
//
// The two foundations diverge because their domain models do:
//   * VANILLA emits a pure domain core on the aggregate (`create/1` via
//     `apply_action`, `<op>/2` precondition + in-memory mutation) and ports the
//     full Loom test idiom onto it — create / op / toThrow / field reads all run
//     DB-free. Only a value-object construction invariant skips (a vanilla VO is
//     an unvalidated map).
//   * ASH stays the pure-subset: an in-memory value-object field read runs;
//     `create`/op/`toThrow` tests are `@tag :skip` placeholders (Ash actions are
//     data-layer-bound).
//
// Both the vanilla pure core and the emitted suite are verified to compile and
// pass under `mix test` (no DB) against a generated project.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const FIXTURE = `
system Shop {
  subdomain Sales {
    context Selling {
      valueobject Money { amount: money currency: string invariant amount >= 0.0 }
      aggregate Order ids guid {
        customer: string
        status: string
        price: Money
        invariant customer.length > 0
        operation confirm() { precondition status == "open" status := "confirmed" }
        test "blank customer is rejected" {
          expect(Order.create({ customer: "", status: "open", price: Money { amount: 1.0, currency: "USD" } })).toThrow()
        }
        test "confirming makes it confirmed" {
          let o = Order.create({ customer: "acme", status: "open", price: Money { amount: 1.0, currency: "USD" } })
          o.confirm()
          expect(o.status).toBe("confirmed")
        }
        test "confirming a confirmed order is rejected" {
          let o = Order.create({ customer: "acme", status: "confirmed", price: Money { amount: 1.0, currency: "USD" } })
          expect(o.confirm()).toThrow()
        }
        test "money builds" {
          let m = Money { amount: 10.5, currency: "USD" }
          expect(m.currency).toBe("USD")
        }
        test "negative money rejected" { expect(Money { amount: -1.0, currency: "USD" }).toThrow() }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource sellingState { for: Selling, kind: state, use: primary }
  deployable ashApi { platform: elixir { foundation: ash } contexts: [Selling] dataSources: [sellingState] serves: SalesApi port: 4000 }
  deployable vanApi { platform: elixir { foundation: vanilla } contexts: [Selling] dataSources: [sellingState] serves: SalesApi port: 4001 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  throw new Error(`no generated file matched ${pattern}; have:\n${[...files.keys()].join("\n")}`);
}

describe("elixir domain `test` → ExUnit emission", () => {
  it("vanilla: emits a pure domain core on the aggregate module", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const agg = findFile(files, /van_api\/lib\/van_api\/selling\/order\.ex$/);
    // create/1 = base_changeset |> apply_action (pure, no Repo).
    expect(agg).toContain("def create(attrs) when is_map(attrs) do");
    expect(agg).toContain("VanApi.Selling.OrderChangeset.base_changeset(%__MODULE__{}, attrs)");
    expect(agg).toContain("|> Ecto.Changeset.apply_action(:insert)");
    // <op>/2 = precondition (raise) + in-memory mutation.
    expect(agg).toContain("def confirm(%__MODULE__{} = record, _params) do");
    expect(agg).toContain('raise(ArgumentError, "Precondition failed: status == \\"open\\"")');
  });

  it("vanilla: ports create / op / toThrow / field reads onto the core", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const src = findFile(files, /van_api\/test\/selling\/order_test\.exs$/);

    expect(src).toContain("defmodule VanApi.Selling.OrderTest do");
    // create-invariant reject → {:error, _} (no raise).
    expect(src).toContain('assert {:error, _} = VanApi.Selling.Order.create(%{customer: ""');
    // create happy-path binds {:ok, _}; money coerced to Decimal.
    expect(src).toContain("{:ok, o} = VanApi.Selling.Order.create(%{");
    expect(src).toContain('price: %{amount: Decimal.new("1.0"), currency: "USD"}');
    // bare op call threads the returned struct; field assert follows.
    expect(src).toContain("o = VanApi.Selling.Order.confirm(o, %{})");
    expect(src).toContain('assert o.status == "confirmed"');
    // precondition reject → assert_raise.
    expect(src).toContain(
      "assert_raise ArgumentError, fn -> VanApi.Selling.Order.confirm(o, %{}) end",
    );
    // value-object field read runs (map literal, money → Decimal).
    expect(src).toContain('m = %{amount: Decimal.new("10.5"), currency: "USD"}');
    expect(src).toContain('assert m.currency == "USD"');
    // ONLY the value-object construction invariant skips on vanilla.
    expect(src.split("@tag :skip").length - 1).toBe(1);
    expect(src).toMatch(/@tag :skip\n {2}test "negative money rejected"/);

    expect(findFile(files, /van_api\/test\/test_helper\.exs$/).trim()).toBe("ExUnit.start()");
  });

  it("ash: keeps the pure-subset (field reads run, create/op/toThrow skip)", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const src = findFile(files, /ash_api\/test\/selling\/order_test\.exs$/);

    // The in-memory value-object field read runs against the embedded struct.
    expect(src).toContain('m = %AshApi.Selling.Money{amount: 10.5, currency: "USD"}');
    expect(src).toContain('assert m.currency == "USD"');
    // create / op / precondition / VO-construction tests are all skipped (4).
    expect(src.split("@tag :skip").length - 1).toBe(4);
    // No aggregate-core / instance-op calls leak into the ash output.
    expect(src).not.toContain(".confirm(");
    expect(src).not.toContain("Order.create(");

    expect(findFile(files, /ash_api\/test\/test_helper\.exs$/).trim()).toBe("ExUnit.start()");
  });
});
