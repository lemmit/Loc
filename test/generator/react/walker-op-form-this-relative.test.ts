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

  // The instance can also be a QueryView data-lambda binding (a hand-written
  // Detail-shaped page) — there the trigger must pass the RENDERED receiver
  // (`<hook>.data`, non-null-asserted past the closure-lost `data &&`
  // narrowing), not the raw source name (which is not a JS identifier in the
  // emitted scope), and `<Agg>Response` must be imported explicitly (the
  // shell's props-interface channel only covers component params).
  const LAMBDA_SRC = `
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
        page OrderConsole(id: Order id) {
          route: "/orders/:id"
          body: QueryView {
            of: Sales.Order.byId(id),
            single: true,
            empty: Empty { "not found" },
            data: o => Card { Modal { OperationForm { o.confirm }, trigger: Button { "Confirm" }, title: "Confirm" } }
          }
        }
      }
      deployable api { platform: node contexts: [Sales] serves: SalesApi port: 3000 }
      deployable web { platform: static targets: api ui: WebApp { Sales: api } port: 3001 }
    }
  `;

  it("passes the rendered receiver + imports the Response type for a QueryView data-lambda instance", async () => {
    const files = await generateSystemFiles(LAMBDA_SRC);
    const tsx = files.get("web/src/pages/order_console.tsx");
    expect(tsx, "OrderConsole page generated").toBeDefined();
    // Trigger passes the RENDERED lambda binding (non-null-asserted), not the
    // raw source name `o` (undefined in the emitted scope).
    expect(tsx!).toMatch(/openConfirmModal\(confirm, orderById\.data!\)/);
    expect(tsx!).not.toMatch(/openConfirmModal\(confirm, o\)/);
    // The Response type the record prop is typed as is imported (the shell
    // imports it for component params only, not data-lambda bindings).
    expect(tsx!).toMatch(/import \{[^}]*\bOrderResponse\b[^}]*\} from "\.\.\/api\/order"/);
  });

  it("passes the rendered receiver on shadcn's self-contained OpModal too", async () => {
    const files = await generateSystemFiles(
      LAMBDA_SRC.replace(
        "ui: WebApp { Sales: api } port: 3001",
        'ui: WebApp { Sales: api } design: "shadcn@v4" port: 3001',
      ),
    );
    const tsx = files.get("web/src/pages/order_console.tsx");
    expect(tsx, "OrderConsole page generated").toBeDefined();
    expect(tsx!).toMatch(/<ConfirmOpModal mut=\{ confirm \} record=\{ orderById\.data! \} \/>/);
    expect(tsx!).toMatch(/import \{[^}]*\bOrderResponse\b[^}]*\} from "\.\.\/api\/order"/);
  });

  it("threads the record on shadcn (self-contained OpModal) too", async () => {
    const files = await generateSystemFiles(
      SRC.replace(
        "ui: WebApp { Sales: api } port: 3001",
        'ui: WebApp { Sales: api } design: "shadcn@v4" port: 3001',
      ),
    );
    const tsx = files.get("web/src/components/OrderPanel.tsx");
    expect(tsx, "OrderPanel component generated").toBeDefined();
    // Self-contained OpModal component takes the typed record prop…
    expect(tsx!).toMatch(/function ConfirmOpModal\(\{ mut, record \}/);
    expect(tsx!).toMatch(/record:\s*OrderResponse/);
    // …seeds defaultValues from it, and the instantiation passes the instance.
    expect(tsx!).toMatch(/defaultValues:\s*\{[^}]*memo:\s*record\.customerId/);
    expect(tsx!).toMatch(/<ConfirmOpModal mut=\{ confirm \} record=\{ order \} \/>/);
  });
});
