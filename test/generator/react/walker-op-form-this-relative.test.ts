import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// this-relative op-param default seeding (Slice 5) — a `this.<field>` default
// on an operation seeds the op-modal's `defaultValues` from the loaded record,
// threaded as a `record` prop into the module-scope op-form component
// (mantine's `seedsOpFormRecord` opt-in).  Exercised through an instance-
// qualified `OperationForm { order.confirm }` where `order` is in scope.

const SRC = `
  system S {
    subdomain Sales {
      context Sales {
        aggregate Order {
          customerId: string
          note:       string
          derived display: string = customerId
          operation confirm(memo: string = this.customerId) { note := memo }
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui WebApp {
      api Sales: SalesApi
      component OrderPanel(order: Order) {
        body: Modal { OperationForm { order.confirm }, trigger: Button { "Confirm" }, title: "Confirm" }
      }
      page Home { route: "/" body: Text { "hi" } }
    }
    deployable api { platform: node contexts: [Sales] serves: SalesApi port: 3000 }
    deployable web { platform: static targets: api ui: WebApp { Sales: api } port: 3001 }
  }
`;

describe("this-relative op-form seeding (mantine)", () => {
  it("threads the record prop and seeds defaultValues from it", async () => {
    const files = await generateSystemFiles(SRC);
    const tsx = files.get("web/src/components/OrderPanel.tsx");
    expect(tsx, "OrderPanel component generated").toBeDefined();
    // defaultValues seed reads the threaded record prop.
    expect(tsx!).toMatch(/defaultValues:\s*\{[^}]*memo:\s*record\.customerId/);
    // Component takes a typed record prop.
    expect(tsx!).toMatch(/function ConfirmForm\(\{ mut, record, onClose \}/);
    expect(tsx!).toMatch(/record:\s*OrderResponse/);
    // Opener + trigger pass the in-scope instance as the record.
    expect(tsx!).toMatch(/openConfirmModal\(confirm, order\)/);
    // Response type imported.
    expect(tsx!).toMatch(/OrderResponse/);
  });
});
