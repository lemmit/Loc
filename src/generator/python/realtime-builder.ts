import type { BoundedContextIR, EventIR, TypeIR } from "../../ir/types/loom-ir.js";
import { realtimeEventTypes } from "../../ir/util/channels.js";
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
// v1 topology is single-hop broadcast-to-all: no rooms, no edge relay, no
// policy-derived router (channels.md "Realtime topology").  The authorized
// read stays the gate — clients refetch through the API.
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
 *  an event (byte-identical wire-free output). */
export function buildPyRealtimeFile(ctx: BoundedContextIR): string | null {
  const types = [...realtimeEventTypes(ctx)].sort();
  if (types.length === 0) return null;
  const events = types
    .map((t) => ctx.events.find((e) => e.name === t))
    .filter((e): e is EventIR => e != null);
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
