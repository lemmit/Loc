// Vanilla (plain Ecto) containment gate.  Nested entity parts now persist on a
// vanilla aggregate two ways:
//   * `shape(embedded)` — each part is an Ecto `embedded_schema` the root
//     `embeds_many`s (inline jsonb column); a containment-mutating op
//     (`items += Item{…}`) appends + `put_embed`s (DEBT-32).
//   * RELATIONAL (default shape, §11c) — each part is a child TABLE the root
//     `has_many`s + `cast_assoc`s, preloaded on read (the value-object
//     collection pattern).  CORE slice: persist + read.  An in-operation
//     containment mutation (`items += Item{…}`) stays gated — the relational
//     `put_assoc` op-mutation path is the §11c follow-up
//     (`loom.vanilla-containment-mutation-unsupported`).
// A `shape(document)` aggregate still can't carry nested parts at all.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function containmentErrors(
  source: string,
  code = "loom.vanilla-containment-unsupported",
): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === code)
    .map((d) => d.message);
}

/** A Shop context whose Order aggregate optionally contains an entity part,
 *  hosted on the given platform string (e.g. `elixir { foundation: vanilla }`).
 *  `mutates` adds an `items += Item{…}` operation (the gated relational case). */
function sys(
  platform: string,
  opts: { contains: boolean; shape?: string; mutates?: boolean },
): string {
  const shapeMod = opts.shape ? ` shape(${opts.shape})` : "";
  const op = opts.mutates
    ? `
        operation addItem(sku: string, qty: int) { items += Item { sku: sku, qty: qty } }`
    : "";
  const body = opts.contains
    ? `
        contains items: Item[]
        entity Item { sku: string  qty: int }${op}`
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
        sys("elixir { foundation: vanilla }", { contains: true, shape: "embedded", mutates: true }),
      ),
    ).toEqual([]);
  });

  it("accepts a non-mutating entity containment on a RELATIONAL vanilla aggregate (§11c — has_many)", async () => {
    const source = sys("elixir { foundation: vanilla }", { contains: true });
    expect(await containmentErrors(source)).toEqual([]);
    expect(
      await containmentErrors(source, "loom.vanilla-containment-mutation-unsupported"),
    ).toEqual([]);
  });

  it("still gates an in-op containment MUTATION on a relational vanilla aggregate (§11c follow-up)", async () => {
    const errs = await containmentErrors(
      sys("elixir { foundation: vanilla }", { contains: true, mutates: true }),
      "loom.vanilla-containment-mutation-unsupported",
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("Order");
    expect(errs[0]).toContain("items");
    expect(errs[0]).toContain("shape(embedded)");
    // The plain unsupported gate does NOT also fire for this case.
    expect(
      await containmentErrors(
        sys("elixir { foundation: vanilla }", { contains: true, mutates: true }),
      ),
    ).toEqual([]);
  });

  it("accepts a vanilla aggregate with NO nested parts (byte-identical)", async () => {
    expect(
      await containmentErrors(sys("elixir { foundation: vanilla }", { contains: false })),
    ).toEqual([]);
  });

  it("does not fire for non-elixir backends (this gate is vanilla-only)", async () => {
    expect(await containmentErrors(sys("node", { contains: true, mutates: true }))).toEqual([]);
  });
});
