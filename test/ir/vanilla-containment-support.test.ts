// Vanilla (plain Ecto) containment gate.  Nested entity parts now persist on a
// vanilla aggregate two ways:
//   * `shape: embedded` — each part is an Ecto `embedded_schema` the root
//     `embeds_many`s (inline jsonb column); a containment-mutating op
//     (`items += Item{…}`) appends + `put_embed`s (DEBT-32).
//   * RELATIONAL (default shape, §11c) — each part is a child TABLE the root
//     `has_many`s + `cast_assoc`s, preloaded on read (the value-object
//     collection pattern).  Persist + read AND in-operation containment mutation
//     (`items += Item{…}`) are now wired: the op persist tail `put_assoc`s the
//     mutated part-struct list (`on_replace: :delete` rewrites the child rows),
//     so `loom.vanilla-containment-mutation-unsupported` is retired.
//   * `shape: document` (Route A) — each part folds into the `<Agg>.Data` embed
//     as `embeds_many`/`embeds_one` (same as embedded), the changeset `cast_embed`s
//     it, and the wireShape serializer projects it through `serialize_<part>/1`.
//     Boot-verified round-trip; the document containment gate is retired.

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
 *  hosted on the given platform string (e.g. `elixir`).
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
      aggregate Order${shapeMod} {
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
  it("accepts an entity containment on a shape: embedded vanilla aggregate (DEBT-32 — embeds_many)", async () => {
    expect(
      await containmentErrors(sys("elixir", { contains: true, shape: "embedded", mutates: true })),
    ).toEqual([]);
  });

  it("accepts a non-mutating entity containment on a RELATIONAL vanilla aggregate (§11c — has_many)", async () => {
    const source = sys("elixir", { contains: true });
    expect(await containmentErrors(source)).toEqual([]);
    expect(
      await containmentErrors(source, "loom.vanilla-containment-mutation-unsupported"),
    ).toEqual([]);
  });

  it("accepts an in-op containment MUTATION on a relational vanilla aggregate (§11c — put_assoc)", async () => {
    const source = sys("elixir", { contains: true, mutates: true });
    // The retired gate no longer fires…
    expect(
      await containmentErrors(source, "loom.vanilla-containment-mutation-unsupported"),
    ).toEqual([]);
    // …and neither does the plain unsupported gate.
    expect(await containmentErrors(source)).toEqual([]);
  });

  it("accepts an entity containment on a shape: document vanilla aggregate (Route A — embeds_many)", async () => {
    expect(await containmentErrors(sys("elixir", { contains: true, shape: "document" }))).toEqual(
      [],
    );
  });

  it("accepts a vanilla aggregate with NO nested parts (byte-identical)", async () => {
    expect(await containmentErrors(sys("elixir", { contains: false }))).toEqual([]);
  });

  it("does not fire for non-elixir backends (this gate is vanilla-only)", async () => {
    expect(await containmentErrors(sys("node", { contains: true, mutates: true }))).toEqual([]);
  });
});
