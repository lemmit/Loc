// deployable composition: backend `serves:` +
// frontend `ui: WebApp { Param: backend }` compose-block.
//
// Closes the explicit binding loop:
//   1. backend deployable says: "I serve SalesApi"   (`serves: SalesApi`)
//   2. UI says: "I take a Sales parameter of SalesApi"  (`api Sales: SalesApi`)
//   3. body refs use the Sales handle:               `Sales.Customer.all.data`
//   4. frontend deployable binds the param to a backend:
//        `ui: WebApp { Sales: salesApi }`
//
// Validator catches every misalignment in the chain.

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

describe("deployable composition (serves + ui-compose)", () => {
  describe("serves:", () => {
    it("backend can serve a declared api", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          deployable salesApi {
            platform: hono
            contexts: [Sales]
            serves: SalesApi
            port: 3000
          }
        }
      `);
      expect(errors.filter((e) => /serves|ui:/.test(e))).toEqual([]);
    });

    it("flags `serves:` on a frontend platform", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          ui WebApp { page X { route: "/x" body: Heading { "hi" } } }
          deployable api { platform: hono, contexts: [Sales], port: 3000 }
          deployable webApp {
            platform: static
            targets: api
            serves: SalesApi
            ui: WebApp
            port: 3001
          }
        }
      `);
      expect(errors.some((e) => /'serves:' is only valid on a backend deployable/.test(e))).toBe(
        true,
      );
    });

    it("flags duplicate api in serves list", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          deployable salesApi {
            platform: hono
            contexts: [Sales]
            serves: SalesApi, SalesApi
            port: 3000
          }
        }
      `);
      expect(errors.some((e) => /lists api 'SalesApi' more than once/.test(e))).toBe(true);
    });
  });

  describe("ui: WebApp { Param: backend } compose-block", () => {
    it("frontend can bind a UI param to a serving backend", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          ui WebApp {
            api Sales: SalesApi
            page X { route: "/x" body: Heading { "hi" } }
          }
          deployable salesApi {
            platform: hono
            contexts: [Sales]
            serves: SalesApi
            port: 3000
          }
          deployable webApp {
            platform: static
            targets: salesApi
            ui: WebApp { Sales: salesApi }
            port: 3001
          }
        }
      `);
      expect(errors.filter((e) => /serves|ui parameter|missing|undeclared/.test(e))).toEqual([]);
    });

    it("flags backend that does NOT serve the param's api", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          ui WebApp {
            api Sales: SalesApi
            page X { route: "/x" body: Heading { "hi" } }
          }
          deployable salesApi {
            platform: hono
            contexts: [Sales]
            port: 3000
          }
          deployable webApp {
            platform: static
            targets: salesApi
            ui: WebApp { Sales: salesApi }
            port: 3001
          }
        }
      `);
      expect(errors.some((e) => /'salesApi' does not 'serves: SalesApi'/.test(e))).toBe(true);
    });

    it("flags binding name that doesn't match any UI param", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          ui WebApp {
            api Sales: SalesApi
            page X { route: "/x" body: Heading { "hi" } }
          }
          deployable salesApi {
            platform: hono
            contexts: [Sales]
            serves: SalesApi
            port: 3000
          }
          deployable webApp {
            platform: static
            targets: salesApi
            ui: WebApp { Misspelled: salesApi }
            port: 3001
          }
        }
      `);
      expect(
        errors.some((e) =>
          /binds parameter 'Misspelled' on ui 'WebApp' but the ui declares no 'api Misspelled: <Api>' parameter/.test(
            e,
          ),
        ),
      ).toBe(true);
    });

    it("flags missing binding for a declared UI param", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          ui WebApp {
            api Sales: SalesApi
            page X { route: "/x" body: Heading { "hi" } }
          }
          deployable salesApi {
            platform: hono
            contexts: [Sales]
            serves: SalesApi
            port: 3000
          }
          deployable webApp {
            platform: static
            targets: salesApi
            ui: WebApp
            port: 3001
          }
        }
      `);
      // Sugar form `ui: WebApp` without bindings → error since UI has params.
      expect(
        errors.some((e) =>
          /deploys ui 'WebApp' which declares api parameters; supply bindings via 'ui: WebApp \{ Sales:/.test(
            e,
          ),
        ),
      ).toBe(true);
    });

    it("flags missing binding when only some params are bound", async () => {
      const { errors } = await parse(`
        system S {
          subdomain Sales { context C { } }
          subdomain Marketing { context C { } }
          api SalesApi from Sales
          api MktgApi from Marketing
          ui WebApp {
            api Sales: SalesApi
            api Mktg:  MktgApi
            page X { route: "/x" body: Heading { "hi" } }
          }
          deployable salesApi {
            platform: hono
            contexts: [Sales]
            serves: SalesApi
            port: 3000
          }
          deployable mktgApi {
            platform: hono
            contexts: [Marketing]
            serves: MktgApi
            port: 3001
          }
          deployable webApp {
            platform: static
            targets: salesApi
            ui: WebApp { Sales: salesApi }
            port: 3002
          }
        }
      `);
      expect(
        errors.some((e) =>
          /missing a binding for ui parameter 'Mktg: MktgApi' on ui 'WebApp'/.test(e),
        ),
      ).toBe(true);
    });

    it("flags duplicate param binding", async () => {
      const { errors } = await parse(`
        system S {
          ${SALES_DOMAIN}
          ui WebApp {
            api Sales: SalesApi
            page X { route: "/x" body: Heading { "hi" } }
          }
          deployable salesApi {
            platform: hono
            contexts: [Sales]
            serves: SalesApi
            port: 3000
          }
          deployable webApp {
            platform: static
            targets: salesApi
            ui: WebApp { Sales: salesApi, Sales: salesApi }
            port: 3001
          }
        }
      `);
      expect(errors.some((e) => /binds ui parameter 'Sales' more than once/.test(e))).toBe(true);
    });

    it("two params from two different backends — fully bound", async () => {
      const { errors } = await parse(`
        system S {
          subdomain Sales { context Orders { aggregate Customer { name: string } } }
          subdomain Marketing { context Campaigns { aggregate Campaign { name: string } } }
          api SalesApi from Sales
          api MktgApi from Marketing
          ui WebApp {
            api Sales: SalesApi
            api Mktg:  MktgApi
            page X { route: "/x" body: Heading { "hi" } }
          }
          deployable salesApi {
            platform: hono
            contexts: [Sales]
            serves: SalesApi
            port: 3000
          }
          deployable mktgApi {
            platform: hono
            contexts: [Marketing]
            serves: MktgApi
            port: 3001
          }
          deployable webApp {
            platform: static
            targets: salesApi
            ui: WebApp { Sales: salesApi, Mktg: mktgApi }
            port: 3002
          }
        }
      `);
      expect(errors.filter((e) => /serves|ui parameter|missing|undeclared/.test(e))).toEqual([]);
    });

    it("UI without api params: sugar form `ui: WebApp` is fine", async () => {
      const { errors } = await parse(`
        system S {
          subdomain M { context C { } }
          ui WebApp { page X { route: "/x" body: Heading { "hi" } } }
          deployable api { platform: hono, contexts: [C], port: 3000 }
          deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      expect(errors.filter((e) => /serves|ui parameter|missing|undeclared/.test(e))).toEqual([]);
    });
  });
});
