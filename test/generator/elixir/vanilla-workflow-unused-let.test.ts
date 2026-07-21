import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// M-T6.21 — a vanilla-workflow `let` binding that no later statement reads
// lowers to an unused variable, which `mix compile --warnings-as-errors`
// rejects.  Such a binding is now `_`-prefixed (the move the for-each / if-let
// body binds already make via `bindUsedLater`); a binding that IS read
// downstream keeps its real name.  An `expr-let` never carries `bindName`, so
// underscoring it can never change the with-chain's `{:ok, <result>}` slot.
// ---------------------------------------------------------------------------

const SOURCE = `
system Catalog {
  subdomain Core {
    context Shop {
      error NotFound { resource: string }
      event Resolved { label: string }
      aggregate Order with crudish {
        customerId: string
      }
      repository Orders for Order {
        find locate(ref: string): Order or NotFound where this.customerId == ref
      }

      // The label binding is NEVER read after it is bound → must underscore.
      workflow resolveUnused {
        create(ref: string) {
          let outcome = Orders.locate(ref)
          let label = match outcome {
            Order o => o.customerId,
            NotFound => "missing"
          }
        }
      }

      // The label binding IS read (the emit) → must stay bare.
      workflow resolveUsed {
        create(ref: string) {
          let outcome = Orders.locate(ref)
          let label = match outcome {
            Order o => o.customerId,
            NotFound => "missing"
          }
          emit Resolved { label: label }
        }
      }
    }
  }
  api CatalogApi from Core
  storage pg { type: postgres }
  resource orderState { for: Shop, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Shop]
    dataSources: [orderState]
    serves: CatalogApi
    port: 4000
  }
}
`;

async function workflowFile(name: string): Promise<string> {
  const files = await generateSystemFiles(SOURCE);
  return files.get([...files.keys()].find((k) => k.endsWith(`/workflows/${name}.ex`))!)!;
}

describe("vanilla — unused workflow `let` binding is underscore-prefixed (M-T6.21)", () => {
  it("underscores an expr-let no later statement reads", async () => {
    const wf = await workflowFile("resolve_unused");
    // `_label <- (…)` — bound but discarded, so `--warnings-as-errors` is clean.
    expect(wf).toMatch(/_label <- \(/);
    expect(wf).not.toMatch(/[^_]label <- \(/);
  });

  it("keeps the real name when the binding IS read downstream", async () => {
    const wf = await workflowFile("resolve_used");
    // Read by the `emit Resolved { label: label }` broadcast → stays bare.
    expect(wf).toMatch(/[^_]label <- \(/);
    expect(wf).toMatch(/Events\.Resolved\{label: label\}/);
  });

  it("keeps a read binding (`outcome`) bare and as the with-chain result", async () => {
    const wf = await workflowFile("resolve_unused");
    // `outcome` is read by `match outcome` → bare, and (last bound name) wins
    // the `{:ok, outcome}` result slot — underscoring `label` left it intact.
    expect(wf).toMatch(/\{:ok, outcome\} <- Context\.locate_order\(ref\)/);
    expect(wf).toMatch(/\{:ok, outcome\}\n\s+end/);
  });
});
