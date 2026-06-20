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
  it("accepts persistedAs(eventLog) on a Hono (node) deployable", async () => {
    expect(await esErrors(sys("node"))).toEqual([]);
  });

  it("accepts persistedAs(eventLog) on a .NET deployable (EF Core event store, A2.2b)", async () => {
    expect(await esErrors(sys("dotnet"))).toEqual([]);
  });

  it("rejects persistedAs(eventLog) on a Phoenix deployable with an Ash-foundation-specific diagnostic", async () => {
    // Phoenix-specific diagnostic (P0 of vanilla-phoenix-foundation.md):
    // names the Ash foundation as the constraint, distinguishes from a
    // Phoenix-platform limitation, points at foundation: vanilla as the
    // planned escape, and lists the today-actionable alternatives.
    const errs = await esErrors(sys("elixir"));
    expect(errs.length).toBe(1);
    const msg = errs[0];
    expect(msg).toContain("Account");
    expect(msg).toContain("persistedAs(eventLog)");
    // Names the foundation, not the platform, as the constraint.
    expect(msg).toContain("Ash-foundation limitation");
    expect(msg).toContain("not a Phoenix-platform limitation");
    // Mentions why each Ash-foundation alternative was rejected.
    expect(msg).toContain("AshEvents");
    expect(msg).toContain("AshCommanded");
    // Points at the proposal for the planned vanilla escape.
    expect(msg).toContain("foundation: vanilla");
    expect(msg).toContain("vanilla-phoenix-foundation.md");
    // Lists the today-actionable escapes (host on node/dotnet; drop ES).
    expect(msg).toContain("node / dotnet");
  });
});
