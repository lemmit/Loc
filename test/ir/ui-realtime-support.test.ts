// Honesty gate for `on <channel>.<Event>` live-event handlers (channels.md
// Part I).  All five built-in frontends consume the realtime SSE wire, and (as
// of the elixir slice) ALL FIVE BACKENDS SERVE IT — so the
// `backend-serves-no-sse` arm no longer bites a real backend platform.  What is
// still gated: a frontend framework with no realtime path at all (flutter), and
// an SSE frontend whose serving deployable is not a backend that streams (a
// `static` host with no `targets:` — nothing there to open an EventSource
// against).  Those warn (`loom.ui-realtime-unsupported`) rather than dropping
// the handler silently.

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

  // The gap this closed: `platform: elixir` served no SSE endpoint, so an SPA
  // pointed at it lost its `on` handler behind this warning.  Vanilla Phoenix
  // now emits the stream (`vanilla/realtime-emit.ts`), so the warning is gone
  // and the handler is real.
  it("does not warn for react → elixir (vanilla Phoenix serves the SSE wire)", async () => {
    expect(await realtimeWarnings(sys("react", "elixir"))).toEqual([]);
  });

  it("warns for an SSE frontend whose serving deployable streams nothing (react → static)", async () => {
    const warns = await realtimeWarnings(sys("react", "static"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("does not serve the realtime SSE wire");
    expect(warns[0]).toContain("silently dropped");
  });

  it("warns for a frontend framework with no realtime path (flutter → node)", async () => {
    const warns = await realtimeWarnings(sys("flutter", "node"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("no realtime consumption");
    expect(warns[0]).toContain("silently dropped");
  });
});
