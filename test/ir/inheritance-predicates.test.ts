import { describe, expect, it } from "vitest";
import { wireFieldsFor } from "../../src/ir/enrich/wire-projection.js";
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

describe("inheritance predicates — multi-level TPH chain (B11)", () => {
  it("merges the FULL transitive chain and keeps one root-owned table", async () => {
    // Dog extends Pet extends Animal — every base is abstract (grammar
    // requires it).  Before B11 the merge was single-level, so Dog lost the
    // grandparent `name` from its wireShape while the TPH table still carried
    // the column → every insert failed.
    const { pool, byName } = await poolFor(`
      context Reg {
        abstract aggregate Animal { name: string }
        abstract aggregate Pet extends Animal { owner: string }
        aggregate Dog extends Pet { breed: string }
      }
    `);
    const dog = byName("Dog");

    // Full transitive field merge: grandbase → base → own, in that order.
    expect(dog.fields.map((f) => f.name)).toEqual(["name", "owner", "breed", "version"]);
    // wireShape carries id + every inherited + own field (+ default-on version).
    const wire = wireFieldsFor(dog);
    expect(wire.map((w) => w.name)).toEqual(["id", "name", "owner", "breed", "version"]);

    // The whole hierarchy lives in ONE table at the ROOT — the intermediate
    // abstract Pet owns none, and the concrete resolves to the root.
    expect(tableOwnerName(dog, pool)).toBe("Animal");
    expect(isTphBase(byName("Animal"), pool)).toBe(true);
    expect(isTphBase(byName("Pet"), pool)).toBe(false);
    expect(isTphConcrete(dog, pool)).toBe(true);
    expect(tphConcretesOf(byName("Animal"), pool).map((a) => a.name)).toEqual(["Dog"]);
  });
});
