import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Realtime SSE wire — Angular frontend (channels.md Part I).
//
// Mirrors test/generator/vue/vue-realtime.test.ts: the client module emits
// when the targeted Hono backend carries a broadcast channel, the renderless
// RealtimeHandlersComponent emits when the ui declares `on <channel>.<Event>`
// members, the minimal LoomToastService backs the pack's `realtime-toast`
// template, and the app shell mounts the component.
// ---------------------------------------------------------------------------

const BASE = `
system RealtimeNgShop {
  subdomain Shipping {
  context Fulfillment {
    aggregate Order { customerId: string  status: string  total: int }
    repository Orders for Order { }

    event OrderPlaced { order: Order id, at: datetime }

    channel Lifecycle {
      carries: OrderPlaced
      delivery: broadcast
      retention: ephemeral
    }
  }
  }
  api FulfillmentApi from Shipping
  ui WebApp {
    api Fulfillment: FulfillmentApi
    channel Live: Fulfillment.Lifecycle
    on Live.OrderPlaced(e) { toast("Order " + e.order + " placed") }
    page Home { route: "/" body: Heading { "hi" } }
  }
  deployable backend {
    platform: node
    contexts: [Fulfillment]
    serves: FulfillmentApi
    port: 3000
  }
  deployable webApp {
    platform: angular
    targets: backend
    ui: WebApp { Fulfillment: backend }
    port: 3001
  }
}
`;

async function ngFiles(src: string): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web_app/")) out.set(p.slice("web_app/".length), c);
  }
  return out;
}

describe("realtime SSE wire — Angular (`on <channel>.<Event>`)", () => {
  it("emits the client, the handlers component, the toast service, and the app-shell mount", async () => {
    const out = await ngFiles(BASE);

    const client = out.get("src/api/realtime.ts") ?? "";
    expect(client).toContain('import { API_BASE_URL } from "./config";');
    expect(client).toContain('"OrderPlaced"');
    expect(client).toContain("/realtime/events");

    const handlers = out.get("src/app/realtime-handlers.component.ts") ?? "";
    expect(handlers).toContain('import { Component, DestroyRef, inject } from "@angular/core";');
    expect(handlers).toContain('import { subscribeRealtime } from "../api/realtime";');
    expect(handlers).toContain('import { LoomToastService } from "./loom-toast.service";');
    expect(handlers).toContain('selector: "app-realtime-handlers"');
    expect(handlers).toContain("const toast = inject(LoomToastService);");
    expect(handlers).toContain("const destroyRef = inject(DestroyRef);");
    expect(handlers).toContain("subscribeRealtime((event) => {");
    expect(handlers).toContain('case "OrderPlaced":');
    expect(handlers).toContain('toast.show("Order " + String(event.order ?? "") + " placed");');
    expect(handlers).toContain("destroyRef.onDestroy(unsubscribe);");
    // Toast-only handler needs no query client.
    expect(handlers).not.toContain("QueryClient");

    // The minimal toast service exists and exposes show().
    const toast = out.get("src/app/loom-toast.service.ts") ?? "";
    expect(toast).toContain('@Injectable({ providedIn: "root" })');
    expect(toast).toContain("export class LoomToastService {");
    expect(toast).toContain("show(message: string): void {");

    // The app shell imports + mounts the renderless component.
    const shell = out.get("src/app/app.component.ts") ?? "";
    expect(shell).toContain(
      'import { RealtimeHandlersComponent } from "./realtime-handlers.component";',
    );
    expect(shell).toContain("RealtimeHandlersComponent,");
    expect(shell).toContain("<app-realtime-handlers />");
  });

  it("a `refetch(Order)` handler injects the query client and invalidates the cache", async () => {
    const src = BASE.replace(
      'on Live.OrderPlaced(e) { toast("Order " + e.order + " placed") }',
      'on Live.OrderPlaced(e) { toast("Order " + e.order + " placed") refetch(Order) }',
    );
    const out = await ngFiles(src);
    const handlers = out.get("src/app/realtime-handlers.component.ts") ?? "";
    expect(handlers).toContain(
      'import { QueryClient } from "@tanstack/angular-query-experimental";',
    );
    expect(handlers).toContain("const qc = inject(QueryClient);");
    expect(handlers).toContain('case "OrderPlaced":');
    expect(handlers).toContain('qc.invalidateQueries({ queryKey: ["orders"] });');
  });

  it("emits the client but no handlers/toast/mount when the ui declares no `on` members", async () => {
    const src = BASE.replace(/ {4}channel Live:.*\n {4}on Live\..*\n/, "");
    const out = await ngFiles(src);
    expect(out.has("src/api/realtime.ts")).toBe(true);
    expect(out.has("src/app/realtime-handlers.component.ts")).toBe(false);
    expect(out.has("src/app/loom-toast.service.ts")).toBe(false);
    expect(out.get("src/app/app.component.ts") ?? "").not.toContain("RealtimeHandlersComponent");
  });

  it("emits no realtime client when the system has no broadcast channel", async () => {
    const src = BASE.replace(/ {4}channel Lifecycle \{[\s\S]*?\n {4}\}\n/, "")
      .replace(/ {4}channel Live:.*\n/, "")
      .replace(/ {4}on Live\..*\n/, "")
      .replace(/\n {4}event OrderPlaced.*\n/, "\n");
    const out = await ngFiles(src);
    expect(out.has("src/api/realtime.ts")).toBe(false);
    expect(out.has("src/app/realtime-handlers.component.ts")).toBe(false);
  });
});
