// Workflow own-state mutation (workflow.md, "handle = own-state mutation") on
// the vanilla Ecto/Phoenix (non-Ash) foundation.  A `field := value` in a
// command-triggered workflow body targeting one of the workflow's OWN state
// fields rebinds the immutable workflow `state` struct via a struct update
// (`%{state | field: value}`) in the workflow execution module — the vanilla
// sibling of the dispatch-emit persisted-saga path.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// A COMMAND-triggered create (`create(n: int)`, no `by`) drives the vanilla
// workflow-execution path; an event-triggered `create … by` persists through
// dispatch-emit instead (covered by the phoenix/ash test).
const SRC = `
  system S {
    subdomain M {
      context C {
        aggregate Order { status: string }
        repository Orders for Order {}
        workflow OrderFulfillment transactional {
          attempts: int
          create(n: int) { attempts := n }
        }
      }
    }
    api A from C
    storage pg { type: postgres }
    resource sagaState { for: C, kind: state, use: pg }
    deployable d { platform: elixir { foundation: vanilla }  contexts: [C]  dataSources: [sagaState]  serves: A  port: 4000 }
  }
`;

describe("vanilla foundation — workflow own-state assignment", () => {
  it("rebinds the workflow state struct via a struct update", async () => {
    const files = await generateSystemFiles(SRC);
    const wf = [...files.entries()].find(([k]) =>
      k.endsWith("workflows/order_fulfillment.ex"),
    )?.[1];
    expect(wf, "workflow execution module not emitted").toBeDefined();
    expect(wf).toContain("state <- (%{state | attempts: n})");
  });
});
