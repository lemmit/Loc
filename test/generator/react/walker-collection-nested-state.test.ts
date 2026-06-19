// Collection + nested page-state mutation across the JS frontends (DEBT-10).
//
//   tags += v   → append   (immutable: [...tags, v])
//   tags -= v   → remove    (tags.filter(x => x !== v))
//   addr.zip := v → nested write — React spreads + setter (immutable);
//                   Vue refs / Svelte $state mutate in place.
//
// `+=`/`-=` are overloaded: arithmetic for a scalar target, append/remove
// for a collection target.  The signal rides the IR (`add`/`remove`
// `collection` flag, set from the lowered target type); the walker reads
// it.  The nested-write idiom is a per-target seam (`renderNestedStateWrite`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const sys = (plat: string, state: string, handler: string): string => `
  system S {
    subdomain M { context C { valueobject Address { city: string  zip: string } } }
    ui WebApp {
      page Form {
        route: "/form"
        state { ${state} }
        body: Stack { Button { "Go", onClick: e => { ${handler} } } }
      }
    }
    deployable api { platform: node, contexts: [C], port: 3000 }
    deployable web { platform: ${plat}, targets: api, ui: WebApp, port: 3001 }
  }
`;

const SUFFIX: Record<string, string> = {
  static: "pages/form.tsx",
  vue: "pages/form.vue",
  // Svelte routes land under a `(app)` group, so match by suffix.
  svelte: "form/+page.svelte",
};

async function page(plat: string, state: string, handler: string): Promise<string> {
  const files = await generateSystemFiles(sys(plat, state, handler));
  for (const [p, c] of files) {
    if (p.endsWith(SUFFIX[plat]!)) return c;
  }
  throw new Error(`MISSING *${SUFFIX[plat]}; keys=${[...files.keys()].join(",")}`);
}

describe("collection state mutation — append / remove (DEBT-10)", () => {
  it("React: += appends immutably, -= removes by value", async () => {
    expect(await page("static", `tags: string[] = []`, `tags += "x"`)).toContain(
      'setTags([...tags, "x"]);',
    );
    expect(await page("static", `tags: string[] = []`, `tags -= "x"`)).toContain(
      'setTags(tags.filter((__v) => __v !== "x"));',
    );
  });

  it("Vue: += / -= reassign the ref with the spread / filtered list", async () => {
    expect(await page("vue", `tags: string[] = []`, `tags += "x"`)).toContain(
      'tags = [...tags, "x"];',
    );
    expect(await page("vue", `tags: string[] = []`, `tags -= "x"`)).toContain(
      'tags = tags.filter((__v) => __v !== "x");',
    );
  });

  it("Svelte: += / -= reassign $state with the spread / filtered list", async () => {
    expect(await page("svelte", `tags: string[] = []`, `tags += "x"`)).toContain(
      'tags = [...tags, "x"];',
    );
    expect(await page("svelte", `tags: string[] = []`, `tags -= "x"`)).toContain(
      'tags = tags.filter((__v) => __v !== "x");',
    );
  });

  it("scalar += stays arithmetic on every frontend (not append)", async () => {
    expect(await page("static", `n: int = 0`, `n += 1`)).toContain("setN(n + 1);");
    expect(await page("vue", `n: int = 0`, `n += 1`)).toContain("n = n + 1;");
    expect(await page("svelte", `n: int = 0`, `n += 1`)).toContain("n = n + 1;");
  });
});

describe("nested state mutation — immutable spread vs in-place (DEBT-10)", () => {
  const ADDR = `addr: Address = Address { city: "", zip: "" }`;

  it("React spreads the state root + setter (immutable)", async () => {
    expect(await page("static", ADDR, `addr.zip := "90210"`)).toContain(
      'setAddr({ ...addr, zip: "90210" });',
    );
  });

  it("Vue mutates the ref in place (SFC compiler unwraps the root)", async () => {
    const p = await page("vue", ADDR, `addr.zip := "90210"`);
    expect(p).toContain('addr.zip = "90210";');
    expect(p).not.toContain("...addr");
  });

  it("Svelte mutates $state in place (deeply reactive)", async () => {
    const p = await page("svelte", ADDR, `addr.zip := "90210"`);
    expect(p).toContain('addr.zip = "90210";');
    expect(p).not.toContain("...addr");
  });
});
