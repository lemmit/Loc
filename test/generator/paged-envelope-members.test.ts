// The paged envelope's page metadata is reachable from the DSL on EVERY
// frontend (M-T1.3 Defect B).
//
// `.all` is `paged<T>` by default (M-T2.6), so its wire response is
// `{items, page, pageSize, total, totalPages}`.  A page body reads the rows and
// the metadata off the one `QueryView` `data:` binding — but the six frontends
// hold that envelope in six different shapes, and three of them do not hold it
// at all until something is decoded into it:
//
//   - the four JSX targets keep the whole object → a plain member access;
//   - feliz SPLITS it (rows into `Remote<'T list>`, metadata into a sibling
//     `PageMeta` record) because the list field is also read by
//     `View.idOptions` and the realtime refetch;
//   - flutter's Riverpod provider yields `Paged<T>` instead of `List<T>`.
//
// This suite is the cross-frontend pin: the same `.ddd` on each frontend, and
// each one resolves the metadata to its own correct shape.  It is deliberately
// ONE file rather than a case per frontend directory — the property under test
// is that they AGREE, and a per-frontend copy is exactly how they drift.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

/** `platform:` for a ui's host.  The four static-bundle frameworks share the
 *  `static` host; feliz and flutter each host only their own framework. */
const hostFor = (framework: string): string =>
  framework === "feliz" || framework === "flutter" ? framework : "static";

/** A list page reading `rows.total` beside a `Table` over the same binding.
 *  `explicitPaged` picks the two modes apart: with the flag the binding is the
 *  envelope (the scaffold's shape, `rows: rows.items`); without it the binding
 *  is auto-unwrapped to the row array (the hand-written shape, `rows: rows`). */
const sys = (framework: string, explicitPaged: boolean): string => `
system S {
  subdomain Sales {
    context Orders {
      aggregate Product { name: string }
      repository Products for Product { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  ui WebApp {
    framework: ${framework}
    api Sales: SalesApi
    page ProductList {
      route: "/products"
      body: QueryView {
        of: Sales.Product.all,${explicitPaged ? "\n        paged: true," : ""}
        data: rows => Stack {
          Text { rows.page }, Text { rows.pageSize },
          Text { rows.total }, Text { rows.totalPages },
          Table { rows: rows${explicitPaged ? ".items" : ""}, Column { "Name", o => Text { o.name } } }
        }
      }
    }
  }
  deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
  deployable web { platform: ${hostFor(framework)}, targets: api, port: 3001, ui: WebApp { Sales: api } }
}
`;

/** The emitted page source for `framework`.  Located by CONTENT rather than by
 *  path: the six frontends disagree about where a page lands (`pages/x.tsx`, a
 *  SvelteKit `routes/(app)/products/+page.svelte`, one `App.fs` for the whole
 *  Feliz ui), and a path guess that silently misses returns "" — which passes
 *  a `not.toContain` assertion for the wrong reason. */
async function pageSource(framework: string, explicitPaged: boolean): Promise<string> {
  const files = await generateSystemFiles(sys(framework, explicitPaged));
  const hit = [...files.entries()].find(
    ([p, src]) =>
      !p.includes("/e2e/") &&
      // A page file: a `pages/` dir (react/vue/angular/flutter), a SvelteKit
      // `+page.svelte`, or Feliz's single `App.fs` for the whole ui.
      (/\/pages?\//.test(p) || /\+page\./.test(p) || p.endsWith("App.fs")) &&
      /\.(tsx|vue|svelte|dart|fs|ts)$/.test(p) &&
      /productAll|AllProducts/.test(src),
  );
  if (!hit) throw new Error(`no ${framework} page source found among: ${[...files.keys()]}`);
  return hit[1];
}

describe("paged envelope — page metadata off the QueryView binding", () => {
  // What each frontend must emit for `rows.total`, in BOTH paging modes.  The
  // rows expression differs per mode; `total` must not.
  const expected: Record<string, (m: string) => string> = {
    react: (m) => `productAll.data.${m}`,
    vue: (m) => `productAll.data.${m}`,
    svelte: (m) => `productAll.data.${m}`,
    angular: (m) => `productAll.data()!.${m}`,
    feliz: (m) => `model.AllProductsPageMeta.${m[0]!.toUpperCase()}${m.slice(1)}`,
    flutter: (m) => `productAll.${m}`,
  };

  // ALL FOUR page-metadata members, not just `total`.  `page` is here because
  // it was the last one with no spelling at all — a reserved keyword, so
  // `rows.page` didn't parse until it was made soft in `MemberName`.
  const MEMBERS = ["page", "pageSize", "total", "totalPages"];

  for (const [framework, access] of Object.entries(expected)) {
    for (const explicitPaged of [true, false]) {
      it(`${framework} resolves every metadata member${explicitPaged ? "" : " (auto-paged)"}`, async () => {
        const src = await pageSource(framework, explicitPaged);
        for (const m of MEMBERS) expect(src, m).toContain(access(m));
      });
    }
  }

  // The regression that motivated all of it: under auto-paging the binding is
  // the row ARRAY, so an un-re-rooted metadata read lands one level too deep —
  // `undefined` at runtime, a type error at build, on every JSX target.
  for (const framework of ["react", "vue", "svelte"]) {
    it(`${framework} never reads metadata off the row array`, async () => {
      const src = await pageSource(framework, false);
      expect(src).not.toContain("data.items.total");
    });
  }

  it("feliz decodes the metadata it resolves against — in BOTH paging modes", async () => {
    for (const explicitPaged of [true, false]) {
      const fs = await pageSource("feliz", explicitPaged);
      // The Model field the view reads, the decoder that fills it, and the
      // update arm that stores it must all exist — the walker resolving
      // `rows.total` to a field the wire never decoded is the exact shape of
      // the derived-vs-declared disagreement this closed.
      expect(fs).toContain("AllProductsPageMeta: PageMeta");
      expect(fs).toContain("Decode.map2 (fun __items __meta -> (__items, __meta))");
      expect(fs).toContain('get.Required.Field "total" Decode.int');
      expect(fs).toContain("AllProductsPageMeta = meta");
    }
  });

  it("flutter's carrier decodes the metadata, not just the rows + page count", async () => {
    const files = await generateSystemFiles(sys("flutter", false));
    const reads = files.get("web/lib/reads.dart") ?? "";
    // `LoomPage<T>` (the server-paged carrier the `.family` provider yields)
    // shipped carrying `items` + `totalPages` — enough for the pager, but a
    // member it doesn't decode is a member the DSL can't reach.
    expect(reads).toContain("class LoomPage<T>");
    expect(reads).toContain("FutureProvider.family<LoomPage<Product>, LoomQuery>");
    for (const f of ["final int page;", "final int pageSize;", "final int total;"]) {
      expect(reads, f).toContain(f);
    }
    expect(reads).toContain("total: (map['total'] as num?)?.toInt() ?? items.length");
    // The emptiness question is about the rows; the carrier is never empty.
    const page = await pageSource("flutter", false);
    expect(page).toContain("productAll.items.isEmpty");
  });

  // A ui with no paged read must not pay for any of this.
  it("a non-paged read keeps flutter's plain List<T> provider", async () => {
    const files = await generateSystemFiles(`
system S {
  subdomain Sales {
    context Orders {
      aggregate Product { name: string }
      repository Products for Product {
        find named(name: string): Product[] { where name == name }
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  ui WebApp {
    framework: flutter
    api Sales: SalesApi
    page ProductList {
      route: "/products"
      body: QueryView {
        of: Sales.Product.named("x"),
        data: rows => Table { rows: rows, Column { "Name", o => Text { o.name } } }
      }
    }
  }
  deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
  deployable web { platform: flutter, targets: api, port: 3001, ui: WebApp { Sales: api } }
}
`);
    const reads = files.get("web/lib/reads.dart") ?? "";
    expect(reads).not.toContain("class LoomPage<T>");
  });
});
