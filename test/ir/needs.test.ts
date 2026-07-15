// Tests for the derived implicit "need" layer (RFC §3.3) threaded onto
// EnrichedSystemIR.needs, plus the need⊆sourceType capability check.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseValid } from "../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order { name: string }
    }
    context Ledger {
      aggregate Entry persistedAs: eventLog { amount: int }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource ledgerLog   { for: Ledger, kind: eventLog, use: primary }

  deployable api {
    platform: node
    contexts: [Orders, Ledger]
    dataSources: [ordersState, ledgerLog]
    port: 3000
  }
}
`;

async function enriched() {
  return enrichLoomModel(lowerModel(await parseValid(SRC)));
}

describe("derived needs", () => {
  it("derives a state need for a context with a state-based aggregate", async () => {
    const sys = (await enriched()).systems[0]!;
    const orders = sys.needs.filter((n) => n.contextName === "Orders");
    expect(orders).toHaveLength(1);
    expect(orders[0]!.kind).toBe("state");
    expect(orders[0]!.capabilities).toContain("state");
  });

  it("derives an eventLog need for a context with an event-sourced aggregate", async () => {
    const sys = (await enriched()).systems[0]!;
    const ledger = sys.needs.filter((n) => n.contextName === "Ledger");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.kind).toBe("eventLog");
    expect(ledger[0]!.capabilities).toEqual(expect.arrayContaining(["append", "read"]));
  });

  it("is idempotent across re-enrichment", async () => {
    const once = await enriched();
    const twice = enrichLoomModel(once as never);
    expect(twice.systems[0]!.needs).toEqual(once.systems[0]!.needs);
  });
});

describe("need ⊆ sourceType capability check", () => {
  it("is silent for a valid postgres-backed model (no double-reporting)", async () => {
    const diags = validateLoomModel(await enriched());
    expect(diags.filter((d) => /does not offer/.test(d.message))).toEqual([]);
  });
});
