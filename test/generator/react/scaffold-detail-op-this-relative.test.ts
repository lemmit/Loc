import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// FU1 — scaffolded Detail-page op modals seed a `this.<field>` param default
// from the loaded record.  The per-operation modals now render INSIDE the
// Detail QueryView's `data` lambda (instance-qualified `OperationForm { data.<op> }`),
// so the in-scope loaded record threads through the pack's `record` prop
// (`seedsOpFormRecord`) into the op-form's `defaultValues` — closing the gap the
// by-name (sibling) form left as type-zero.

const SRC = (design = "") => `
  system S {
    subdomain Sales {
      context Sales {
        aggregate Order {
          customerId: string
          note:       string
          operation retag(memo: string = this.customerId) { note := memo }
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui WebApp with scaffold(aggregates: [Order]) { api Sales: SalesApi }
    deployable api { platform: node contexts: [Sales] serves: SalesApi port: 3000 }
    deployable web { platform: react targets: api ui: WebApp { Sales: api }${design} port: 3001 }
  }
`;

describe("scaffolded Detail op-modal this-relative seeding", () => {
  it("threads the loaded record and seeds defaultValues from it (mantine)", async () => {
    const files = await generateSystemFiles(SRC());
    const tsx = files.get("web/src/pages/orders/detail.tsx");
    expect(tsx, "detail page generated").toBeDefined();
    // The op-form component takes the typed record prop and seeds from it.
    expect(tsx!).toMatch(/function RetagForm\(\{ mut, record, onClose \}/);
    expect(tsx!).toMatch(/record:\s*OrderResponse/);
    expect(tsx!).toMatch(/defaultValues:\s*\{[^}]*memo:\s*record\.customerId/);
    // The opener takes the record; the trigger — now inside the QueryView data
    // lambda — passes the resolved loaded-record receiver (`<hook>.data`,
    // non-null-asserted per #2060's data-lambda threading).
    expect(tsx!).toMatch(/function openRetagModal\(mut:[^)]*,\s*record:\s*OrderResponse\)/);
    expect(tsx!).toMatch(/openRetagModal\(retag,\s*orderById\.data!\)/);
  });

  it("shadcn (self-contained OpModal) threads the record too", async () => {
    const files = await generateSystemFiles(SRC(' design: "shadcn@v4"'));
    const tsx = files.get("web/src/pages/orders/detail.tsx");
    expect(tsx, "detail page generated").toBeDefined();
    expect(tsx!).toMatch(/record:\s*OrderResponse/);
    expect(tsx!).toMatch(/defaultValues:\s*\{[^}]*memo:\s*record\.customerId/);
  });

  it("a constant-only op still seeds without a record prop (no this-default)", async () => {
    const src = `
      system S {
        subdomain Sales {
          context Sales {
            aggregate Order {
              status: string
              operation flag(label: string = "urgent") { status := label }
            }
            repository Orders for Order { }
          }
        }
        api SalesApi from Sales
        ui WebApp with scaffold(aggregates: [Order]) { api Sales: SalesApi }
        deployable api { platform: node contexts: [Sales] serves: SalesApi port: 3000 }
        deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3001 }
      }
    `;
    const files = await generateSystemFiles(src);
    const tsx = files.get("web/src/pages/orders/detail.tsx");
    // Constant seeds its literal; no record prop is threaded (no this-default).
    expect(tsx!).toMatch(/defaultValues:\s*\{[^}]*label:\s*"urgent"/);
    expect(tsx!).not.toMatch(/function FlagForm\([^)]*record/);
  });
});
