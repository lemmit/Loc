// Vanilla (plain Ecto) containment gate.  The vanilla foundation does not yet
// persist nested entity parts — `contains <part>: <Part>[]` lowers fine but the
// schema emitter emits no `embeds_many` / `has_many`, and a containment-mutating
// operation's changeset casts the part's fields onto the root struct (runtime
// `Ecto.cast` error).  The check turns that silent-breakage into a hard error,
// pointing at the Ash foundation (which models parts as embedded resources /
// relationships).  The Ash foundation — the default for `platform: elixir` — is
// unaffected.

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
function sys(platform: string, opts: { contains: boolean }): string {
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
      aggregate Order ids guid {
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
  it("rejects an entity containment on a vanilla deployable (silent-drop footgun)", async () => {
    const errs = await containmentErrors(sys("elixir { foundation: vanilla }", { contains: true }));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("Order");
    expect(errs[0]).toContain("Item");
    expect(errs[0]).toContain("foundation: ash");
  });

  it("accepts a vanilla aggregate with NO nested parts (byte-identical)", async () => {
    expect(
      await containmentErrors(sys("elixir { foundation: vanilla }", { contains: false })),
    ).toEqual([]);
  });

  it("accepts an entity containment on the Ash foundation (embedded resources / relationships)", async () => {
    // Default `platform: elixir` is the Ash foundation, which DOES persist parts.
    expect(await containmentErrors(sys("elixir", { contains: true }))).toEqual([]);
  });

  it("does not fire for non-elixir backends (this gate is vanilla-only)", async () => {
    // node handles nested parts; this specific gate must stay silent for it.
    expect(await containmentErrors(sys("node", { contains: true }))).toEqual([]);
  });
});
