import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { wireFieldsForAggregate } from "../../src/ir/enrich/wire-projection.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { AggregateIR } from "../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// A derived field's declared type carries its nullability
// (`derived x: T? = …`).  It must flow into `wireShape.optional` so the
// `.loom/wire-spec.json` contract artifact does not list a nullable derived
// in its `required` array (which every backend serves as nullish).
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

async function aggregateFrom(src: string, name: string): Promise<AggregateIR> {
  const doc = await parse(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  expect(errors).toEqual([]);
  const enriched = enrichLoomModel(lowerModel(doc.parseResult.value));
  for (const ctx of enriched.contexts) {
    const agg = ctx.aggregates.find((a) => a.name === name);
    if (agg) return agg;
  }
  throw new Error(`Aggregate ${name} not found`);
}

const SRC = `
context People {
  aggregate Person {
    firstName: string
    nickname: string?
    derived greeting: string = "Hi " + firstName
    derived label: string? = nickname
  }
}
`;

describe("wireShape — derived-field nullability", () => {
  it("carries the derived's declared optionality (not hardcoded non-optional)", async () => {
    const agg = await aggregateFrom(SRC, "Person");
    const byName = Object.fromEntries(wireFieldsForAggregate(agg).map((f) => [f.name, f]));

    // A non-optional derived stays required.
    expect(byName.greeting.source).toBe("derived");
    expect(byName.greeting.optional).toBe(false);

    // An optional-typed derived must be optional on the wire — otherwise the
    // wire-spec contract lists it as `required` while backends serve it null.
    expect(byName.label.source).toBe("derived");
    expect(byName.label.optional).toBe(true);
  });
});
