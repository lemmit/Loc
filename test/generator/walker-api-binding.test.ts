// Slice 11.24 — `api X from Module` declaration + UI `api X: Y`
// parameter + walker auto-injection of React Query hooks per
// body reference of the form `<paramName>.<aggregate>.<op>`.
//
// Architecture:
//   1. system-level: `api SalesApi from Sales` declares a contract.
//   2. ui-scope:     `api Sales: SalesApi` declares a parameter with
//                    a local handle.
//   3. body refs:    `Sales.Customer.all.data`, `Sales.Customer.create.mutate(...)`.
//   4. walker auto-emits at page top:
//        const customerAll    = useAllCustomers();
//        const customerCreate = useCreateCustomer();
//      and rewrites the 3-segment ref to the local var name.
//
// Naming convention (matches the existing scaffold output in
// `webApp/src/api/<aggregate>.ts`):
//   <agg>.all          → useAll<Plural>            (no args)
//   <agg>.byId(id)     → use<Single>ById(id)       (parameterized)
//   <agg>.create       → useCreate<Single>         (mutation)
//   <agg>.update       → useUpdate<Single>         (mutation)
//   <agg>.delete       → useDelete<Single>         (mutation)
//   <agg>.<finder>     → use<Finder><Single>       (custom)
// Variable name: `<aggCamel><OpPascal>`.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Slice 11.24 — api binding + walker hook injection", () => {
  it("UI `api X: Y` parameter + body ref injects useAllAggregates hook at page top", async () => {
    const files = await buildAndGenerate(`
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
          page List {
            route: "/customers"
            body: Stack(
              Heading("Customers"),
              Text(Sales.Customer.all.isLoading)
            )
          }
        }
        deployable api { platform: hono, modules: Sales, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/list.tsx")!;
    expect(content).toBeDefined();
    // Hook import + page-top declaration deterministic.
    expect(content).toMatch(/import \{ useAllCustomers \} from "\.\.\/api\/customer";/);
    expect(content).toMatch(/const customerAll = useAllCustomers\(\);/);
    // Body ref rewritten to local var.
    expect(content).toMatch(/<Text>\{customerAll\.isLoading\}<\/Text>/);
  });

  it("create mutation: `Sales.Customer.create.mutate(...)` in onClick", async () => {
    const files = await buildAndGenerate(`
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
          page New {
            route: "/customers/new"
            state { name: string = "" }
            body: Stack(
              Field("Name", bind: name),
              Button("Save", onClick: e => {
                Sales.Customer.create.mutate({ name: name })
              })
            )
          }
        }
        deployable api { platform: hono, modules: Sales, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/new.tsx")!;
    expect(content).toMatch(/import \{ useCreateCustomer \} from "\.\.\/api\/customer";/);
    expect(content).toMatch(/const customerCreate = useCreateCustomer\(\);/);
    // Body onClick uses the local var's `.mutate(...)`.
    expect(content).toMatch(/customerCreate\.mutate\(/);
  });

  it("parameterized query: byId(id) hoists with the arg at hook decl time", async () => {
    const files = await buildAndGenerate(`
      system S {
        module Sales {
          context Orders {
            aggregate Customer { name: string }
            repository Customers for Customer { find byId(id: string): Customer? }
          }
        }
        api SalesApi from Sales
        ui WebApp {
          api Sales: SalesApi
          page Detail(slug: string) {
            route: "/customers/:slug"
            body: Stack(
              Heading("Customer"),
              Text(Sales.Customer.byId(slug).isLoading)
            )
          }
        }
        deployable api { platform: hono, modules: Sales, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/detail.tsx")!;
    expect(content).toMatch(/import \{ useCustomerById \} from "\.\.\/api\/customer";/);
    // Hook arg passed through at decl time; the param is in scope from useParams above.
    expect(content).toMatch(/const customerById = useCustomerById\(slug\);/);
    expect(content).toMatch(/<Text>\{customerById\.isLoading\}<\/Text>/);
    // The param consumed by the hook arg gets destructured in the shell.
    expect(content).toMatch(/const \{ slug \} = useParams<\{ slug: string \}>\(\);/);
  });

  it("multiple references to same op de-dupe to one hook decl", async () => {
    const files = await buildAndGenerate(`
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
              Text(Sales.Customer.all.data),
              Text(Sales.Customer.all.isLoading),
              Text(Sales.Customer.all.error)
            )
          }
        }
        deployable api { platform: hono, modules: Sales, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    // Only one decl emitted despite three refs.
    const decls = content.match(/const customerAll = useAllCustomers\(\);/g) ?? [];
    expect(decls).toHaveLength(1);
    // All three accessors read from the local var.
    expect(content).toMatch(/customerAll\.data/);
    expect(content).toMatch(/customerAll\.isLoading/);
    expect(content).toMatch(/customerAll\.error/);
  });

  it("multiple ops on same aggregate share a single import line", async () => {
    const files = await buildAndGenerate(`
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
            state { name: string = "" }
            body: Stack(
              Text(Sales.Customer.all.isLoading),
              Button("New", onClick: e => {
                Sales.Customer.create.mutate({ name: name })
              })
            )
          }
        }
        deployable api { platform: hono, modules: Sales, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    // useAllCustomers + useCreateCustomer on one import line.
    expect(content).toMatch(
      /import \{ useAllCustomers, useCreateCustomer \} from "\.\.\/api\/customer";/,
    );
    // Both hooks declared.
    expect(content).toMatch(/const customerAll = useAllCustomers\(\);/);
    expect(content).toMatch(/const customerCreate = useCreateCustomer\(\);/);
  });

  it("custom finder operation: byEmail → useByEmailCustomer with arg", async () => {
    const files = await buildAndGenerate(`
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
          page Lookup(email: string) {
            route: "/lookup/:email"
            body: Text(Sales.Customer.byEmail(email).isLoading)
          }
        }
        deployable api { platform: hono, modules: Sales, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/lookup.tsx")!;
    expect(content).toMatch(/import \{ useByEmailCustomer \} from "\.\.\/api\/customer";/);
    expect(content).toMatch(/const customerByEmail = useByEmailCustomer\(email\);/);
  });

  it("UI without api parameters: existing behaviour unchanged (no hook injection)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body: Heading("hi")
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    // No api hooks emitted — no api binding declared.
    expect(content).not.toMatch(/use\w+from "\.\.\/api\//);
    expect(content).not.toMatch(/const \w+ = use\w+\(\);/);
  });
});
