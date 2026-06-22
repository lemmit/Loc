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
