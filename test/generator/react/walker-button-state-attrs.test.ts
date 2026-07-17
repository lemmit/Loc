// Button accepts `disabled:` and `loading:` named
// args.  Closes the gap that forced architecture-integration test
// to remove `disabled: customerCreate.isPending` from its assertions.
//
//   Button {"Save",
//     disabled: customer.create.isPending,
//     loading:  customer.create.isPending,
//     onClick:  e => { customer.create.mutate({...}) }}

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

const SCAFFOLD = `
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
`;

describe("Button disabled: + loading: named args", () => {
  it("Button { disabled: <bool-state> } emits the disabled attr", async () => {
    const files = await buildAndGenerate(`
      system S {
        ${SCAFFOLD}
        ui WebApp {
          page X {
            route: "/x"
            state { busy: bool = false }
            body: Button { "Save", disabled: busy }
          }
        }
        deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).toMatch(/<Button disabled=\{busy\}>Save<\/Button>/);
  });

  it("Button { loading: <ref> } emits the loading attr (mantine pack)", async () => {
    const files = await buildAndGenerate(`
      system S {
        ${SCAFFOLD}
        ui WebApp {
          page X {
            route: "/x"
            state { busy: bool = false }
            body: Button { "Save", loading: busy }
          }
        }
        deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).toMatch(/<Button loading=\{busy\}>Save<\/Button>/);
  });

  it("disabled + loading + onClick all on one Button — wired together", async () => {
    const files = await buildAndGenerate(`
      system S {
        ${SCAFFOLD}
        ui WebApp {
          api Sales: SalesApi
          page X {
            route: "/x"
            state { name: string = "" }
            body: Button {"Save",
              disabled: Sales.Customer.create.isPending,
              loading:  Sales.Customer.create.isPending,
              onClick: e => { Sales.Customer.create.mutate({ name: name }) }}
          }
        }
        deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    // Hook injected at page top.
    expect(content).toMatch(/const customerCreate = useCreateCustomer\(\);/);
    // Button has all three attrs: onClick wired to the mutation,
    // disabled + loading both bound to .isPending.
    expect(content).toMatch(/customerCreate\.mutate\(/);
    expect(content).toMatch(/disabled=\{customerCreate\.isPending\}/);
    expect(content).toMatch(/loading=\{customerCreate\.isPending\}/);
  });

  it("Button without disabled/loading is unaffected (no extra attrs)", async () => {
    const files = await buildAndGenerate(`
      system S {
        ${SCAFFOLD}
        ui WebApp {
          page X { route: "/x" body: Button { "Plain" } }
        }
        deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).toMatch(/<Button>Plain<\/Button>/);
    expect(content).not.toMatch(/disabled=/);
    expect(content).not.toMatch(/loading=/);
    // a11y: a plain button gets no aria-label (its visible text is the name).
    expect(content).not.toMatch(/aria-label=/);
  });

  it("Button { label: … } emits an aria-label accessible name (a11y)", async () => {
    const files = await buildAndGenerate(`
      system S {
        ${SCAFFOLD}
        ui WebApp {
          page X {
            route: "/x"
            body: Button { icon: "trash", label: "Delete order" }
          }
        }
        deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    // The `label:` hint becomes the button's aria-label (its accessible name);
    // the glyph rides the rightSection icon slot.
    expect(content).toMatch(/<Button[^>]*\baria-label="Delete order"/);
  });
});
