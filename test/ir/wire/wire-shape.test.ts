import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { wireFieldsFor } from "../../../src/ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  EntityPartIR,
  LoomModel,
  ValueObjectIR,
  WireField,
} from "../../../src/ir/types/loom-ir.js";
import { loadExampleModel, toLoomModel } from "../../_helpers/index.js";

async function buildEnrichedModel(file: string): Promise<LoomModel> {
  return toLoomModel(await loadExampleModel(file));
}

function allAggregates(loom: LoomModel): AggregateIR[] {
  const out: AggregateIR[] = [];
  for (const c of loom.contexts) out.push(...c.aggregates);
  for (const s of loom.systems) {
    for (const m of s.subdomains) for (const c of m.contexts) out.push(...c.aggregates);
  }
  return out;
}

function allParts(loom: LoomModel): EntityPartIR[] {
  return allAggregates(loom).flatMap((a) => a.parts);
}

function allValueObjects(loom: LoomModel): ValueObjectIR[] {
  const out: ValueObjectIR[] = [];
  for (const c of loom.contexts) out.push(...c.valueObjects);
  for (const s of loom.systems) {
    for (const m of s.subdomains) for (const c of m.contexts) out.push(...c.valueObjects);
  }
  return out;
}

describe("enrichLoomModel — wire-shape derivation", () => {
  it("populates wireShape on every aggregate / part / value object", async () => {
    for (const example of [
      "examples/sales.ddd",
      "examples/banking.ddd",
      "examples/inventory.ddd",
      "examples/acme.ddd",
    ]) {
      const loom = await buildEnrichedModel(example);
      for (const a of allAggregates(loom)) {
        expect(wireFieldsFor(a), `${example}: ${a.name}`).toBeDefined();
        expect(wireFieldsFor(a).length).toBeGreaterThan(0);
      }
      for (const p of allParts(loom)) {
        expect(wireFieldsFor(p), `${example}: part ${p.name}`).toBeDefined();
      }
      for (const v of allValueObjects(loom)) {
        expect(wireFieldsFor(v), `${example}: vo ${v.name}`).toBeDefined();
      }
    }
  });

  it("places `id` first in every aggregate / part shape", async () => {
    const loom = await buildEnrichedModel("examples/sales.ddd");
    for (const a of allAggregates(loom)) {
      expect(wireFieldsFor(a)[0]!.source, `${a.name} first field`).toBe("id");
      expect(wireFieldsFor(a)[0]!.name).toBe("id");
    }
    for (const p of allParts(loom)) {
      expect(wireFieldsFor(p)[0]!.source, `part ${p.name} first field`).toBe("id");
    }
  });

  it("orders fields: id → properties → containments → derived", async () => {
    const loom = await buildEnrichedModel("examples/sales.ddd");
    const order = allAggregates(loom).find((a) => a.name === "Order")!;
    const sourceOrder = wireFieldsFor(order).map((f) => f.source);
    // Each source category appears in a contiguous block; once we
    // leave a category we never return to it.
    const expected: WireField["source"][] = ["id", "property", "containment", "derived"];
    let cursor = 0;
    for (const s of sourceOrder) {
      while (cursor < expected.length && s !== expected[cursor]) cursor++;
      expect(cursor, `unexpected source ${s} in order`).toBeLessThan(expected.length);
    }
  });

  it("value-object wireShape has no `id` and no `containment`", async () => {
    const loom = await buildEnrichedModel("examples/sales.ddd");
    const vos = allValueObjects(loom);
    expect(vos.length).toBeGreaterThan(0);
    for (const vo of vos) {
      for (const f of wireFieldsFor(vo)) {
        expect(f.source).not.toBe("id");
        expect(f.source).not.toBe("containment");
      }
    }
  });

  it("is idempotent — enrich(enrich(m)) deep-equals enrich(m)", async () => {
    const loom = await buildEnrichedModel("examples/acme.ddd");
    const twice = enrichLoomModel(loom);
    expect(twice).toEqual(loom);
  });
});

describe("enrichLoomModel — auto-includes findAll", () => {
  it("every aggregate's repository has an `all` find first", async () => {
    const loom = await buildEnrichedModel("examples/sales.ddd");
    for (const ctx of loom.contexts) {
      for (const agg of ctx.aggregates) {
        const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
        expect(repo, `${agg.name} repository`).toBeDefined();
        expect(repo!.finds[0]!.name).toBe("all");
        expect(repo!.finds[0]!.params).toEqual([]);
      }
    }
  });

  it("creates a repository for aggregates with no declared one", async () => {
    // banking.ddd has aggregates without explicit repository blocks
    // for some of them; enrichment should backfill.
    const loom = await buildEnrichedModel("examples/banking.ddd");
    for (const ctx of loom.contexts) {
      for (const agg of ctx.aggregates) {
        expect(
          ctx.repositories.some((r) => r.aggregateName === agg.name),
          `${agg.name} should have a repository after enrichment`,
        ).toBe(true);
      }
    }
  });
});

describe("enrichLoomModel — frontend `targets:` context inheritance", () => {
  it("frontend deployable's contextNames matches its target's", async () => {
    // `static` deployables share the legacy `react` context-
    // inheritance behaviour.  Match either tag to keep this test
    // resilient through the platform rename.
    const loom = await buildEnrichedModel("examples/acme.ddd");
    const sys = loom.systems[0]!;
    const web = sys.deployables.find((d) => d.platform === "react" || d.platform === "static");
    expect(web).toBeDefined();
    const target = sys.deployables.find((d) => d.name === web!.targetName);
    expect(target).toBeDefined();
    expect(web!.contextNames.sort()).toEqual([...target!.contextNames].sort());
  });
});
