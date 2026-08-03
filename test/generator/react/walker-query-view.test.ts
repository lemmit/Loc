// QueryView macro for the canonical 4-arm query state
//   loading / error / empty / data
//
// Macro that captures the rendering pattern the scaffold List page
// emits inline (`{ q.isLoading && (...) }` / `{ q.isError && ... }`
// / `{ q.data && q.data.length === 0 && ... }` / `{ q.data &&
// q.data.length > 0 && ... }`) into one declarative primitive.
//
// What this test pins:
//   1. The `of:` query expression flows through the walker's hook
//      detection so `Sales.Order.all` lifts to a `useAllOrders()`
//      hook decl + import and the four branches reference the
//      hook variable.
//   2. Each branch (loading / error / empty / data) walks
//      independently so its body composes from any walker stdlib
//      primitive.
//   3. The `data:` branch supports a lambda binding (`rows => …`)
//      that rebinds the lambda param to the unwrapped query data
//      inside the branch.
//   4. Plain (non-lambda) `data:` bodies render unchanged.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

const ordersListBody = (queryViewBody: string) => `
  system S {
    api SalesApi from Sales
    subdomain Sales {
      context C {
        aggregate Order {
          customerId: string
          derived display: string = customerId
          status:     string
        }
        repository Orders for Order { }
      }
    }
    ui WebApp {
      api Sales: SalesApi
      page OrdersList { route: "/orders"  body: ${queryViewBody} }
    }
    deployable api { platform: node, contexts: [C], serves: SalesApi, port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
  }
`;

describe("QueryView macro", () => {
  it("auto-injects the hook for `of:` and references it in all four branches", async () => {
    const files = await buildAndGenerate(
      ordersListBody(`QueryView {
        of:      Sales.Order.all,
        loading: Skeleton { count: 5 },
        error:   Alert { "Couldn't load" },
        empty:   Empty { "No orders yet." },
        data:    rows => Table { rows: rows, Column { "ID", o => o.id } }
      }`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/import \{ useAllOrders \} from "\.\.\/api\/order"/);
    // `.all` is paged, and a bare `Table` over a paged read is auto-upgraded to
    // server paging — so the hook carries the page/sort bag the pager drives.
    expect(tsx).toMatch(
      /const orderAll = useAllOrders\(\{ page: pageNum, pageSize: \d+, sort: sortKey, dir: sortDir \}\)/,
    );
    expect(tsx).toMatch(/\{ orderAll\.isLoading && \(/);
    expect(tsx).toMatch(/\{ orderAll\.isError && \(/);
    expect(tsx).toMatch(/\{ orderAll\.data && orderAll\.data\.items\.length === 0 && \(/);
    expect(tsx).toMatch(/\{ orderAll\.data && orderAll\.data\.items\.length > 0 && \(/);
  });

  it("loading branch renders the supplied loading body (Skeleton)", async () => {
    const files = await buildAndGenerate(
      ordersListBody(`QueryView {
        of:      Sales.Order.all,
        loading: Skeleton { count: 5 },
        error:   Alert { "err" },
        empty:   Empty { "none" },
        data:    rows => Empty { "placeholder" }
      }`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    // The loading branch ends up wrapped in the conditional guard;
    // assert the Skeleton stack is present inside it.
    expect(tsx).toMatch(/orderAll\.isLoading && \([\s\S]*?Array\.from\(\{ length: 5 \}\)/);
  });

  it("data: lambda rebinds its param to the query's `.data` inside the branch", async () => {
    const files = await buildAndGenerate(
      ordersListBody(`QueryView {
        of:      Sales.Order.all,
        loading: Skeleton {},
        error:   Alert { "err" },
        empty:   Empty { "none" },
        data:    rows => Table {
          rows: rows,
          Column { "ID",     o => o.id },
          Column { "Status", o => Badge { o.status } }
        }
      }`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    // `rows` in `Table { rows: rows, ... }` resolves to `orderAll.data`.
    expect(tsx).toMatch(
      /orderAll\.data && orderAll\.data\.items\.length > 0 && \([\s\S]*orderAll\.data\.items\.map\(\(row\) => \(/,
    );
    // Inner Column accessors still work — `o.status` resolves to
    // `row.status` (the lambda-param scope).
    expect(tsx).toMatch(/<Table\.Td>\{row\.id\}<\/Table\.Td>/);
    expect(tsx).toMatch(/<Table\.Td><Badge[^>]*>\{row\.status\}<\/Badge><\/Table\.Td>/);
  });

  it("emits the four branches inside a JSX fragment so they can sit anywhere a single child is expected", async () => {
    const files = await buildAndGenerate(
      ordersListBody(`Stack {
        Heading { "Orders" },
        QueryView {
          of:      Sales.Order.all,
          loading: Skeleton {},
          error:   Alert { "err" },
          empty:   Empty { "none" },
          data:    rows => Empty { "placeholder" }
        }
      }`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    // Fragment opens immediately after Heading.
    expect(tsx).toMatch(/<Title order=\{2\}>\{t\("[^"]*", "Orders"\)\}<\/Title>[\s\S]*<>/);
    // Fragment closes before Stack closes.
    expect(tsx).toMatch(/<\/>[\s\S]*<\/Stack>/);
  });

  // ---- Paged-envelope page metadata (M-T1.3 Defect B) --------------------
  // `.all` is `paged<T>` by default (M-T2.6), so its `.data` is the envelope
  // `{items, page, pageSize, total, totalPages}`.  A hand-written QueryView is
  // AUTO-paged: the `data:` binding unwraps to `.items` so the body's
  // `Table { rows: rows }` keeps iterating records — which used to put every
  // metadata member one level too deep (`.data.items.total`: `undefined` at
  // runtime, TS2339 at build).  The rows and the metadata come off different
  // levels of the same envelope, and both have to be right at once.
  it("auto-paged: `rows.total` resolves against the ENVELOPE while the rows stay the array", async () => {
    const files = await buildAndGenerate(
      ordersListBody(`QueryView {
        of:      Sales.Order.all,
        loading: Skeleton {},
        error:   Alert { "err" },
        empty:   Empty { "none" },
        data:    rows => Stack {
          Text { rows.total },
          Table { rows: rows, Column { "ID", o => o.id } }
        }
      }`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    expect(tsx).toContain("{orderAll.data.total}");
    expect(tsx).not.toContain("orderAll.data.items.total");
    // The unwrap the metadata read is threading around is still in force.
    expect(tsx).toMatch(/orderAll\.data\.items\.map\(\(row\) => \(/);
  });

  // `rows.page` is absent on purpose: `page` is a reserved keyword, so the
  // member access doesn't PARSE (the same reason the scaffold's page-state
  // field is named `pageNum`).  That member of the envelope is unreachable by
  // spelling, which is a grammar limit and not this walker's to fix.
  it("auto-paged: every spellable metadata member re-roots, `items` does NOT", async () => {
    const files = await buildAndGenerate(
      ordersListBody(`QueryView {
        of:      Sales.Order.all,
        loading: Skeleton {},
        error:   Alert { "err" },
        empty:   Empty { "none" },
        data:    rows => Stack {
          Text { rows.pageSize }, Text { rows.totalPages },
          Text { rows.items }
        }
      }`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    expect(tsx).toContain("{orderAll.data.pageSize}");
    expect(tsx).toContain("{orderAll.data.totalPages}");
    // `items` is deliberately left alone: on an unwrapped binding `rows` IS the
    // array, so re-rooting it would silently repair the author's own mistake
    // into something that looks right and reads a different value.
    expect(tsx).toContain("{orderAll.data.items.items}");
  });

  it("explicit `paged: true`: the binding is already the envelope, so metadata reads pass straight through", async () => {
    const files = await buildAndGenerate(
      ordersListBody(`QueryView {
        of:      Sales.Order.all,
        paged:   true,
        loading: Skeleton {},
        error:   Alert { "err" },
        empty:   Empty { "none" },
        data:    rows => Stack {
          Text { rows.total },
          Table { rows: rows.items, Column { "ID", o => o.id } }
        }
      }`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    expect(tsx).toContain("{orderAll.data.total}");
    expect(tsx).toMatch(/orderAll\.data\.items\.map\(\(row\) => \(/);
  });

  // The binding map is keyed by the lambda's param NAME, so a nested QueryView
  // reusing `rows` has to shadow the outer entry.  Inheriting it would resolve
  // the inner `rows.total` against the OUTER query's envelope — a real number
  // from the wrong read, which no compiler catches.
  it("a nested QueryView reusing the param name shadows the outer paged binding", async () => {
    const files = await buildAndGenerate(
      ordersListBody(`QueryView {
        of:      Sales.Order.all,
        loading: Skeleton {},
        error:   Alert { "err" },
        empty:   Empty { "none" },
        data:    rows => Stack {
          Text { rows.total },
          QueryView {
            of:      Sales.Order.byId(id),
            single:  true,
            loading: Skeleton {},
            error:   Alert { "err" },
            empty:   Empty { "none" },
            data:    rows => Text { rows.status }
          }
        }
      }`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    // Outer: the metadata read still re-roots onto the list query's envelope.
    expect(tsx).toContain("{orderAll.data.total}");
    // Inner: `rows` is the byId record, untouched by the outer binding.
    expect(tsx).toContain("{orderById.data.status}");
    expect(tsx).not.toContain("orderById.data.total");
  });

  // `single:` restated a fact the IR already knows — the read yields one
  // record — so a byId query written WITHOUT the flag took the COLLECTION
  // arms: `.length` of one record is `undefined`, so neither `=== 0` nor
  // `> 0` fires and the page renders blank (on HEEx, `Enum.empty?/1` of a
  // struct raises).  Derived now, with the flag as an opt-in on top.
  it("a byId query takes single-record semantics without a `single:` flag", async () => {
    const files = await buildAndGenerate(
      ordersListBody(`QueryView {
        of:      Sales.Order.byId(id),
        loading: Skeleton {},
        error:   Alert { "err" },
        empty:   Empty { "none" },
        data:    rec => Text { rec.status }
      }`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    // Presence/absence of the record, never `.length` of it — `.length` of one
    // record is `undefined`, so both collection guards would be false and the
    // page would render blank.
    expect(tsx).toContain("!orderById.data &&");
    expect(tsx).toContain("{ orderById.data && (");
    expect(tsx).not.toContain("orderById.data.length");
    expect(tsx).toContain("{orderById.data.status}");
  });

  it("missing 'of:' surfaces a visible TSX comment, no crash", async () => {
    const files = await buildAndGenerate(
      ordersListBody(`QueryView {
        loading: Empty { "…" },
        error:   Empty { "…" },
        empty:   Empty { "…" },
        data:    rows => Empty { "…" }
      }`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    expect(tsx).toMatch(/\{\/\* QueryView: missing 'of:' query expression \*\/\}/);
  });
});
