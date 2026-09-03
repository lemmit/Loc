// Svelte `store` emission (named-actions-and-stores.md §3 /
// frontend-state-management.md §4.1, Stage 5).  A `store Cart { … }` emits a
// Svelte 5 runes (`$state`) module singleton at
// `web/src/lib/stores/<snake>.svelte.ts` (the `.svelte.ts` suffix is REQUIRED
// for runes to compile).  Actions are exported module-level arrows that mutate
// the deeply-reactive singleton in place.  A page/component reading `Cart.lines`
// imports the singleton + binds `const lines = $derived(cart.lines)`; a store
// action is imported by name and called bare.

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

async function svelteFiles(uiBody: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: svelte, targets: api, ui: Web, port: 3001 }
    }
  `);
}

describe("Svelte store emission", () => {
  it("emits a `$state` runes module at a `.svelte.ts` path with exported actions", async () => {
    const files = await svelteFiles(`
      ${STORE}
      page P { route: "/p" body: Heading { Cart.count, level: 1 } }
    `);
    // The `.svelte.ts` suffix is load-bearing — runes only compile in such a module.
    const mod = files.get("web/src/lib/stores/cart.svelte.ts")!;
    expect(mod).toBeTruthy();
    expect(mod).toContain("export const cart = $state<{ lines: string[]; count: number }>({");
    expect(mod).toContain("lines: [],");
    expect(mod).toContain("count: 0,");
    // Actions are module-level arrow exports mutating the reactive singleton.
    expect(mod).toContain(
      "export const add = (sku: string) => { cart.lines = [...cart.lines, sku]; cart.count = cart.count + 1; };",
    );
    expect(mod).toContain("export const clear = () => { cart.lines = []; cart.count = 0; };");
  });

  it("imports the singleton + binds `$derived` per field in a page", async () => {
    const files = await svelteFiles(`
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
    const page = [...files].find(([p]) => p.endsWith("+page.svelte"))?.[1] ?? "";
    // Singleton imported (field read) + the action imported by name (no `.ts`).
    expect(page).toContain('import { cart, clear } from "$lib/stores/cart.svelte";');
    expect(page).toContain("const count = $derived(cart.count);");
    expect(page).toContain("const lines = $derived(cart.lines);");
    // Page action calls the bare imported store action.
    expect(page).toContain("const discard = () => { clear(); };");
  });

  it("wires a store read + action call from a COMPONENT body too", async () => {
    const files = await svelteFiles(`
      ${STORE}
      component CartSummary() {
        action addOne() { Cart.add("SKU-1") }
        body: Stack { Heading { Cart.count, level: 3 }, Button { "Add", onClick: addOne } }
      }
      page P { route: "/p" body: CartSummary() }
    `);
    const comp = files.get("web/src/lib/components/CartSummary.svelte")!;
    expect(comp).toContain('import { add, cart } from "$lib/stores/cart.svelte";');
    expect(comp).toContain("const count = $derived(cart.count);");
    expect(comp).toContain('const addOne = () => { add("SKU-1"); };');
  });

  // Collision guard: a page declaring its own `state` field with the SAME name
  // as a dotted store-field read must not emit a duplicate `lines` binding.  The
  // store-field local is store-qualified (`cartLines`), leaving the page's
  // `let lines = $state(...)` as the only bare `lines`.  (Angular avoids the
  // clash differently — store reads are `this.cart.<field>()`-qualified.)
  it("aliases a store-field read that collides with a page-state field", async () => {
    const files = await svelteFiles(`
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
    const page = [...files].find(([p]) => p.endsWith("+page.svelte"))?.[1] ?? "";
    const bareLines = (page.match(/\b(?:const|let)\s+lines\b/g) ?? []).length;
    expect(bareLines).toBe(1);
    expect(page).toContain("const cartLines = $derived(cart.lines);");
  });
});

// Lifetime ladder (frontend-state-management.md §3.1) — `persist:` tiers over
// the `$state` rune singleton.  Parity with the React/Vue tier tests.
describe("Svelte store lifetime ladder", () => {
  const FILT = (life: string) => `
    store Filt ${life} {
      state { category: string = ""  pageNo: int = 0  minPrice: money = 0.00 }
      action setPage(p: int) { pageNo := p }
    }
    page P { route: "/p" body: Heading { Filt.pageNo, level: 1 } }`;
  const mod = async (life: string) =>
    (await svelteFiles(FILT(life))).get("web/src/lib/stores/filt.svelte.ts")!;

  it("persist: local hydrates from + writes back to localStorage via $effect.root", async () => {
    const m = await mod("persist: local");
    expect(m).toContain('const STORAGE_KEY = "loom.store.Filt";');
    expect(m).toContain("localStorage.getItem(STORAGE_KEY)");
    expect(m).toContain("localStorage.setItem(STORAGE_KEY");
    expect(m).toContain("$effect.root");
    expect(m).toContain('["minPrice"].includes(key)'); // money reviver
  });

  it("persist: session backs storage with sessionStorage", async () => {
    const m = await mod("persist: session");
    expect(m).toContain("sessionStorage.getItem(STORAGE_KEY)");
    expect(m).toContain("sessionStorage.setItem(STORAGE_KEY");
  });

  it("persist: url binds SvelteKit's router (page + goto) with a typed decoder", async () => {
    const m = await mod("persist: url");
    expect(m).toContain('import { goto } from "$app/navigation";');
    expect(m).toContain('import { page } from "$app/state";');
    expect(m).toContain('import { browser } from "$app/environment";');
    expect(m).toContain('category: p.get("category") ?? "",');
    expect(m).toContain('Number.isFinite(Number(p.get("pageNo")))');
    // URL → store via reactive `page.url`; store → URL via `goto(...replaceState)`.
    expect(m).toContain("Object.assign(filt, decodeFrom(page.url.searchParams));");
    expect(m).toContain("replaceState: true,");
    // no raw window.history / popstate residue.
    expect(m).not.toContain("window.history.replaceState");
    expect(m).not.toContain("popstate");
  });
});

// ---------------------------------------------------------------------------
// F2-FFE-1 — declared store defaults.  `storeFieldInit` took only the field's
// TYPE on react/vue/svelte, so every non-zero `= init` was silently replaced by
// the type zero (`mode: string = "dark"` booted as `""`, `pageSize: int = 25`
// as `0`); angular honoured it on construction and then reset it in the `url`
// tier's replayed `queryParamMap` decode.  Page `state {}` initializers were
// honoured all along, so the divergence read as a runtime data bug.  Every
// shipped example declares zero-equal defaults, which is why no fixture saw it.
// ---------------------------------------------------------------------------

const DEFAULTED = (life: string) => `
    store Prefs ${life} {
      state { mode: string = "dark"  pageSize: int = 25  compact: bool = true }
    }
    page P { route: "/p" body: Heading { Prefs.mode, level: 1 } }`;

describe("Svelte store — declared state defaults", () => {
  it("memory: the declared literals are the initial state, not the type zeros", async () => {
    const mod = (await svelteFiles(DEFAULTED("persist: memory"))).get(
      "web/src/lib/stores/prefs.svelte.ts",
    )!;
    expect(mod).toContain('mode: "dark"');
    expect(mod).toContain("pageSize: 25");
    expect(mod).toContain("compact: true");
  });

  it("persist: local seeds the same declared literals", async () => {
    const mod = (await svelteFiles(DEFAULTED("persist: local"))).get(
      "web/src/lib/stores/prefs.svelte.ts",
    )!;
    expect(mod).toContain('mode: "dark"');
    expect(mod).toContain("pageSize: 25");
  });

  it("persist: url defaults an absent param to the declared literal, and drops it when equal", async () => {
    const mod = (await svelteFiles(DEFAULTED("persist: url"))).get(
      "web/src/lib/stores/prefs.svelte.ts",
    )!;
    expect(mod).toContain('p.get("mode") ?? "dark"');
    expect(mod).toContain(": 25");
    // A `= true` bool must not decode to `false` on an absent param.
    expect(mod).toContain('p.has("compact") ? p.get("compact") === "true" : true');
    // …and the encoder drops the param when it equals the declared default,
    // so absent and default keep meaning the same thing.
    expect(mod).toContain('s.mode !== "dark"');
  });
});
