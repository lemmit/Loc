// Realtime SSE wire (channels.md, Part I — "WebSockets / SSE are an
// infrastructural concern").  Emitted as `http/realtime.ts` when the
// context declares any `delivery: broadcast` channel:
//
//   - `REALTIME_EVENT_TYPES` — the UI-observable set (broadcast channels'
//     carried events; `queue` channels are work distribution, never
//     browser-observable).
//   - `publishRealtime(event)` — fan a carried event out to the connected SSE
//     subscribers its policy admits.
//   - `realtimeTee(inner)` — the dispatcher decorator createApp wraps its
//     default with, so every dispatched event (inline OR relayed from the
//     outbox) also reaches the wire.
//   - `realtimeRoutes()` — `GET /realtime/events`, one SSE stream per
//     browser connection with a 15s keep-alive ping.
//
// Two topologies (channels.md "Realtime topology" — rooms + policy-derived
// routing v1):
//
//   - Untenanted context (no `tenantOwned` aggregate): single-hop
//     broadcast-to-all, byte-identical to the v1 wire.  The gate stays the
//     authorized read — SSE carries payloads/tickets, the refetch decides
//     what a client may see.
//   - Tenant-owned context: delivery is scoped by the tenant DataKey
//     (`currentUser.tenantId`, the equality part of the `tenantOwned` read
//     policy).  A tenant-scoped event reaches only subscribers in the
//     emitter's tenant room — never cross-tenant.  A connection derives its
//     room from the verified principal at connect (never a client-supplied
//     value); an unauthenticated connection joins no room.

import type { EnrichedBoundedContextIR } from "../../../ir/types/loom-ir.js";
import { realtimeEventTypes } from "../../../ir/util/channels.js";
import { type RealtimeRoomPlan, realtimeRoomPlan } from "../../../ir/util/realtime-rooms.js";

export function buildRealtimeFile(ctx: EnrichedBoundedContextIR): string | null {
  const types = [...realtimeEventTypes(ctx)].sort();
  if (types.length === 0) return null;
  const typeList = types.map((t) => JSON.stringify(t)).join(", ");
  const plan = realtimeRoomPlan(ctx);
  // A context with no tenant-owned aggregate keeps the v1 broadcast wire
  // byte-for-byte (fixture-gated) — rooms buy nothing when there is no
  // DataKey to scope by.
  return plan.tenantScoped
    ? buildRoomScopedRealtime(typeList, plan)
    : buildBroadcastRealtime(typeList);
}

/** v1 broadcast-to-all wire — kept byte-identical for untenanted contexts. */
function buildBroadcastRealtime(typeList: string): string {
  return `// Auto-generated.  Do not edit by hand.
// Realtime SSE wire (channels.md, Part I): events carried by a
// \`delivery: broadcast\` channel stream to connected browsers at
// GET /realtime/events.  v1 is broadcast-to-all (no rooms); the
// authorized read remains the gate — clients refetch through it.
import { OpenAPIHono } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import type { DomainEventDispatcher } from "../domain/events";
import type * as Events from "../domain/events";

/** Events carried by a broadcast channel — the UI-observable set. */
export const REALTIME_EVENT_TYPES: ReadonlySet<string> = new Set([${typeList}]);

type Subscriber = (event: Events.DomainEvent) => void;
const subscribers = new Set<Subscriber>();

/** Fan a carried event out to every connected SSE subscriber. */
export function publishRealtime(event: Events.DomainEvent): void {
  if (!REALTIME_EVENT_TYPES.has(event.type)) return;
  for (const s of subscribers) s(event);
}

/** Dispatcher decorator: every dispatched event also reaches the SSE
 *  wire (then delegates).  createApp wraps its default dispatcher with
 *  this, and the outbox relay's inner dispatcher rides through it too —
 *  so durable (relayed) and ephemeral (inline) events both stream. */
export function realtimeTee(inner: DomainEventDispatcher): DomainEventDispatcher {
  return {
    async dispatch(event: Events.DomainEvent): Promise<void> {
      publishRealtime(event);
      await inner.dispatch(event);
    },
  };
}

/** The SSE endpoint — one long-lived stream per browser connection.
 *  Each event writes \`event: <Type>\` + the JSON payload; a comment-only
 *  ping every 15s keeps proxies from idling the connection out. */
export function realtimeRoutes(): OpenAPIHono {
  const app = new OpenAPIHono();
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const sub: Subscriber = (event) => {
        void stream.writeSSE({ data: JSON.stringify(event), event: event.type });
      };
      subscribers.add(sub);
      stream.onAbort(() => {
        subscribers.delete(sub);
      });
      while (!stream.aborted) {
        await stream.writeSSE({ data: "", event: "ping" });
        await stream.sleep(15000);
      }
    }),
  );
  return app;
}
`;
}

/** Tenant-scoped wire — the relay's connection registry is keyed by the
 *  tenant DataKey; tenant-scoped events reach only the emitter's tenant room
 *  (channels.md rooms + policy-derived routing v1). */
function buildRoomScopedRealtime(typeList: string, plan: RealtimeRoomPlan): string {
  const tenantTypes = [...plan.tenantEventTypes].sort();
  const tenantList = tenantTypes.map((t) => JSON.stringify(t)).join(", ");
  // Event names are grammar `ID`s (valid JS identifiers), so bare object keys
  // — Biome's recommended `useLiteralKeys` rejects needless quoting.
  const idFieldEntries = tenantTypes
    .map((t) => {
      const fields = plan.eventIdFields.get(t) ?? [];
      return `  ${t}: [${fields.map((f) => JSON.stringify(f)).join(", ")}],`;
    })
    .join("\n");
  return `// Auto-generated.  Do not edit by hand.
// Realtime SSE wire (channels.md — rooms + policy-derived routing v1).
// Events carried by a \`delivery: broadcast\` channel stream to connected
// browsers at GET /realtime/events.  This context hosts tenant-owned
// aggregates, so delivery is scoped by the tenant DataKey
// (\`currentUser.tenantId\`, the equality part of the \`tenantOwned\` read
// policy): a tenant-scoped event reaches only subscribers in the emitter's
// tenant room — never cross-tenant.  The authorized read remains the gate;
// clients refetch through it.
import { OpenAPIHono } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import type { DomainEventDispatcher } from "../domain/events";
import type * as Events from "../domain/events";
import { requestContext } from "../obs/als";

/** Events carried by a broadcast channel — the UI-observable set. */
export const REALTIME_EVENT_TYPES: ReadonlySet<string> = new Set([${typeList}]);

/** Events whose payload references a \`tenantOwned\` aggregate — routed to the
 *  emitter's tenant room only, never broadcast cross-tenant. */
const TENANT_SCOPED_EVENT_TYPES: ReadonlySet<string> = new Set([${tenantList}]);

/** Id-reference (\`<Agg> id\`) fields kept when a tenant-scoped event can't be
 *  tenant-routed (dispatched with no ambient request — outbox relay drain /
 *  timer scheduler): it degrades to a refetch ticket (type + ids, no scalar
 *  payload) and the authorized read re-gates on refetch. */
const EVENT_ID_FIELDS: Record<string, readonly string[]> = {
${idFieldEntries}
};

/** A full event or a refetch ticket — both discriminate on \`type\`. */
type RealtimeFrame = Events.DomainEvent | ({ type: string } & Record<string, unknown>);
type Subscriber = (frame: RealtimeFrame) => void;

/** Every live connection — receives tenant-agnostic (global) events and any
 *  broadcast refetch ticket. */
const subscribers = new Set<Subscriber>();
/** Per-tenant rooms — a connection joins its own tenant's room at connect
 *  (key = \`currentUser.tenantId\`, the tenantOwned DataKey). */
const rooms = new Map<string, Set<Subscriber>>();

function roomFor(tenant: string): Set<Subscriber> {
  let room = rooms.get(tenant);
  if (!room) {
    room = new Set();
    rooms.set(tenant, room);
  }
  return room;
}

/** The writing request's tenant, off the ambient AsyncLocalStorage frame —
 *  present for inline-dispatched events (the write that caused them),
 *  undefined outside a request (outbox relay drain / timer scheduler). */
function ambientTenant(): string | undefined {
  const user = requestContext()?.currentUser as { tenantId?: unknown } | undefined;
  return typeof user?.tenantId === "string" ? user.tenantId : undefined;
}

/** Strip a tenant-scoped event to a refetch ticket — its type plus the
 *  \`<Agg> id\` reference fields, no other payload. */
function ticketOf(event: Events.DomainEvent): { type: string } & Record<string, unknown> {
  const ticket: Record<string, unknown> = { type: event.type };
  for (const f of EVENT_ID_FIELDS[event.type] ?? []) {
    ticket[f] = (event as unknown as Record<string, unknown>)[f];
  }
  return ticket as { type: string } & Record<string, unknown>;
}

/** Fan a carried event out to the subscribers its policy admits.  A global
 *  event goes to every connection; a tenant-scoped event goes to the
 *  emitter's tenant room only (full payload — same-tenant is a subset of the
 *  authorized audience).  With no ambient tenant the subset can't be proven,
 *  so it degrades to a refetch ticket broadcast (over-delivery of a ticket is
 *  harmless — the authorized refetch re-gates). */
export function publishRealtime(event: Events.DomainEvent): void {
  if (!REALTIME_EVENT_TYPES.has(event.type)) return;
  if (!TENANT_SCOPED_EVENT_TYPES.has(event.type)) {
    for (const s of subscribers) s(event);
    return;
  }
  const tenant = ambientTenant();
  if (tenant !== undefined) {
    const room = rooms.get(tenant);
    if (room) for (const s of room) s(event);
    return;
  }
  const ticket = ticketOf(event);
  for (const s of subscribers) s(ticket);
}

/** Dispatcher decorator: every dispatched event also reaches the SSE
 *  wire (then delegates).  createApp wraps its default dispatcher with
 *  this, and the outbox relay's inner dispatcher rides through it too —
 *  so durable (relayed) and ephemeral (inline) events both stream. */
export function realtimeTee(inner: DomainEventDispatcher): DomainEventDispatcher {
  return {
    async dispatch(event: Events.DomainEvent): Promise<void> {
      publishRealtime(event);
      await inner.dispatch(event);
    },
  };
}

/** The SSE endpoint — one long-lived stream per browser connection.  The
 *  connection joins its tenant's room (derived from the verified principal on
 *  the request, never a client-supplied value); an unauthenticated connection
 *  joins no room, so it never receives another tenant's payloads.  Each frame
 *  writes \`event: <Type>\` + JSON; a comment-only ping every 15s keeps proxies
 *  from idling the connection out. */
export function realtimeRoutes(): OpenAPIHono {
  const app = new OpenAPIHono();
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const principal = (
        c as unknown as { get(k: "currentUser"): { tenantId?: unknown } | undefined }
      ).get("currentUser");
      const tenant = typeof principal?.tenantId === "string" ? principal.tenantId : undefined;
      const sub: Subscriber = (frame) => {
        void stream.writeSSE({ data: JSON.stringify(frame), event: frame.type });
      };
      subscribers.add(sub);
      const room = tenant !== undefined ? roomFor(tenant) : undefined;
      room?.add(sub);
      stream.onAbort(() => {
        subscribers.delete(sub);
        room?.delete(sub);
      });
      while (!stream.aborted) {
        await stream.writeSSE({ data: "", event: "ping" });
        await stream.sleep(15000);
      }
    }),
  );
  return app;
}
`;
}
