// Feliz frontend — store subsystem (M-T6.15).
//
// A `store` folds into the SINGLE-program Elmish MVU: each store field becomes
// a namespaced Model field (`Cart` + `count` → `CartCount`), each store action
// a Msg case (`CartClear`) with an update arm under a store-scope, a store-field
// read binds a page-view local (`let count = model.CartCount`), and a store
// action call from a page action dispatches (`Cmd.ofMsg (CartAdd …)`).  The
// emitted App.fs is proven to `dotnet fable`-compile in CI.

import { describe, expect, it } from "vitest";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SYS = `
system P {
  subdomain S { context C { } }
  ui WebApp {
    store Cart {
      state { lines: string[]  count: int = 0 }
      action add(sku: string) { lines += sku  count += 1 }
      action clear() { lines := [ ]  count := 0 }
    }
    page Home {
      route: "/"
      action addOne() { Cart.add("SKU-1") }
      action discard() { Cart.clear() }
      body: Stack {
        Heading { "Cart", level: 1 },
        Text { "Items: " + Cart.count },
        For { each: Cart.lines, line => Card { line } },
        Button { "Add", onClick: addOne }
      }
    }
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}`;

async function app(): Promise<string> {
  const model = await buildLoomModel(SYS);
  const sys = model.systems[0]!;
  const web = sys.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts([], sys, web).get("src/App.fs")!;
}

describe("feliz store subsystem (M-T6.15)", () => {
  it("folds store state into the Model as namespaced fields", async () => {
    const fs = await app();
    expect(fs).toContain("CartLines: string list");
    expect(fs).toContain("CartCount: int");
  });

  it("seeds store fields in init from their declared defaults", async () => {
    const fs = await app();
    expect(fs).toContain("CartLines = []");
    expect(fs).toContain("CartCount = 0");
  });

  it("emits a Msg case + a store-scoped update arm per store action", async () => {
    const fs = await app();
    expect(fs).toContain("| CartAdd of string");
    expect(fs).toContain("| CartClear");
    expect(fs).toContain("| CartAdd sku ->");
    expect(fs).toContain("{ model with CartLines = (model.CartLines @ [ sku ]) }");
    expect(fs).toContain("{ model with CartCount = (model.CartCount + 1) }");
    expect(fs).toContain("| CartClear ->");
  });

  it("dispatches a store action called from a page action via Cmd.ofMsg", async () => {
    const fs = await app();
    expect(fs).toContain('Cmd.ofMsg (CartAdd "SKU-1")');
    expect(fs).toContain("Cmd.ofMsg (CartClear)");
  });

  it("binds store-field reads to page-view locals off the Model", async () => {
    const fs = await app();
    expect(fs).toContain("let count = model.CartCount");
    expect(fs).toContain("let lines = model.CartLines");
    // the `For { each: Cart.lines }` iterates the bound local
    expect(fs).toContain("lines |> List.map");
  });

  it("leaves no silent-drop markers", async () => {
    const fs = await app();
    expect(fs).not.toContain("// TODO feliz");
    expect(fs).not.toContain("unsupported");
  });
});
