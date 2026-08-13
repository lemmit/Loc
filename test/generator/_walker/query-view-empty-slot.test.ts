// An ABSENT `QueryView` slot must render NOTHING — in the host language's own
// spelling of nothing.
//
// The walker handed the pack template the string `"null"` for a missing
// `loading:` / `error:` / `empty:` slot.  That is correct for JSX and ONLY for
// JSX: react's `primitive-query-view` wraps each branch in `{ cond && ( … ) }`,
// a JS EXPRESSION position where `null` renders nothing (and where an empty
// string would not even parse).  Angular, Vue and Svelte put the slot in a
// MARKUP BLOCK (`@if (…) { … }`, `<template v-if>…</template>`, `{#if …}`), so
// the same string rendered as literal TEXT: a slotless QueryView displayed the
// word "null" to the user while the query loaded, when it errored, and when the
// result set was empty.  Nothing failed — it compiles on every target.
//
// Both halves of the fix are pinned here, because they are one decision:
//   • the markup-block targets emit an EMPTY branch (`WalkerTarget.emptyChild`),
//   • and react KEEPS `null` — "fixing" it to `""` is a syntax error.
// Targets that own their no-op spelling elsewhere are pinned too, so a future
// refactor of the seam cannot quietly drop them: Feliz `Html.none`, Flutter
// `SizedBox.shrink()`, and HEEx's own default loading/error/empty chrome.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** One slotless QueryView per read shape (collection + single), because the
 *  pack template branches on `single` and each branch carries its own slots. */
const UI = `
    page OrderList {
      route: "/"
      body: Stack {
        Heading { "Orders" },
        QueryView { of: Sales.Order.all, data: rows => Table { rows: rows } }
      }
    }
    page OrderDetail {
      route: "/orders/:id"
      body: QueryView {
        of: Sales.Order.byId(id),
        single: true,
        data: o => Stack { Heading { "Order" }, Text { o.customerId } }
      }
    }`;

const DOMAIN = `
  api SalesApi from Sales
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        customerId: string
        priority: int
      }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }`;

/** A static-bundle frontend (react / vue / svelte) beside a node backend. */
const spa = (framework: string) => `
system Shop {${DOMAIN}
  ui WebApp {
    framework: ${framework}
    api Sales: SalesApi
${UI}
  }
  deployable api {
    platform: node
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    port: 8080
  }
  deployable web { platform: static targets: api ui: WebApp { Sales: api } port: 3004 }
}`;

/** A frontend whose deployable IS the platform (angular / feliz / flutter). */
const hosted = (platform: string) => `
system Shop {${DOMAIN}
  ui WebApp {
    api Sales: SalesApi
${UI}
  }
  deployable api {
    platform: node
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    port: 8080
  }
  deployable web { platform: ${platform} targets: api ui: WebApp { Sales: api } port: 3004 }
}`;

/** Phoenix SELF-HOSTS the ui, so its deployable owns the contexts and `targets:`
 *  is a validator error on it (see render-degradation.test.ts's `retargetFixture`
 *  for why getting this wrong makes a whole leg assert nothing). */
const selfHosted = `
system Shop {${DOMAIN}
  ui WebApp {
    framework: phoenixLiveView
    api Sales: SalesApi
${UI}
  }
  deployable web {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    ui: WebApp { Sales: web }
    port: 4000
  }
}`;

const CASES = [
  { framework: "react", source: spa("react"), pages: /\/src\/pages\/.*\.tsx$/ },
  { framework: "vue", source: spa("vue"), pages: /\/src\/pages\/.*\.vue$/ },
  { framework: "svelte", source: spa("svelte"), pages: /\+page\.svelte$/ },
  { framework: "angular", source: hosted("angular"), pages: /\/src\/app\/pages\// },
  { framework: "feliz", source: hosted("feliz"), pages: /App\.fs$/ },
  { framework: "flutter", source: hosted("flutter"), pages: /lib\/pages\// },
  { framework: "phoenixLiveView", source: selfHosted, pages: /_live\.ex$/ },
] as const;

async function pagesFor(c: (typeof CASES)[number]): Promise<string[]> {
  const files = await generateSystemFiles(c.source);
  const pages = [...files.entries()].filter(([k]) => c.pages.test(k)).map(([, v]) => v);
  expect(pages.length, `no page files matched for ${c.framework}`).toBeGreaterThan(0);
  return pages;
}

/** A line whose entire content is the bare token `null` — how the defect showed
 *  up in every markup-block target.  (React's `null` sits on its own line too,
 *  which is exactly why the assertion below is per-target rather than global.) */
const BARE_NULL_LINE = /^\s*null\s*$/m;

describe("QueryView with no loading/error/empty slot", () => {
  for (const c of CASES.filter((x) => x.framework !== "react")) {
    it(`${c.framework}: no bare \`null\` token reaches the markup`, async () => {
      for (const page of await pagesFor(c)) {
        expect(
          BARE_NULL_LINE.test(page),
          `${c.framework}: an absent QueryView slot emitted a bare \`null\`, which this ` +
            `target renders as the literal TEXT "null":\n${page}`,
        ).toBe(false);
      }
    }, 120_000);
  }

  it("angular: the branch is present and EMPTY", async () => {
    const pages = await pagesFor(CASES.find((c) => c.framework === "angular")!);
    const detail = pages.find((p) => p.includes("orderById.isLoading()"))!;
    expect(detail).toBeDefined();
    // The `@if` still guards the (now empty) region — the fix is the CONTENT, not
    // the control flow, so a later slot addition keeps landing in the same place.
    expect(detail).toMatch(/@if \(orderById\.isLoading\(\)\) \{\s*\}/);
    expect(detail).not.toContain("null\n");
  });

  it("vue: the branch is present and EMPTY", async () => {
    const pages = await pagesFor(CASES.find((c) => c.framework === "vue")!);
    const detail = pages.find((p) => p.includes("orderById.isLoading"))!;
    expect(detail).toMatch(/<template v-if="orderById\.isLoading">\s*<\/template>/);
  });

  it("svelte: the branch renders nothing WITHOUT tripping `Empty block`", async () => {
    // Svelte warns on a childless `{#if}` branch, and a generator that ships
    // warnings trains everyone to ignore the gate — so the branch carries an
    // empty-string expression tag, which provably renders nothing.  Verified over
    // the emitted project: `svelte-check` reports 0 errors AND 0 warnings.
    const pages = await pagesFor(CASES.find((c) => c.framework === "svelte")!);
    const detail = pages.find((p) => p.includes("orderById.isLoading"))!;
    expect(detail).toMatch(/\{#if orderById\.isLoading\}\s*\{""\}\s*\{:else if/);
  });

  it("react KEEPS `null` — an empty JSX expression would not parse", async () => {
    // `{ orderById.isLoading && ( ) }` is a syntax error, so react's absent slot
    // must stay a JS `null`.  This is the reason the fix is a target seam rather
    // than a change to the shared primitive's string.
    const pages = await pagesFor(CASES.find((c) => c.framework === "react")!);
    const detail = pages.find((p) => p.includes("orderById.isLoading"))!;
    expect(detail).toMatch(/\{ orderById\.isLoading && \(\s*null\s*\) \}/);
  });

  it("feliz spells nothing `Html.none`", async () => {
    const [app] = await pagesFor(CASES.find((c) => c.framework === "feliz")!);
    expect(app).toContain("(Html.none) (Html.none) (Html.none)");
  });

  it("flutter spells nothing `SizedBox.shrink()`", async () => {
    const pages = await pagesFor(CASES.find((c) => c.framework === "flutter")!);
    expect(pages.some((p) => p.includes("const SizedBox.shrink()"))).toBe(true);
  });

  it("HEEx substitutes its own loading / error / empty chrome", async () => {
    // Phoenix does not render "nothing" for an absent slot at all — its engine
    // supplies default chrome.  Pinned so the seam refactor can't silently
    // replace real chrome with an empty branch.
    const pages = await pagesFor(CASES.find((c) => c.framework === "phoenixLiveView")!);
    const list = pages.join("\n");
    expect(list).toContain("Loading...");
    expect(list).toContain("Error loading data.");
    expect(list).toContain("No items.");
  });
});
