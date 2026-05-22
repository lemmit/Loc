// Slice 11.25 — validator coverage for api declarations, UI api
// parameters, and body-ref chains.
//
// Three categories of checks:
//   1. Api declaration: name uniqueness within system, source
//      module reference resolves.
//   2. UI api parameter: name uniqueness within UI, api ref
//      resolves.
//   3. Body ref: chain `<paramName>.<aggregate>.<op>` rooted at a
//      declared param must resolve to a real aggregate + op.

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

describe("Slice 11.25 — api binding validator", () => {
  describe("api declaration", () => {
    it("flags duplicate api names", async () => {
      const { errors } = await parse(`
        system S {
          module Sales { context C { } }
          api Foo from Sales
          api Foo from Sales
          deployable api { platform: hono, modules: Sales, port: 3000 }
        }
      `);
      expect(errors.some((e) => /Duplicate api 'Foo'/.test(e))).toBe(true);
    });

    it("flags api referencing an undeclared module", async () => {
      const { errors } = await parse(`
        system S {
          api Foo from MissingModule
          deployable api { platform: hono, port: 3000 }
        }
      `);
      expect(
        errors.some((e) => /api 'Foo' references undeclared module 'MissingModule'/.test(e)),
      ).toBe(true);
    });

    it("accepts a valid api declaration", async () => {
      const { errors } = await parse(`
        system S {
          module Sales { context Orders { aggregate Customer { name: string } } }
          api SalesApi from Sales
          deployable api { platform: hono, modules: Sales, port: 3000 }
        }
      `);
      expect(errors.filter((e) => /api/.test(e))).toEqual([]);
    });
  });

  describe("UI api parameter", () => {
    it("flags duplicate api parameter names within a UI", async () => {
      const { errors } = await parse(`
        system S {
          module Sales { context C { } }
          api SalesApi from Sales
          ui WebApp {
            api Sales: SalesApi
            api Sales: SalesApi
            page X { route: "/x" body: Heading("hi") }
          }
          deployable api { platform: hono, modules: Sales, port: 3000 }
          deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      expect(errors.some((e) => /declares api parameter 'Sales' more than once/.test(e))).toBe(
        true,
      );
    });

    it("flags ui parameter referencing an undeclared api", async () => {
      const { errors } = await parse(`
        system S {
          module Sales { context C { } }
          ui WebApp {
            api Sales: NoSuchApi
            page X { route: "/x" body: Heading("hi") }
          }
          deployable api { platform: hono, modules: Sales, port: 3000 }
          deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      expect(errors.some((e) => /references undeclared api 'NoSuchApi'/.test(e))).toBe(true);
    });
  });

  describe("body ref chain `<param>.<aggregate>.<op>`", () => {
    it("flags an unknown aggregate", async () => {
      const { errors } = await parse(`
        system S {
          module Sales {
            context Orders {
              aggregate Customer { name: string }
              repository Customers for Customer { }
            }
          }
          api SalesApi from Sales
          ui WebApp {
            api Sales: SalesApi
            page X { route: "/x" body: Text(Sales.NoSuchAggregate.all.isLoading) }
          }
          deployable api { platform: hono, modules: Sales, port: 3000 }
          deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      expect(
        errors.some((e) => /Aggregate 'NoSuchAggregate' not found in api 'SalesApi'/.test(e)),
      ).toBe(true);
    });

    it("flags an unknown operation on a real aggregate", async () => {
      const { errors } = await parse(`
        system S {
          module Sales {
            context Orders {
              aggregate Customer { name: string }
              repository Customers for Customer { }
            }
          }
          api SalesApi from Sales
          ui WebApp {
            api Sales: SalesApi
            page X { route: "/x" body: Text(Sales.Customer.allll.isLoading) }
          }
          deployable api { platform: hono, modules: Sales, port: 3000 }
          deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      expect(
        errors.some((e) => /Operation 'allll' is not declared on aggregate 'Customer'/.test(e)),
      ).toBe(true);
      // Suggestion lists the available ops.
      expect(errors.some((e) => /all, byId, create/.test(e))).toBe(true);
    });

    it("accepts standard CRUD operations: all, byId, create", async () => {
      const { errors } = await parse(`
        system S {
          module Sales {
            context Orders {
              aggregate Customer { name: string }
              repository Customers for Customer { }
            }
          }
          api SalesApi from Sales
          ui WebApp {
            api Sales: SalesApi
            page X {
              route: "/x"
              body: Stack(
                Text(Sales.Customer.all.isLoading),
                Text(Sales.Customer.byId("xx").isLoading),
                Button("Create", onClick: e => { Sales.Customer.create.mutate({ name: "x" }) })
              )
            }
          }
          deployable api { platform: hono, modules: Sales, port: 3000 }
          deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      expect(errors.filter((e) => /Operation .* is not declared/.test(e))).toEqual([]);
    });

    it("accepts a custom repository finder", async () => {
      const { errors } = await parse(`
        system S {
          module Sales {
            context Orders {
              aggregate Customer { name: string }
              repository Customers for Customer { find byEmail(email: string): Customer? }
            }
          }
          api SalesApi from Sales
          ui WebApp {
            api Sales: SalesApi
            page X(email: string) {
              route: "/x/:email"
              body: Text(Sales.Customer.byEmail(email).isLoading)
            }
          }
          deployable api { platform: hono, modules: Sales, port: 3000 }
          deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      expect(errors.filter((e) => /Operation .* is not declared/.test(e))).toEqual([]);
    });

    it("does NOT flag chains rooted at a non-api-param name (those are different feature)", async () => {
      // `lodash.compact(items)` should not be validated as an api ref.
      const { errors } = await parse(`
        system S {
          module Sales { context C { } }
          api SalesApi from Sales
          ui WebApp {
            api Sales: SalesApi
            page X {
              route: "/x"
              state { items: int = 0 }
              body: Button("Foo", onClick: e => { lodash.compact.foo(items) })
            }
          }
          deployable api { platform: hono, modules: Sales, port: 3000 }
          deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
        }
      `);
      // No api-binding error for the lodash chain.
      expect(errors.filter((e) => /Aggregate 'compact'/.test(e))).toEqual([]);
      expect(errors.filter((e) => /Operation 'foo' is not declared/.test(e))).toEqual([]);
    });
  });
});
