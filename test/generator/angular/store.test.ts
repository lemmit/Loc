// Angular `store` emission (named-actions-and-stores.md §3, Stage 5;
// frontend-state-management.md §4.1).  A `store Cart { … }` emits an injectable
// signal service at `web/src/app/stores/<dasherized>.store.ts`
// (`@Injectable({ providedIn: "root" })`, state fields as `signal()`s, actions
// as class methods).  A page reading `Cart.lines` injects the store once
// (`readonly cart = inject(CartStore)`) and reads the signal in place
// (`this.cart.lines()`); a page action calling `Cart.clear()` calls
// `this.cart.clear()`.
//
// NOTE: the Angular generator does not yet emit user-defined `component`
// declarations as standalone files (a page body referencing one renders an
// `<!-- unknown layout component -->` comment), so the store-from-component
// path is exercised on React/Vue/Svelte; Angular's coverage is page-only.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const STORE = `
    store Cart {
      state {
        lines: string[]
        count: int = 0
      }
      action add(sku: string) { lines += sku  count += 1 }
      action clear() { lines := [ ]  count := 0 }
    }`;

async function angularFiles(uiBody: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: angular, targets: api, ui: Web, port: 3001 }
    }
  `);
}

describe("Angular store emission", () => {
  it("emits an injectable signal-store service with signal fields and method actions", async () => {
    const files = await angularFiles(`
      ${STORE}
      page P { route: "/p" body: Heading { Cart.count, level: 1 } }
    `);
    const mod = files.get("web/src/app/stores/cart.store.ts")!;
    expect(mod).toBeTruthy();
    expect(mod).toContain('import { Injectable, signal } from "@angular/core";');
    expect(mod).toContain('@Injectable({ providedIn: "root" })');
    expect(mod).toContain("export class CartStore {");
    // State fields are signals; the array zero value is `[]`.
    expect(mod).toContain("readonly lines = signal<string[]>([]);");
    expect(mod).toContain("readonly count = signal<number>(0);");
    // Actions are class methods reading via `this.f()` and writing via `this.f.set()`.
    expect(mod).toContain(
      "add(sku: string) { this.lines.set([...this.lines(), sku]); this.count.set(this.count() + 1); }",
    );
    expect(mod).toContain("clear() { this.lines.set([]); this.count.set(0); }");
  });

  it("injects the store once and reads `this.cart.<field>()` in a page", async () => {
    const files = await angularFiles(`
      ${STORE}
      page P {
        route: "/p"
        action discard() { Cart.clear() }
        body: Stack {
          Heading { Cart.count, level: 1 },
          For { each: Cart.lines, line => Card { line } },
          Button { "Discard", onClick: discard }
        }
      }
    `);
    const comp = files.get("web/src/app/pages/p.component.ts")!;
    // The store-service import + the single `inject(CartStore)` member.
    expect(comp).toContain('import { CartStore } from "../stores/cart.store";');
    expect(comp).toContain("readonly cart = inject(CartStore);");
    // Field reads are `this.`-qualified signal calls — in the template AND body.
    expect(comp).toContain("{{ this.cart.count() }}");
    expect(comp).toContain("@for (line of this.cart.lines(); track $index)");
    // A page action calling a store action renders the qualified method call.
    expect(comp).toContain("discard() { this.cart.clear(); }");
  });

  it("disambiguates a page-state read (bare) from a store read (`this.`-qualified)", async () => {
    // A page with its own `count` state AND a store read of `Cart.count`: the
    // page-state read stays a bare signal call, the store read is `this.cart`-
    // qualified — no collision (the `this.`-prefix is the disambiguator).
    const files = await angularFiles(`
      ${STORE}
      page P {
        route: "/p"
        state { count: int = 7 }
        body: Stack {
          Heading { count, level: 1 },
          Heading { Cart.count, level: 2 }
        }
      }
    `);
    const comp = files.get("web/src/app/pages/p.component.ts")!;
    // Page-local signal field declared; store injected separately.
    expect(comp).toContain("readonly count = signal");
    expect(comp).toContain("readonly cart = inject(CartStore);");
    // Page state read is bare `count()`; store read is `this.cart.count()`.
    expect(comp).toContain("{{ count() }}");
    expect(comp).toContain("{{ this.cart.count() }}");
  });
});

// Lifetime ladder (frontend-state-management.md §3.1) — `persist:` tiers over
// the `providedIn:"root"` signal service.  Parity with React/Vue/Svelte.
describe("Angular store lifetime ladder", () => {
  const FILT = (life: string) => `
    store Filt ${life} {
      state { category: string = ""  pageNo: int = 0  minPrice: money = 0.00 }
      action setPage(p: int) { pageNo := p }
    }
    page P { route: "/p" body: Heading { Filt.pageNo, level: 1 } }`;
  const mod = async (life: string) =>
    (await angularFiles(FILT(life))).get("web/src/app/stores/filt.store.ts")!;

  it("persist: local hydrates in the constructor + writes back via effect() to localStorage", async () => {
    const m = await mod("persist: local");
    expect(m).toContain('localStorage.getItem("loom.store.Filt")');
    expect(m).toContain('localStorage.setItem("loom.store.Filt"');
    expect(m).toContain("effect(()");
    expect(m).toContain("new Decimal"); // money revival
  });

  it("persist: session backs storage with sessionStorage", async () => {
    const m = await mod("persist: session");
    expect(m).toContain('sessionStorage.getItem("loom.store.Filt")');
    expect(m).toContain('sessionStorage.setItem("loom.store.Filt"');
  });

  it("persist: url syncs to the query string with a typed decoder (parity with React)", async () => {
    const m = await mod("persist: url");
    expect(m).toContain("decodeFromUrl()");
    expect(m).toContain('this.category.set(p.get("category") ?? "")');
    expect(m).toContain('Number.isFinite(Number(p.get("pageNo")))');
    expect(m).toContain("window.history.replaceState(null");
    expect(m).toContain('window.addEventListener("popstate"');
  });
});

// Regression: a money store field lowers to `Decimal`, so a declared money
// literal must be constructed (`new Decimal(...)`), not assigned raw to the
// `signal<Decimal>` (a TS2322).  Scalar-only showcases don't cover it.
describe("Angular store — money field init", () => {
  it("constructs a Decimal for a money field default", async () => {
    const m = (
      await angularFiles(`
      store Filt persist: local {
        state { category: string = ""  minPrice: money = 0.00 }
        action setCat(c: string) { category := c }
      }
      page P { route: "/p" body: Heading { Filt.category, level: 1 } }`)
    ).get("web/src/app/stores/filt.store.ts")!;
    expect(m).toContain('readonly minPrice = signal<Decimal>(new Decimal("0.00"));');
  });
});
