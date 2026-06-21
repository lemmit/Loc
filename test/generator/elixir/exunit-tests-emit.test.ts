// Domain `test "..."` blocks → ExUnit emission (Phoenix/Elixir parity, F1 of
// docs/audits/test-parity-generated-backends.md).
//
// Elixir has no pure in-memory factory (Ash actions / Ecto changesets validate
// against a live DB), so the emitter is a PURE SUBSET: a test of value-object
// construction + field reads renders to a runnable `assert`; a test that calls
// `create`/operations or asserts a construction-time `toThrow` is emitted as an
// `@tag :skip` placeholder (visible, never silently dropped).  Both foundations
// follow the policy — vanilla's `create_*` also inserts via Repo.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const FIXTURE = `
system Shop {
  subdomain Sales {
    context Selling {
      valueobject Money {
        amount: money
        currency: string
        invariant amount >= 0.0
      }
      aggregate Product ids guid with crudish {
        sku: string
        price: Money
        invariant sku.length > 0
        operation reprice(next: Money) {
          precondition next.amount >= 0.0
          price := next
        }
        test "money literal builds" {
          let m = Money { amount: 10.5, currency: "USD" }
          expect(m.amount).toBe(10.5)
          expect(m.currency).toBe("USD")
        }
        test "negative money rejected" {
          expect(Money { amount: -1.0, currency: "USD" }).toThrow()
        }
        test "repricing exercises the aggregate" {
          let p = Product.create({ sku: "x", price: Money { amount: 1.0, currency: "USD" } })
          expect(p.reprice(Money { amount: 2.0, currency: "USD" })).toBe(p)
        }
      }
      repository Products for Product { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource sellingState { for: Selling, kind: state, use: primary }
  deployable ashApi {
    platform: elixir { foundation: ash }
    contexts: [Selling]
    dataSources: [sellingState]
    serves: SalesApi
    port: 4000
  }
  deployable vanillaApi {
    platform: elixir { foundation: vanilla }
    contexts: [Selling]
    dataSources: [sellingState]
    serves: SalesApi
    port: 4001
  }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  throw new Error(`no generated file matched ${pattern}; have:\n${[...files.keys()].join("\n")}`);
}

describe("elixir domain `test` → ExUnit emission", () => {
  it("ash: emits a pure value-object test as runnable asserts and a test_helper", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const src = findFile(files, /ash_api\/test\/selling\/product_test\.exs$/);

    expect(src).toContain("defmodule AshApi.Selling.ProductTest do");
    expect(src).toContain("use ExUnit.Case, async: true");
    // Pure VO test → real ExUnit body, no skip tag.
    expect(src).toContain('test "money literal builds" do');
    expect(src).toContain('m = %AshApi.Selling.Money{amount: 10.5, currency: "USD"}');
    // The struct is built directly, so the field holds the bare literal —
    // plain `==` compares correctly (both operands render identically).
    expect(src).toContain("assert m.amount == 10.5");
    expect(src).toContain('assert m.currency == "USD"');

    // test_helper.exs emitted once per project.
    expect(findFile(files, /ash_api\/test\/test_helper\.exs$/).trim()).toBe("ExUnit.start()");
  });

  it("ash: skips construction-time toThrow and aggregate create/op tests", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const src = findFile(files, /ash_api\/test\/selling\/product_test\.exs$/);

    // Both the toThrow invariant and the create/op test are @tag :skip,
    // and neither renders an invalid instance call.
    const blocks = src.split("@tag :skip");
    expect(blocks.length).toBe(3); // 2 skipped tests
    expect(src).toContain('test "negative money rejected" do');
    expect(src).toContain('test "repricing exercises the aggregate" do');
    expect(src).not.toContain(".reprice(");
    expect(src).not.toContain("Product.create(");
    expect(src).not.toContain("create_product");
  });

  it("vanilla: builds value objects as plain maps and follows the same policy", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const src = findFile(files, /vanilla_api\/test\/selling\/product_test\.exs$/);

    expect(src).toContain("defmodule VanillaApi.Selling.ProductTest do");
    // Vanilla VO ctor is a plain map (no %Ctx.Money{} struct module emitted).
    expect(src).toContain('m = %{amount: 10.5, currency: "USD"}');
    expect(src).toContain("assert m.amount == 10.5");
    expect(src).toContain("@tag :skip");
    expect(findFile(files, /vanilla_api\/test\/test_helper\.exs$/).trim()).toBe("ExUnit.start()");
  });
});
