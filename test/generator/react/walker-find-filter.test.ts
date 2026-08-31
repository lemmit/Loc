// Find-filter list UI (T3.14, hook-only v1) + `match` in body position.
//
// A repository `find` whose params are all plain strings and whose
// return is an unwrapped list gives the scaffolded list page a filter
// bar: one bound text input per param, and a `match`-driven switch —
// when every input of a find is non-empty the list renders that find's
// results, else `all`.  The find hook hoists with the OBJECT-shaped
// query arg its emitted signature takes (`use<Find><Agg>(query)`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SCAFFOLD_SRC = `
  system S {
    subdomain Sub { context Sales {
      aggregate Order { status: string  customerId: string }
      repository Orders for Order {
        find byStatus(status: string): Order[] where this.status == status
      }
    } }
    api SalesApi from Sub
    ui WebApp with scaffold(subdomains: [Sub]) {
      api Sub: SalesApi
    }
    storage loomDb { type: postgres }
    resource salesState { for: Sales, kind: state, use: loomDb }
    deployable api { platform: node, contexts: [Sales], dataSources: [salesState], serves: SalesApi, port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp { Sub: api }, port: 3001 }
  }
`;

describe("find-filter list UI — scaffolded list pages", () => {
  it("synthesises filter state + a bound input + the match-driven query switch", async () => {
    const files = await generateSystemFiles(SCAFFOLD_SRC);
    const list = files.get("web/src/pages/orders/list.tsx")!;
    // State per find param, named <find><Param>.
    expect(list).toContain('const [byStatusStatus, setByStatusStatus] = useState<string>("");');
    // Bound filter input with a stable testid.
    expect(list).toContain('data-testid="orders-filter-by_status_status"');
    expect(list).toContain("value={byStatusStatus}");
    // The find hook hoists with the object-shaped query arg.
    expect(list).toContain("const orderByStatus = useByStatusOrder({ status: byStatusStatus });");
    // match → chained ternary; strict equality under Biome's rules.
    expect(list).toContain('((byStatusStatus !== "")) ? (');
    // Both branches render their own QueryView lifecycles.
    expect(list).toContain("orderByStatus.data");
    expect(list).toContain("orderAll.data");
  });

  it("a list page without eligible finds keeps the unfiltered shape", async () => {
    const files = await generateSystemFiles(
      SCAFFOLD_SRC.replace(/find byStatus\(status: string\): Order\[\] where [^\n]*\n/, ""),
    );
    const list = files.get("web/src/pages/orders/list.tsx")!;
    // The list always carries client-side sort state now (M-T1.1) — so `useState`
    // is present; what a filterless list lacks is the find-filter wiring.
    expect(list).toContain("const [sortKey, setSortKey] = useState");
    expect(list).not.toContain("orderByStatus");
    expect(list).not.toContain("filter");
    expect(list).toContain(
      "const orderAll = useAllOrders({ page: pageNum, pageSize: 10, sort: sortKey, dir: sortDir });",
    );
  });

  // M-T1.15: an `int` / `long` / `X id` / `guid` / `datetime` / `bool` param
  // used to be dropped from the bar SILENTLY — declared, emitted as a backend
  // route, no input, no diagnostic.  Each now renders with its state type and
  // the generated query-param type AGREEING (number → `NumberField`; id, guid
  // and datetime → the text box the string case gets, since all three are
  // `z.string()` on the request wire; bool → a three-state select).  A `decimal`
  // param and a PAGED find still decline.
  it("offers int, `X id`, guid, datetime and bool filter params, and still declines decimal and a paged find", async () => {
    const files = await generateSystemFiles(`
      system S {
        subdomain Sub { context Sales {
          aggregate Customer { name: string  derived display: string = name }
          aggregate Order {
            total: int
            placedAt: datetime
            corr: guid
            active: bool
            rate: decimal
            customer: Customer id
          }
          repository Customers for Customer { }
          repository Orders for Order {
            find expensive(min: int): Order[] where this.total > min
            find forCustomer(c: Customer id): Order[] where this.customer == c
            find since(d: datetime): Order[] where this.placedAt >= d
            find byCorr(k: guid): Order[] where this.corr == k
            find byActive(a: bool): Order[] where this.active == a
            find byRate(r: decimal): Order[] where this.rate == r
            find recent(): Order paged
          }
        } }
        api SalesApi from Sub
        ui WebApp with scaffold(subdomains: [Sub]) {
          api Sub: SalesApi
        }
        storage loomDb { type: postgres }
        resource salesState { for: Sales, kind: state, use: loomDb }
        deployable api { platform: node, contexts: [Sales], dataSources: [salesState], serves: SalesApi, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp { Sub: api }, port: 3001 }
      }
    `);
    const list = files.get("web/src/pages/orders/list.tsx")!;
    // int → a NUMBER input bound to a number state; "unset" is 0.
    expect(list).toContain("const [expensiveMin, setExpensiveMin] = useState<number>(0);");
    expect(list).toContain('data-testid="orders-filter-expensive_min"');
    expect(list).toContain("const orderExpensive = useExpensiveOrder({ min: expensiveMin });");
    expect(list).toContain("((expensiveMin !== 0)) ? (");
    // `X id` → the string box, since an id's wire form IS a string.
    expect(list).toContain('const [forCustomerC, setForCustomerC] = useState<string>("");');
    expect(list).toContain("const orderForCustomer = useForCustomerOrder({ c: forCustomerC });");
    expect(list).toContain('((forCustomerC !== "")) ? (');
    // `guid` and `datetime` → the same string box: both are `z.string()` on the
    // request wire and `string` in the state emitter, so the call type-checks.
    expect(list).toContain('const [sinceD, setSinceD] = useState<string>("");');
    expect(list).toContain("const orderSince = useSinceOrder({ d: sinceD });");
    expect(list).toContain('const [byCorrK, setByCorrK] = useState<string>("");');
    expect(list).toContain("const orderByCorr = useByCorrOrder({ k: byCorrK });");
    // `bool` → a three-state STRING select, not a Toggle: a Toggle's zero value
    // is `false`, which would make "filter for false" and "no filter" the same
    // page state.  Unset is `""`, and the comparison is the find argument.
    expect(list).toContain('const [byActiveA, setByActiveA] = useState<string>("");');
    expect(list).toContain('data={ ["true", "false"] }');
    expect(list).toContain('const orderByActive = useByActiveOrder({ a: (byActiveA === "true") });');
    expect(list).toContain('((byActiveA !== "")) ? (');
    // A `decimal` param has no type-checking zero sentinel (Feliz would see
    // `decimal <> int`), and a PAGED find is not a filter arm at all — both
    // still decline.
    expect(list).not.toContain("useByRateOrder");
    expect(list).not.toContain("useRecentOrder");
    expect(list).toContain(
      "const orderAll = useAllOrders({ page: pageNum, pageSize: 10, sort: sortKey, dir: sortDir });",
    );
  });
});

describe("match expression in body position", () => {
  it("renders as a brace-wrapped chained ternary walking each arm as JSX", async () => {
    const files = await generateSystemFiles(`
      system S {
        subdomain Sub { context C { } }
        ui W {
          page Home {
            route: "/"
            state { tab: string = "a" }
            body: Stack {
              match {
                tab == "a" => Heading { "Alpha" }
                tab == "b" => Heading { "Beta" }
                else => Text { "neither" }
              }
            }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: W, port: 3001 }
      }
    `);
    const home = files.get("web/src/pages/home.tsx")!;
    expect(home).toContain('((tab === "a")) ? (');
    expect(home).toContain('((tab === "b")) ? (');
    expect(home).toContain(', "Alpha")}</');
    expect(home).toContain(', "Beta")}</');
    expect(home).toContain(', "neither")}</');
  });
});
