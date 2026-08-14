// `if let … { … }` BRANCH statements on the vanilla (plain Ecto/Phoenix)
// workflow emitter.  The flat branch renderer handled only op-call /
// factory-let / emit / expr-let / resource-call; `assign` (`field := value`,
// own-state mutation) and `domain-service-call` fell through to
// `# TODO: lower if-let branch statement kind '<kind>'` — an ELIXIR COMMENT, so
// `mix compile --warnings-as-errors` accepted the mutilated output and the
// statement was silently dropped at runtime.  Both now render the same way the
// loop-body arm (`renderLoopBody`) already did, and the fallthrough is an
// exhaustiveness check that throws instead of emitting a comment.
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Orders {
      criterion Pending(d: bool) of Order = this.open == d
      aggregate Order {
        open: bool
        operation confirm() { open := false }
      }
      repository Orders for Order { }
      domainService Adjust {
        operation run(target: Order) { target.confirm() }
      }
      workflow serviceInIfLet {
        create(d: bool) {
          if let o = Orders.find(Pending(d)) {
            Adjust.run(o)
          }
        }
      }
      workflow assignInIfLet {
        seen: int
        create(d: bool) {
          if let o = Orders.find(Pending(d)) {
            seen := 1
            o.confirm()
          }
        }
      }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

describe("vanilla workflow if-let branch statements", () => {
  it("renders an `assign` branch statement as the real state write", async () => {
    const files = await generateSystemFiles(SRC);
    const wf = [...files.entries()].find(([k]) => k.endsWith("workflows/assign_in_if_let.ex"))?.[1];
    expect(wf, "workflow module not emitted").toBeDefined();
    // The same struct-update rebind the loop-body / top-level arms emit.
    expect(wf).toContain("state = %{state | seen: 1}");
    // No silently-accepted Elixir comment left where a statement should be.
    expect(wf).not.toContain("# TODO: lower if-let branch statement kind");
    // The statement that already worked still follows it in the branch.
    expect(wf).toContain("Context.confirm_order(o, %{})");
  });

  it("inlines a `domain-service-call` branch statement as the real context call", async () => {
    const files = await generateSystemFiles(SRC);
    const wf = [...files.entries()].find(([k]) =>
      k.endsWith("workflows/service_in_if_let.ex"),
    )?.[1];
    expect(wf, "workflow module not emitted").toBeDefined();
    // The flat branch binds sequentially, so the loop arm's `<-` with-clause
    // becomes a `=` match (a mismatch raises, rolling the transaction back —
    // the branch's documented contract).
    expect(wf).toContain("{:ok, _} = Context.confirm_order(o, %{})");
    expect(wf).not.toContain("# TODO: lower if-let branch statement kind");
  });
});
