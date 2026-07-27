// ---------------------------------------------------------------------------
// Vanilla (plain Ecto) event-sourced applier — drained, NOT gated (M-T6.2).
//
// An `apply(e: E) { … }` fold that CONSTRUCTS a contained entity part
// (`boxes += Box{…}`) is now emitted: the ES aggregate has no `%Ctx.Box{}` Ecto
// schema, so the fold builds a plain map over the part's wire shape (a minted
// `id`, the provided fields, `[]` for the part's own containments) — mirroring
// the other backends' ES folds.  So there is NO `loom.vanilla-es-applier-*`
// gate, and the part-in-part containment gate does NOT fire for an event-sourced
// aggregate (its parts fold in memory, not into relational child tables).  This
// pins that the drained shapes stay ungated.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function errorCodes(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code ?? "");
}

/** An event-sourced Order whose `apply(e: Boxed)` folds a `+=` of `applierAdd`,
 *  hosted on `platform`.  `boxExtra` can nest a containment inside Box. */
function sys(platform: string, applierAdd: string, boxExtra = ""): string {
  return `
system Shop {
  subdomain Sales {
    context Orders {
      valueobject Money { amount: int  currency: string }
      event Placed { order: Order id, customer: string }
      event Boxed { order: Order id, label: string }
      aggregate Order persistedAs: eventLog {
        customer: string
        total: int
        tags: string[]
        charges: Money[]
        contains boxes: Box[]
        entity Box { label: string${boxExtra} }
        entity Item { sku: string }
        create place(customer: string) { emit Placed { order: id, customer: customer } }
        operation box(label: string) { emit Boxed { order: id, label: label } }
        apply(e: Placed) { customer := e.customer }
        apply(e: Boxed) { ${applierAdd} }
      }
      repository Orders for Order {
        find byCustomer(customer: string): Order[] where this.customer == customer
      }
    }
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  resource orderLog { for: Orders, kind: eventLog, use: pg }
  deployable api { platform: ${platform}, contexts: [Orders], dataSources: [orderLog], serves: OrdersApi, port: 4000 }
}`;
}

describe("vanilla elixir ES applier — drained, not gated", () => {
  it("does NOT gate a contained ENTITY-PART construction (`boxes += Box{…}`)", async () => {
    const codes = await errorCodes(sys("elixir", "boxes += Box { label: e.label }"));
    expect(codes).not.toContain("loom.vanilla-es-applier-unsupported");
    expect(codes).not.toContain("loom.vanilla-containment-unsupported");
  });

  it("does NOT gate part-in-part construction on an event-sourced aggregate", async () => {
    // `Box` itself contains `items` — a part-in-part.  On a RELATIONAL aggregate
    // that stays gated (no grandchild table), but an ES aggregate folds it in
    // memory, so it is allowed.
    const codes = await errorCodes(
      sys("elixir", "boxes += Box { label: e.label }", "  contains items: Item[]"),
    );
    expect(codes).not.toContain("loom.vanilla-containment-unsupported");
    expect(codes).not.toContain("loom.vanilla-es-applier-unsupported");
  });

  it("does NOT gate a scalar / primitive / value-object fold", async () => {
    expect(await errorCodes(sys("elixir", "total -= 1"))).not.toContain(
      "loom.vanilla-es-applier-unsupported",
    );
    expect(await errorCodes(sys("elixir", "tags += e.label"))).not.toContain(
      "loom.vanilla-es-applier-unsupported",
    );
    expect(
      await errorCodes(sys("elixir", 'charges += Money { amount: 1, currency: "USD" }')),
    ).not.toContain("loom.vanilla-es-applier-unsupported");
  });
});
