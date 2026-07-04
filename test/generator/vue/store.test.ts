// Vue `store` emission (named-actions-and-stores.md §3, Stage 5;
// frontend-state-management.md §4.1).  A `store Cart { … }` emits a
// `reactive()` singleton module at `web/src/stores/<snake>.ts` with a
// `useCart()` accessor returning `{ state, <action>… }`.  A page/component
// reading `Cart.lines` binds the singleton once (`const cart = useCart()`) and
// one reactive `computed(() => cart.state.lines)` per used field; a store
// action binds the bound callable (`const clear = cart.clear`).

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

async function vueFiles(uiBody: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: vue, targets: api, ui: Web, port: 3001 }
    }
  `);
}

describe("Vue store emission", () => {
  it("emits a `reactive()` singleton module with a `useCart` accessor", async () => {
    const files = await vueFiles(`
      ${STORE}
      page P { route: "/p" body: Heading { Cart.count, level: 1 } }
    `);
    const mod = files.get("web/src/stores/cart.ts")!;
    expect(mod).toBeTruthy();
    expect(mod).toContain('import { reactive } from "vue";');
    expect(mod).toContain("export interface CartState {");
    expect(mod).toContain("lines: string[];");
    expect(mod).toContain("count: number;");
    // The singleton + accessor returning `{ state, ...actions }`.
    expect(mod).toContain("const state = reactive<CartState>({ lines: [], count: 0 });");
    expect(mod).toContain("export const useCart = () => ({");
    expect(mod).toContain("state,");
    // Actions mutate the reactive object in place (no immutable spread of state).
    expect(mod).toContain(
      "add: (sku: string) => { state.lines = [...state.lines, sku]; state.count = state.count + 1; },",
    );
    expect(mod).toContain("clear: () => { state.lines = []; state.count = 0; },");
  });

  it("binds the singleton once and a `computed` per used field in a page", async () => {
    const files = await vueFiles(`
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
    const sfc = files.get("web/src/pages/p.vue")!;
    expect(sfc).toContain('import { useCart } from "../stores/cart";');
    expect(sfc).toContain("const cart = useCart();");
    // Field reads → reactive computeds.
    expect(sfc).toContain("const count = computed(() => cart.state.count);");
    expect(sfc).toContain("const lines = computed(() => cart.state.lines);");
    // Store action → bound callable; page action calls it.
    expect(sfc).toContain("const clear = cart.clear;");
    expect(sfc).toContain("const discard = () => { clear(); };");
  });

  it("wires a store read + action call from a COMPONENT body too", async () => {
    const files = await vueFiles(`
      ${STORE}
      component CartSummary() {
        action addOne() { Cart.add("SKU-1") }
        body: Stack { Heading { Cart.count, level: 3 }, Button { "Add", onClick: addOne } }
      }
      page P { route: "/p" body: CartSummary() }
    `);
    const comp = files.get("web/src/components/CartSummary.vue")!;
    expect(comp).toContain('import { useCart } from "../stores/cart";');
    expect(comp).toContain("const cart = useCart();");
    expect(comp).toContain("const count = computed(() => cart.state.count);");
    expect(comp).toContain("const add = cart.add;");
    expect(comp).toContain('const addOne = () => { add("SKU-1"); };');
  });

  // Collision guard: a page declaring its own `state` field with the SAME name
  // as a dotted store-field read must not emit a duplicate `lines` binding.  The
  // store-field local is store-qualified (`cartLines`), leaving the page's
  // `const lines = ref(...)` as the only bare `lines`.  (Angular avoids the
  // clash differently — store reads are `this.cart.<field>()`-qualified.)
  it("aliases a store-field read that collides with a page-state field", async () => {
    const files = await vueFiles(`
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
    const sfc = files.get("web/src/pages/p.vue")!;
    const bareLines = (sfc.match(/\bconst\s+lines\b/g) ?? []).length;
    expect(bareLines).toBe(1);
    expect(sfc).toContain("const cartLines = computed(() => cart.state.lines);");
  });
});

// Lifetime ladder (frontend-state-management.md §3.1) — `persist:` tiers over
// the reactive() singleton.  Mirrors the React tier tests; the item shape is
// identical, only the module wrapper (storage watch / URL sync) changes.
describe("Vue store lifetime ladder", () => {
  const FILT = (life: string) => `
    store Filt ${life} {
      state { category: string = ""  pageNo: int = 0  minPrice: money = 0.00 }
      action setPage(p: int) { pageNo := p }
    }
    page P { route: "/p" body: Heading { Filt.pageNo, level: 1 } }`;

  it("persist: local hydrates from + writes back to localStorage", async () => {
    const mod = (await vueFiles(FILT("persist: local"))).get("web/src/stores/filt.ts")!;
    expect(mod).toContain('const STORAGE_KEY = "loom.store.Filt";');
    expect(mod).toContain("localStorage.getItem(STORAGE_KEY)");
    expect(mod).toContain("localStorage.setItem(STORAGE_KEY");
    expect(mod).toContain('["minPrice"].includes(key)'); // money reviver
    expect(mod).toContain("{ deep: true }");
  });

  it("persist: session backs storage with sessionStorage", async () => {
    const mod = (await vueFiles(FILT("persist: session"))).get("web/src/stores/filt.ts")!;
    expect(mod).toContain("sessionStorage.getItem(STORAGE_KEY)");
    expect(mod).toContain("sessionStorage.setItem(STORAGE_KEY");
  });

  it("persist: url syncs to the query string with a typed decoder (parity with React)", async () => {
    const mod = (await vueFiles(FILT("persist: url"))).get("web/src/stores/filt.ts")!;
    expect(mod).toContain("function decodeFromUrl()");
    expect(mod).toContain('category: p.get("category") ?? "",');
    expect(mod).toContain('Number.isFinite(Number(p.get("pageNo")))');
    expect(mod).toContain("window.history.replaceState(null");
    expect(mod).toContain('window.addEventListener("popstate"');
  });
});
