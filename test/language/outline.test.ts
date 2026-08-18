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

/** A ui with a nested area — the shape the outline used to be blind to.  Pages
 *  are `UiMember`/`AreaMember`s and system-scoped, never context members, which
 *  is why the old `OutlineContext.pages` was permanently empty. */
const UI_MODEL = `system Shop {
  context Sales {
    aggregate Order { total: int }
  }
  ui Admin {
    component Badge() { body: Text { "b" } }
    store Cart { state { lines: int = 0 } }
    area Back {
      page Board { route: "/b" body: Text { "x" } }
      area Deep {
        page Nested { route: "/d" body: Text { "y" } }
      }
    }
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
  it("addresses uis, and qualifies a page by every area enclosing it", async () => {
    const { model, errors } = await parseString(UI_MODEL);
    // A fixture that half-parses would quietly shrink the member list below to
    // whatever survived, and every assertion on it would still "pass" for the
    // members that remain (§59/§63 — the check that never reaches its subject).
    expect(errors, "fixture must parse clean").toEqual([]);
    const outline = buildOutline(model);
    const sys = outline.systems.find((s) => s.name === "Shop");

    const admin = sys?.uis.find((u) => u.node === "ui Admin");
    expect(admin, "the ui itself is addressable").toBeDefined();

    // The area path lives IN the address, so the member list stays flat without
    // losing where a page sits — and two pages named alike under different
    // areas (or different uis) can no longer collapse onto one address.
    expect(admin?.members).toContain("area Admin.Back");
    expect(admin?.members).toContain("page Admin.Back.Board");
    expect(admin?.members).toContain("page Admin.Back.Deep.Nested");
    expect(admin?.members).toContain("component Admin.Badge");
    expect(admin?.members).toContain("store Admin.Cart");
  });
});
