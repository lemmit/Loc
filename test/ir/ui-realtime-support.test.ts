// Honesty gate for `on <channel>.<Event>` live-event handlers (channels.md
// Part I).  ALL SIX built-in frontends now consume the realtime SSE wire —
// flutter was the last holdout and joined with `generator/flutter/realtime.ts`
// — and ALL FIVE BACKENDS now SERVE it, elixir last
// (`vanilla/realtime-emit.ts`).  So neither half of the gate bites a shipped
// platform pairing any more.  Both stay as the SEAMS the next target gates on:
// the `frontend-has-no-consumer` arm for a NEW frontend without a realtime
// path, and the `backend-serves-no-sse` arm for an SSE frontend whose serving
// deployable streams nothing (a `static` host with no backend behind it —
// nothing there to open an EventSource against).  Those warn
// (`loom.ui-realtime-unsupported`) rather than dropping the handler silently.

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

  it("does not warn for flutter on a realtime-serving backend (flutter → node)", async () => {
    expect(await realtimeWarnings(sys("flutter", "node"))).toEqual([]);
  });

  // …and elixir serves the wire now too, so the pairing that USED to be the
  // flutter counter-example is clean as well.
  it("does not warn for flutter → elixir (both halves ship)", async () => {
    expect(await realtimeWarnings(sys("flutter", "elixir"))).toEqual([]);
  });

  // What still bites: an SSE frontend — flutter included — whose serving
  // deployable streams nothing at all.
  it("warns for flutter whose serving deployable streams nothing (flutter → static)", async () => {
    const warns = await realtimeWarnings(sys("flutter", "static"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("does not serve the realtime SSE wire");
  });
});
