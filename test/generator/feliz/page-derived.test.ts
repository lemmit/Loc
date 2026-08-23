// Feliz frontend — PAGE-level `derived name: T = expr` bindings (M-T1.20).
//
// #2602 threaded component-level `derived` through the `renderDerivedRead`
// seam; the page walk still got an EMPTY `derivedNames`, so a body read of a
// page derived fell through to the walker's unresolved-ref path and rendered a
// `(* ref: <name> *)` give-up comment — the value silently vanished from the
// render, and `dotnet fable` stayed green because a comment compiles.
//
// The fix mirrors the component shape exactly: one `let <name> = <F#>` per
// derived, in declaration order (so a later one may read an earlier), placed in
// the view's preamble after the dispatch / store wrappers, with the bound names
// handed to the walk as its `derivedNames`.
//
// A derived whose expression reaches OUTSIDE that scope (an api read's
// `Remote<'T>` envelope, `currentUser`, a resource handle) keeps the old
// behaviour rather than emitting F# that names something absent — an unbound
// derived is a missing value, an unbound NAME is a build break.

import { describe, expect, it } from "vitest";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const sys = (pageBody: string) => `
system P {
  subdomain S { context C { } }
  ui WebApp {
${pageBody}
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}`;

async function app(pageBody: string): Promise<string> {
  const model = await buildLoomModel(sys(pageBody));
  const system = model.systems[0]!;
  const web = system.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts([], system, web).get("src/App.fs")!;
}

describe("feliz page-level `derived`", () => {
  it("binds a state-derived value as a `let` and the body reads it BARE", async () => {
    const fs = await app(`
    page Home {
      route: "/"
      state { qty: int = 2 }
      derived total: int = qty * 3
      body: Stack { Text { total } }
    }`);
    expect(fs).toContain("let total = (model.Qty * 3)");
    expect(fs).toContain("Html.text (string (total))");
    // The give-up comment is GONE — that is the bug this closes.
    expect(fs).not.toContain("(* ref: total *)");
    // A derived is NOT a Model field / Msg case — it recomputes per render.
    expect(fs).not.toContain("Total: int");
  });

  it("is sequential — a later derived reads an earlier one", async () => {
    const fs = await app(`
    page Home {
      route: "/"
      state { qty: int = 2 }
      derived total: int = qty * 3
      derived quad: int = total + total
      body: Stack { Text { quad } }
    }`);
    const total = fs.indexOf("let total = ");
    const quad = fs.indexOf("let quad = (total + total)");
    expect(total).toBeGreaterThan(-1);
    expect(quad).toBeGreaterThan(total); // F# resolves top-to-bottom
    expect(fs).not.toContain("(* ref: quad *)");
  });

  it("reads a store field through its namespaced Model field", async () => {
    const fs = await app(`
    store Cart {
      state { items: int = 0 }
      action add() { items := items + 1 }
    }
    page Home {
      route: "/"
      derived doubled: int = Cart.items * 2
      body: Stack { Text { doubled } }
    }`);
    expect(fs).toContain("let doubled = (model.CartItems * 2)");
    expect(fs).not.toContain("(* ref: doubled *)");
  });

  it("NEGATIVE CONTROL: a page with no `derived` is untouched", async () => {
    const fs = await app(`
    page Home {
      route: "/"
      state { qty: int = 2 }
      body: Stack { Text { qty } }
    }`);
    expect(fs).toContain("Html.text (string (model.Qty))");
    expect(fs).not.toContain("let qty =");
  });

  it("a derived reaching OUTSIDE page scope stays unbound rather than emitting a bare name", async () => {
    // `currentUser` is only bound under the UI-gate machinery; a page view
    // without one has no such local, so a `let` here would name nothing.
    const fs = await app(`
    page Home {
      route: "/"
      derived who: string = currentUser.id
      body: Stack { Text { who } }
    }`);
    expect(fs).not.toContain("let who =");
    expect(fs).toContain("(* ref: who *)");
  });
});
