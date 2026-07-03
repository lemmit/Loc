// React `store` emission (named-actions-and-stores.md §3, Stage 5).  A
// `store Cart { … }` emits a Zustand module at `web/src/stores/<snake>.ts`
// (`create<…State>`, an exported `useCart` hook).  A page/component that reads
// `Cart.lines` imports the hook and binds one selector per used member
// (`const lines = useCart((s) => s.lines)`); a page action calling
// `Cart.clear()` calls the bound action local.

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

async function reactFiles(uiBody: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: react, targets: api, ui: Web, port: 3001 }
    }
  `);
}

describe("React store emission", () => {
  it("emits a Zustand store module with the state interface and actions", async () => {
    const files = await reactFiles(`
      ${STORE}
      page P { route: "/p" body: Heading { Cart.count, level: 1 } }
    `);
    const mod = files.get("web/src/stores/cart.ts")!;
    expect(mod).toBeTruthy();
    expect(mod).toContain('import { create } from "zustand";');
    expect(mod).toContain("export interface CartState {");
    expect(mod).toContain("lines: string[];");
    expect(mod).toContain("count: number;");
    // Actions are typed members of the state interface.
    expect(mod).toContain("add: (sku: string) => void;");
    expect(mod).toContain("clear: () => void;");
    // The hook is the Zustand `create<CartState>(...)` store.
    expect(mod).toContain("export const useCart = create<CartState>((set) => ({");
    // Array field initializes to `[]`; the action body lowers `+=` on the
    // array to an immutable spread inside the Zustand `set` callback.  A
    // multi-statement action body renders as a block of `set(...)` calls.
    expect(mod).toContain("lines: [],");
    expect(mod).toContain("add: (sku) => { set((s) => ({ lines: [...s.lines, sku] }));");
    // A single-statement action renders inline (no block).
    expect(mod).toContain("clear: () => { set(() => ({ lines: [] }));");
  });

  it("wires a page read of `Cart.lines` to a `useCart` selector binding", async () => {
    const files = await reactFiles(`
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
    const tsx = files.get("web/src/pages/p.tsx")!;
    // Hook import + one selector binding per used member.
    expect(tsx).toContain('import { useCart } from "../stores/cart";');
    expect(tsx).toContain("const lines = useCart((s) => s.lines);");
    expect(tsx).toContain("const count = useCart((s) => s.count);");
    // A page action calling a store action binds + calls the action local.
    expect(tsx).toContain("const clear = useCart((s) => s.clear);");
    expect(tsx).toContain("const discard = () => { clear(); };");
  });

  it("wires a store read + action call from a COMPONENT body too", async () => {
    const files = await reactFiles(`
      ${STORE}
      component CartSummary() {
        action addOne() { Cart.add("SKU-1") }
        body: Stack { Heading { Cart.count, level: 3 }, Button { "Add", onClick: addOne } }
      }
      page P { route: "/p" body: CartSummary() }
    `);
    const comp = files.get("web/src/components/CartSummary.tsx")!;
    expect(comp).toContain('import { useCart } from "../stores/cart";');
    expect(comp).toContain("const count = useCart((s) => s.count);");
    expect(comp).toContain("const add = useCart((s) => s.add);");
    expect(comp).toContain('const addOne = () => { add("SKU-1"); };');
  });

  // Collision guard: when a page declares its own `state` field with the SAME
  // name as a store field it reads dotted, the store-field selector binding
  // must NOT collide with the `useState` binding.  The store local is
  // store-qualified (`cartLines`) so the page's `const [lines, setLines] =
  // useState(...)` stays the only `lines` binding, and the dotted read resolves
  // to the aliased local.  (Angular avoids the clash differently — its store
  // reads are `this.cart.<field>()`-qualified — see its sibling test.)
  it("aliases a store-field read that collides with a page-state field", async () => {
    const files = await reactFiles(`
      ${STORE}
      page P {
        route: "/p"
        state { lines: string[] = [ ] }
        body: Stack {
          For { each: lines, x => Card { x } },
          For { each: Cart.lines, y => Card { y } }
        }
      }
    `);
    const tsx = files.get("web/src/pages/p.tsx")!;
    // Exactly one bare `lines` binding (the page's `useState`); the store read
    // binds the qualified `cartLines`.
    const bareLines = (tsx.match(/\b(?:const|let)\s+(?:\[\s*)?lines\b/g) ?? []).length;
    expect(bareLines).toBe(1);
    expect(tsx).toContain("const cartLines = useCart((s) => s.lines);");
  });
});

// Lifetime ladder (frontend-state-management.md §3.1) — `persist:` picks where
// the store's state lives.  The item shape is identical across tiers; only the
// module wrapper (persist middleware / URL sync) changes.
describe("React store lifetime ladder", () => {
  const FILT = (life: string) => `
    store Filt ${life} {
      state { category: string = ""  pageNo: int = 0  minPrice: money = 0.00 }
      action setPage(p: int) { pageNo := p }
    }
    page P { route: "/p" body: Heading { Filt.pageNo, level: 1 } }`;

  it("persist: local wraps the store in the Zustand persist middleware over localStorage", async () => {
    const mod = (await reactFiles(FILT("persist: local"))).get("web/src/stores/filt.ts")!;
    expect(mod).toContain('import { persist, createJSONStorage } from "zustand/middleware";');
    expect(mod).toContain("create<FiltState>()(");
    expect(mod).toContain("persist(");
    expect(mod).toContain('name: "loom.store.Filt",');
    expect(mod).toContain("createJSONStorage(() => localStorage");
    // money field is revived back into a Decimal on load.
    expect(mod).toContain('["minPrice"].includes(key)');
  });

  it("persist: session backs the persist middleware with sessionStorage", async () => {
    const mod = (await reactFiles(FILT("persist: session"))).get("web/src/stores/filt.ts")!;
    expect(mod).toContain("createJSONStorage(() => sessionStorage");
  });

  it("persist: url syncs the store to the query string with a typed untrusted-input decoder", async () => {
    const mod = (await reactFiles(FILT("persist: url"))).get("web/src/stores/filt.ts")!;
    // Typed decode from the URL — each field coerced, defaulted on garbage.
    expect(mod).toContain("function decodeFromUrl()");
    expect(mod).toContain('category: p.get("category") ?? "",');
    expect(mod).toContain('Number.isFinite(Number(p.get("pageNo")))');
    expect(mod).toContain('p.get("minPrice")!.match(/^-?\\d+(\\.\\d+)?$/)');
    // store → URL (replaceState) and URL → store (popstate) both wired.
    expect(mod).toContain("window.history.replaceState(null");
    expect(mod).toContain("useFilt.subscribe((s) => encodeToUrl(s));");
    expect(mod).toContain('window.addEventListener("popstate"');
    // seeded from the URL at creation.
    expect(mod).toContain("...decodeFromUrl(),");
  });

  it("persist: memory (the default) is a plain create() with no persistence wrapper", async () => {
    const mod = (await reactFiles(FILT("persist: memory"))).get("web/src/stores/filt.ts")!;
    expect(mod).toContain("create<FiltState>((set) => ({");
    expect(mod).not.toContain("zustand/middleware");
    expect(mod).not.toContain("decodeFromUrl");
  });
});
