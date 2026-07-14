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
    expect(tsx).toMatch(/const orderAll = useAllOrders\(\)/);
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
    expect(tsx).toMatch(/<Title order=\{2\}>Orders<\/Title>[\s\S]*<>/);
    // Fragment closes before Stack closes.
    expect(tsx).toMatch(/<\/>[\s\S]*<\/Stack>/);
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
