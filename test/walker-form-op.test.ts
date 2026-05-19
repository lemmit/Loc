// Operation modals on scaffolded aggregate Detail pages.
//
// Restores the legacy detail-preparer behaviour through the
// walker-stdlib path: every public `operation` on a scaffolded
// aggregate becomes a Modal whose trigger button opens an auto-
// generated form bound to the `use<Op><Agg>` mutation hook.  This
// exercises the full pipeline — scaffold AST expander → IR
// scaffold-expander (`Modal(trigger: Button, Form(of:, op:))`) →
// body-walker `emitModal`/`emitFormOfOperation` → mantine pack
// templates.

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { generateSystems } from "../src/system/index.js";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

const SRC = `
  system S {
    module Sales {
      context Sales {
        aggregate Order {
          customerId: string display
          quantity:   int
          operation confirm() { }
          operation addLine(qty: int) { }
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui WebApp {
      api Sales: SalesApi
      scaffold aggregates: Order
    }
    deployable api {
      platform: hono
      modules: Sales
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
