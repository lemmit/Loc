// byFeature — real LayoutAdapter for the hono (node) platform
// (D-REALIZATION-AXES Phase 5b).  `directoryLayout: byFeature` colocates each
// aggregate's domain module / repository / routes / extern / test under a
// single `features/<agg>/` folder.  Cross-cutting / shared files delegate to
// byLayer.  Because TS imports are PATH-based, the orchestrator runs a post-emit
// import-rewrite pass so the relocated project still compiles — the
// "no dangling imports" assertion below is the net that guards that.

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
    expect(p("domain-aggregate-base", "Order")).toBe("features/order/order.base.ts");
    expect(p("domain-test", "Order")).toBe("features/order/order.test.ts");
  });

  it("delegates CROSS-CUTTING categories to byLayer (pooled domain / schema / shell / root)", () => {
    for (const a of [
      { category: "domain-ids" },
      { category: "domain-value-objects" },
      { category: "domain-events" },
      { category: "domain-errors" },
      { category: "drizzle-schema" },
      { category: "http-index" },
      { category: "obs-log" },
      { category: "project-index" },
    ] as const) {
      const art = { name: "", content: "", ...a } as HonoArtifact;
      expect(byFeatureLayoutAdapter.pathFor(art, ctx)).toBe(byLayerLayoutAdapter.pathFor(art, ctx));
    }
  });

  it("throws when a feature category lacks aggregateName", () => {
    expect(() => p("domain-aggregate")).toThrow(/missing aggregateName/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a `directoryLayout: byFeature` selection relocates the per-
// aggregate files AND rewrites every relative import so the project compiles.
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
    platform: node${layout}
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
    styleAdapter: resolveStyle(d.platform, null),
    layoutAdapter: resolveLayout(d.platform, d.directoryLayout),
  });
}

/** Resolve a relative specifier against the file it appears in → `<path>.ts`. */
function resolveSpec(fromFile: string, spec: string): string {
  const slash = fromFile.lastIndexOf("/");
  const acc = slash === -1 ? [] : fromFile.slice(0, slash).split("/").filter(Boolean);
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") acc.pop();
    else acc.push(part);
  }
  return `${acc.join("/")}.ts`;
}

/** Every relative import in every emitted .ts file must resolve to an emitted
 *  module — the net that guards the relocation/import-rewrite correctness. */
function danglingImports(files: Map<string, string>): string[] {
  const dangling: string[] = [];
  for (const [path, content] of files) {
    if (!path.endsWith(".ts")) continue;
    for (const m of content.matchAll(/\b(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g)) {
      const target = resolveSpec(path, m[1]!);
      if (!files.has(target)) dangling.push(`${path}: "${m[1]}" -> ${target}`);
    }
  }
  return dangling;
}

describe("byFeature end-to-end emit — hono/node", () => {
  it("relocates the per-aggregate files under features/order/", async () => {
    const paths = [...(await emit(" { directoryLayout: byFeature }")).keys()];
    expect(paths).toContain("features/order/order.ts");
    expect(paths).toContain("features/order/order-repository.ts");
    expect(paths).toContain("features/order/order.routes.ts");
    expect(paths).not.toContain("domain/order.ts");
    expect(paths).not.toContain("db/repositories/order-repository.ts");
    // Shared / pooled files STAY layered.
    expect(paths).toContain("db/schema.ts");
    expect(paths).toContain("http/index.ts");
    expect(paths).toContain("domain/ids.ts");
  });

  it("rewrites relative imports so the moved repository resolves its deps", async () => {
    const files = await emit(" { directoryLayout: byFeature }");
    const repo = files.get("features/order/order-repository.ts")!;
    // schema (stayed) is now two levels up + db/; the agg domain (also moved)
    // is a sibling.
    expect(repo).toContain(`from "../../db/schema"`);
    expect(repo).toContain(`from "./order"`);
    // the stale byLayer-relative specifiers are gone.
    expect(repo).not.toContain(`from "../schema"`);
    expect(repo).not.toContain(`from "../../domain/order"`);
  });

  it("rewrites a STAYED file (http/index.ts) that imports the moved routes", async () => {
    const idx = (await emit(" { directoryLayout: byFeature }")).get("http/index.ts")!;
    expect(idx).toContain(`../features/order/order.routes`);
  });

  it("has NO dangling relative imports — byFeature OR byLayer", async () => {
    expect(danglingImports(await emit(" { directoryLayout: byFeature }"))).toEqual([]);
    expect(danglingImports(await emit(""))).toEqual([]);
  });

  it("the default (byLayer) emit produces NO features/ folder", async () => {
    const files = await emit("");
    expect([...files.keys()].some((k) => k.startsWith("features/"))).toBe(false);
    expect(files.has("domain/order.ts")).toBe(true);
  });

  it("same set of files (relocation preserves the file COUNT)", async () => {
    const byLayer = await emit(" { directoryLayout: byLayer }");
    const byFeature = await emit(" { directoryLayout: byFeature }");
    expect(byFeature.size).toBe(byLayer.size);
  });
});
