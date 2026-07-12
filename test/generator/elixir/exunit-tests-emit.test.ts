// Domain `test "..."` blocks → ExUnit emission (Phoenix/Elixir parity, F1 of
// docs/audits/test-parity-generated-backends.md).
//
// The two foundations diverge because their domain models do:
//   * VANILLA emits a pure domain core on the aggregate (`create/1` via
//     `apply_action`, `<op>/2` precondition + in-memory mutation) and ports the
//     full Loom test idiom onto it — create / op / toThrow / field reads all run
//     DB-free.
//   * ASH runs the REJECTION subset DB-free (Rec3): an invariant / precondition /
//     value-object-construction `toThrow` lowers to a changeset-build
//     `Ash.Changeset.for_create/for_update(...).valid?` check (Ash validations run
//     when the changeset is built, no data layer), plus in-memory field reads.
//     Only a happy-path post-operation STATE assertion still `@tag :skip`s (it
//     needs a persisted record / SQL.Sandbox).
//
// Both emitted suites are verified to compile and pass under `mix test` (no DB)
// against a generated project.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const FIXTURE = `
system Shop {
  subdomain Sales {
    context Selling {
      valueobject Money { amount: money currency: string invariant amount >= 0.0 }
      aggregate Order {
        customer: string
        status: string
        price: Money?
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
  deployable ashApi { platform: elixir contexts: [Selling] dataSources: [sellingState] serves: SalesApi port: 4000 }
  deployable vanApi { platform: elixir contexts: [Selling] dataSources: [sellingState] serves: SalesApi port: 4001 }
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
    // F5: the value-object construction invariant now runs via the VO's
    // validating constructor — nothing skips on vanilla anymore.
    expect(src).toContain(
      'assert {:error, _} = VanApi.Selling.Money.new(%{amount: Decimal.new("-1.0"), currency: "USD"})',
    );
    expect(src).not.toContain("@tag :skip");

    expect(findFile(files, /van_api\/test\/test_helper\.exs$/).trim()).toBe("ExUnit.start()");
  });

  it("vanilla: threads a synthetic actor into a currentUser-gated op call in a test", async () => {
    // §11d follow-up — the pure-core gated op carries `current_user \\ nil`; the
    // ExUnit test must pass a privileged actor so the `requires currentUser` guard
    // runs (not `nil.role`).  Mirror of node's TEST_ACTOR.
    const SRC = `
system G {
  user { id: string  role: string }
  subdomain Sales { context Selling {
    aggregate Order {
      customer: string
      status: string = "open"
      operation cancel(reason: string) {
        requires currentUser.role == "admin"
        status := "cancelled"
      }
      test "an admin can cancel" {
        let o = Order.create({ customer: "acme" })
        o.cancel("done")
        expect(o.status).toBe("cancelled")
      }
    }
    repository Orders for Order { }
  } }
  api GApi from Sales
  storage pg { type: postgres }
  resource st { for: Selling, kind: state, use: pg }
  deployable api { platform: elixir contexts: [Selling] dataSources: [st] serves: GApi port: 4000 auth: required }
}
`;
    const src = findFile(await generateSystemFiles(SRC), /api\/test\/selling\/order_test\.exs$/);
    expect(src).toContain(
      'Api.Selling.Order.cancel(o, %{"reason" => "done"}, %{id: "00000000-0000-0000-0000-000000000000", role: "admin", permissions: ["*"]})',
    );
  });

  it("vanilla: emits a validating value-object constructor + enforces it in base_changeset (F5)", async () => {
    const files = await generateSystemFiles(FIXTURE);
    // The VO module runs its invariant in a schemaless changeset.
    const vo = findFile(files, /van_api\/lib\/van_api\/selling\/money\.ex$/);
    expect(vo).toContain("defmodule VanApi.Selling.Money do");
    expect(vo).toContain("@types %{amount: :decimal, currency: :string}");
    expect(vo).toContain("|> validate_number(:amount, greater_than_or_equal_to: 0)");
    expect(vo).toContain("def new(attrs) when is_map(attrs) do");
    expect(vo).toContain("apply_action(changeset(attrs), :insert)");
    // The aggregate create/update path runs the VO constructor over the price
    // field — invariant enforced at runtime, not just in tests.
    const cs = findFile(files, /van_api\/lib\/van_api\/selling\/order_changeset\.ex$/);
    expect(cs).toContain("|> validate_vo(:price, &VanApi.Selling.Money.new/1)");
    expect(cs).toContain("defp validate_vo(changeset, field, new_fun) do");
  });
});
