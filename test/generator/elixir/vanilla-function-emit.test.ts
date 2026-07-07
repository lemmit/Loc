import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Vanilla-Phoenix aggregate `function` member emit (gap §11b,
// docs/plans/vanilla-phoenix-gaps.md).
//
// An aggregate `function passed(): bool = total > 100` is a pure domain helper
// callable from op / precondition bodies (`precondition passed()`).  Before this
// fix it was emitted NOWHERE on vanilla and the call site rendered an
// unqualified `passed(record)` → `mix compile` failed on the undefined ref.
// The fix emits `def passed(%Agg{} = record, …)` on the context-facade module
// (and the pure-core schema module) so the call resolves.
// ---------------------------------------------------------------------------

const SRC = `
system FnDemo {
  subdomain Sales {
    context Ordering {
      aggregate Order {
        total: int
        status: string

        function passed(): bool = total > 100
        function bonus(extra: int): int = total + extra

        // Block-body form (domain-services.md rev. 4) — pure: let + precondition
        // + return.  Renders as binding/guard lines then a trailing bare value
        // (no {:ok, …} tuple — a function yields its value directly).
        function shippingFor(extra: int): int {
          let base = total + extra
          precondition base >= 0
          return base
        }

        operation approve() {
          precondition passed()
          status := "approved"
        }
      }
      repository Orders for Order { }
    }
  }
  api OrderApi from Sales
  storage primary { type: postgres }
  resource orderState { for: Ordering, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Ordering]
    dataSources: [orderState]
    serves: OrderApi
    port: 4000
  }
}
`;

async function contextModule(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  for (const [p, c] of files) {
    if (p.endsWith("/ordering.ex")) return c;
  }
  throw new Error("Ordering context module not found");
}

describe("vanilla aggregate `function` emit (gap §11b)", () => {
  it("emits a struct-guarded def for a no-param function", async () => {
    const ctx = await contextModule();
    expect(ctx).toMatch(/def passed\(%Api\.Ordering\.Order\{\} = record\) do/);
    expect(ctx).toContain("record.total > 100");
  });

  it("emits a function with declared params after the struct", async () => {
    const ctx = await contextModule();
    expect(ctx).toMatch(/def bonus\(%Api\.Ordering\.Order\{\} = record, extra\) do/);
    expect(ctx).toContain("record.total + extra");
  });

  it("emits a typespec carrying the aggregate struct as the first arg", async () => {
    const ctx = await contextModule();
    expect(ctx).toMatch(/@spec passed\(Api\.Ordering\.Order\.t\(\)\) :: boolean\(\)/);
    expect(ctx).toMatch(/@spec bonus\(Api\.Ordering\.Order\.t\(\), integer\(\)\) :: integer\(\)/);
  });

  it("qualifies the call site so the precondition resolves to the emitted fn", async () => {
    const ctx = await contextModule();
    // `precondition passed()` renders `passed(record)` — resolving to the
    // module-level def above (the §11b call-site qualification).
    expect(ctx).toMatch(/if not \(passed\(record\)\)/);
  });

  it("emits a block-body function as binding/guard lines + a trailing bare value", async () => {
    const ctx = await contextModule();
    expect(ctx).toMatch(/def shipping_for\(%Api\.Ordering\.Order\{\} = record, extra\) do/);
    // `let base = …` → an Elixir binding.
    expect(ctx).toContain("base = record.total + extra");
    // `precondition` → a bug-regime raise guard.
    expect(ctx).toMatch(/if not \(base >= 0\), do: raise\(ArgumentError/);
    // `return base` yields the bare value — NOT wrapped in `{:ok, …}`.
    expect(ctx).not.toContain("{:ok, base}");
  });

  it("does not emit any function defs for an aggregate without `function` members", async () => {
    const noFns = `
system NoFns {
  subdomain S {
    context Inv {
      aggregate Gadget {
        name: string
      }
    }
  }
  api InvApi from S
  deployable api {
    platform: elixir, contexts: [Inv],
    serves: InvApi, port: 4000
  }
}
`;
    const files = await generateSystemFiles(noFns);
    const ctx = [...files].find(([p]) => p.endsWith("/inv.ex"))?.[1] ?? "";
    expect(ctx).toContain("defmodule");
    // No pure-domain-function docstrings — output unchanged for a fn-less agg.
    expect(ctx).not.toContain("Pure domain function");
  });
});
