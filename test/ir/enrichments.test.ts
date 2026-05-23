import { describe, expect, it } from "vitest";
import { allAggregates, allContexts } from "../../src/ir/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

// enrichLoomModel runs one pure pass after lowering.  These tests pin the
// two derivations every backend's DTO emitter and repository depend on:
// the canonical wireShape ordering and the auto-injected `findAll`.

const SRC = `
  context Shop {
    aggregate Order {
      customerId: string
      total: int
      contains lines: OrderLine[]
      derived lineCount: int = lines.count
      entity OrderLine { quantity: int }
    }
    repository Orders for Order { }
    valueobject Money { amount: int  currency: string }
  }
`;

describe("enrichment — wireShape", () => {
  it("orders fields id → declared properties → containments → derived", async () => {
    const loom = await buildLoomModel(SRC);
    const order = allAggregates(loom).find((a) => a.name === "Order")!;
    expect(order.wireShape, "Order.wireShape").toBeDefined();
    const shape = order.wireShape!;
    expect(shape.map((f) => f.source)).toEqual([
      "id",
      "property",
      "property",
      "containment",
      "derived",
    ]);
    expect(shape.map((f) => f.name)).toEqual(["id", "customerId", "total", "lines", "lineCount"]);
  });

  it("gives a contained part a wireShape whose first field is its id", async () => {
    const loom = await buildLoomModel(SRC);
    const order = allAggregates(loom).find((a) => a.name === "Order")!;
    const line = order.parts.find((p) => p.name === "OrderLine")!;
    expect(line.wireShape![0]!.source).toBe("id");
    expect(line.wireShape![0]!.name).toBe("id");
  });

  it("a value object's wireShape carries neither an id nor a containment", async () => {
    const loom = await buildLoomModel(SRC);
    const money = allContexts(loom)
      .flatMap((c) => c.valueObjects)
      .find((v) => v.name === "Money")!;
    for (const f of money.wireShape ?? []) {
      expect(f.source).not.toBe("id");
      expect(f.source).not.toBe("containment");
    }
  });
});

describe("enrichment — auto findAll", () => {
  it("injects `all` (no params) as the first find on every repository", async () => {
    const loom = await buildLoomModel(SRC);
    for (const ctx of allContexts(loom)) {
      for (const agg of ctx.aggregates) {
        const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
        expect(repo, `${agg.name} repository`).toBeDefined();
        expect(repo!.finds[0]!.name).toBe("all");
        expect(repo!.finds[0]!.params).toEqual([]);
      }
    }
  });
});

describe("enrichment — associations (T id[] join tables)", () => {
  const ASSOC_SRC = `
    context Roster {
      aggregate Pokemon { species: string }
      aggregate Trainer {
        name: string
        party: Pokemon id[]
        caught: Pokemon id[]
      }
      repository Trainers for Trainer { }
    }
  `;

  it("derives one association per T id[] field with snake-cased join metadata", async () => {
    const loom = await buildLoomModel(ASSOC_SRC);
    const trainer = allAggregates(loom).find((a) => a.name === "Trainer")!;
    expect(trainer.associations?.map((a) => a.joinTable)).toEqual([
      "trainer_party",
      "trainer_caught",
    ]);
    const party = trainer.associations!.find((a) => a.fieldName === "party")!;
    expect(party).toMatchObject({
      ownerAgg: "Trainer",
      targetAgg: "Pokemon",
      ownerFk: "trainer_id",
      targetFk: "pokemon_id",
    });
  });

  it("leaves associations empty for aggregates without reference collections", async () => {
    const loom = await buildLoomModel(ASSOC_SRC);
    const pokemon = allAggregates(loom).find((a) => a.name === "Pokemon")!;
    expect(pokemon.associations).toEqual([]);
  });
});
