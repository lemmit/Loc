// Vanilla (plain Ecto) containment gate.  A `shape(embedded)` aggregate now
// persists nested entity parts (DEBT-32): each part becomes an Ecto
// `embedded_schema` module the root `embeds_many`s (inline jsonb column), and a
// containment-mutating op (`items += Item{…}`) appends + `put_embed`s.  A
// RELATIONAL-shaped aggregate's containments would need child tables + has_many
// (the shape's migration emits a child table, not an inline column) — that
// relational nested-entity emit is NOT wired, so it stays gated.  The Ash
// foundation (default for `platform: elixir`) handles both and is unaffected.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function containmentErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.vanilla-containment-unsupported")
    .map((d) => d.message);
}

/** A Shop context whose Order aggregate optionally contains an entity part,
 *  hosted on the given platform string (e.g. `elixir { foundation: vanilla }`). */
function sys(platform: string, opts: { contains: boolean; shape?: string }): string {
  const shapeMod = opts.shape ? ` shape(${opts.shape})` : "";
  const body = opts.contains
    ? `
        contains items: Item[]
        entity Item { sku: string  qty: int }
        operation addItem(sku: string, qty: int) { items += Item { sku: sku, qty: qty } }`
    : "";
  return `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Order ids guid${shapeMod} {
        code: string${body}
      }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: ${platform}, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;
}

describe("vanilla containment support gate", () => {
  it("accepts an entity containment on a shape(embedded) vanilla aggregate (DEBT-32 — embeds_many)", async () => {
    expect(
      await containmentErrors(
        sys("elixir { foundation: vanilla }", { contains: true, shape: "embedded" }),
      ),
    ).toEqual([]);
  });

  it("still rejects an entity containment on a RELATIONAL vanilla aggregate (no child-table emit)", async () => {
    const errs = await containmentErrors(sys("elixir { foundation: vanilla }", { contains: true }));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("Order");
    expect(errs[0]).toContain("Item");
    expect(errs[0]).toContain("shape(embedded)");
    expect(errs[0]).toContain("foundation: ash");
  });

  it("accepts a vanilla aggregate with NO nested parts (byte-identical)", async () => {
    expect(
      await containmentErrors(sys("elixir { foundation: vanilla }", { contains: false })),
    ).toEqual([]);
  });

  it("accepts an entity containment on the Ash foundation (embedded resources / relationships)", async () => {
    // The Ash foundation persists parts on both shapes (post D-VANILLA-DEFAULT
    // ash is the explicit opt-in; bare `platform: elixir` is now vanilla).
    expect(await containmentErrors(sys("elixir { foundation: ash }", { contains: true }))).toEqual(
      [],
    );
    expect(
      await containmentErrors(
        sys("elixir { foundation: ash }", { contains: true, shape: "embedded" }),
      ),
    ).toEqual([]);
  });

  it("does not fire for non-elixir backends (this gate is vanilla-only)", async () => {
    expect(await containmentErrors(sys("node", { contains: true }))).toEqual([]);
  });
});
