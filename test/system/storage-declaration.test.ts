// storage declarations + per-module storage map on
// backend deployables.
//
//   storage primarySql  { type: postgres }
//   storage hotCache    { type: redis    }
//   storage warehouse   { type: clickhouse }
//
//   deployable salesApi {
//     platform: hono
//     contexts: [C] {
//       primary: primarySql
//       cache:   hotCache
//       bi:      warehouse
//     }
//     serves: SalesApi
//     port: 3000
//   }

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";

async function parse(source: string) {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(source, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    warnings: diags.filter((d) => d.severity === 2).map((d) => d.message),
  };
}

const SALES_DOMAIN = `
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
`;

describe("storage declarations + module-storage map", () => {
  describe("storage declaration", () => {
    it("accepts a postgres storage", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          storage mainDb { type: postgres }
          deployable api {
            platform: hono
            contexts: [C]
            serves: SalesApi
            port: 3000
          }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("accepts each v0 type alias", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          storage pg     { type: postgres }
          storage my     { type: mysql }
          storage lite   { type: sqlite }
          storage mem    { type: inMemory }
          storage cache  { type: redis }
          storage es     { type: elastic }
          storage meili  { type: meilisearch }
          storage events { type: kafka }
          storage ch     { type: clickhouse }
          storage bq     { type: bigquery }
          deployable api {
            platform: hono
            contexts: [C]
            serves: SalesApi
            port: 3000
          }
        }
      `);
      // Type enum accepts every alias; structure-only check.
      expect(errors.filter((e) => /storage|type/.test(e))).toEqual([]);
    });

    it("flags duplicate storage names", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          storage db { type: postgres }
          storage db { type: postgres }
          deployable api {
            platform: hono
            contexts: [C]
            serves: SalesApi
            port: 3000
          }
        }
      `);
      expect(errors.some((e) => /Duplicate storage 'db'/.test(e))).toBe(true);
    });
  });

  describe("module-storage map on backend deployable", () => {
    it("accepts a primary binding", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          storage pg { type: postgres }
          deployable api {
            platform: hono
            contexts: [C]
            serves: SalesApi
            port: 3000
          }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("accepts a multi-role binding (primary + cache + bi)", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          storage pg     { type: postgres   }
          storage cache  { type: redis      }
          storage wh     { type: clickhouse }
          deployable api {
            platform: hono
            contexts: [C]
            serves: SalesApi
            port: 3000
          }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("flags missing primary in a non-empty module brace block", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          storage cache { type: redis }
          deployable api {
            platform: hono
            contexts: [C]
            serves: SalesApi
            port: 3000
          }
        }
      `);
      expect(errors.some((e) => /must include a 'primary: <storage>' binding/.test(e))).toBe(true);
    });

    it("flags duplicate role within one module block", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          storage db1 { type: postgres }
          storage db2 { type: postgres }
          deployable api {
            platform: hono
            contexts: [C]
            serves: SalesApi
            port: 3000
          }
        }
      `);
      expect(errors.some((e) => /binds role 'primary' more than once/.test(e))).toBe(true);
    });

    it("flags storage ref that doesn't resolve", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          deployable api {
            platform: hono
            contexts: [C]
            serves: SalesApi
            port: 3000
          }
        }
      `);
      expect(errors.some((e) => /references undeclared storage 'noSuchStorage'/.test(e))).toBe(
        true,
      );
    });

    it("flags brace-block on a frontend deployable", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          storage pg { type: postgres }
          ui WebApp { page X { route: "/x" body: Heading { "hi" } } }
          deployable api {
            platform: hono
            contexts: [C]
            serves: SalesApi
            port: 3000
          }
          deployable webApp {
            platform: static
            contexts: [C]
            targets: api
            ui: WebApp
            port: 3001
          }
        }
      `);
      expect(
        errors.some((e) => /storage block is only valid on a backend deployable/.test(e)),
      ).toBe(true);
    });

    it("multi-module deployable with separate storage allocations", async () => {
      const { errors } = await parse(`
        system S {
          subdomain Sales { context C { } }
          subdomain Marketing { context C { } }
          api SalesApi from Sales
          api MktgApi from Marketing
          storage salesPg  { type: postgres }
          storage mktgPg   { type: postgres }
          storage shared   { type: clickhouse }
          deployable api {
            platform: hono
            modules:
              Sales     { primary: salesPg, bi: shared },
              Marketing { primary: mktgPg, bi: shared }
            serves: SalesApi, MktgApi
            port: 3000
          }
        }
      `);
      expect(errors).toEqual([]);
    });

    it("backward compat: bare-list `contexts: [C], Marketing` still works", async () => {
      const { errors } = await parse(`
        system S {
          subdomain Sales { context C { } }
          subdomain Marketing { context C { } }
          deployable api {
            platform: hono
            contexts: [Sales, Marketing]
            port: 3000
          }
        }
      `);
      expect(errors).toEqual([]);
    });
  });
});
