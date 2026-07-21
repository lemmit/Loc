import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Realtime SSE wire — SvelteKit frontend (channels.md Part I).
//
// Mirrors the react coverage in
// test/generator/typescript/realtime-emission.test.ts: the client
// module emits when the targeted Hono backend carries a broadcast
// channel, the RealtimeHandlers component emits when the ui declares
// `on <channel>.<Event>` members, and the root layout mounts it.
// ---------------------------------------------------------------------------

const BASE = `
system RealtimeSvelteShop {
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
    platform: svelte
    targets: backend
    ui: WebApp { Fulfillment: backend }
    port: 3001
  }
}
`;

describe("realtime SSE wire — SvelteKit (`on <channel>.<Event>`)", () => {
  it("emits the client, the handlers component, and the root-layout mount", async () => {
    const out = await generateSystemFiles(BASE);

    const client = out.get("web_app/src/lib/api/realtime.ts") ?? "";
    expect(client).toContain('import { API_BASE_URL } from "./config";');
    expect(client).toContain('"OrderPlaced"');
    expect(client).toContain("/realtime/events");

    const handlers = out.get("web_app/src/lib/components/RealtimeHandlers.svelte") ?? "";
    expect(handlers).toContain('import { subscribeRealtime } from "$lib/api/realtime";');
    expect(handlers).toContain('import { toast } from "$lib/toast.svelte";');
    expect(handlers).toContain('case "OrderPlaced":');
    expect(handlers).toContain('toast.success("Order " + String(event.order ?? "") + " placed");');
    expect(handlers).toContain("$effect(");

    const layout = out.get("web_app/src/routes/+layout.svelte") ?? "";
    expect(layout).toContain(
      'import RealtimeHandlers from "$lib/components/RealtimeHandlers.svelte";',
    );
    expect(layout).toContain("<RealtimeHandlers />");
  });

  it("a `refetch(Order)` handler invalidates the aggregate's query cache", async () => {
    const src = BASE.replace(
      'on Live.OrderPlaced(e) { toast("Order " + e.order + " placed") }',
      'on Live.OrderPlaced(e) { toast("Order " + e.order + " placed") refetch(Order) }',
    );
    const out = await generateSystemFiles(src);
    const handlers = out.get("web_app/src/lib/components/RealtimeHandlers.svelte") ?? "";
    expect(handlers).toContain('import { useQueryClient } from "@tanstack/svelte-query";');
    expect(handlers).toContain("const qc = useQueryClient();");
    expect(handlers).toContain('case "OrderPlaced":');
    expect(handlers).toContain('qc.invalidateQueries({ queryKey: ["orders"] });');
  });

  it("emits the client but no handlers component when the ui declares no `on` members", async () => {
    const src = BASE.replace(/ {4}channel Live:.*\n {4}on Live\..*\n/, "");
    const out = await generateSystemFiles(src);
    expect(out.has("web_app/src/lib/api/realtime.ts")).toBe(true);
    expect(out.has("web_app/src/lib/components/RealtimeHandlers.svelte")).toBe(false);
    expect(out.get("web_app/src/routes/+layout.svelte") ?? "").not.toContain("RealtimeHandlers");
  });

  it("emits no realtime client when the system has no broadcast channel", async () => {
    const src = BASE.replace(/ {4}channel Lifecycle \{[\s\S]*?\n {4}\}\n/, "")
      .replace(/ {4}channel Live:.*\n/, "")
      .replace(/ {4}on Live\..*\n/, "")
      .replace(/\n {4}event OrderPlaced.*\n/, "\n");
    const out = await generateSystemFiles(src);
    expect(out.has("web_app/src/lib/api/realtime.ts")).toBe(false);
    expect(out.has("web_app/src/lib/components/RealtimeHandlers.svelte")).toBe(false);
  });
});
