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
    deployable api { platform: node, contexts: [Sales], serves: SalesApi, port: 3000 }
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
    expect(list).toContain("const orderAll = useAllOrders();");
  });

  it("a paged or non-string-param find is not offered as a filter (v1 eligibility)", async () => {
    const files = await generateSystemFiles(`
      system S {
        subdomain Sub { context Sales {
          aggregate Order { total: int }
          repository Orders for Order {
            find expensive(min: int): Order[] where this.total > min
            find recent(): Order paged
          }
        } }
        api SalesApi from Sub
        ui WebApp with scaffold(subdomains: [Sub]) {
          api Sub: SalesApi
        }
        deployable api { platform: node, contexts: [Sales], serves: SalesApi, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp { Sub: api }, port: 3001 }
      }
    `);
    const list = files.get("web/src/pages/orders/list.tsx")!;
    expect(list).not.toContain("useExpensiveOrder");
    expect(list).not.toContain("useRecentOrder");
    expect(list).toContain("const orderAll = useAllOrders();");
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
    expect(home).toContain(">Alpha</");
    expect(home).toContain(">Beta</");
    expect(home).toContain(">neither</");
  });
});
