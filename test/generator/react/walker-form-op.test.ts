// Operation modals on scaffolded aggregate Detail pages.
//
// Restores the legacy detail-preparer behaviour through the
// walker-stdlib path: every public `operation` on a scaffolded
// aggregate becomes a Modal whose trigger button opens an auto-
// generated form bound to the `use<Op><Agg>` mutation hook.  This
// exercises the full pipeline — scaffold AST expander → IR
// scaffold-expander (`Modal { trigger: Button, CreateForm { of: , op: } }`) →
// body-walker `emitModal`/`emitFormOfOperation` → mantine pack
// templates.

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
          quantity:   int
          operation confirm() { }
          operation addLine(qty: int) { }
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui WebApp with scaffold(aggregates: [Order]) {
      api Sales: SalesApi
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

describe("scaffold detail page — operation modals", () => {
  it("emits a module-scope <Op>Form component + opener per public op", async () => {
    const files = await buildAndGenerate(SRC);
    const tsx = files.get("web/src/pages/orders/detail.tsx");
    expect(tsx, "Order detail page is generated").toBeDefined();
    // mantine modals-manager pattern: opener + form component.
    expect(tsx!).toMatch(/function openConfirmModal\(/);
    expect(tsx!).toMatch(/function ConfirmForm\(/);
    expect(tsx!).toMatch(/function openAddLineModal\(/);
    expect(tsx!).toMatch(/function AddLineForm\(/);
  });

  it("declares the use<Op><Agg> mutation hook bound to the route id", async () => {
    const files = await buildAndGenerate(SRC);
    const tsx = files.get("web/src/pages/orders/detail.tsx")!;
    expect(tsx).toMatch(/const confirm = useConfirmOrder\(id \?\? ""\)/);
    expect(tsx).toMatch(/const addLine = useAddLineOrder\(id \?\? ""\)/);
    // Imports merged into a single api line (no duplicate-identifier).
    expect(tsx).toMatch(
      /import \{[^}]*useAddLineOrder[^}]*useConfirmOrder[^}]*\} from "\.\.\/\.\.\/api\/order"/,
    );
    // useForm imported exactly once even though two ops use it.
    expect(tsx.match(/from "react-hook-form"/g)!.length).toBe(1);
  });

  it("renders the trigger buttons + RHF form with op-param inputs", async () => {
    const files = await buildAndGenerate(SRC);
    const tsx = files.get("web/src/pages/orders/detail.tsx")!;
    // Trigger buttons with op testids.
    expect(tsx).toMatch(
      /onClick=\{\(\) => openConfirmModal\(confirm\)\}[^>]*data-testid="orders-op-confirm"/,
    );
    expect(tsx).toMatch(/data-testid="orders-op-addLine"/);
    // confirm() has no params → the "no parameters" note.
    expect(tsx).toMatch(/This operation has no parameters\./);
    // addLine(qty: int) → a NumberInput bound to the param.
    expect(tsx).toMatch(/orders-op-addLine-input-qty/);
    // Submit wired to the mutation + success notification.
    expect(tsx).toMatch(/await mut\.mutateAsync\(vals\)/);
    expect(tsx).toMatch(/data-testid="orders-op-confirm-submit"/);
  });
});

// A hand-authored op-form inside a user component. Unlike the scaffold
// Detail page (where the record is a QueryView lambda binding, so the
// mutation falls back to the route id), a component param is an in-scope
// instance at function-top — so the hook targets `order.id` directly.
// Exercises the component shell's form wiring (the page shell isn't
// involved here).
const COMPONENT_SRC = `
  system S {
    subdomain Sales {
      context Sales {
        aggregate Order {
          customerId: string
          derived display: string = customerId
          operation confirm() { }
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
    deployable web {
      platform: static
      targets: api
      ui: WebApp { Sales: api }
      port: 3001
    }
  }
`;

describe("instance-qualified op-form inside a component", () => {
  it("wires the module-scope form + function-top hook against the instance id", async () => {
    const files = await buildAndGenerate(COMPONENT_SRC);
    const tsx = files.get("web/src/components/OrderPanel.tsx");
    expect(tsx, "OrderPanel component is generated").toBeDefined();
    // Function-top mutation hook targets the prop instance (`order.id`),
    // not the route `id ?? ""` the scaffold Detail page falls back to.
    expect(tsx!).toMatch(/const confirm = useConfirmOrder\(order\.id\)/);
    // Module-scope form component + opener (the page-shell wiring,
    // now emitted by the component shell too).
    expect(tsx!).toMatch(/function ConfirmForm\(/);
    expect(tsx!).toMatch(/function openConfirmModal\(/);
    // Trigger button references the (now-defined) opener + hook.
    expect(tsx!).toMatch(/onClick=\{\(\) => openConfirmModal\(confirm\)\}/);
    expect(tsx!).toMatch(/await mut\.mutateAsync\(vals\)/);
  });
});

// A BARE `OperationForm(<instance>.<op>)` in a hand-written page body — NOT
// wrapped in a `Modal { … }`. The page shell still emits the module-scope
// form component (which references the pack modal shell: `modals`,
// `notifications`, `Button`/`Group`, `applyServerErrors`), so those imports
// must be registered by the op-form itself rather than by an enclosing Modal
// that isn't there. Regression for the "bare op-form → un-imported modals"
// codegen bug.
const BARE_OPFORM_SRC = `
  system S {
    subdomain Sales {
      context Sales {
        aggregate Order {
          customerId: string
          derived display: string = customerId
          operation confirm() { }
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
          data: o => Card { OperationForm { o.confirm } }
        }
      }
    }
    deployable api { platform: node contexts: [Sales] serves: SalesApi port: 3000 }
    deployable web {
      platform: static
      targets: api
      ui: WebApp { Sales: api }
      port: 3001
    }
  }
`;

describe("bare op-form (no enclosing Modal) in a hand-written page", () => {
  it("self-registers the modal-shell imports so the emitted component compiles", async () => {
    const files = await buildAndGenerate(BARE_OPFORM_SRC);
    const tsx = files.get("web/src/pages/order_console.tsx");
    expect(tsx, "OrderConsole page is generated").toBeDefined();
    // The module-scope form component is emitted...
    expect(tsx!).toMatch(/function ConfirmForm\(/);
    // ...so every identifier it references must be imported.
    expect(tsx!).toMatch(/import \{ modals \} from "@mantine\/modals"/);
    expect(tsx!).toMatch(/import \{ notifications \} from "@mantine\/notifications"/);
    expect(tsx!).toMatch(/applyServerErrors.*from "\.\.\/lib\/apply-server-errors"/);
    // Button + Group come from the mantine core import line.
    expect(tsx!).toMatch(/import \{[^}]*\bButton\b[^}]*\bGroup\b[^}]*\} from "@mantine\/core"/);
  });
});
