// `Action { <instance>.<operation>, then? }` — a button bound to an
// aggregate operation invoked on an in-scope instance.  The operation
// is referenced through the instance (`order.confirm`), so the walker
// resolves the aggregate + the id to mutate (`order.id`) from the
// component param's declared type, declares the `use<Op><Agg>`
// mutation hook at function top, and runs the optional `then:` effect
// on success.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

const SRC = `
  system S {
    subdomain Sales {
      context Sales {
        aggregate Order {
          customerId: string
          derived display: string = customerId
          operation confirm() { }
          operation cancel() { }
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui WebApp with scaffold(aggregates: [Order]) {
      api Sales: SalesApi
      component OrderPanel(order: Order) {
        body: Toolbar {
          Action { order.confirm, then: navigate(OrderHome, { customerId: order.customerId }) },
          Action { order.cancel }
        }
      }
      page OrderHome { route: "/order-home" body: Text { "home" } }
    }
    deployable api {
      platform: node
      contexts: [Sales]
      serves: SalesApi
      port: 3000
    }
    deployable web {
      platform: static
      targets: api
      ui: WebApp { Sales: api }
      port: 3001
    }
  }
`;

describe("Action primitive — instance-qualified operation refs", () => {
  it("declares the use<Op><Agg> mutation hook bound to the instance id", async () => {
    const files = await buildAndGenerate(SRC);
    const tsx = files.get("web/src/components/OrderPanel.tsx");
    expect(tsx, "OrderPanel component is generated").toBeDefined();
    expect(tsx!).toMatch(/const confirmOrder = useConfirmOrder\(order\?\.id\)/);
    expect(tsx!).toMatch(/const cancelOrder = useCancelOrder\(order\?\.id\)/);
    // Hooks imported from the aggregate's api module (one hop up).
    expect(tsx!).toMatch(
      /import \{[^}]*useCancelOrder[^}]*useConfirmOrder[^}]*\} from "\.\.\/api\/order"/,
    );
  });

  it("types an aggregate-instance prop as the wire DTO so member access typechecks", async () => {
    const files = await buildAndGenerate(SRC);
    const tsx = files.get("web/src/components/OrderPanel.tsx")!;
    // `order: Order` → the aggregate's wire DTO, imported from its api.
    expect(tsx).toMatch(/import type \{ OrderResponse \} from "\.\.\/api\/order"/);
    expect(tsx).toMatch(/order: OrderResponse;/);
  });

  it("renders a button firing the mutation then running the then-effect", async () => {
    const files = await buildAndGenerate(SRC);
    const tsx = files.get("web/src/components/OrderPanel.tsx")!;
    // confirm → mutate then navigate to the page route with state.
    expect(tsx).toMatch(
      /confirmOrder\.mutateAsync\(\{\}\)\.then\(\(\) => \{ navigate\("\/order-home", \{ state: \{ customerId: order\.customerId \} \}\); \}\)/,
    );
    // cancel → bare mutation, no then-effect.
    expect(tsx).toMatch(/cancelOrder\.mutateAsync\(\{\}\)/);
    // Button labels are the humanised operation names.
    expect(tsx).toMatch(/>Confirm</);
    expect(tsx).toMatch(/>Cancel</);
    // navigate hook is wired for the then-effect.
    expect(tsx).toMatch(/const navigate = useNavigate\(\)/);
  });
});
