// Workflow own-state mutation (workflow.md, "handle = own-state mutation") on
// Hono.  A `field := value` in a workflow `create`/`handle`/`on` body that
// targets one of the workflow's OWN state fields writes onto the loaded
// correlation-state row (`state.<field>`), which `save<Wf>` flushes at handler
// exit — NOT an aggregate `this`.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system S {
    subdomain C {
      context C {
        aggregate Order {
          status: string
          operation place() { status := "Placed"  emit OrderPlaced { order: id, at: now() } }
        }
        repository Orders for Order {}
        event OrderPlaced { order: Order id, at: datetime }
        channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
        workflow OrderFulfillment {
          orderId: Order id
          attempts: int
          create(p: OrderPlaced) by p.order { attempts := 1 }
        }
      }
    }
    api A from C
    storage pg { type: postgres }
    resource sagaState { for: C, kind: state, use: pg }
    deployable d { platform: node  contexts: [C]  dataSources: [sagaState]  serves: A  port: 4000 }
  }
`;

describe("Hono workflow own-state assignment", () => {
  it("writes the own-state field onto the loaded saga row and saves at exit", async () => {
    const files = (await generateSystems(await parseValid(SRC))).files;
    const wf = [...files.entries()].find(([k]) => k.endsWith("/http/workflows.ts"))?.[1];
    expect(wf, "workflows.ts not emitted").toBeDefined();

    const start = wf!.slice(wf!.indexOf("orderFulfillmentStartOrderPlaced"));
    expect(start).toContain("state.attempts = 1;");
    // The write lands on the persisted correlation-state row, flushed at exit.
    expect(start).toContain("await saveOrderFulfillment(db, state);");
  });
});
