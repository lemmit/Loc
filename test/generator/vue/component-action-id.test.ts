// Regression: a Vue component-scope `Action(<instance>.<op>)` button must call
// its mutation hook WITH the instance id — `useConfirmOrder(props.order.id)` —
// matching React (`useConfirmOrder(order.id)`) and Svelte
// (`useConfirmOrder(() => order.id)`).  Previously Vue emitted
// `useConfirmOrder()` with no arg, so the mutation had no target id (and the
// `useConfirmOrder(id: string)` hook call didn't even type-check).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order {
        status: string
        operation confirm() { status := "confirmed" }
      }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  api SalesApi from Sales
  deployable api { platform: node contexts: [Orders] serves: SalesApi dataSources: [st] port: 8080 }
  ui WebApp with scaffold(subdomains: [Sales]) {
    component OrderActions(order: Order) {
      body: Toolbar { Action { order.confirm } }
    }
  }
  deployable web { platform: vue targets: api ui: WebApp port: 3001 }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("vue component action-button mutation id", () => {
  it("passes the prop instance id to the mutation hook", async () => {
    const c = find(await generateSystemFiles(SYS), "OrderActions.vue");
    // The instance is a component prop, so `order.id` → `props.order.id`.
    expect(c).toContain("const confirmOrder = reactive(useConfirmOrder(props.order.id));");
    // Never the arg-less form (the bug).
    expect(c).not.toContain("reactive(useConfirmOrder())");
  });
});
