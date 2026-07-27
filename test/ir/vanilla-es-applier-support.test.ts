// ---------------------------------------------------------------------------
// Vanilla (plain Ecto) event-sourced applier gate (M-T6.2).
//
// An `apply(e: E) { … }` fold that CONSTRUCTS a contained entity part
// (`boxes += Box{…}` — a `new` expression) needs an Elixir struct module
// (`%Ctx.Box{}`) the ES path never emits (the schema emitters skip
// event-sourced aggregates), so it is gated honestly with
// `loom.vanilla-es-applier-unsupported` — rather than silently dropping the
// applier body (the pre-M-T6.2 behaviour) or emitting a reference to a missing
// struct.  Scalar / primitive-collection / value-object folds are NOT gated.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function esApplierErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.vanilla-es-applier-unsupported")
    .map((d) => d.message);
}

/** An event-sourced Order whose `apply(e: Boxed)` folds a `+=` of `applierAdd`,
 *  hosted on `platform`.  The `contains`/`entity`/`valueobject` scaffolding is
 *  included so the constructed type resolves. */
function sys(platform: string, applierAdd: string, extraDecls = ""): string {
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
        entity Box { label: string }${extraDecls}
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

describe("vanilla elixir ES applier gate (loom.vanilla-es-applier-unsupported)", () => {
  it("gates an applier that constructs a contained ENTITY PART (`boxes += Box{…}`)", async () => {
    const errs = await esApplierErrors(sys("elixir", "boxes += Box { label: e.label }"));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("Boxed");
    expect(errs[0]).toContain("contained entity part");
  });

  it("does NOT gate a scalar `+=`/`-=` fold", async () => {
    expect(await esApplierErrors(sys("elixir", "total -= 1"))).toHaveLength(0);
  });

  it("does NOT gate a primitive-collection `+=` fold", async () => {
    expect(await esApplierErrors(sys("elixir", "tags += e.label"))).toHaveLength(0);
  });

  it("does NOT gate a value-object collection `+=` fold (folds as a plain map)", async () => {
    expect(
      await esApplierErrors(sys("elixir", 'charges += Money { amount: 1, currency: "USD" }')),
    ).toHaveLength(0);
  });

  it("does NOT gate the entity-part construction on a non-elixir backend (node emits it)", async () => {
    expect(await esApplierErrors(sys("node", "boxes += Box { label: e.label }"))).toHaveLength(0);
  });
});
