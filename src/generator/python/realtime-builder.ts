import type { BoundedContextIR, EventIR, TypeIR } from "../../ir/types/loom-ir.js";
import { realtimeEventTypes } from "../../ir/util/channels.js";
import { type RealtimeRoomPlan, realtimeRoomPlan } from "../../ir/util/realtime-rooms.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Realtime SSE wire — `app/realtime.py` (channels.md, Part I).  Events carried
// by a `delivery: broadcast` channel stream to connected browsers at
// GET /realtime/events; the frontend `EventSource` client
// (src/generator/_frontend/realtime.ts) consumes the SAME wire the Hono
// backend serves — `event: <EventType>` frames + camelCase JSON data, a 15s
// keep-alive ping.
//
//   - `REALTIME_EVENT_TYPES` — the UI-observable set (broadcast channels'
//     carried events).
//   - `publish_realtime(event)` — fan a carried event out to every connected
//     SSE subscriber.
//   - `RealtimeDispatcher(inner)` — the dispatcher decorator `make_dispatcher`
//     wraps the in-process dispatcher with, so every dispatched event (inline
//     OR relayed from the outbox) also reaches the wire (mirrors Hono's
//     `realtimeTee`).
//   - `realtime_router` — `GET /realtime/events`, one StreamingResponse SSE
//     stream per browser connection.
//
// Two topologies (channels.md "Realtime topology" — rooms + policy-derived
// routing v1), mirroring the Hono backend: an untenanted context is
// broadcast-to-all (byte-identical); a tenant-owned context scopes delivery by
// the tenant DataKey (`currentUser.tenant_id`), so a tenant-scoped event
// reaches only subscribers in the emitter's tenant room — never cross-tenant.
// A connection derives its room from the verified principal at connect (never
// a client value); an unauthenticated connection joins no room.  The
// authorized read stays the gate either way — clients refetch through the API.
// ---------------------------------------------------------------------------

/** The camelCase JSON keyed on the DSL field name, its value converted to the
 *  same wire form the Hono backend emits (datetime → ISO string, money →
 *  precise-decimal string; ids are branded `str` NewTypes and enums are
 *  `StrEnum`, both already JSON-safe). */
function pyWireValue(access: string, t: TypeIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  const opt = t.kind === "optional";
  let base = access;
  if (inner.kind === "primitive" && inner.name === "datetime") base = `${access}.isoformat()`;
  else if (inner.kind === "primitive" && inner.name === "money") base = `str(${access})`;
  if (opt && base !== access) return `(None if ${access} is None else ${base})`;
  return base;
}

function frameArm(ev: EventIR, keyword: "if" | "elif"): string[] {
  const payload = [
    `"type": "${ev.name}"`,
    ...ev.fields.map((f) => `"${f.name}": ${pyWireValue(`event.${snake(f.name)}`, f.type)}`),
  ].join(", ");
  return [
    `    ${keyword} isinstance(event, ${ev.name}):`,
    `        data = json.dumps({${payload}})`,
    `        return f"event: ${ev.name}\\ndata: {data}\\n\\n"`,
  ];
}

/** The realtime module, or null when no `delivery: broadcast` channel carries
 *  an event (byte-identical wire-free output).  A tenant-owned context emits
 *  the room-scoped module; otherwise the v1 broadcast-to-all one. */
export function buildPyRealtimeFile(ctx: BoundedContextIR): string | null {
  const types = [...realtimeEventTypes(ctx)].sort();
  if (types.length === 0) return null;
  const events = types
    .map((t) => ctx.events.find((e) => e.name === t))
    .filter((e): e is EventIR => e != null);
  const plan = realtimeRoomPlan(ctx);
  return plan.tenantScoped
    ? buildRoomScopedRealtime(events, types, plan)
    : buildBroadcastRealtime(events, types);
}

/** v1 broadcast-to-all module — kept byte-identical for untenanted contexts. */
function buildBroadcastRealtime(events: EventIR[], types: string[]): string {
  const typeSet = types.map((t) => `"${t}"`).join(", ");

  return lines(
    `"""Realtime SSE wire (channels.md Part I).  Auto-generated.`,
    "",
    "Events carried by a `delivery: broadcast` channel stream to connected",
    "browsers at GET /realtime/events.  v1 is broadcast-to-all (no rooms, no",
    "auth beyond the ordinary session); the authorized read remains the gate —",
    "clients refetch through the API rather than trust payloads.",
    `"""`,
    "",
    "import asyncio",
    "import json",
    "from collections.abc import AsyncIterator",
    "",
    "from fastapi import APIRouter",
    "from fastapi.responses import StreamingResponse",
    "",
    `from app.domain.events import DomainEvent, DomainEventDispatcher, ${events
      .map((e) => e.name)
      .join(", ")}`,
    "",
    "# Events carried by a broadcast channel — the UI-observable set.",
    `REALTIME_EVENT_TYPES: frozenset[str] = frozenset({${typeSet}})`,
    "",
    "_subscribers: set[asyncio.Queue[str]] = set()",
    "",
    "",
    "def _event_to_frame(event: DomainEvent) -> str | None:",
    `    """One SSE frame (\`event: <Type>\` + JSON data) for a carried event,`,
    `    or None when the event isn't UI-observable."""`,
    ...events.flatMap((ev, i) => frameArm(ev, i === 0 ? "if" : "elif")),
    "    return None",
    "",
    "",
    "def publish_realtime(event: DomainEvent) -> None:",
    `    """Fan a carried event out to every connected SSE subscriber."""`,
    "    frame = _event_to_frame(event)",
    "    if frame is None:",
    "        return",
    "    for queue in _subscribers:",
    "        queue.put_nowait(frame)",
    "",
    "",
    "class RealtimeDispatcher:",
    `    """Dispatcher decorator: every dispatched event also reaches the SSE`,
    "    wire, then delegates (mirrors Hono's realtimeTee) — so durable (relayed)",
    `    and ephemeral (inline) events both stream."""`,
    "",
    "    def __init__(self, inner: DomainEventDispatcher) -> None:",
    "        self._inner = inner",
    "",
    "    async def dispatch(self, event: DomainEvent) -> None:",
    "        publish_realtime(event)",
    "        await self._inner.dispatch(event)",
    "",
    "",
    "realtime_router = APIRouter()",
    "",
    "",
    // Excluded from the OpenAPI schema: the SSE stream is transport plumbing,
    // not a REST operation — node/.NET exclude theirs too, and the
    // conformance-parity gate compares the specs across backends.
    `@realtime_router.get("/realtime/events", include_in_schema=False)`,
    "async def realtime_events() -> StreamingResponse:",
    `    """One long-lived SSE stream per browser connection, with a 15s`,
    `    keep-alive ping so proxies don't idle the connection out."""`,
    "    queue: asyncio.Queue[str] = asyncio.Queue()",
    "    _subscribers.add(queue)",
    "",
    "    async def _stream() -> AsyncIterator[str]:",
    "        try:",
    "            while True:",
    "                try:",
    "                    yield await asyncio.wait_for(queue.get(), timeout=15.0)",
    "                except TimeoutError:",
    `                    yield "event: ping\\ndata: \\n\\n"`,
    "        finally:",
    "            _subscribers.discard(queue)",
    "",
    `    return StreamingResponse(_stream(), media_type="text/event-stream")`,
    "",
  );
}

/** One refetch-ticket frame — the event's `type` plus its `<Agg> id` reference
 *  fields only (no scalar payload), for a tenant-scoped event dispatched with
 *  no ambient request. */
function ticketArm(ev: EventIR, idFields: readonly string[], keyword: "if" | "elif"): string[] {
  const payload = [
    `"type": "${ev.name}"`,
    ...idFields.map((f) => `"${f}": event.${snake(f)}`),
  ].join(", ");
  return [
    `    ${keyword} isinstance(event, ${ev.name}):`,
    `        data = json.dumps({${payload}})`,
    `        return f"event: ${ev.name}\\ndata: {data}\\n\\n"`,
  ];
}

/** The tenant-scoped module (channels.md rooms + policy-derived routing v1):
 *  the subscriber registry is keyed by the tenant DataKey; tenant-scoped events
 *  reach only the emitter's tenant room, never cross-tenant. */
function buildRoomScopedRealtime(
  events: EventIR[],
  types: string[],
  plan: RealtimeRoomPlan,
): string {
  const typeSet = types.map((t) => `"${t}"`).join(", ");
  const tenantTypes = [...plan.tenantEventTypes].sort();
  const tenantSet = tenantTypes.map((t) => `"${t}"`).join(", ");
  const tenantEvents = tenantTypes
    .map((t) => events.find((e) => e.name === t))
    .filter((e): e is EventIR => e != null);

  return lines(
    `"""Realtime SSE wire (channels.md rooms + policy-derived routing v1).  Auto-generated.`,
    "",
    "Events carried by a `delivery: broadcast` channel stream to connected",
    "browsers at GET /realtime/events.  This context hosts tenant-owned",
    "aggregates, so delivery is scoped by the tenant DataKey",
    "(`currentUser.tenant_id`): a tenant-scoped event reaches only subscribers in",
    "the emitter's tenant room — never cross-tenant.  The authorized read remains",
    "the gate — clients refetch through the API rather than trust payloads.",
    `"""`,
    "",
    "import asyncio",
    "import json",
    "from collections.abc import AsyncIterator",
    "",
    "from fastapi import APIRouter, Request",
    "from fastapi.responses import StreamingResponse",
    "",
    "from app.auth.user import User, current_user",
    `from app.domain.events import DomainEvent, DomainEventDispatcher, ${events
      .map((e) => e.name)
      .join(", ")}`,
    "",
    "# Events carried by a broadcast channel — the UI-observable set.",
    `REALTIME_EVENT_TYPES: frozenset[str] = frozenset({${typeSet}})`,
    "",
    "# Events whose payload references a `tenantOwned` aggregate — routed to the",
    "# emitter's tenant room only, never broadcast cross-tenant.",
    `TENANT_SCOPED_EVENT_TYPES: frozenset[str] = frozenset({${tenantSet}})`,
    "",
    "# Every live connection — receives tenant-agnostic (global) events and any",
    "# broadcast refetch ticket.",
    "_subscribers: set[asyncio.Queue[str]] = set()",
    "# Per-tenant rooms (key = `currentUser.tenant_id`, the tenantOwned DataKey) —",
    "# a connection joins its own tenant's room at connect.",
    "_rooms: dict[str, set[asyncio.Queue[str]]] = {}",
    "",
    "",
    "def _tenant_of(user: User | None) -> str | None:",
    `    """The connecting/emitting principal's tenant room key`,
    `    (\`currentUser.tenant_id\`, the tenantOwned DataKey), or None when there is`,
    `    no authenticated principal."""`,
    "    return None if user is None or user.tenant_id is None else str(user.tenant_id)",
    "",
    "",
    "def _event_to_frame(event: DomainEvent) -> str | None:",
    `    """One SSE frame (\`event: <Type>\` + JSON data) for a carried event,`,
    `    or None when the event isn't UI-observable."""`,
    ...events.flatMap((ev, i) => frameArm(ev, i === 0 ? "if" : "elif")),
    "    return None",
    "",
    "",
    "def _event_to_ticket(event: DomainEvent) -> str | None:",
    `    """A refetch ticket frame (\`type\` + \`<Agg> id\` fields only) for a`,
    `    tenant-scoped event dispatched with no ambient request (outbox relay`,
    `    drain / timer scheduler) — the authorized read re-gates on refetch."""`,
    ...tenantEvents.flatMap((ev, i) =>
      ticketArm(ev, plan.eventIdFields.get(ev.name) ?? [], i === 0 ? "if" : "elif"),
    ),
    "    return None",
    "",
    "",
    "def publish_realtime(event: DomainEvent) -> None:",
    `    """Fan a carried event out to the subscribers its policy admits.  A global`,
    "    event goes to every connection; a tenant-scoped event to the emitter's",
    "    tenant room only (full payload).  With no ambient tenant the subset can't",
    "    be proven, so it degrades to a refetch ticket broadcast (over-delivery of",
    `    a ticket is harmless — the authorized refetch re-gates)."""`,
    "    name = type(event).__name__",
    "    if name not in REALTIME_EVENT_TYPES:",
    "        return",
    "    if name not in TENANT_SCOPED_EVENT_TYPES:",
    "        frame = _event_to_frame(event)",
    "        if frame is not None:",
    "            for queue in _subscribers:",
    "                queue.put_nowait(frame)",
    "        return",
    "    tenant = _tenant_of(current_user())",
    "    if tenant is not None:",
    "        room = _rooms.get(tenant)",
    "        if room:",
    "            frame = _event_to_frame(event)",
    "            if frame is not None:",
    "                for queue in room:",
    "                    queue.put_nowait(frame)",
    "        return",
    "    ticket = _event_to_ticket(event)",
    "    if ticket is not None:",
    "        for queue in _subscribers:",
    "            queue.put_nowait(ticket)",
    "",
    "",
    "class RealtimeDispatcher:",
    `    """Dispatcher decorator: every dispatched event also reaches the SSE`,
    "    wire, then delegates (mirrors Hono's realtimeTee) — so durable (relayed)",
    `    and ephemeral (inline) events both stream."""`,
    "",
    "    def __init__(self, inner: DomainEventDispatcher) -> None:",
    "        self._inner = inner",
    "",
    "    async def dispatch(self, event: DomainEvent) -> None:",
    "        publish_realtime(event)",
    "        await self._inner.dispatch(event)",
    "",
    "",
    "realtime_router = APIRouter()",
    "",
    "",
    `@realtime_router.get("/realtime/events", include_in_schema=False)`,
    "async def realtime_events(request: Request) -> StreamingResponse:",
    `    """One long-lived SSE stream per browser connection, with a 15s`,
    `    keep-alive ping so proxies don't idle the connection out.  The connection`,
    `    joins its tenant's room, derived from the verified principal on the`,
    `    request (never a client value); an unauthenticated connection joins no`,
    `    room, so it never receives another tenant's payloads."""`,
    "    queue: asyncio.Queue[str] = asyncio.Queue()",
    "    _subscribers.add(queue)",
    '    tenant = _tenant_of(getattr(request.state, "current_user", None))',
    "    if tenant is not None:",
    "        _rooms.setdefault(tenant, set()).add(queue)",
    "",
    "    async def _stream() -> AsyncIterator[str]:",
    "        try:",
    "            while True:",
    "                try:",
    "                    yield await asyncio.wait_for(queue.get(), timeout=15.0)",
    "                except TimeoutError:",
    `                    yield "event: ping\\ndata: \\n\\n"`,
    "        finally:",
    "            _subscribers.discard(queue)",
    "            if tenant is not None:",
    "                room = _rooms.get(tenant)",
    "                if room is not None:",
    "                    room.discard(queue)",
    "                    if not room:",
    "                        _rooms.pop(tenant, None)",
    "",
    `    return StreamingResponse(_stream(), media_type="text/event-stream")`,
    "",
  );
}
