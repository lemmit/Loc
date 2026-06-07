import { describe, expect, it } from "vitest";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import {
  discriminatorValue,
  isTpcBase,
  isTpcConcrete,
  isTphBase,
  isTphConcrete,
  ownFieldsOf,
  tableOwnerName,
  tpcConcretesOf,
  tphConcretesOf,
} from "../../src/ir/util/inheritance.js";
import { buildLoomModel } from "../_helpers/index.js";

// The platform-neutral aggregate-inheritance predicates (aggregate-inheritance.md)
// are the single source of truth every backend's table/discriminator emission
// consults — so the owning table name and `kind` discriminator value are
// derived identically on Hono, .NET, and Phoenix. This pins that contract.

async function poolFor(src: string) {
  const model = await buildLoomModel(src);
  const ctx = allContexts(model).find((c) => c.name === "Reg")!;
  const byName = (n: string) => ctx.aggregates.find((a) => a.name === n)!;
  return { pool: ctx.aggregates, byName };
}

describe("inheritance predicates — TPH (sharedTable)", () => {
  it("derives base/concrete/table-owner/discriminator identically", async () => {
    const { pool, byName } = await poolFor(`
      context Reg {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
        aggregate Vendor extends Party { rating: int }
      }
    `);
    const party = byName("Party");
    const customer = byName("Customer");

    expect(isTphBase(party, pool)).toBe(true);
    expect(isTphConcrete(party, pool)).toBe(false);
    expect(isTphConcrete(customer, pool)).toBe(true);

    // One shared table named for the base; `kind` value is the concrete's name.
    expect(tableOwnerName(customer, pool)).toBe("Party");
    expect(tableOwnerName(party, pool)).toBe("Party");
    expect(discriminatorValue(customer, pool)).toBe("Customer");
    expect(discriminatorValue(party, pool)).toBeUndefined();

    expect(tphConcretesOf(party, pool).map((a) => a.name)).toEqual(["Customer", "Vendor"]);

    // Own fields exclude the enrichment-merged base fields.
    expect(ownFieldsOf(customer, party).map((f) => f.name)).toEqual(["creditLimit"]);
  });
});

describe("inheritance predicates — TPC (ownTable)", () => {
  it("recognises a per-concrete (table-per-class) hierarchy", async () => {
    const { pool, byName } = await poolFor(`
      context Reg {
        abstract aggregate Party inheritanceUsing(ownTable) { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
      }
    `);
    const party = byName("Party");
    const customer = byName("Customer");

    expect(isTpcBase(party, pool)).toBe(true);
    expect(isTpcConcrete(customer, pool)).toBe(true);
    expect(isTphBase(party, pool)).toBe(false);
    expect(tpcConcretesOf(party, pool).map((a) => a.name)).toEqual(["Customer"]);

    // A TPC concrete is a standalone table — it owns itself, not the base.
    expect(tableOwnerName(customer, pool)).toBe("Customer");
  });
});
