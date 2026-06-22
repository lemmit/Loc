// Workflow own-state mutation (workflow.md, "handle = own-state mutation") on
// Python.  A `field := value` in a workflow body targeting one of the
// workflow's OWN state fields writes onto the loaded correlation-state row
// (`state.<snake>`) in app/dispatch.py — flushed at handler exit.

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
    deployable d { platform: python  contexts: [C]  dataSources: [sagaState]  serves: A  port: 4000 }
  }
`;

describe("Python workflow own-state assignment", () => {
  it("writes the own-state field onto the saga row in the dispatcher", async () => {
    const files = (await generateSystems(await parseValid(SRC))).files;
    const dispatch = [...files.entries()].find(([k]) => k.endsWith("app/dispatch.py"))?.[1];
    expect(dispatch, "dispatch.py not emitted").toBeDefined();
    expect(dispatch).toContain("state.attempts = 1");
  });
});

// Scalar COMPOUND own-state mutation (`field += value` / `field -= value`).  It
// lowers to the same `assign` node with the value rewritten to a `binary` over
// the current value, so the `state.<snake> = <expr>` emitter renders the
// read-modify-write off the shared expression renderer — int as `+`/`-`, money
// as `Decimal` `+`/`-`.
const COMPOUND_SRC = `
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
          total: money
          create(p: OrderPlaced) by p.order { attempts += 1  total -= 5.00 USD }
        }
      }
    }
    api A from C
    storage pg { type: postgres }
    resource sagaState { for: C, kind: state, use: pg }
    deployable d { platform: python  contexts: [C]  dataSources: [sagaState]  serves: A  port: 4000 }
  }
`;

describe("Python workflow own-state compound assignment", () => {
  it("emits a read-modify-write for an int `attempts += 1`", async () => {
    const files = (await generateSystems(await parseValid(COMPOUND_SRC))).files;
    const dispatch = [...files.entries()].find(([k]) => k.endsWith("app/dispatch.py"))?.[1];
    expect(dispatch, "dispatch.py not emitted").toBeDefined();
    expect(dispatch).toContain("state.attempts = state.attempts + 1");
  });

  it("emits Decimal arithmetic for a money `total -= 5.00 USD`", async () => {
    const files = (await generateSystems(await parseValid(COMPOUND_SRC))).files;
    const dispatch = [...files.entries()].find(([k]) => k.endsWith("app/dispatch.py"))?.[1];
    expect(dispatch).toContain('state.total = state.total - Decimal("5.00")');
  });
});
