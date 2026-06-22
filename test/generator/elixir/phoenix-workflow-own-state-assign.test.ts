// Workflow own-state mutation (workflow.md, "handle = own-state mutation") on
// the Phoenix/Ash backend.  A `field := value` in an event-triggered workflow
// `create … by` body targeting one of the workflow's OWN state fields persists
// the write on the correlation-state row: saga state is a plain Ecto schema
// (no Ash resource), so it rebinds `state` via an `Ecto.Changeset.change/2` +
// `Repo.update!` in the dispatch start handler.

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
    deployable d { platform: elixir  contexts: [C]  dataSources: [sagaState]  serves: A  port: 4000 }
  }
`;

async function gen(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

describe("phoenix/ash workflow own-state assignment", () => {
  it("persists the own-state write via Ecto.Changeset.change + Repo.update!", async () => {
    const files = await gen();
    const start = [...files.entries()].find(([k]) =>
      k.endsWith("workflows/order_fulfillment/start_order_placed.ex"),
    )?.[1];
    expect(start, "start handler not emitted").toBeDefined();
    expect(start).toContain("D.Repo.update!(Ecto.Changeset.change(state, %{attempts: 1}))");
    // The update is the last statement and nothing reads its result, so it is a
    // bare side-effecting call — NOT a `state = …` rebind, which `mix compile
    // --warnings-as-errors` would reject as an unused variable.
    expect(start).not.toContain("state = D.Repo.update!");
  });
});

// Scalar COMPOUND own-state mutation (`field += value` / `field -= value`).  It
// lowers to the same `assign` node with the value rewritten to a `binary` over
// the current value, so the changeset's new value is a read-modify-write off the
// shared expression renderer — int as `state.attempts + 1`, money as
// `Decimal.sub(state.total, …)`.  An intermediate write (not the body's last
// statement) keeps the `state = …` rebind so the next read sees it; the final
// write drops it (the #1532 unused-`state` fix), which `mix compile
// --warnings-as-errors` requires.
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
    deployable d { platform: elixir  contexts: [C]  dataSources: [sagaState]  serves: A  port: 4000 }
  }
`;

async function genCompound(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(COMPOUND_SRC);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

describe("phoenix/ash workflow own-state compound assignment", () => {
  it("emits a read-modify-write changeset for an int `attempts += 1`", async () => {
    const files = await genCompound();
    const start = [...files.entries()].find(([k]) =>
      k.endsWith("workflows/order_fulfillment/start_order_placed.ex"),
    )?.[1];
    expect(start, "start handler not emitted").toBeDefined();
    // Non-final write keeps the `state = …` rebind so the trailing `total -=`
    // reads the updated row.
    expect(start).toContain(
      "state = D.Repo.update!(Ecto.Changeset.change(state, %{attempts: state.attempts + 1}))",
    );
  });

  it("emits Decimal arithmetic for a money `total -= 5.00 USD`", async () => {
    const files = await genCompound();
    const start = [...files.entries()].find(([k]) =>
      k.endsWith("workflows/order_fulfillment/start_order_placed.ex"),
    )?.[1];
    // Final write is a bare side-effecting call (no `state = …` rebind), and the
    // money RHS renders via Decimal.sub, not a bare `-`.
    expect(start).toContain(
      'D.Repo.update!(Ecto.Changeset.change(state, %{total: Decimal.sub(state.total, Decimal.new("5.00"))}))',
    );
  });
});
