// The shared seeder model (M-T6.52) — "what does the seeder know" about ONE
// aggregate, derived once (`seederAggregate` / `seederAggregates`) and
// consumed by all five backends' seed emitters instead of each re-deriving
// its own create-input / create-call shape.  See `src/generator/_persistence/
// seed-datasets.ts` for the full rationale; this pins the derivation itself.

import { describe, expect, it } from "vitest";
import {
  seederAggregate,
  seederAggregates,
} from "../../../src/generator/_persistence/seed-datasets.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import type { EnrichedBoundedContextIR } from "../../../src/ir/types/loom-ir.js";
import { parseString } from "../../_helpers/parse.js";

async function contextOf(src: string): Promise<EnrichedBoundedContextIR> {
  const { model } = await parseString(src, { validate: false });
  const ir = enrichLoomModel(lowerModel(model));
  for (const s of ir.systems) for (const sd of s.subdomains) for (const c of sd.contexts) return c;
  throw new Error("no context");
}

const wrap = (body: string) => `system S { subdomain M { context C {
  ${body}
} } }`;

describe("seederAggregate — event-sourced aggregates", () => {
  const SRC = wrap(`
    event Opened { account: Account id, owner: string }
    aggregate Account persistedAs: eventLog {
      owner: string
      balance: int
      create open(owner: string) { emit Opened { account: id, owner: owner } }
      apply(e: Opened) { owner := e.owner  balance := 0 }
    }
    repository Accounts for Account { }
  `);

  it("derives createParams from the `create` action's OWN params, not the field set", async () => {
    const ctx = await contextOf(SRC);
    const agg = ctx.aggregates.find((a) => a.name === "Account")!;
    const model = seederAggregate(agg)!;
    expect(model.persistenceKind).toBe("event-sourced");
    // `owner` is the create action's ONLY param — `balance` is a real
    // aggregate FIELD (folded by the applier) but is NOT a create param, so
    // `forCreateInput(agg.fields)` (the old, wrong derivation) would have
    // included it and this must not.
    expect(model.createParams.map((p) => p.name)).toEqual(["owner"]);
  });

  it("returns null (not constructible) for an event-sourced aggregate with no `create`", async () => {
    const ctx = await contextOf(
      wrap(`
        event Opened { account: Account id, owner: string }
        aggregate Account persistedAs: eventLog {
          owner: string
          apply(e: Opened) { owner := e.owner }
        }
        repository Accounts for Account { }
      `),
    );
    const agg = ctx.aggregates.find((a) => a.name === "Account")!;
    expect(seederAggregate(agg)).toBeNull();
  });

  it("excludes a not-constructible event-sourced aggregate from seederAggregates", async () => {
    const ctx = await contextOf(
      wrap(`
        event Opened { account: Account id, owner: string }
        aggregate Account persistedAs: eventLog {
          owner: string
          apply(e: Opened) { owner := e.owner }
        }
        repository Accounts for Account { }
      `),
    );
    expect(seederAggregates(ctx).has("Account")).toBe(false);
  });
});

describe("seederAggregate — relational / state aggregates", () => {
  it("derives createParams from the full create-input field set", async () => {
    const ctx = await contextOf(
      wrap(`
        aggregate Product with crudish {
          sku: string
          stock: int
        }
        repository Products for Product { }
      `),
    );
    const agg = ctx.aggregates.find((a) => a.name === "Product")!;
    const model = seederAggregate(agg)!;
    expect(model.persistenceKind).toBe("relational");
    expect(model.createParams.map((p) => p.name).sort()).toEqual(["sku", "stock"]);
  });

  it("returns null for an abstract inheritance base", async () => {
    const ctx = await contextOf(
      wrap(`
        abstract aggregate Base { name: string }
        aggregate Child extends Base with crudish { extra: int }
        repository Children for Child { }
      `),
    );
    const base = ctx.aggregates.find((a) => a.name === "Base")!;
    expect(seederAggregate(base)).toBeNull();
    expect(seederAggregates(ctx).has("Base")).toBe(false);
  });

  it("derives persistenceKind: document for a `shape: document` aggregate", async () => {
    const ctx = await contextOf(
      wrap(`
        aggregate Article shape: document, with crudish { title: string }
        repository Articles for Article { }
      `),
    );
    const agg = ctx.aggregates.find((a) => a.name === "Article")!;
    expect(seederAggregate(agg)!.persistenceKind).toBe("document");
  });
});

describe("seederAggregate — omission values", () => {
  it("a field/param with an explicit default omits to that default", async () => {
    const ctx = await contextOf(
      wrap(`
        aggregate Product with crudish {
          sku: string
          stock: int = 0
        }
        repository Products for Product { }
      `),
    );
    const agg = ctx.aggregates.find((a) => a.name === "Product")!;
    const stock = seederAggregate(agg)!.createParams.find((p) => p.name === "stock")!;
    expect(stock.omission.kind).toBe("default");
  });

  it("a bare optional field/param omits to null", async () => {
    const ctx = await contextOf(
      wrap(`
        aggregate Product with crudish {
          sku: string
          note: string?
        }
        repository Products for Product { }
      `),
    );
    const agg = ctx.aggregates.find((a) => a.name === "Product")!;
    const note = seederAggregate(agg)!.createParams.find((p) => p.name === "note")!;
    expect(note.omission).toEqual({ kind: "null" });
  });

  it("a bare non-optional bool field/param omits to false", async () => {
    const ctx = await contextOf(
      wrap(`
        aggregate Product with crudish {
          sku: string
          active: bool
        }
        repository Products for Product { }
      `),
    );
    const agg = ctx.aggregates.find((a) => a.name === "Product")!;
    const active = seederAggregate(agg)!.createParams.find((p) => p.name === "active")!;
    expect(active.omission).toEqual({ kind: "false" });
  });
});
