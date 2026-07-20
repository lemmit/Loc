import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Realtime SSE wire — Vue frontend (channels.md Part I).
//
// Mirrors test/generator/svelte/svelte-realtime.test.ts: the client
// module emits when the targeted Hono backend carries a broadcast
// channel, the renderless RealtimeHandlers component emits when the ui
// declares `on <channel>.<Event>` members, and the App shell mounts it
// alongside the toast host bound to the generated `src/lib/toast.ts`
// queue.
// ---------------------------------------------------------------------------

const BASE = `
system RealtimeVueShop {
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
    platform: vue
    targets: backend
    ui: WebApp { Fulfillment: backend }
    port: 3001
  }
}
`;

async function vueFiles(src: string): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web_app/")) out.set(p.slice("web_app/".length), c);
  }
  return out;
}

describe("realtime SSE wire — Vue (`on <channel>.<Event>`)", () => {
  it("emits the client, the handlers component, the toast queue, and the App mount", async () => {
    const out = await vueFiles(BASE);

    const client = out.get("src/api/realtime.ts") ?? "";
    expect(client).toContain('import { API_BASE_URL } from "./config";');
    expect(client).toContain('"OrderPlaced"');
    expect(client).toContain("/realtime/events");

    const handlers = out.get("src/components/RealtimeHandlers.vue") ?? "";
    expect(handlers).toContain('import { subscribeRealtime } from "../api/realtime";');
    expect(handlers).toContain('import { pushToast } from "../lib/toast";');
    expect(handlers).toContain('case "OrderPlaced":');
    expect(handlers).toContain('pushToast("Order " + String(event.order ?? "") + " placed");');
    expect(handlers).toContain("onMounted(");
    expect(handlers).toContain("onUnmounted(");

    // The toast queue runtime exists and exports pushToast.
    const toast = out.get("src/lib/toast.ts") ?? "";
    expect(toast).toContain("export function pushToast(");
    expect(toast).toContain("export const toastQueue");

    // App.vue imports + mounts the renderless component and the host.
    const app = out.get("src/App.vue") ?? "";
    expect(app).toContain('import RealtimeHandlers from "./components/RealtimeHandlers.vue";');
    expect(app).toContain('import { toastQueue } from "./lib/toast";');
    expect(app).toContain("<RealtimeHandlers />");
    expect(app).toContain('data-testid="channel-toast"');
    expect(app).toContain("{{ t.message }}");
  });

  it("a `refetch(Order)` handler invalidates the aggregate's query cache", async () => {
    const src = BASE.replace(
      'on Live.OrderPlaced(e) { toast("Order " + e.order + " placed") }',
      'on Live.OrderPlaced(e) { toast("Order " + e.order + " placed") refetch(Order) }',
    );
    const out = await vueFiles(src);
    const handlers = out.get("src/components/RealtimeHandlers.vue") ?? "";
    expect(handlers).toContain('import { useQueryClient } from "@tanstack/vue-query";');
    expect(handlers).toContain("const qc = useQueryClient();");
    expect(handlers).toContain('case "OrderPlaced":');
    expect(handlers).toContain('qc.invalidateQueries({ queryKey: ["orders"] });');
  });

  it("emits the client but no handlers/toast when the ui declares no `on` members", async () => {
    const src = BASE.replace(/ {4}channel Live:.*\n {4}on Live\..*\n/, "");
    const out = await vueFiles(src);
    expect(out.has("src/api/realtime.ts")).toBe(true);
    expect(out.has("src/components/RealtimeHandlers.vue")).toBe(false);
    expect(out.has("src/lib/toast.ts")).toBe(false);
    expect(out.get("src/App.vue") ?? "").not.toContain("RealtimeHandlers");
  });

  it("emits no realtime client when the system has no broadcast channel", async () => {
    const src = BASE.replace(/ {4}channel Lifecycle \{[\s\S]*?\n {4}\}\n/, "")
      .replace(/ {4}channel Live:.*\n/, "")
      .replace(/ {4}on Live\..*\n/, "")
      .replace(/\n {4}event OrderPlaced.*\n/, "\n");
    const out = await vueFiles(src);
    expect(out.has("src/api/realtime.ts")).toBe(false);
    expect(out.has("src/components/RealtimeHandlers.vue")).toBe(false);
  });
});
