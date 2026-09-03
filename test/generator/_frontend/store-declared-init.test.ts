// A `store`'s DECLARED field initializer must survive to the generated module,
// on every JS-family frontend and every `persist:` lifetime.
//
// It did not.  React / Vue / Svelte each carried a `storeFieldInit(type)` whose
// doc comment claimed to honour "its declared `= init`" while its parameter
// list made that impossible — it never saw the field, only the type — so
//
//     store Mem { state { label: string = "hello"  n: int = 7  flag: bool = true } }
//
// emitted `label: "", n: 0, flag: false`.  Silent: the wrong value is a
// perfectly well-typed value, so no tsc gate could see it.  Angular honoured a
// declared init on the memory tier through a local LITERAL-only shim, but its
// `url` tier then OVERWROTE the correct `signal<string>("hello")` on the first
// queryParamMap emission, because the decoder defaulted to the type zero
// (its own comment: "byte-for-byte with React's `decodeFieldFromParam`" — i.e.
// byte-for-byte with the bug).  Feliz and Flutter have always rendered the
// initializer, so the JS family was the odd one out.
//
// All four now ride the shared `storeFieldInitJs`, which renders the init
// through each frontend's own expression emitter — so a NON-literal init
// (`n: int = 1 + 1`) reaches the output too, instead of falling back to `0`.
//
// The `url` tier additionally has to DEFAULT to that init on both halves:
// decode restores it for an absent param, and encode drops the param exactly
// when the value equals it (comparing to a hardcoded `""` would delete the
// param for a state that decodes back to something else).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const STORES = `
    store Mem {
      state {
        label: string = "hello"
        n: int = 7
        flag: bool = true
      }
      action bump() { n := n }
    }
    store Url persist: url {
      state {
        label: string = "hello"
        n: int = 7
      }
      action bump() { n := n }
    }
    store Expr {
      state {
        n: int = 1 + 1
      }
      action bump() { n := n }
    }`;

async function storeModules(platform: string): Promise<Map<string, string>> {
  const files = await generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui Web {
        ${STORES}
        page P {
          route: "/p"
          body: Stack { Heading { Mem.label, level: 1 }, Heading { Url.label, level: 1 }, Heading { Expr.n, level: 1 } }
        }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: ${platform}, targets: api, ui: Web, port: 3001 }
    }
  `);
  // Key each emitted store module by its lowercase store name, so the
  // per-frontend path conventions (`stores/mem.ts`, `lib/stores/mem.svelte.ts`,
  // `app/stores/mem.store.ts`) don't leak into the assertions.
  const out = new Map<string, string>();
  for (const [path, body] of files) {
    const m = path.match(/stores\/(mem|url|expr)(\.store)?\.(svelte\.)?ts$/);
    if (m) out.set(m[1]!, body);
  }
  return out;
}

describe("store field `= init` reaches the generated module", () => {
  it("react: memory tier keeps every declared init", async () => {
    const m = await storeModules("react");
    expect(m.get("mem")).toContain(`label: "hello",`);
    expect(m.get("mem")).toContain("n: 7,");
    expect(m.get("mem")).toContain("flag: true,");
  });

  it("vue: memory tier keeps every declared init", async () => {
    const m = await storeModules("vue");
    expect(m.get("mem")).toContain(`{ label: "hello", n: 7, flag: true }`);
  });

  it("svelte: memory tier keeps every declared init", async () => {
    const m = await storeModules("svelte");
    expect(m.get("mem")).toContain(`label: "hello",`);
    expect(m.get("mem")).toContain("n: 7,");
    expect(m.get("mem")).toContain("flag: true,");
  });

  it("angular: memory tier keeps every declared init", async () => {
    const m = await storeModules("angular");
    expect(m.get("mem")).toContain(`readonly label = signal<string>("hello");`);
    expect(m.get("mem")).toContain("readonly n = signal<number>(7);");
    expect(m.get("mem")).toContain("readonly flag = signal<boolean>(true);");
  });

  // The `url` tier: an ABSENT query param must restore the declared init, not
  // the type zero — otherwise the same declaration means two different things
  // depending on the lifetime, and on Angular the decoder actively overwrites
  // the correct signal init a few lines after it is declared.
  for (const platform of ["react", "vue", "svelte", "angular"]) {
    it(`${platform}: url tier defaults an absent param to the declared init`, async () => {
      const m = await storeModules(platform);
      const url = m.get("url")!;
      expect(url).toBeTruthy();
      expect(url).toContain(`p.get("label") ?? "hello"`);
      expect(url).toContain(`? Number(p.get("n")) : 7`);
      // The type zero must NOT appear as the fallback any more.
      expect(url).not.toContain(`p.get("label") ?? ""`);
      expect(url).not.toContain(`? Number(p.get("n")) : 0`);
      // …and the write-back drops the param at the DECLARED default, so the
      // round-trip is lossless.
      expect(url).toContain(`!== "hello"`);
    });
  }

  // A non-literal initializer used to fall back to the type zero on all four
  // (silently — Angular's shim only rendered literals; the other three
  // rendered nothing at all).  It now lowers through the real expression
  // emitter, as it always has on Feliz and Flutter.
  for (const platform of ["react", "vue", "svelte", "angular"]) {
    it(`${platform}: a non-literal init lowers as an expression, not the type zero`, async () => {
      const m = await storeModules(platform);
      const expr = m.get("expr")!;
      expect(expr).toBeTruthy();
      expect(expr).toContain("(1 + 1)");
    });
  }
});
