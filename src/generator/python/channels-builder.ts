import type { EventIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import type { BrokerBinding } from "../_channels/bindings.js";
import { fromPayload, toPayload } from "./dispatch-builder.js";

// ---------------------------------------------------------------------------
// `app/channels.py` — the broker transport module (M-T4.4 slice 2b, the
// Python leg of the Hono reference driver in
// src/generator/typescript/emit/channels.ts).  Emitted only when the
// deployable wires a redis-bound `broadcast`/`ephemeral` channelSource via
// `channels:`; channel-less projects stay byte-identical.
//
// Carries the CloudEvents 1.0 envelope (same field pin —
// src/util/channels.ts), the redis.asyncio pub/sub driver against the
// compose-provisioned Valkey sidecar, the producer publish half of the
// delivery-uniformity rule (design §4: a broker-routed event is PUBLISHED,
// not fanned out locally — the tee itself lives in app/dispatch.py's
// `make_dispatcher`), and the consumer loop feeding received envelopes into
// the same in-process dispatcher local reactors use.
//
// Wire parity with the Hono driver: envelope `data` is keyed by the DSL
// field names (Hono events carry them verbatim; the Python dataclasses are
// snake_case, so the codec arms map both directions), datetimes travel as
// ISO-8601 strings, money as decimal strings.
// ---------------------------------------------------------------------------

function uniqueBindings(bindings: BrokerBinding[]): BrokerBinding[] {
  const seen = new Set<string>();
  return bindings.filter((b) => {
    if (seen.has(b.csName)) return false;
    seen.add(b.csName);
    return true;
  });
}

export function buildPyChannelsFile(
  bindings: BrokerBinding[],
  /** The carried events' IRs (foreign ones already resolved system-wide by
   *  the orchestrator) — drives the envelope (de)serialiser arms. */
  carriedEvents: EventIR[],
  /** True when a hosted workflow reactor subscribes to a carried event —
   *  gates the consumer loop (a pure producer ships publish-only). */
  hasChannelConsumers: boolean,
): string {
  const unique = uniqueBindings(bindings);
  // event type -> address of the (first) carrying broker-bound channel;
  // mirrors the in-process dispatcher's first-by-declaration routing rule.
  const routing = new Map<string, string>();
  for (const b of unique) {
    for (const ev of b.events) {
      if (!routing.has(ev)) routing.set(ev, b.address);
    }
  }
  const carried = carriedEvents.filter((e) => routing.has(e.name));
  const toArms = carried.flatMap((ev, i) => [
    `    ${i === 0 ? "if" : "elif"} isinstance(event, ${ev.name}):`,
    `        return {${ev.fields.map((f) => `"${f.name}": ${toPayload(`event.${snake(f.name)}`, f.type)}`).join(", ")}}`,
  ]);
  const fromArms = carried.flatMap((ev, i) => [
    `    ${i === 0 ? "if" : "elif"} event_type == "${ev.name}":`,
    `        return ${ev.name}(${ev.fields.map((f) => `${snake(f.name)}=${fromPayload(f.name, f.type)}`).join(", ")})`,
  ]);
  const codec = lines(
    "def _event_to_data(event: DomainEvent) -> dict[str, object]:",
    ...toArms,
    `    raise ValueError(f"event not carried by a wired channel: {type(event).__name__}")`,
    "",
    "",
    "def _event_from_data(event_type: str, payload: dict[str, object]) -> DomainEvent:",
    ...fromArms,
    `    raise ValueError(f"unknown carried event type: {event_type}")`,
  );
  const scan = codec.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);

  const eventNames = carried.map((e) => e.name).sort();
  const idNames = [
    ...new Set(
      carried.flatMap((e) =>
        e.fields
          .map((f) => (f.type.kind === "optional" ? f.type.inner : f.type))
          .filter((t): t is Extract<typeof t, { kind: "id" }> => t.kind === "id")
          .map((t) => t.targetName),
      ),
    ),
  ].sort();
  const enumNames = [
    ...new Set(
      carried.flatMap((e) =>
        e.fields
          .map((f) => (f.type.kind === "optional" ? f.type.inner : f.type))
          .filter((t): t is Extract<typeof t, { kind: "enum" }> => t.kind === "enum")
          .map((t) => t.name),
      ),
    ),
  ].sort();

  return lines(
    `"""Broker channel transport (channels.md; M-T4.4).  Auto-generated.`,
    "",
    "Redis/Valkey pub/sub carries CloudEvents 1.0 envelopes between",
    "deployables; the consumer loop feeds received events into the same",
    "in-process dispatcher local reactors use.  The publish half of the",
    "delivery-uniformity tee lives here (`publish_event`); the tee itself",
    "wraps `make_dispatcher` in app.dispatch.",
    `"""`,
    "",
    hasChannelConsumers ? "import asyncio" : null,
    "import json",
    "import os",
    "from datetime import UTC, datetime",
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    // `get_message` narrows redis-py's Any-typed pubsub surface with `cast`
    // in every shape; the consumer block adds the envelope-field narrows.
    "from typing import cast",
    "",
    "import redis.asyncio as aioredis",
    hasChannelConsumers ? "from sqlalchemy.ext.asyncio import AsyncSession" : null,
    "from uuid6 import uuid7",
    "",
    hasChannelConsumers ? "from app.db.engine import engine" : null,
    `from app.domain.events import ${["DomainEvent", ...eventNames].join(", ")}`,
    idNames.length > 0
      ? `from app.domain.ids import ${idNames.map((n) => `${n}Id`).join(", ")}`
      : null,
    enumNames.length > 0 ? `from app.domain.value_objects import ${enumNames.join(", ")}` : null,
    "from app.obs.log import log",
    "",
    "# The deployable's wired bindings: broker address per channelSource, with",
    "# the connection URL injected by compose/k8s as LOOM_CHANNEL_<NAME>_URL.",
    "CHANNEL_BINDINGS: list[dict[str, str]] = [",
    ...unique.map(
      (b) =>
        `    {"cs_name": ${JSON.stringify(b.csName)}, "address": ${JSON.stringify(b.address)}, "env_var": ${JSON.stringify(b.envVar)}, "context": ${JSON.stringify(b.contextName)}},`,
    ),
    "]",
    "",
    "# event type -> broker address (first carrying broker-bound channel,",
    "# mirroring the in-process dispatcher's first-by-declaration rule).",
    "CHANNEL_ROUTING: dict[str, str] = {",
    ...[...routing.entries()].map(([ev, addr]) => `    "${ev}": ${JSON.stringify(addr)},`),
    "}",
    "",
    "",
    codec,
    "",
    "",
    "class RedisChannelTransport:",
    `    """Redis (Valkey) driver — pub/sub over redis.asyncio.  A dedicated`,
    "    connection is required for subscribe mode by the redis protocol.",
    `    """`,
    "",
    "    def __init__(self, url: str) -> None:",
    "        self._pub = aioredis.Redis.from_url(url)",
    "        self._sub = self._pub.pubsub()",
    "",
    "    async def publish(self, address: str, envelope: dict[str, object]) -> None:",
    "        await self._pub.publish(address, json.dumps(envelope))",
    "",
    "    async def subscribe(self, *addresses: str) -> None:",
    "        await self._sub.subscribe(*addresses)",
    "",
    '    async def get_message(self, timeout: float) -> "dict[str, object] | None":',
    "        # redis-py's pubsub surface is Any-typed; narrow at the boundary.",
    "        message = await self._sub.get_message(ignore_subscribe_messages=True, timeout=timeout)",
    '        return cast("dict[str, object] | None", message)',
    "",
    "    async def close(self) -> None:",
    "        await self._sub.aclose()",
    "        await self._pub.aclose()",
    "",
    "",
    "# One shared transport per broker URL for the process (publisher tee and",
    "# consumer loop reuse the same connections), keyed by channelSource name.",
    "_transports: dict[str, RedisChannelTransport] = {}",
    "",
    "",
    "def init_channel_transports() -> None:",
    "    by_url: dict[str, RedisChannelTransport] = {}",
    "    for binding in CHANNEL_BINDINGS:",
    '        url = os.environ.get(binding["env_var"])',
    "        if not url:",
    "            raise RuntimeError(",
    "                f\"channel binding '{binding['cs_name']}' needs {binding['env_var']} \"",
    '                "(the broker URL compose/k8s injects)"',
    "            )",
    "        transport = by_url.get(url)",
    "        if transport is None:",
    "            transport = RedisChannelTransport(url)",
    "            by_url[url] = transport",
    '        _transports[binding["cs_name"]] = transport',
    "",
    "",
    "async def close_channel_transports() -> None:",
    "    for transport in {id(t): t for t in _transports.values()}.values():",
    "        await transport.close()",
    "    _transports.clear()",
    "",
    "",
    "def _envelope_for(event: DomainEvent, address: str) -> dict[str, object]:",
    '    context = next((b["context"] for b in CHANNEL_BINDINGS if b["address"] == address), "")',
    "    return {",
    '        "specversion": "1.0",',
    '        "id": str(uuid7()),',
    '        "type": f"{context}.{event.type}",',
    '        "source": f"/loom/{context}",',
    '        "time": datetime.now(UTC).isoformat(),',
    '        "datacontenttype": "application/json",',
    '        "loomchannel": address,',
    '        "data": _event_to_data(event),',
    "    }",
    "",
    "",
    "async def publish_event(event: DomainEvent) -> bool:",
    `    """The publish half of the delivery-uniformity rule (design §4): a`,
    "    broker-routed event is published — co-located consumers receive it",
    "    through their subscription, never a local shortcut.  Returns False",
    "    for events no wired channel carries (the caller falls through to the",
    "    in-process dispatch).",
    `    """`,
    "    address = CHANNEL_ROUTING.get(event.type)",
    "    if address is None:",
    "        return False",
    '    binding = next((b for b in CHANNEL_BINDINGS if b["address"] == address), None)',
    '    transport = _transports.get(binding["cs_name"]) if binding else None',
    "    if transport is None:",
    '        raise RuntimeError(f"no transport wired for channel address {address}")',
    "    envelope = _envelope_for(event, address)",
    "    await transport.publish(address, envelope)",
    '    log("info", "channel_published", address=address, type=event.type, id=envelope["id"])',
    "    return True",
    ...(hasChannelConsumers
      ? [
          "",
          "",
          "async def _consume_one(raw: object) -> None:",
          "    # Deferred import: app.dispatch imports this module for the tee, so",
          "    # the reverse edge must not exist at module-load time.",
          "    from app.dispatch import InProcessDispatcher",
          "",
          "    envelope = json.loads(cast(bytes, raw))",
          '    full_type = cast(str, envelope["type"])',
          '    bare = full_type.split(".", 1)[-1]',
          '    event = _event_from_data(bare, cast("dict[str, object]", envelope["data"]))',
          "    async with AsyncSession(engine) as session:",
          "        await InProcessDispatcher(session).dispatch(event)",
          "        await session.commit()",
          "    log(",
          '        "info",',
          '        "channel_consumed",',
          '        address=cast(str, envelope["loomchannel"]),',
          "        type=full_type,",
          '        id=cast(str, envelope["id"]),',
          "    )",
          "",
          "",
          "async def _run_channel_consumers() -> None:",
          `    """Consumer loop: subscribes every wired address and dispatches`,
          "    received envelopes into the in-process dispatcher, so reactors and",
          "    event-triggered creates run identically for local and remote events.",
          `    """`,
          "    subscribed: set[int] = set()",
          "    transports: list[RedisChannelTransport] = []",
          "    for binding in CHANNEL_BINDINGS:",
          '        transport = _transports[binding["cs_name"]]',
          "        if id(transport) not in subscribed:",
          "            subscribed.add(id(transport))",
          "            transports.append(transport)",
          '        await transport.subscribe(binding["address"])',
          "    while True:",
          "        for transport in transports:",
          "            message = await transport.get_message(timeout=0.25)",
          "            if message is None:",
          "                continue",
          "            try:",
          '                await _consume_one(message["data"])',
          "            except Exception as exc:  # noqa: BLE001 — keep the subscription alive",
          '                raw_addr = message.get("channel")',
          "                addr = raw_addr.decode() if isinstance(raw_addr, bytes) else str(raw_addr)",
          "                log(",
          '                    "warn",',
          '                    "channel_consume_failed",',
          "                    address=addr,",
          "                    error=str(exc),",
          "                )",
          "",
          "",
          'def start_channel_consumers() -> "asyncio.Task[None]":',
          "    return asyncio.create_task(_run_channel_consumers())",
        ]
      : []),
    "",
  );
}
