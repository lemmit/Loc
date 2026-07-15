import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { wireFieldsFor } from "../../src/ir/enrich/wire-projection.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { AggregateIR } from "../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Field access modifier — grammar + lowering + enrichment resolution.
// Covers the declared form (`name: T managed`), the type-driven inference
// (`X id` → token), the default (no modifier → editable), the nullable-
// token validator rule, and the propagation onto `WireField.access`.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

async function parseModel(
  src: string,
): Promise<{ model: Model; errors: string[]; warnings: string[] }> {
  const doc = await parse(src, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    model: doc.parseResult.value,
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    warnings: diags.filter((d) => d.severity === 2).map((d) => d.message),
  };
}

function aggregateFrom(model: Model, name: string): AggregateIR {
  const enriched = enrichLoomModel(lowerModel(model));
  for (const sys of enriched.systems) {
    for (const mod of sys.subdomains) {
      for (const ctx of mod.contexts) {
        const agg = ctx.aggregates.find((a) => a.name === name);
        if (agg) return agg;
      }
    }
  }
  for (const ctx of enriched.contexts) {
    const agg = ctx.aggregates.find((a) => a.name === name);
    if (agg) return agg;
  }
  throw new Error(`Aggregate ${name} not found`);
}

const SYSTEM = (fields: string) => `
system S {
  subdomain M {
    context C {
      aggregate Post {
${fields}
      }
    }
  }
  deployable api { platform: node, contexts: [C], port: 3000 }
}
`;

describe("field access — grammar + lowering", () => {
  it("parses every declared modifier", async () => {
    const src = SYSTEM(`        label: string
        slug: string immutable
        createdAt: datetime managed
        version: int token
        notes: string internal
        secretBlob: string secret
`);
    const { errors } = await parseModel(src);
    expect(errors).toEqual([]);
  });

  it("lowers the declared modifier with accessSource=declared", async () => {
    const src = SYSTEM(`        label: string
        slug: string immutable
        createdAt: datetime managed
`);
    const { model, errors } = await parseModel(src);
    expect(errors).toEqual([]);
    const agg = aggregateFrom(model, "Post");
    const byName = Object.fromEntries(agg.fields.map((f) => [f.name, f]));
    expect(byName.slug.access).toBe("immutable");
    expect(byName.slug.accessSource).toBe("declared");
    expect(byName.createdAt.access).toBe("managed");
    expect(byName.createdAt.accessSource).toBe("declared");
  });
});

describe("field access — enrichment defaults", () => {
  it("defaults a plain field to editable", async () => {
    const src = SYSTEM(`        label: string
`);
    const { model } = await parseModel(src);
    const agg = aggregateFrom(model, "Post");
    const label = agg.fields.find((f) => f.name === "label")!;
    expect(label.access).toBe("editable");
    expect(label.accessSource).toBe("default");
  });

  it("defaults a declared X id (foreign-key reference) to editable", async () => {
    // Declared `X id` is a foreign-key reference (the client supplies
    // it on create, e.g. `holder: Customer id`).  It is NOT a token —
    // tokens are the aggregate's synthetic identity (added separately
    // in `wireFieldsForAggregate`) and explicit concurrency tokens
    // (opt-in via the `token` modifier in source).
    const src = SYSTEM(`        author: Post id
`);
    const { model } = await parseModel(src);
    const agg = aggregateFrom(model, "Post");
    const author = agg.fields.find((f) => f.name === "author")!;
    expect(author.access).toBe("editable");
    expect(author.accessSource).toBe("default");
  });

  it("declared modifier wins over default", async () => {
    const src = SYSTEM(`        author: Post id internal
`);
    const { model } = await parseModel(src);
    const agg = aggregateFrom(model, "Post");
    const author = agg.fields.find((f) => f.name === "author")!;
    expect(author.access).toBe("internal");
    expect(author.accessSource).toBe("declared");
  });
});

describe("field access — wireShape projection", () => {
  it("attaches access to every WireField including the implicit id", async () => {
    const src = SYSTEM(`        label: string
        createdAt: datetime managed
`);
    const { model } = await parseModel(src);
    const agg = aggregateFrom(model, "Post");
    const byName = Object.fromEntries(wireFieldsFor(agg).map((w) => [w.name, w]));
    expect(byName.id.access).toBe("token");
    expect(byName.label.access).toBe("editable");
    expect(byName.createdAt.access).toBe("managed");
  });
});

describe("field access — validator", () => {
  it("rejects nullable token", async () => {
    const src = SYSTEM(`        version: int? token
`);
    const { errors } = await parseModel(src);
    expect(errors.some((e) => /Token field .* cannot be nullable/.test(e))).toBe(true);
  });

  it("accepts non-nullable token", async () => {
    const src = SYSTEM(`        version: int token
`);
    const { errors } = await parseModel(src);
    expect(errors).toEqual([]);
  });
});
