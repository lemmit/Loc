// Slice 11.20 — NumberField + Loader primitives.
//
//   NumberField("Quantity", bind: qty)
//     → <NumberInput value={qty} onChange={(v) => setQty(...)} />
//
//   Loader()        → <Loader />
//   Loader(size: "lg")  → <Loader size="lg" />

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";
import { generateSystems } from "../src/system/index.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Slice 11.20 — NumberField + Loader primitives", () => {
  it("NumberField('Qty', bind: qty) wires controlled NumberInput", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Form {
            route: "/form"
            state { qty: int = 1 }
            body:  NumberField("Quantity", bind: qty)
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/form.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/import \{ NumberInput \} from "@mantine\/core";/);
    expect(content).toMatch(/const \[qty, setQty\] = useState<number>\(1\);/);
    expect(content).toMatch(
      /<NumberInput label="Quantity" value=\{qty\} onChange=\{\(v\) => setQty\(typeof v === "number" \? v : 0\)\} \/>/,
    );
  });

  it("NumberField with decimal-typed state", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Form {
            route: "/form"
            state { price: decimal = 9.99 }
            body:  NumberField("Price", bind: price)
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/form.tsx")!;
    expect(content).toMatch(/const \[price, setPrice\] = useState<number>\(9\.99\);/);
    expect(content).toMatch(/<NumberInput label="Price" value=\{price\}/);
  });

  it("NumberField without bind: emits a label-only stub", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body:  NumberField("Bare")
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).toMatch(/<NumberInput label="Bare" \/>/);
    expect(content).not.toMatch(/onChange=/);
  });

  it("Loader() emits a default Mantine spinner", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state { loading: bool = true }
            body:  loading ? Loader() : Heading("Done")
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).toMatch(/import \{ Loader, Title \} from "@mantine\/core";/);
    expect(content).toMatch(/<Loader \/>/);
  });

  it("Loader(size: 'lg') emits the size attr", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body:  Loader(size: "lg")
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).toMatch(/<Loader size="lg" \/>/);
  });
});
