// Realtime SSE wire (channels.md, Part I): events carried by a
// `delivery: broadcast` channel stream to connected browsers.  The Hono
// backend emits `http/realtime.ts` (REALTIME_EVENT_TYPES + publishRealtime +
// realtimeTee + GET /realtime/events via streamSSE) and createApp wraps its
// default dispatcher in the tee; the React generator emits the matching
// `src/api/realtime.ts` EventSource client when the targeted backend is
// Hono.  A project with no broadcast channel keeps its output byte-identical
// (no realtime file, no tee, no mount).
//
// v1 topology is broadcast-to-all (no rooms / edge relay / policy router —
// those layer on the authorization work).  The authorized read remains the
// gate: clients refetch through the API rather than trust payloads.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateTypeScript } from "../../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS } from "../../../src/platform/hono/v4/pins.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");

async function generate(file: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(root, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  expect(
    errors.map((d) => d.message),
    "fixture validation errors",
  ).toEqual([]);
  return generateTypeScript(doc.parseResult.value as Model, BACKEND_PINS);
}

describe("realtime SSE wire — Hono (delivery: broadcast)", () => {
  it("emits http/realtime.ts with the event-type set, the tee, and the SSE route", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");
    const rt = files.get("http/realtime.ts") ?? "";
    expect(rt).toContain(
      'export const REALTIME_EVENT_TYPES: ReadonlySet<string> = new Set(["OrderPlaced", "ShipmentRequested"]);',
    );
    expect(rt).toContain("export function publishRealtime(event: Events.DomainEvent): void {");
    expect(rt).toContain("if (!REALTIME_EVENT_TYPES.has(event.type)) return;");
    expect(rt).toContain(
      "export function realtimeTee(inner: DomainEventDispatcher): DomainEventDispatcher {",
    );
    expect(rt).toContain('import { streamSSE } from "hono/streaming";');
    expect(rt).toContain("stream.writeSSE({ data: JSON.stringify(event), event: event.type })");
    expect(rt).toContain('await stream.writeSSE({ data: "", event: "ping" });');
  });

  it("createApp tees its default dispatcher and mounts /realtime", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");
    const idx = files.get("http/index.ts") ?? "";
    expect(idx).toContain('import { realtimeRoutes, realtimeTee } from "./realtime";');
    expect(idx).toContain(
      "events: DomainEventDispatcher = realtimeTee(createInProcessDispatcher(db)),",
    );
    expect(idx).toContain('app.route("/api/realtime", realtimeRoutes());');
  });

  it("a durable broadcast channel composes outbox → tee → in-process (relay included)", async () => {
    const files = await generate("test/fixtures/outbox-sample.ddd");
    expect(files.get("http/index.ts") ?? "").toContain(
      "events: DomainEventDispatcher = createOutboxDispatcher(db, realtimeTee(createInProcessDispatcher(db))),",
    );
    // The relay's inner dispatcher rides through the tee too, so relayed
    // (durable) events also reach connected SSE subscribers.
    const boot = files.get("index.ts") ?? "";
    expect(boot).toContain('import { realtimeTee } from "./http/realtime";');
    expect(boot).toContain("const inProcessEvents = realtimeTee(createInProcessDispatcher(db));");
    expect(boot).toContain("const stopOutboxRelay = startOutboxRelay(db, inProcessEvents);");
  });

  it("a project with no broadcast channel keeps the wire-free output", async () => {
    const files = await generate("examples/sales.ddd");
    expect(files.has("http/realtime.ts")).toBe(false);
    const idx = files.get("http/index.ts") ?? "";
    expect(idx).not.toContain("realtimeTee");
    expect(idx).not.toContain("/realtime");
  });
});

// ─── Rooms + policy-derived routing v1 (tenant-scoped delivery) ─────────────

const TENANT_REALTIME_SYSTEM = `
system TenantRealtime {
  user { id: guid  tenantId: string }
  tenancy by user.tenantId of Organization
  subdomain Core {
  context Fulfillment {
    aggregate Order with tenantOwned, crudish { status: string }
    repository Orders for Order { }
    crossTenant aggregate Plan with crudish { code: string }
    repository Plans for Plan { }
    aggregate Organization with crudish { name: string }

    event OrderPlaced { order: Order id, at: datetime }
    event PlanPublished { plan: Plan id, at: datetime }

    channel Lifecycle {
      carries: OrderPlaced, PlanPublished
      delivery: broadcast
      retention: ephemeral
    }
  }
  }
  api FulfillmentApi from Core
  storage primary { type: postgres }
  resource coreState { for: Fulfillment, kind: state, use: primary }
  deployable backend {
    platform: node
    contexts: [Fulfillment]
    dataSources: [coreState]
    serves: FulfillmentApi
    port: 3000
    auth: required
  }
}
`;

describe("realtime rooms — Hono (tenant-scoped delivery)", () => {
  async function backendRealtime(source: string): Promise<string> {
    const model = await parseValid(source);
    const { files } = generateSystems(model);
    const key = [...files.keys()].find((k) => k.endsWith("backend/http/realtime.ts"));
    expect(key, "backend realtime.ts emitted").toBeTruthy();
    return files.get(key ?? "") ?? "";
  }

  it("keys the registry by tenant and scopes only tenantOwned-referencing events", async () => {
    const rt = await backendRealtime(TENANT_REALTIME_SYSTEM);
    // Both carried events are UI-observable...
    expect(rt).toContain(
      'export const REALTIME_EVENT_TYPES: ReadonlySet<string> = new Set(["OrderPlaced", "PlanPublished"]);',
    );
    // ...but only OrderPlaced references the tenant-owned Order — PlanPublished
    // references the crossTenant Plan, so it stays a global broadcast.
    expect(rt).toContain(
      'const TENANT_SCOPED_EVENT_TYPES: ReadonlySet<string> = new Set(["OrderPlaced"]);',
    );
    expect(rt).toContain('OrderPlaced: ["order"],');
    // The tenant DataKey comes from the ambient principal at publish and the
    // verified principal at connect.
    expect(rt).toContain('import { requestContext } from "../obs/als";');
    expect(rt).toContain("const rooms = new Map<string, Set<Subscriber>>();");
    expect(rt).toContain("function ambientTenant(): string | undefined {");
    expect(rt).toContain(
      "const user = requestContext()?.currentUser as { tenantId?: unknown } | undefined;",
    );
    // Publish routes tenant-scoped events to the emitter's room, never all.
    expect(rt).toContain("if (!TENANT_SCOPED_EVENT_TYPES.has(event.type)) {");
    expect(rt).toContain("const room = rooms.get(tenant);");
    // Connect derives the room from the verified principal (never client-supplied).
    expect(rt).toContain('.get("currentUser");');
    expect(rt).toContain("const room = tenant !== undefined ? roomFor(tenant) : undefined;");
  });

  it("an untenanted broadcast context keeps the v1 wire byte-identical (no rooms)", async () => {
    const rt = await backendRealtime(REALTIME_SYSTEM);
    expect(rt).not.toContain("TENANT_SCOPED_EVENT_TYPES");
    expect(rt).not.toContain("const rooms = new Map");
    expect(rt).not.toContain("requestContext");
    // The v1 broadcast body is preserved verbatim.
    expect(rt).toContain("const subscribers = new Set<Subscriber>();");
    expect(rt).toContain("for (const s of subscribers) s(event);");
    expect(rt).toContain("v1 is broadcast-to-all (no rooms); the");
  });
});

// ─── React client ────────────────────────────────────────────────────────────

const REALTIME_SYSTEM = `
system RealtimeShop {
  subdomain Shipping {
  context Fulfillment {
    aggregate Order { customerId: string  status: string  total: int }
    repository Orders for Order { }
    aggregate Shipment {
      orderRef: Order id
      status: string
      operation markTracked() { status := "Tracked" }
    }
    repository Shipments for Shipment { }

    event OrderPlaced { order: Order id, at: datetime }
    event ShipmentRequested { shipment: Shipment id, order: Order id, at: datetime }

    channel Lifecycle {
      carries: OrderPlaced, ShipmentRequested
      delivery: broadcast
      retention: ephemeral
    }

    workflow OrderFulfillment {
      orderId: Order id
      create(p: OrderPlaced) by p.order {
        let ship = Shipment.create({ orderRef: p.order, status: "Pending" })
        emit ShipmentRequested { shipment: ship.id, order: p.order, at: now() }
      }
      on(s: ShipmentRequested) by s.order {
        let ship = Shipments.getById(s.shipment)
        ship.markTracked()
      }
    }
  }
  }
  api FulfillmentApi from Shipping
  ui WebApp {
    api Fulfillment: FulfillmentApi
    page Home { route: "/" body: Heading { "hi" } }
  }
  deployable backend {
    platform: node
    contexts: [Fulfillment]
    serves: FulfillmentApi
    port: 3000
  }
  deployable webApp {
    platform: static
    targets: backend
    ui: WebApp { Fulfillment: backend }
    port: 3001
  }
}
`;

describe("realtime SSE client — React", () => {
  it("emits src/api/realtime.ts when the targeted Hono backend has a broadcast channel", async () => {
    const model = await parseValid(REALTIME_SYSTEM);
    const { files } = generateSystems(model);
    const key = [...files.keys()].find((k) => k.endsWith("web_app/src/api/realtime.ts"));
    expect(key, "react realtime client emitted").toBeTruthy();
    const client = files.get(key ?? "") ?? "";
    expect(client).toContain(
      'export const REALTIME_EVENT_TYPES = ["OrderPlaced", "ShipmentRequested"] as const;',
    );
    expect(client).toContain(
      "export function subscribeRealtime(onEvent: (event: RealtimeEvent) => void): () => void {",
    );
    // The react config module exports `API_BASE_URL` (the shared
    // `src/util/api-base.ts` emitter), so the realtime client imports + uses
    // that symbol — matching svelte/vue, not the historical `API_BASE`.
    expect(client).toContain('import { API_BASE_URL } from "./config";');
    expect(client).toContain("new EventSource(`${API_BASE_URL}/realtime/events`)");
    expect(client).toContain(
      "for (const t of REALTIME_EVENT_TYPES) source.addEventListener(t, handler);",
    );
    expect(client).toContain("return () => source.close();");
    // The backend side of the same system carries the wire.
    expect([...files.keys()].some((k) => k.endsWith("backend/http/realtime.ts"))).toBe(true);
  });

  it("emits no client when the system has no broadcast channel", async () => {
    const model = await parseValid(
      REALTIME_SYSTEM.replace("delivery: broadcast", "delivery: queue"),
    );
    const { files } = generateSystems(model);
    expect([...files.keys()].some((k) => k.endsWith("/src/api/realtime.ts"))).toBe(false);
    expect([...files.keys()].some((k) => k.endsWith("/http/realtime.ts"))).toBe(false);
  });
});

// ─── Live-event handlers (`channel` / `on` ui surface) ──────────────────────

const HANDLERS_UI = `
  ui WebApp {
    api Fulfillment: FulfillmentApi
    channel Orders: Fulfillment.Lifecycle
    on Orders.OrderPlaced(e) { toast("Order " + e.order + " placed") }
    page Home { route: "/" body: Heading { "hi" } }
  }`;

const HANDLERS_SYSTEM = REALTIME_SYSTEM.replace(
  / {2}ui WebApp \{[\s\S]*?\n {2}\}/,
  HANDLERS_UI.trimStart().replace(/^/, "  "),
);

describe("realtime live-event handlers — React (`on <channel>.<Event>`)", () => {
  it("emits RealtimeHandlers.tsx with the pack toast and mounts it in App", async () => {
    const model = await parseValid(HANDLERS_SYSTEM);
    const { files } = generateSystems(model);
    const key = [...files.keys()].find((k) =>
      k.endsWith("web_app/src/components/RealtimeHandlers.tsx"),
    );
    expect(key, "RealtimeHandlers emitted").toBeTruthy();
    const rh = files.get(key ?? "") ?? "";
    expect(rh).toContain('import { subscribeRealtime } from "../api/realtime";');
    // Default design is mantine — the pack's `realtime-toast` template.
    expect(rh).toContain('import { notifications } from "@mantine/notifications";');
    expect(rh).toContain('case "OrderPlaced":');
    expect(rh).toContain(
      'notifications.show({ message: "Order " + String(event.order ?? "") + " placed" });',
    );
    const app = files.get(key!.replace("src/components/RealtimeHandlers.tsx", "src/App.tsx")) ?? "";
    expect(app).toContain('import { RealtimeHandlers } from "./components/RealtimeHandlers";');
    expect(app).toContain("<RealtimeHandlers />");
  });

  it("a ui without handlers gets no component and an unchanged App shell", async () => {
    const model = await parseValid(REALTIME_SYSTEM);
    const { files } = generateSystems(model);
    expect([...files.keys()].some((k) => k.endsWith("/RealtimeHandlers.tsx"))).toBe(false);
    const appKey = [...files.keys()].find((k) => k.endsWith("web_app/src/App.tsx"));
    expect(files.get(appKey ?? "") ?? "").not.toContain("RealtimeHandlers");
  });

  it("a `refetch(Order)` handler invalidates the aggregate's query cache", async () => {
    // Same `["orders"]` key `useCreateOrder`/`useDeleteOrder` invalidate on
    // success — a realtime event refetches through the identical cache entry.
    const refetchUi = HANDLERS_UI.replace(
      'on Orders.OrderPlaced(e) { toast("Order " + e.order + " placed") }',
      'on Orders.OrderPlaced(e) { toast("Order " + e.order + " placed") refetch(Order) }',
    );
    const system = REALTIME_SYSTEM.replace(
      / {2}ui WebApp \{[\s\S]*?\n {2}\}/,
      refetchUi.trimStart().replace(/^/, "  "),
    );
    const model = await parseValid(system);
    const { files } = generateSystems(model);
    const key = [...files.keys()].find((k) =>
      k.endsWith("web_app/src/components/RealtimeHandlers.tsx"),
    );
    const rh = files.get(key ?? "") ?? "";
    expect(rh).toContain('import { useQueryClient } from "@tanstack/react-query";');
    expect(rh).toContain("const qc = useQueryClient();");
    expect(rh).toContain('case "OrderPlaced":');
    expect(rh).toContain('qc.invalidateQueries({ queryKey: ["orders"] });');
  });
});
