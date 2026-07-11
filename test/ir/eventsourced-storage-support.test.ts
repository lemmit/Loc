// Event-sourced storage capability validator (appliers A2).  An
// aggregate's `persistedAs(eventLog)` storage emission is implemented on the
// Hono (node), .NET (dotnet) and elixir (vanilla) backends: the `<agg>_events`
// stream table + fold-on-load repository.  Hosting an event-sourced aggregate
// on a backend that doesn't branch on `persistedAs` would silently fall back
// to state persistence, so the validator rejects it instead.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function esErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.message.includes("persistedAs(eventLog)"))
    .map((d) => d.message);
}

function sys(platform: string): string {
  return `
system Ledger {
  subdomain Core {
    context Accounts {
      event Deposited { account: Account id, amount: int }
      aggregate Account persistedAs(eventLog) {
        balance: int
        operation deposit(amount: int) { emit Deposited { account: id, amount: amount } }
        apply(e: Deposited) { balance := balance + e.amount }
      }
      repository Accounts for Account { }
    }
  }
  storage pg { type: postgres }
  resource accountsLog { for: Accounts, kind: eventLog, use: pg }
  deployable api { platform: ${platform}, contexts: [Accounts], dataSources: [accountsLog], port: 4000 }
}
`;
}

describe("event-sourced storage capability validation", () => {
  it("accepts persistedAs(eventLog) on a Hono (node) deployable", async () => {
    expect(await esErrors(sys("node"))).toEqual([]);
  });

  it("accepts persistedAs(eventLog) on a .NET deployable (EF Core event store, A2.2b)", async () => {
    expect(await esErrors(sys("dotnet"))).toEqual([]);
  });

  it("accepts persistedAs(eventLog) on an elixir (vanilla) deployable (ES home)", async () => {
    expect(await esErrors(sys("elixir"))).toEqual([]);
  });
});
