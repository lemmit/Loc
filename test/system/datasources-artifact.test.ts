// `.loom/datasources.md` artifact — derived view of how dataSource
// decls route domain contexts to physical storage.  Tests assert the
// shape of the rendered markdown for representative inputs.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { renderDataSourcesMd } from "../../src/system/datasources.js";
import { parseString } from "../_helpers/index.js";

async function buildSys(src: string) {
  const { model } = await parseString(src);
  const loom = enrichLoomModel(lowerModel(model));
  return loom.systems[0];
}

describe(".loom/datasources.md", () => {
  it("emits the system name as the H1", async () => {
    const sys = await buildSys(`
      system Acme {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        resource cState { for: C, kind: state, use: pg }
        deployable api {
          platform: hono, contexts: [C], dataSources: [cState], port: 3000
        }
      }
    `);
    const md = renderDataSourcesMd(sys);
    expect(md).toContain("# Acme — resource routing");
  });

  it("renders a per-deployable table with one row per dataSource", async () => {
    const sys = await buildSys(`
      system S {
        subdomain M { context Orders { aggregate Order { x: int } } }
        storage pg { type: postgres }
        resource ordersState { for: Orders, kind: state, use: pg }
        deployable api {
          platform: hono, contexts: [Orders],
          dataSources: [ordersState], port: 3000
        }
      }
    `);
    const md = renderDataSourcesMd(sys);
    expect(md).toMatch(/### api — `platform: node`/);
    expect(md).toMatch(
      /\| Orders \| state \| ordersState \| pg \| postgres \| orders _\(default\)_ \| — \|/,
    );
  });

  it("defaults missing schema to snake(contextName) for relational storage", async () => {
    const sys = await buildSys(`
      system S {
        subdomain M { context CustomerOrders { aggregate Order { x: int } } }
        storage pg { type: postgres }
        resource s { for: CustomerOrders, kind: state, use: pg }
        deployable api {
          platform: hono, contexts: [CustomerOrders],
          dataSources: [s], port: 3000
        }
      }
    `);
    const md = renderDataSourcesMd(sys);
    expect(md).toContain("customer_orders _(default)_");
  });

  it("honors an explicit DSL `schema:` value verbatim", async () => {
    const sys = await buildSys(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        resource s { for: C, kind: state, use: pg, schema: "legacy_app" }
        deployable api {
          platform: hono, contexts: [C], dataSources: [s], port: 3000
        }
      }
    `);
    const md = renderDataSourcesMd(sys);
    expect(md).toContain("legacy_app");
    expect(md).not.toContain("_(default)_");
  });

  it("renders 'n/a' for schema when the storage is non-relational (redis)", async () => {
    const sys = await buildSys(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        storage r  { type: redis }
        resource cState { for: C, kind: state, use: pg }
        resource cCache { for: C, kind: cache, use: r }
        deployable api {
          platform: hono, contexts: [C],
          dataSources: [cState, cCache], port: 3000
        }
      }
    `);
    const md = renderDataSourcesMd(sys);
    // Cache row uses redis (non-relational) → schema column is n/a.
    expect(md).toMatch(/\| C \| cache \| cCache \| r \| redis \| n\/a \| — \|/);
  });

  it("renders a per-storage usage table listing every consumer", async () => {
    const sys = await buildSys(`
      system S {
        subdomain M {
          context A { aggregate One { x: int } }
          context B { aggregate Two { y: int } }
        }
        storage pg { type: postgres }
        resource aState { for: A, kind: state, use: pg }
        resource bState { for: B, kind: state, use: pg }
        deployable api {
          platform: hono, contexts: [A, B],
          dataSources: [aState, bState], port: 3000
        }
      }
    `);
    const md = renderDataSourcesMd(sys);
    expect(md).toContain("## Per storage");
    expect(md).toMatch(/\| pg \| postgres \| .*api → A \(state\).*api → B \(state\)/);
  });

  it("flags a storage with no resource pointing at it as '_unused_'", async () => {
    const sys = await buildSys(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        storage unused { type: redis }
        resource s { for: C, kind: state, use: pg }
        deployable api {
          platform: hono, contexts: [C], dataSources: [s], port: 3000
        }
      }
    `);
    const md = renderDataSourcesMd(sys);
    expect(md).toMatch(/\| unused \| redis \| _unused_ \|/);
  });

  it("calls out dataSources declared but not listed on any deployable", async () => {
    const sys = await buildSys(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        resource s     { for: C, kind: state, use: pg }
        resource extra { for: C, kind: cache, use: pg }
        deployable api {
          platform: hono, contexts: [C], dataSources: [s], port: 3000
        }
      }
    `);
    const md = renderDataSourcesMd(sys);
    expect(md).toContain("## Unused dataSources");
    expect(md).toContain("`extra` (for: C, kind: cache, use: pg)");
  });

  it("skips frontend-only deployables (no backend, no dataSources)", async () => {
    const sys = await buildSys(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        storage pg { type: postgres }
        resource s { for: C, kind: state, use: pg }
        deployable api {
          platform: hono, contexts: [C], dataSources: [s], port: 3000
        }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    const md = renderDataSourcesMd(sys);
    expect(md).not.toMatch(/### web/);
    expect(md).toMatch(/### api/);
  });

  it("renders a placeholder when the system has no backend deployables", async () => {
    const sys = await buildSys(`
      system S {
        subdomain M { context C { } }
      }
    `);
    const md = renderDataSourcesMd(sys);
    expect(md).toContain("_No backend deployables in this system._");
  });
});
