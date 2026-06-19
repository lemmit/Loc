import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Find-filter live-refetch — Vue.
//
// A scaffolded list page with an eligible `find` gets a bound filter
// input.  On Vue the query must live-refetch when the input changes, so
// the find hook takes a `MaybeRefOrGetter` (queryKey tracks a
// `computed(toValue(query))`) and the page passes a getter
// `() => ({ ... })` rather than snapshotting `state.value` at setup.
// React (re-render-driven) is unaffected — its hook stays a plain
// object param.
// ---------------------------------------------------------------------------

const SRC = (platform: string) => `
  system S {
    subdomain Sub { context Sales {
      aggregate Order { status: string  customerId: string }
      repository Orders for Order {
        find byStatus(status: string): Order[] where this.status == status
      }
    } }
    api SalesApi from Sub
    ui WebApp with scaffold(subdomains: [Sub]) { api Sub: SalesApi }
    deployable api { platform: node, contexts: [Sales], serves: SalesApi, port: 3000 }
    deployable web { platform: ${platform}, targets: api, ui: WebApp { Sub: api }, port: 3001 }
  }
`;

async function files(platform: string, prefix: string): Promise<Map<string, string>> {
  const all = await generateSystemFiles(SRC(platform));
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith(prefix)) out.set(p.slice(prefix.length), c);
  }
  return out;
}

describe("find-filter live-refetch — Vue", () => {
  it("the find hook takes a MaybeRefOrGetter and tracks it via computed(toValue)", async () => {
    const f = await files("vue", "web/");
    const api = f.get("src/api/order.ts")!;
    expect(api).toContain('import { type MaybeRefOrGetter, computed, toValue } from "vue";');
    expect(api).toContain(
      "export function useByStatusOrder(query: MaybeRefOrGetter<ByStatusQuery>) {",
    );
    expect(api).toContain("const queryArgs = computed(() => toValue(query));");
    expect(api).toContain('queryKey: ["orders", "find", "by_status", queryArgs],');
    expect(api).toContain("Object.entries(queryArgs.value)");
  });

  it("the list page passes the filter as a getter so it live-refetches", async () => {
    const f = await files("vue", "web/");
    const list = f.get("src/pages/orders/list.vue")!;
    expect(list).toContain(
      "const orderByStatus = reactive(useByStatusOrder(() => ({ status: byStatusStatus.value })));",
    );
  });

  it("React's find hook is unaffected — a plain object param, no Vue imports", async () => {
    const f = await files("static", "web/");
    const api = f.get("src/api/order.ts")!;
    expect(api).toContain("export function useByStatusOrder(query: ByStatusQuery) {");
    expect(api).not.toContain("MaybeRefOrGetter");
    expect(api).not.toContain("toValue");
  });
});
