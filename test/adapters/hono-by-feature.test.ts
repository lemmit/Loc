// byFeature — real LayoutAdapter for the hono (node) platform
// (D-REALIZATION-AXES Phase 5b).  `directoryLayout: byFeature` colocates each
// aggregate's domain module / repository / routes / extern / test under a
// single `features/<agg>/` folder (vertical slice) instead of byLayer's
// `domain/`, `db/repositories/`, `http/` split.  Cross-cutting / shared files
// (pooled domain, db/schema, http/index, obs, auth, root) delegate to byLayer.

import { describe, expect, it } from "vitest";
import type { EmitCtx } from "../../src/generator/_adapters/index.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { EnrichedBoundedContextIR } from "../../src/ir/types/loom-ir.js";
import { byFeatureLayoutAdapter } from "../../src/platform/hono/v4/adapters/by-feature-layout.js";
import {
  byLayerLayoutAdapter,
  type HonoArtifact,
} from "../../src/platform/hono/v4/adapters/by-layer-layout.js";
import honoPlatform from "../../src/platform/hono/v4/index.js";
import { resolveLayout, resolveStyle } from "../../src/platform/resolve-adapters.js";
import { parseValid } from "../_helpers/parse.js";

const ctx = {} as EmitCtx; // path routing ignores ctx

function p(category: HonoArtifact["category"], aggregateName?: string): string {
  return byFeatureLayoutAdapter.pathFor(
    { name: "", content: "", category, aggregateName } as HonoArtifact,
    ctx,
  );
}

describe("byFeature LayoutAdapter — hono/node (real, Phase 5b)", () => {
  it("is registered as the node byFeature layout adapter", () => {
    const resolved = resolveLayout("node", "byFeature");
    expect(resolved).toBe(byFeatureLayoutAdapter);
    expect(resolved.name).toBe("byFeature");
  });

  it("colocates an aggregate's files under features/<agg>/ (byLayer basenames)", () => {
    expect(p("domain-aggregate", "Order")).toBe("features/order/order.ts");
    expect(p("drizzle-repository", "Order")).toBe("features/order/order-repository.ts");
    expect(p("http-routes", "Order")).toBe("features/order/order.routes.ts");
    expect(p("domain-extern", "Order")).toBe("features/order/order-extern.ts");
    expect(p("domain-test", "Order")).toBe("features/order/order.test.ts");
  });

  it("lowerFirsts the aggregate name for the feature folder", () => {
    expect(p("domain-aggregate", "OrderLine")).toBe("features/orderLine/orderLine.ts");
  });

  it("delegates CROSS-CUTTING categories to byLayer (pooled domain / schema / shell / root)", () => {
    for (const a of [
      { category: "domain-ids" },
      { category: "domain-value-objects" },
      { category: "domain-events" },
      { category: "domain-errors" },
      { category: "drizzle-schema" },
      { category: "http-index" },
      { category: "http-views" },
      { category: "http-workflows" },
      { category: "obs-log" },
      { category: "project-index" },
      { category: "package-json" },
    ] as const) {
      const art = { name: "", content: "", ...a } as HonoArtifact;
      expect(byFeatureLayoutAdapter.pathFor(art, ctx)).toBe(byLayerLayoutAdapter.pathFor(art, ctx));
    }
  });

  it("throws when a feature category lacks aggregateName", () => {
    expect(() => p("domain-aggregate")).toThrow(/missing aggregateName/);
  });

  it("throws when an artifact arrives without a category", () => {
    expect(() => byFeatureLayoutAdapter.pathFor({ name: "x.ts", content: "" }, ctx)).toThrow(
      /missing a category/,
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a `directoryLayout: byFeature` selection relocates the emitted
// files — a PURE relocation (identical contents, only the per-aggregate paths
// differ from the byLayer default).
// ---------------------------------------------------------------------------

const SRC = (layout: string) => `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
        status: int
        invariant name.length > 0
        operation confirm() { precondition status == 0  status := 1 }
      }
      repository Orders for Order {
        find byName(name: string): Order? where this.name == name
      }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: hono${layout}
    contexts: [Orders]
    dataSources: [ordersState]
    port: 3000
  }
}
`;

async function emit(layout: string): Promise<Map<string, string>> {
  const loom = enrichLoomModel(lowerModel(await parseValid(SRC(layout))));
  const sys = loom.systems[0]!;
  const d = sys.deployables[0]!;
  const contexts: EnrichedBoundedContextIR[] = sys.subdomains
    .flatMap((s) => s.contexts)
    .filter((c) => d.contextNames.includes(c.name));
  return honoPlatform.emitProject({
    contexts,
    deployable: d,
    sys,
    migrations: [],
    styleAdapter: resolveStyle(d.platform, d.application),
    layoutAdapter: resolveLayout(d.platform, d.directoryLayout),
  });
}

describe("byFeature end-to-end emit — hono/node", () => {
  it("colocates the aggregate's domain + repository + routes under features/order/", async () => {
    const files = await emit(" { directoryLayout: byFeature }");
    const paths = [...files.keys()];
    expect(paths).toContain("features/order/order.ts");
    expect(paths).toContain("features/order/order-repository.ts");
    expect(paths).toContain("features/order/order.routes.ts");
    // …and NOT under the byLayer responsibility folders.
    expect(paths).not.toContain("domain/order.ts");
    expect(paths).not.toContain("db/repositories/order-repository.ts");
    expect(paths).not.toContain("http/order.routes.ts");
    // Shared / pooled files STAY layered.
    expect(paths).toContain("db/schema.ts");
    expect(paths).toContain("http/index.ts");
    expect(paths).toContain("domain/ids.ts");
  });

  it("the default (byLayer) emit produces NO features/ folder", async () => {
    const files = await emit("");
    expect([...files.keys()].some((p) => p.startsWith("features/"))).toBe(false);
    expect(files.has("domain/order.ts")).toBe(true);
  });

  it("is a pure relocation: same set of file CONTENTS, only paths differ", async () => {
    const byLayer = await emit(" { directoryLayout: byLayer }");
    const byFeature = await emit(" { directoryLayout: byFeature }");
    expect(byFeature.size).toBe(byLayer.size);
    const sortedContents = (m: Map<string, string>) => [...m.values()].sort();
    expect(sortedContents(byFeature)).toEqual(sortedContents(byLayer));
    const sortedPaths = (m: Map<string, string>) => [...m.keys()].sort();
    expect(sortedPaths(byFeature)).not.toEqual(sortedPaths(byLayer));
  });
});
