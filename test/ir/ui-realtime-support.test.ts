// Honesty gate for `on <channel>.<Event>` live-event handlers (channels.md
// Part I).  ALL SIX built-in frontends now consume the realtime SSE wire —
// flutter was the last holdout and joined with `generator/flutter/realtime.ts`
// — so the frontend-has-no-consumer half of the gate no longer bites any
// shipped target; it stays as the seam a NEW frontend gates on.  What still
// warns is the other half: an SSE-consuming frontend pointed at a backend that
// does not serve the wire (the Phoenix/Elixir backend), where the handler would
// subscribe to a route that isn't there.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function realtimeWarnings(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "warning" && d.code === "loom.ui-realtime-unsupported")
    .map((d) => d.message);
}

// A broadcast channel + an `on` handler on the ui, targeting a backend of the
// given platform from a frontend of the given platform.
function sys(frontendPlatform: string, backendPlatform: string): string {
  const backendDataSources = backendPlatform === "elixir" ? "" : " dataSources: [st]";
  return `
system RtGate {
  subdomain Shipping {
    context Fulfillment {
      aggregate Order { status: string }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
    }
  }
  storage primary { type: postgres }
  resource st { for: Fulfillment, kind: state, use: primary }
  api FulfillmentApi from Shipping
  ui WebApp {
    api Fulfillment: FulfillmentApi
    channel Live: Fulfillment.Lifecycle
    on Live.OrderPlaced(e) { toast("order placed") }
    page Home { route: "/" body: Heading { "hi" } }
  }
  deployable backend { platform: ${backendPlatform} contexts: [Fulfillment] serves: FulfillmentApi${backendDataSources} port: 3000 }
  deployable webApp { platform: ${frontendPlatform} targets: backend ui: WebApp { Fulfillment: backend } port: 3001 }
}
`;
}

describe("ui realtime honesty gate (`loom.ui-realtime-unsupported`)", () => {
  it("does not warn for an SSE frontend on a realtime-serving backend (react → node)", async () => {
    expect(await realtimeWarnings(sys("react", "node"))).toEqual([]);
  });

  it("does not warn for feliz on a realtime-serving backend (feliz → node)", async () => {
    expect(await realtimeWarnings(sys("feliz", "node"))).toEqual([]);
  });

  it("does not warn for angular on a realtime-serving backend (angular → java)", async () => {
    expect(await realtimeWarnings(sys("angular", "java"))).toEqual([]);
  });

  it("warns for an SSE frontend targeting a backend without the wire (react → elixir)", async () => {
    const warns = await realtimeWarnings(sys("react", "elixir"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("does not serve the realtime SSE wire");
    expect(warns[0]).toContain("silently dropped");
  });

  it("does not warn for flutter on a realtime-serving backend (flutter → node)", async () => {
    expect(await realtimeWarnings(sys("flutter", "node"))).toEqual([]);
  });

  // …and the OTHER half still bites flutter: pointed at a backend with no SSE
  // wire, the emitted subscription would connect to nothing.
  it("warns for flutter targeting a backend without the wire (flutter → elixir)", async () => {
    const warns = await realtimeWarnings(sys("flutter", "elixir"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("does not serve the realtime SSE wire");
  });
});
