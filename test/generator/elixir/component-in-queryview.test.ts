// Regression: a user `component` invoked inside a QueryView `data:` lambda.
// The QueryView renders its branches as a HEEx `<%= cond do %> … <% end %>`;
// the `data:` arm invokes a user `component`, which renders to a HEEx
// function-component tag (`<…UiComponents.order_panel … />`).  That tag is
// markup — it must NOT be wrapped in `<%= %>`.  The bug emitted
// `<%= <…order_panel … /> %>`, invalid HEEx that only failed at `mix compile`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYS = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order { status: string }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  ui WebApp {
    component OrderPanel(order: Order) {
      body: Card { Heading { "Order" }, Text { order.status } }
    }
    page OrderDetail {
      route: "/orders/:id"
      body: QueryView {
        of: Orders.Order.byId(id),
        single: true,
        loading: Loader {},
        empty: Empty { "none" },
        data: order => OrderPanel(order)
      }
    }
  }
  deployable app { platform: elixir contexts: [Orders] dataSources: [st] ui: WebApp port: 4000 }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("phoenix QueryView data lambda invoking a user component", () => {
  it("renders the component as a bare HEEx tag, not wrapped in <%= %>", async () => {
    const live = find(await generateSystemFiles(SYS), "order_detail_live.ex");
    // The component tag is emitted directly inside the `cond` arm.
    expect(live).toMatch(/<\w+Web\.Components\.UiComponents\.order_panel order=\{@order\} \/>/);
    // NOT wrapped in `<%= … %>` (the bug).
    expect(live).not.toMatch(/<%=\s*<\w+Web\.Components\.UiComponents\.order_panel/);
  });
});
