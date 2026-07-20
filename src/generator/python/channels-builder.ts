import type { EventIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import type { BrokerBinding } from "../_channels/bindings.js";
import { fromPayload, toPayload } from "./dispatch-builder.js";

// ---------------------------------------------------------------------------
// `app/channels.py` — the broker transport module (M-T4.4 slices 2b + 7a, the
// Python leg of the Hono reference driver in
// src/generator/typescript/emit/channels.ts).  Emitted only when the
// deployable wires a broker-bound channelSource via `channels:`;
// channel-less projects stay byte-identical.
//
// Carries the CloudEvents 1.0 envelope (same field pin —
// src/util/channels.ts), the redis.asyncio pub/sub driver
// (`broadcast`/`ephemeral` against the compose-provisioned Valkey sidecar),
// the aio-pika RabbitMQ driver (`queue`/`ephemeral`+`work`, design §4
// topology: durable fanout exchange per address, one durable queue per
// consuming deployable — replicas compete — manual ack, bounded retry, DLX
// `loom.dlx` → `loom.dlq.<address>` parking), the producer publish half of
// the delivery-uniformity rule (design §4: a broker-routed event is
// PUBLISHED, not fanned out locally — the tee itself lives in
// app/dispatch.py's `make_dispatcher`), and the consumer side feeding
// received envelopes into the same in-process dispatcher local reactors use.
//
// Producer path split (design §5): `publish_event` (the inline tee half)
// only routes EPHEMERAL events; durable (`work`) events fall through to the
// outbox dispatcher and are published by the relay on drain via
// `publish_event_from_relay`, with the outbox row id as the envelope id —
// the stable consumer-side idempotency key across broker redeliveries.
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
   *  gates the consumer side (a pure producer ships publish-only). */
  hasChannelConsumers: boolean,
  /** True when THIS deployable hosts the durable channel's context (the
   *  outbox tier exists in app/dispatch.py) — gates the relay publisher and
   *  the consumer-side `_current_event_id` idempotency marker.  A
   *  foreign-channel consumer relies on broker ack semantics instead (the
   *  slice-3 stance). */
  hasDurable = false,
): string {
  const unique = uniqueBindings(bindings);
  const hasRedis = unique.some((b) => b.transport === "redis");
  const hasRabbit = unique.some((b) => b.transport === "rabbitmq");
  // event type -> address, split by durability (design §5): ephemeral events
  // publish inline in the tee; durable (`work`) events ride the outbox relay.
  // First-by-declaration within each tier, mirroring the in-process
  // dispatcher's routing rule.
  const ephemeralRouting = new Map<string, string>();
  const durableRouting = new Map<string, string>();
  for (const b of unique) {
    const target = b.retention === "ephemeral" ? ephemeralRouting : durableRouting;
    for (const ev of b.events) {
      if (!target.has(ev)) target.set(ev, b.address);
    }
  }
  const routed = new Set([...ephemeralRouting.keys(), ...durableRouting.keys()]);
  const carried = carriedEvents.filter((e) => routed.has(e.name));
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

  const transportUnion =
    hasRedis && hasRabbit
      ? '"RedisChannelTransport | RabbitChannelTransport"'
      : hasRabbit
        ? "RabbitChannelTransport"
        : "RedisChannelTransport";

  return lines(
    `"""Broker channel transport (channels.md; M-T4.4).  Auto-generated.`,
    "",
    hasRabbit && hasRedis
      ? "Redis/Valkey pub/sub and RabbitMQ queues carry CloudEvents 1.0"
      : hasRabbit
        ? "RabbitMQ queues (design §4 topology) carry CloudEvents 1.0"
        : "Redis/Valkey pub/sub carries CloudEvents 1.0",
    "envelopes between deployables; the consumer side feeds received events",
    "into the same in-process dispatcher local reactors use.  The publish",
    "half of the delivery-uniformity tee lives here (`publish_event`); the",
    "tee itself wraps `make_dispatcher` in app.dispatch.",
    `"""`,
    "",
    hasChannelConsumers ? "import asyncio" : null,
    "import json",
    "import os",
    hasRabbit ? "from collections.abc import Awaitable, Callable" : null,
    "from datetime import UTC, datetime",
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    // `get_message` narrows redis-py's Any-typed pubsub surface with `cast`
    // in every shape; the consumer block adds the envelope-field narrows.
    "from typing import cast",
    "",
    hasRabbit ? "import aio_pika" : null,
    hasRedis ? "import redis.asyncio as aioredis" : null,
    hasRabbit
      ? "from aio_pika.abc import AbstractChannel, AbstractIncomingMessage, AbstractRobustConnection"
      : null,
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
    "# `group` is the durable queue the deployable's replicas COMPETE on for",
    "# `queue` channels (design §4: one queue per consuming deployable).",
    "CHANNEL_BINDINGS: list[dict[str, str]] = [",
    ...unique.map(
      (b) =>
        `    {"cs_name": ${JSON.stringify(b.csName)}, "address": ${JSON.stringify(b.address)}, "env_var": ${JSON.stringify(b.envVar)}, "context": ${JSON.stringify(b.contextName)}, "transport": ${JSON.stringify(b.transport)}, "group": ${JSON.stringify(b.group)}},`,
    ),
    "]",
    "",
    "# event type -> broker address (first carrying broker-bound channel,",
    "# mirroring the in-process dispatcher's first-by-declaration rule).",
    "# Ephemeral events publish inline in the tee; durable (`work`) events",
    "# pass through to the outbox and publish on relay drain (design §5).",
    "CHANNEL_ROUTING: dict[str, str] = {",
    ...[...ephemeralRouting.entries()].map(([ev, addr]) => `    "${ev}": ${JSON.stringify(addr)},`),
    "}",
    "",
    "DURABLE_CHANNEL_ROUTING: dict[str, str] = {",
    ...[...durableRouting.entries()].map(([ev, addr]) => `    "${ev}": ${JSON.stringify(addr)},`),
    "}",
    "",
    "",
    codec,
    "",
    "",
    ...(hasRedis
      ? [
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
        ]
      : []),
    ...(hasRabbit
      ? [
          "# Bounded per-message retries before a poisoned message parks in the",
          "# DLQ (mirrors the outbox relay's max_attempts).",
          "CHANNEL_MAX_ATTEMPTS = 5",
          "",
          "# The rabbit consumer callback contract (subscribe's handler param).",
          "ChannelEnvelopeHandler = Callable[[dict[str, object]], Awaitable[None]]",
          "",
          "",
          "class RabbitChannelTransport:",
          `    """RabbitMQ driver — aio-pika over AMQP 0-9-1 (design §4 topology):`,
          "    a durable fanout exchange per channel address; one durable queue per",
          "    consuming deployable (the consumer group) so replicas compete;",
          "    manual ack; a failed handler republishes with an attempt header up",
          "    to CHANNEL_MAX_ATTEMPTS, then parks via DLX `loom.dlx` into",
          "    `loom.dlq.<address>`.",
          `    """`,
          "",
          "    def __init__(self, url: str) -> None:",
          "        self._url = url",
          '        self._conn: "AbstractRobustConnection | None" = None',
          '        self._ch: "AbstractChannel | None" = None',
          "",
          "    async def _channel(self) -> AbstractChannel:",
          "        if self._conn is None:",
          "            self._conn = await aio_pika.connect_robust(self._url)",
          "        if self._ch is None:",
          "            self._ch = await self._conn.channel()",
          "            await self._ch.set_qos(prefetch_count=1)",
          "        return self._ch",
          "",
          "    async def publish(self, address: str, envelope: dict[str, object]) -> None:",
          "        ch = await self._channel()",
          "        exchange = await ch.declare_exchange(",
          "            address, aio_pika.ExchangeType.FANOUT, durable=True",
          "        )",
          "        await exchange.publish(",
          "            aio_pika.Message(",
          "                body=json.dumps(envelope).encode(),",
          '                content_type="application/json",',
          "                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,",
          "            ),",
          '            routing_key="",',
          "        )",
          "",
          "    async def subscribe(",
          "        self,",
          "        address: str,",
          "        group: str,",
          "        handler: ChannelEnvelopeHandler,",
          "    ) -> None:",
          "        # The queue name IS the consumer group: replicas of one deployable",
          "        # share it and compete; other deployables bind their own queue to",
          "        # the same exchange (fan-out across deployables, one-of-N within).",
          "        ch = await self._channel()",
          "        exchange = await ch.declare_exchange(",
          "            address, aio_pika.ExchangeType.FANOUT, durable=True",
          "        )",
          '        dlx = await ch.declare_exchange("loom.dlx", aio_pika.ExchangeType.DIRECT, durable=True)',
          '        dlq = await ch.declare_queue(f"loom.dlq.{address}", durable=True)',
          "        await dlq.bind(dlx, routing_key=address)",
          "        queue = await ch.declare_queue(",
          "            group,",
          "            durable=True,",
          "            arguments={",
          '                "x-dead-letter-exchange": "loom.dlx",',
          '                "x-dead-letter-routing-key": address,',
          "            },",
          "        )",
          '        await queue.bind(exchange, routing_key="")',
          "",
          "        async def _on_message(message: AbstractIncomingMessage) -> None:",
          "            try:",
          '                envelope = cast("dict[str, object]", json.loads(message.body))',
          "            except Exception:  # noqa: BLE001 — malformed body: no retry can fix it",
          "                # nack without requeue routes through the queue's DLX into",
          "                # loom.dlq.<address> — parked, not lost.",
          "                await message.reject(requeue=False)",
          '                log("warn", "channel_dead_lettered", address=address, error="malformed envelope")',
          "                return",
          "            try:",
          "                await handler(envelope)",
          "                await message.ack()",
          "            except Exception as exc:  # noqa: BLE001 — bounded retry, then park",
          "                headers = dict(message.headers or {})",
          '                attempts = int(cast("int | str", headers.get("x-loom-attempts", 0))) + 1',
          "                if attempts >= CHANNEL_MAX_ATTEMPTS:",
          "                    await message.reject(requeue=False)",
          "                    log(",
          '                        "warn",',
          '                        "channel_dead_lettered",',
          "                        address=address,",
          '                        type=str(envelope.get("type")),',
          '                        id=str(envelope.get("id")),',
          "                        attempts=attempts,",
          "                        error=str(exc),",
          "                    )",
          "                else:",
          "                    # Bounded retry: republish with the attempt header and ack",
          "                    # the original (immediate nack-requeue would hot-loop).",
          '                    headers["x-loom-attempts"] = attempts',
          "                    retry_ch = await self._channel()",
          "                    await retry_ch.default_exchange.publish(",
          "                        aio_pika.Message(",
          "                            body=message.body,",
          '                            content_type="application/json",',
          "                            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,",
          "                            headers=headers,",
          "                        ),",
          "                        routing_key=group,",
          "                    )",
          "                    await message.ack()",
          "",
          "        await queue.consume(_on_message)",
          "",
          "    async def close(self) -> None:",
          "        if self._ch is not None:",
          "            await self._ch.close()",
          "        if self._conn is not None:",
          "            await self._conn.close()",
          "",
          "",
        ]
      : []),
    "# One shared transport per broker URL for the process (publisher tee and",
    "# consumer side reuse the same connections), keyed by channelSource name.",
    `_transports: dict[str, ${transportUnion}] = {}`,
    "",
    "",
    "def init_channel_transports() -> None:",
    `    by_url: dict[str, ${transportUnion}] = {}`,
    "    for binding in CHANNEL_BINDINGS:",
    '        url = os.environ.get(binding["env_var"])',
    "        if not url:",
    "            raise RuntimeError(",
    "                f\"channel binding '{binding['cs_name']}' needs {binding['env_var']} \"",
    '                "(the broker URL compose/k8s injects)"',
    "            )",
    "        transport = by_url.get(url)",
    "        if transport is None:",
    hasRedis && hasRabbit
      ? lines(
          '            if binding["transport"] == "rabbitmq":',
          "                transport = RabbitChannelTransport(url)",
          "            else:",
          "                transport = RedisChannelTransport(url)",
        )
      : hasRabbit
        ? "            transport = RabbitChannelTransport(url)"
        : "            transport = RedisChannelTransport(url)",
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
    "def _envelope_for(",
    '    event: DomainEvent, address: str, event_id: "str | None" = None',
    ") -> dict[str, object]:",
    '    context = next((b["context"] for b in CHANNEL_BINDINGS if b["address"] == address), "")',
    "    return {",
    '        "specversion": "1.0",',
    "        # Relay-published (durable) events reuse their outbox row id — the",
    "        # stable consumer-side idempotency key across broker redeliveries.",
    '        "id": event_id if event_id is not None else str(uuid7()),',
    '        "type": f"{context}.{event.type}",',
    '        "source": f"/loom/{context}",',
    '        "time": datetime.now(UTC).isoformat(),',
    '        "datacontenttype": "application/json",',
    '        "loomchannel": address,',
    '        "data": _event_to_data(event),',
    "    }",
    "",
    "",
    "async def _publish_to(address: str, envelope: dict[str, object], event_type: str) -> None:",
    '    binding = next((b for b in CHANNEL_BINDINGS if b["address"] == address), None)',
    '    transport = _transports.get(binding["cs_name"]) if binding else None',
    "    if transport is None:",
    '        raise RuntimeError(f"no transport wired for channel address {address}")',
    "    await transport.publish(address, envelope)",
    '    log("info", "channel_published", address=address, type=event_type, id=envelope["id"])',
    "",
    "",
    "async def publish_event(event: DomainEvent) -> bool:",
    `    """The publish half of the delivery-uniformity rule (design §4): an`,
    "    EPHEMERAL broker-routed event is published — co-located consumers",
    "    receive it through their subscription, never a local shortcut.",
    "    Returns False for everything else: unrouted events fall through to the",
    "    in-process dispatch, and durable (`work`) events fall through to the",
    "    outbox dispatcher, publishing on relay drain instead (design §5).",
    `    """`,
    "    address = CHANNEL_ROUTING.get(event.type)",
    "    if address is None:",
    "        return False",
    "    await _publish_to(address, _envelope_for(event, address), event.type)",
    "    return True",
    ...(hasDurable
      ? [
          "",
          "",
          "async def publish_event_from_relay(event: DomainEvent, event_id: str) -> bool:",
          `    """Design §5, the relay half of the producer split: a drained durable`,
          "    outbox row whose channel is broker-bound publishes here, carrying its",
          "    outbox row id as the envelope id (the consumer-side idempotency key).",
          "    Rows on non-broker durable channels return False and stay on the",
          "    local redelivery path.",
          `    """`,
          "    address = DURABLE_CHANNEL_ROUTING.get(event.type)",
          "    if address is None:",
          "        return False",
          "    await _publish_to(address, _envelope_for(event, address, event_id), event.type)",
          "    return True",
        ]
      : []),
    ...(hasChannelConsumers
      ? [
          "",
          "",
          "async def _consume_one(envelope: dict[str, object]) -> None:",
          "    # Deferred import: app.dispatch imports this module for the tee, so",
          "    # the reverse edge must not exist at module-load time.",
          ...(hasDurable
            ? ["    from app.dispatch import InProcessDispatcher, _current_event_id"]
            : ["    from app.dispatch import InProcessDispatcher"]),
          "",
          '    full_type = cast(str, envelope["type"])',
          '    bare = full_type.split(".", 1)[-1]',
          '    event = _event_from_data(bare, cast("dict[str, object]", envelope["data"]))',
          ...(hasDurable
            ? [
                "    # The envelope id rides in as the idempotency marker: saga rows",
                "    # stamped with it no-op on broker redelivery (design §5).",
                '    token = _current_event_id.set(cast(str, envelope["id"]))',
                "    try:",
                "        async with AsyncSession(engine) as session:",
                "            await InProcessDispatcher(session).dispatch(event)",
                "            await session.commit()",
                "    finally:",
                "        _current_event_id.reset(token)",
              ]
            : [
                "    async with AsyncSession(engine) as session:",
                "        await InProcessDispatcher(session).dispatch(event)",
                "        await session.commit()",
              ]),
          "    log(",
          '        "info",',
          '        "channel_consumed",',
          '        address=cast(str, envelope["loomchannel"]),',
          "        type=full_type,",
          '        id=cast(str, envelope["id"]),',
          "    )",
          ...(hasRedis
            ? [
                "",
                "",
                "async def _consume_redis_raw(raw: object) -> None:",
                '    await _consume_one(cast("dict[str, object]", json.loads(cast(bytes, raw))))',
              ]
            : []),
          "",
          "",
          "async def _run_channel_consumers() -> None:",
          `    """Consumer side: subscribes every wired address (competing-consumer`,
          "    group on `queue` channels, broadcast otherwise) and dispatches",
          "    received envelopes into the in-process dispatcher, so reactors and",
          "    event-triggered creates run identically for local and remote events.",
          `    """`,
          ...(hasRedis
            ? [
                "    subscribed: set[int] = set()",
                "    transports: list[RedisChannelTransport] = []",
              ]
            : []),
          "    for binding in CHANNEL_BINDINGS:",
          '        transport = _transports[binding["cs_name"]]',
          ...(hasRedis && hasRabbit
            ? [
                "        if isinstance(transport, RabbitChannelTransport):",
                '            await transport.subscribe(binding["address"], binding["group"], _consume_one)',
                "            continue",
                "        if id(transport) not in subscribed:",
                "            subscribed.add(id(transport))",
                "            transports.append(transport)",
                '        await transport.subscribe(binding["address"])',
              ]
            : hasRabbit
              ? [
                  '        await transport.subscribe(binding["address"], binding["group"], _consume_one)',
                ]
              : [
                  "        if id(transport) not in subscribed:",
                  "            subscribed.add(id(transport))",
                  "            transports.append(transport)",
                  '        await transport.subscribe(binding["address"])',
                ]),
          ...(hasRedis
            ? [
                "    while True:",
                "        for transport in transports:",
                "            message = await transport.get_message(timeout=0.25)",
                "            if message is None:",
                "                continue",
                "            try:",
                '                await _consume_redis_raw(message["data"])',
                "            except Exception as exc:  # noqa: BLE001 — keep the subscription alive",
                '                raw_addr = message.get("channel")',
                "                addr = raw_addr.decode() if isinstance(raw_addr, bytes) else str(raw_addr)",
                "                log(",
                '                    "warn",',
                '                    "channel_consume_failed",',
                "                    address=addr,",
                "                    error=str(exc),",
                "                )",
              ]
            : [
                "    # aio-pika consumption is callback-driven; keep the task alive so",
                "    # cancellation on shutdown tears the subscriptions down with it.",
                "    await asyncio.Event().wait()",
              ]),
          "",
          "",
          'def start_channel_consumers() -> "asyncio.Task[None]":',
          "    return asyncio.create_task(_run_channel_consumers())",
        ]
      : []),
    "",
  );
}
