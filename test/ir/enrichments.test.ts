import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import type { RawLoomModel } from "../../src/ir/types/loom-ir.js";
import { allAggregates, allContexts } from "../../src/ir/types/loom-ir.js";
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

describe("enrichment — idempotency", () => {
  // Re-enriching an already-enriched LoomModel must be a no-op.  Every
  // derivation that synthesises (`ensureFindAll`, `synthesizeInspect`,
  // `resolveFieldAccess`, `assignMigrationsOwner`) has an early-out for
  // pre-existing output; this test pins that contract end-to-end so a
  // future derivation can't slip past it.

  const SYSTEM_SRC = `
    system Shop {
      subdomain Sales {
        context Orders {
          aggregate Order {
            customerId: string
            total: int
            contains lines: OrderLine[]
            derived lineCount: int = lines.count
            entity OrderLine { quantity: int }
          }
          aggregate Catalog {
            name: string
            tags: Order id[]
          }
          repository Orders for Order { }
          repository Catalogs for Catalog { }
          valueobject Money { amount: int  currency: string }
        }
      }
      deployable api { platform: node, contexts: [Orders], port: 3000 }
    }
  `;

  it("derives channel-routed eventSubscriptions for on-reactors and event-creates", async () => {
    const SRC = `
      context Sales {
        aggregate Order { total: int }
        repository Orders for Order { }
        event OrderPlaced { order: Order id, at: datetime }
        event PaymentTaken { order: Order id, amount: int }
        channel Lifecycle {
          carries: OrderPlaced, PaymentTaken
          delivery: broadcast
          retention: ephemeral
          key: order
        }
        workflow Fulfillment {
          orderId: Order id
          on(p: OrderPlaced) by p.order { }
          create(pay: PaymentTaken) by pay.order { }
        }
      }`;
    const loom = await buildLoomModel(SRC);
    const ctx = allContexts(loom).find((c) => c.name === "Sales")!;
    const subs = ctx.eventSubscriptions;
    expect(subs.find((s) => s.trigger === "on")).toMatchObject({
      event: "OrderPlaced",
      channel: "Lifecycle",
      workflow: "Fulfillment",
      param: "p",
    });
    expect(subs.find((s) => s.trigger === "create")).toMatchObject({
      event: "PaymentTaken",
      channel: "Lifecycle",
      workflow: "Fulfillment",
      param: "pay",
    });
  });

  it("omits a subscription for an event no channel carries (channel-routed)", async () => {
    const SRC = `
      context Sales {
        aggregate Order { total: int }
        repository Orders for Order { }
        event OrderPlaced { order: Order id, at: datetime }
        channel Empty { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
        event Ignored { order: Order id }
        workflow W {
          orderId: Order id
          on(i: Ignored) by i.order { }
        }
      }`;
    const loom = await buildLoomModel(SRC);
    const ctx = allContexts(loom).find((c) => c.name === "Sales")!;
    expect(ctx.eventSubscriptions.some((s) => s.event === "Ignored")).toBe(false);
  });

  it("yields [] for a channel-less context (byte-identical / Noop path)", async () => {
    const loom = await buildLoomModel(SRC);
    for (const ctx of allContexts(loom)) {
      expect(ctx.eventSubscriptions).toEqual([]);
    }
  });

  it("re-enriching deep-equals the first enrichment pass", async () => {
    const once = await buildLoomModel(SYSTEM_SRC);
    // Brand cast: enrichLoomModel's input is the `RawLoomModel` brand;
    // an already-`EnrichedLoomModel` value is structurally compatible
    // but carries the wrong phantom phase tag.  The cast is for the
    // type-checker only — no runtime data is changed.
    const twice = enrichLoomModel(once as unknown as RawLoomModel);
    expect(twice).toEqual(once);
  });

  it("re-enriching does not duplicate the auto-injected `findAll`", async () => {
    const once = await buildLoomModel(SYSTEM_SRC);
    const twice = enrichLoomModel(once as unknown as RawLoomModel);
    for (const ctx of allContexts(twice)) {
      for (const repo of ctx.repositories) {
        const allCount = repo.finds.filter((f) => f.name === "all").length;
        expect(allCount, `${repo.aggregateName}.repository.finds["all"]`).toBe(1);
      }
    }
  });

  it("re-enriching keeps the per-module migrationsOwner stable", async () => {
    const once = await buildLoomModel(SYSTEM_SRC);
    const twice = enrichLoomModel(once as unknown as RawLoomModel);
    const onceOwners = once.systems.flatMap((s) =>
      s.subdomains.map((m) => [m.name, m.migrationsOwner] as const),
    );
    const twiceOwners = twice.systems.flatMap((s) =>
      s.subdomains.map((m) => [m.name, m.migrationsOwner] as const),
    );
    expect(twiceOwners).toEqual(onceOwners);
  });
});
