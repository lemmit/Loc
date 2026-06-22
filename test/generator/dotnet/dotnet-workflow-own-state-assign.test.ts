// Workflow own-state mutation (workflow.md, "handle = own-state mutation") on
// .NET.  A `field := value` in a workflow body targeting one of the workflow's
// OWN state fields writes onto the loaded correlation-state row
// (`state.<Field>`, PascalCase) — flushed by the handler's SaveAsync at exit.

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
    deployable d { platform: dotnet  contexts: [C]  dataSources: [sagaState]  serves: A  port: 4000 }
  }
`;

describe(".NET workflow own-state assignment", () => {
  it("writes the own-state field onto the saga row in the start handler", async () => {
    const files = (await generateSystems(await parseValid(SRC))).files;
    const handler = [...files.entries()].find(([k]) =>
      k.endsWith("OrderFulfillmentStartOrderPlacedHandler.cs"),
    )?.[1];
    expect(handler, "start handler not emitted").toBeDefined();
    expect(handler).toContain("state.Attempts = 1;");
  });

  it("emits a settable Attempts property on the saga state entity", async () => {
    const files = (await generateSystems(await parseValid(SRC))).files;
    const entity = [...files.entries()].find(([k]) =>
      k.endsWith("Workflows/OrderFulfillmentState.cs"),
    )?.[1];
    expect(entity).toContain("public int Attempts { get; set; }");
  });
});

// Scalar COMPOUND own-state mutation (`field += value` / `field -= value`).  It
// lowers to the same `assign` node with the value rewritten to a `binary` over
// the current value, so the `state.<Field> = <expr>` emitter renders the
// read-modify-write off the shared expression renderer — int as `+`/`-`, money
// as `decimal` `+`/`-`.
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
    deployable d { platform: dotnet  contexts: [C]  dataSources: [sagaState]  serves: A  port: 4000 }
  }
`;

describe(".NET workflow own-state compound assignment", () => {
  it("emits a read-modify-write for an int `attempts += 1`", async () => {
    const files = (await generateSystems(await parseValid(COMPOUND_SRC))).files;
    const handler = [...files.entries()].find(([k]) =>
      k.endsWith("OrderFulfillmentStartOrderPlacedHandler.cs"),
    )?.[1];
    expect(handler, "start handler not emitted").toBeDefined();
    expect(handler).toContain("state.Attempts = state.Attempts + 1;");
  });

  it("emits decimal arithmetic for a money `total -= 5.00 USD`", async () => {
    const files = (await generateSystems(await parseValid(COMPOUND_SRC))).files;
    const handler = [...files.entries()].find(([k]) =>
      k.endsWith("OrderFulfillmentStartOrderPlacedHandler.cs"),
    )?.[1];
    expect(handler).toContain("state.Total = state.Total - 5.00m;");
  });
});
