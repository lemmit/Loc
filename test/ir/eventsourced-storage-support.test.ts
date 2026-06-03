// Event-sourced storage capability validator (appliers A2).  An
// aggregate's `persistedAs(eventLog)` storage emission is implemented for
// the Hono backend only (v1): the `<agg>_events` stream table + fold-on-load
// repository.  Hosting an event-sourced aggregate on .NET / Phoenix — which
// don't yet branch on `persistedAs` — would silently fall back to state
// persistence, so the validator rejects it instead.

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
      aggregate Account ids guid persistedAs(eventLog) {
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
  it("accepts persistedAs(eventLog) on a Hono deployable", async () => {
    expect(await esErrors(sys("hono"))).toEqual([]);
  });

  it("rejects persistedAs(eventLog) on a .NET deployable (no ES emission yet)", async () => {
    const errs = await esErrors(sys("dotnet"));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("Account");
    expect(errs[0]).toContain("Hono backend only");
  });

  it("rejects persistedAs(eventLog) on a Phoenix deployable", async () => {
    const errs = await esErrors(sys("phoenixLiveView"));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("event-sourced");
  });
});
