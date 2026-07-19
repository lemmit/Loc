import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// this-relative op-param default seeding on Vue (FU3 — parity with the React
// `seedsOpFormRecord` packs).  A `this.<field>` op-param default seeds the
// inlined op-form's `useLoomForm` defaults from the in-scope component prop
// (`props.<instance>`), which is available at `<script setup>` time — so no
// prop/reset plumbing is needed.  Vuetify and shadcnVue both opt in via the
// pack-manifest `seedsOpFormRecord` flag; a constant default still seeds its
// literal, and a non-client-evaluable default still falls back to type-zero.

const SRC = (design: string) => `
  system S {
    subdomain Sales {
      context Sales {
        aggregate Order {
          customerId: string
          note:       string
          derived display: string = customerId
          operation confirm(memo: string = this.customerId) { note := memo }
          operation flag(label: string = "urgent") { note := label }
          operation touch(at: datetime = now()) { note := "touched" }
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui WebApp {
      api Sales: SalesApi
      component OrderPanel(order: Order) {
        body: Stack {
          Modal { OperationForm { order.confirm }, trigger: Button { "Confirm" }, title: "Confirm" },
          Modal { OperationForm { order.flag },    trigger: Button { "Flag" },    title: "Flag" },
          Modal { OperationForm { order.touch },   trigger: Button { "Touch" },   title: "Touch" }
        }
      }
      page Home { route: "/" body: Text { "hi" } }
    }
    deployable api { platform: node contexts: [Sales] serves: SalesApi port: 3000 }
    deployable web { platform: vue targets: api ui: WebApp design: "${design}" port: 3001 }
  }
`;

describe.each([
  "vuetify@v3",
  "shadcnVue@v1",
])("vue this-relative op-form seeding (%s)", (design) => {
  it("seeds a this.<field> op default from the in-scope component prop", async () => {
    const files = await generateSystemFiles(SRC(design));
    const vue = files.get("web/src/components/OrderPanel.vue");
    expect(vue, "OrderPanel component generated").toBeDefined();
    // this-relative default reads the record off the component prop.
    expect(vue!).toMatch(
      /useLoomForm\(ConfirmOrderRequest,\s*\{\s*memo:\s*props\.order\.customerId\s*\}\)/,
    );
    // The record's response type is imported for the prop.
    expect(vue!).toMatch(/import type \{ OrderResponse \} from "\.\.\/api\/order"/);
  });

  it("still seeds a constant default as its literal", async () => {
    const files = await generateSystemFiles(SRC(design));
    const vue = files.get("web/src/components/OrderPanel.vue");
    expect(vue!).toMatch(/useLoomForm\(FlagOrderRequest,\s*\{\s*label:\s*"urgent"\s*\}\)/);
  });

  it("falls back to type-zero for a non-client-evaluable default (now())", async () => {
    const files = await generateSystemFiles(SRC(design));
    const vue = files.get("web/src/components/OrderPanel.vue");
    // `now()` is not client-evaluable → the seed stays the type-zero "".
    expect(vue!).toMatch(/useLoomForm\(TouchOrderRequest,\s*\{\s*at:\s*""\s*\}\)/);
    expect(vue!).not.toMatch(/at:\s*props\.order/);
  });
});
