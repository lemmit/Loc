import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { ApiIR, EnrichedAggregateIR } from "../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Lifecycle URL style — Phase 2 (urlStyle on the api body + routeSlug
// enrichment).  See docs/proposals/lifecycle-url-style.md (D-URLSTYLE).
//   - `api X from Sub { urlStyle: literal | resource }`, default literal.
//   - routeSlug derived per action: canonical => undefined (bare URL),
//     literal => name, resource => plural(name).
//   - conflict warning when two apis surface one subdomain differently.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

async function parseModel(
  src: string,
): Promise<{ model: Model; errors: string[]; codes: (string | number | undefined)[] }> {
  const doc = await parse(src, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    model: doc.parseResult.value,
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    codes: diags.map((d) => d.code),
  };
}

function aggFrom(model: Model, name: string): EnrichedAggregateIR {
  for (const sys of enrichLoomModel(lowerModel(model)).systems) {
    for (const sub of sys.subdomains) {
      for (const ctx of sub.contexts) {
        const a = ctx.aggregates.find((x) => x.name === name);
        if (a) return a;
      }
    }
  }
  throw new Error(`Aggregate ${name} not found`);
}

function apiFrom(model: Model, name: string): ApiIR {
  for (const sys of lowerModel(model).systems) {
    const a = sys.apis.find((x) => x.name === name);
    if (a) return a;
  }
  throw new Error(`Api ${name} not found`);
}

/** `system S { subdomain Sales { context Sales { aggregate Order … } } api SalesApi from Sales<apiBody> }` */
const SYS = (members: string, apiBody = "") => `
system S {
  subdomain Sales {
    context Sales {
      aggregate Order {
        subject: string
        status:  string
${members}
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales${apiBody}
}
`;

describe("urlStyle — grammar + lowering", () => {
  it("defaults to literal when the api body is omitted", async () => {
    const { model, errors } = await parseModel(SYS(`        operation cancel() { status := "x" }`));
    expect(errors).toEqual([]);
    expect(apiFrom(model, "SalesApi").urlStyle).toBe("literal");
  });

  it("defaults to literal for an empty api body", async () => {
    const { model, errors } = await parseModel(
      SYS(`        operation cancel() { status := "x" }`, ` { }`),
    );
    expect(errors).toEqual([]);
    expect(apiFrom(model, "SalesApi").urlStyle).toBe("literal");
  });

  it("parses urlStyle: resource on the api body", async () => {
    const { model, errors } = await parseModel(
      SYS(`        operation cancel() { status := "x" }`, ` { urlStyle: resource }`),
    );
    expect(errors).toEqual([]);
    expect(apiFrom(model, "SalesApi").urlStyle).toBe("resource");
  });
});

describe("routeSlug — enrichment derivation", () => {
  it("literal: a mutate operation's slug is its verbatim name", async () => {
    const { model } = await parseModel(SYS(`        operation cancel() { status := "x" }`));
    const op = aggFrom(model, "Order").operations.find((o) => o.name === "cancel");
    expect(op?.routeSlug).toBe("cancel");
  });

  it("resource: a mutate operation's slug is pluralised", async () => {
    const { model } = await parseModel(
      SYS(`        operation cancel() { status := "x" }`, ` { urlStyle: resource }`),
    );
    const op = aggFrom(model, "Order").operations.find((o) => o.name === "cancel");
    expect(op?.routeSlug).toBe("cancels");
  });

  it("literal vs resource on a named create", async () => {
    const lit = await parseModel(SYS(`        create place(s: string) { subject := s }`));
    expect(aggFrom(lit.model, "Order").creates?.[0].routeSlug).toBe("place");
    const res = await parseModel(
      SYS(`        create place(s: string) { subject := s }`, ` { urlStyle: resource }`),
    );
    expect(aggFrom(res.model, "Order").creates?.[0].routeSlug).toBe("places");
  });

  it("a canonical create gets no slug (bare collection URL) — even under resource", async () => {
    const { model } = await parseModel(
      SYS(`        create(s: string) { subject := s }`, ` { urlStyle: resource }`),
    );
    const agg = aggFrom(model, "Order");
    expect(agg.canonicalCreate?.canonical).toBe(true);
    expect(agg.canonicalCreate?.routeSlug).toBeUndefined();
    expect(agg.creates?.[0].routeSlug).toBeUndefined();
  });

  it("a canonical destroy gets no slug", async () => {
    const { model } = await parseModel(SYS(`        destroy { }`, ` { urlStyle: resource }`));
    const agg = aggFrom(model, "Order");
    expect(agg.canonicalDestroy?.routeSlug).toBeUndefined();
  });

  it("a named destroy pluralises under resource", async () => {
    const { model } = await parseModel(
      SYS(`        destroy archive() { status := "archived" }`, ` { urlStyle: resource }`),
    );
    expect(aggFrom(model, "Order").destroys?.[0].routeSlug).toBe("archives");
  });

  it("defaults to literal slugs for a top-level context with no api", async () => {
    const { model } = await parseModel(`
      context C {
        aggregate Order {
          status: string
          operation cancel() { status := "x" }
        }
      }
    `);
    // top-level contexts live under the enriched model's `contexts`, not systems
    const raw = enrichLoomModel(lowerModel(model));
    const agg = raw.contexts[0].aggregates.find((a) => a.name === "Order");
    expect(agg?.operations.find((o) => o.name === "cancel")?.routeSlug).toBe("cancel");
  });
});

describe("urlStyle — conflict validation", () => {
  it("warns when two apis surface one subdomain with differing urlStyle", async () => {
    const { codes } = await parseModel(`
      system S {
        subdomain Sales {
          context Sales {
            aggregate Order { status: string }
            repository Orders for Order { }
          }
        }
        api SalesApi from Sales { urlStyle: resource }
        api SalesAlt from Sales { urlStyle: literal }
      }
    `);
    expect(codes).toContain("loom.subdomain-conflicting-urlstyle");
  });

  it("is silent when two apis agree on urlStyle", async () => {
    const { codes } = await parseModel(`
      system S {
        subdomain Sales {
          context Sales {
            aggregate Order { status: string }
            repository Orders for Order { }
          }
        }
        api SalesApi from Sales { urlStyle: resource }
        api SalesAlt from Sales { urlStyle: resource }
      }
    `);
    expect(codes).not.toContain("loom.subdomain-conflicting-urlstyle");
  });
});
