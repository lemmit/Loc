import { describe, expect, it } from "vitest";
import { buildOutline } from "../../src/language/print/index.js";
import { parseString } from "../_helpers/parse.js";

// ---------------------------------------------------------------------------
// buildOutline — the agent's address book.  Pins that the address space covers
// all the major named declarations (not just aggregates): value objects + their
// members, enums, events, repositories, and system-level deployables — so an
// agent (and a fix-hint ModelPatch) can target them.
// ---------------------------------------------------------------------------

const MODEL = `system Shop {
  context Sales {
    valueobject Money { amount: int }
    aggregate Order { total: int }
    enum Status { Open }
    event Placed { at: int }
    repository Orders for Order {}
  }
  deployable api { platform: dotnet contexts: [Sales] }
}`;

describe("buildOutline — comprehensive addressing", () => {
  it("addresses value objects + their members, enums, events, repositories, deployables", async () => {
    const { model } = await parseString(MODEL);
    const outline = buildOutline(model);

    const sys = outline.systems.find((s) => s.name === "Shop");
    expect(sys).toBeDefined();
    expect(sys?.deployables).toContain("deployable api");

    const ctx = sys?.contexts.find((c) => c.name === "Sales");
    expect(ctx).toBeDefined();
    expect(ctx?.aggregates.map((a) => a.node)).toContain("aggregate Sales.Order");

    const money = ctx?.valueObjects.find((v) => v.node === "valueobject Sales.Money");
    expect(money).toBeDefined();
    expect(money?.members).toContain("valueobject Sales.Money.amount");

    expect(ctx?.enums).toContain("enum Sales.Status");
    expect(ctx?.events).toContain("event Sales.Placed");
    expect(ctx?.repositories).toContain("repository Sales.Orders");
  });
});
