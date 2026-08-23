import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// M-T6.21 — a vanilla-workflow `let` binding that no later statement reads
// lowers to an unused variable, which `mix compile --warnings-as-errors`
// rejects.  Such a binding is now `_`-prefixed (the move the for-each / if-let
// body binds already make via `bindUsedLater`); a binding that IS read
// downstream keeps its real name.
//
// The rule spans four binding shapes and carries three invariants a naive
// `_`-prefix breaks — each has a test below:
//
//   1. `expr-let` (`label <- (…)`) never carries a `bindName`, so underscoring
//      it can never change the with-chain's `{:ok, <result>}` slot.
//   2. The three FALLIBLE shapes (`repo-let` / `repo-run` / `factory-let`) DO
//      carry one.  The LAST of them fills `assembleBody`'s `{:ok, <result>}`
//      return, so it is read by construction and must keep its real name.
//   3. Discarding the VALUE never discards the GATE: the tuple stays
//      `{:ok, _x} <- …`, so a failing call still short-circuits the chain.
//
// Plus the explicit-handler `return <expr>`: that expression is not a
// `WorkflowStmtIR`, so its refs have to be threaded in as reads — without them
// the only reader of a binding was invisible, the binding got `_`-prefixed, and
// the do-branch referenced an undefined variable (a hard `** (CompileError)`).
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
      retrieval ByCustomer(ref: string) of Order {
        where: this.customerId == ref
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

      // All three FALLIBLE bind shapes, unread and not the result slot.
      workflow discardUnreadTuples {
        create(ref: string) {
          let probe = Orders.locate(ref)
          let rows = Orders.run(ByCustomer(ref))
          let extra = Order.create({ customerId: ref })
          let kept = Order.create({ customerId: ref })
        }
      }

      // The SOLE bind fills the with-chain's return → must keep its name.
      workflow keepsResultBind {
        create(ref: string) {
          let only = Orders.locate(ref)
        }
      }

      // The handler's \`return\` is the binding's only reader.
      queryHandler DescribeOrder(ref: string): string {
        let found = Orders.locate(ref)
        let label = match found {
          Order o => o.customerId,
          NotFound => "missing"
        }
        return label
      }
    }
  }
  api CatalogApi from Core {
    route GET "/orders/describe" -> Shop.DescribeOrder
  }
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

let cache: Map<string, string> | undefined;
async function emitted(): Promise<Map<string, string>> {
  cache ??= await generateSystemFiles(SOURCE);
  return cache;
}

async function fileEndingWith(suffix: string): Promise<string> {
  const files = await emitted();
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

const workflowFile = (name: string): Promise<string> => fileEndingWith(`/workflows/${name}.ex`);

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

  it("underscores unread repo-let / repo-run / factory-let tuple binds", async () => {
    const wf = await workflowFile("discard_unread_tuples");
    expect(wf).toMatch(/\{:ok, _probe\} <- Context\.locate_order\(ref\)/);
    expect(wf).toMatch(/\{:ok, _rows\} <- Context\.run_by_customer_order\(ref\)/);
    expect(wf).toMatch(/\{:ok, _extra\} <- Context\.create_order\(/);
  });

  it("discards the VALUE, never the `:ok` GATE, on a fallible bind", async () => {
    const wf = await workflowFile("discard_unread_tuples");
    // Every discarded bind is still a two-element `{:ok, _x}` pattern: a
    // failing call still fails to match and short-circuits the with-chain.
    // A bare `_ <- …` (or a plain `=`) would swallow the error instead.
    for (const name of ["_probe", "_rows", "_extra"]) {
      expect(wf).toContain(`{:ok, ${name}} <- `);
    }
    expect(wf).not.toMatch(/^\s*_ <- Context\./m);
  });

  it("never underscores the bind that fills the `{:ok, <result>}` slot", async () => {
    // Last bind of a multi-bind chain…
    const many = await workflowFile("discard_unread_tuples");
    expect(many).toMatch(/\{:ok, kept\} <- Context\.create_order\(/);
    expect(many).toMatch(/\{:ok, kept\}\n\s+end/);
    // …and the sole bind of a single-bind chain, which nothing else reads.
    const one = await workflowFile("keeps_result_bind");
    expect(one).toMatch(/\{:ok, only\} <- Context\.locate_order\(ref\)/);
    expect(one).toMatch(/\{:ok, only\}\n\s+end/);
    expect(one).not.toContain("_only");
  });

  it("counts an explicit handler's `return <expr>` as a downstream read", async () => {
    // `assembleHandlerBody` closes with `{:ok, <return expr>}`, which is not a
    // statement — underscoring `label` here emitted `{:ok, label}` against a
    // `_label` bind: `** (CompileError) undefined variable "label"`.
    const h = await fileEndingWith("/handlers/describe_order.ex");
    expect(h).toMatch(/\n\s+label <- \(/);
    expect(h).not.toContain("_label");
    expect(h).toMatch(/\{:ok, label\}/);
  });
});
