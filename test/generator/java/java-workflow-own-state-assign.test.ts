// Workflow own-state mutation (workflow.md, "handle = own-state mutation") on
// Java.  A `field := value` in a workflow body targeting one of the workflow's
// OWN state fields writes through the saga state entity's public JavaBean
// setter (`state.set<Field>(value)`) from the dispatcher — `repo.save(state)`
// at handler exit flushes it.  The state fields are package-private, so a
// cross-package direct write wouldn't compile — the setter is the seam.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

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
    deployable d { platform: java  contexts: [C]  dataSources: [sagaState]  serves: A  port: 4000 }
  }
`;

async function gen(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

const find = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1];

describe("java workflow own-state assignment", () => {
  it("writes the own-state field through the setter in the dispatcher", async () => {
    const dispatcher = find(await gen(), "workflows/CDispatcher.java");
    expect(dispatcher, "dispatcher not emitted").toBeDefined();
    expect(dispatcher).toContain("state.setAttempts(1);");
  });

  it("emits the public setter on the saga state entity", async () => {
    const entity = find(await gen(), "persistence/OrderFulfillmentState.java");
    expect(entity, "saga state entity not emitted").toBeDefined();
    expect(entity).toContain("public void setAttempts(int attempts) {");
  });
});

// Scalar COMPOUND own-state mutation (`field += value` / `field -= value`).  It
// lowers to the same `assign` node with the value rewritten to a `binary` over
// the current value.  On Java that read-modify-write is doubly seam-bound: the
// WRITE uses the JavaBean setter, but the self-READ on the RHS goes through the
// record-style accessor (`state.attempts()`), because the cross-package saga row
// exposes its fields only via accessors — the `accessorProps:true` dispatch fix.
// Money RHS uses BigDecimal arithmetic (`.add`/`.subtract`), not a bare `+`/`-`.
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
    deployable d { platform: java  contexts: [C]  dataSources: [sagaState]  serves: A  port: 4000 }
  }
`;

async function genCompound(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(COMPOUND_SRC);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

describe("java workflow own-state compound assignment", () => {
  it("emits setter-write over an accessor-read for an int `attempts += 1`", async () => {
    const dispatcher = find(await genCompound(), "workflows/CDispatcher.java");
    expect(dispatcher, "dispatcher not emitted").toBeDefined();
    // Write through the setter; read the current value through the accessor.
    expect(dispatcher).toContain("state.setAttempts(state.attempts() + 1);");
  });

  it("emits BigDecimal arithmetic for a money `total -= 5.00 USD`", async () => {
    const dispatcher = find(await genCompound(), "workflows/CDispatcher.java");
    expect(dispatcher).toContain('state.setTotal(state.total().subtract(new BigDecimal("5.00")));');
  });
});
