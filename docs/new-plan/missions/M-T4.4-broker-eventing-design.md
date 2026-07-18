# M-T4.4 design — external broker transports for `channelSource`

*Design deliverable for sign-off (per [M-T4.4-broker-eventing-brief.md](M-T4.4-broker-eventing-brief.md)). Grounded on `main` 58f3a40. Owning proposal: [channels.md](../../old/proposals/channels.md) Part I — this doc concretizes its §"IR, lowering, enrichment" and §"Generated code, per backend" against the code as it exists today, under the pinned broker decision (redis → rabbitmq → kafka; **no NATS**).*

## 0. What exists today (the anchor points)

- **Contract:** `ChannelIR` (`loom-ir.ts:777`) with `delivery`/`retention`/`key` knobs; `ChannelSourceIR = {name, channelName, storageName}` (`loom-ir.ts:2258`), consumed only by `src/system/asyncapi.ts`.
- **The publish seam (Hono, the reference backend):** generated `DomainEventDispatcher { dispatch(event) }` (`typescript/emit/events.ts:47`) with a composed decorator chain in `typescript/emit/routes.ts:74-113`: **outbox wrapper** (durable events short-circuit to `__loom_outbox`; the relay re-enters the chain) → **realtime SSE tee** (copies every dispatched event onto `GET /realtime/events`) → **in-process workflow fan-out** (or Noop). .NET mirrors this (`OutboxDomainEventDispatcher` + `OutboxRelayService` over `__loom_outbox`, `dotnet/emit/outbox.ts`); Python has the table + dispatch-builder; Java ⚠ verify; Phoenix has no outbox (M-T4.3 remainder).
- **Missing entirely:** the deployable `channels:` wiring clause (proposal §"Surface — transport binding"), any broker driver, compose provisioning, `queue` competing-consumer semantics, service-to-service auth.

Everything below is designed as *another decorator/driver on that existing chain* — producer domain code is untouched, exactly as the proposal promised.

## 1. Wiring surface — the `channels:` deployable clause

Grammar (`ddd.langium`, Deployable rule): a `channels:` list of `channelSource` names, mirroring `dataSources:`.

```ddd
storage bus { type: redis }
channelSource lifecycleBus { for: Orders.Lifecycle, use: bus }

deployable salesApi { platform: node   contexts: [Orders]   serves: SalesApi
                      dataSources: [ordersState]  channels: [lifecycleBus]  port: 3000 }
deployable shipApi  { platform: python contexts: [Shipping]
                      dataSources: [shipState]    channels: [lifecycleBus]  port: 8000 }
```

Generated effect (Hono producer side, sketch):

```ts
// index.ts (generated) — channel drivers compose into the existing chain
const lifecycleBus = redisChannelTransport({ url: env.LOOM_CHANNEL_LIFECYCLEBUS_URL });
const dispatcher = withOutbox(db, withRealtimeTee(sse, brokerPublisher(lifecycleBus, ROUTING)));
startOutboxRelay(db, dispatcher);                 // relay drains __loom_outbox → broker
startChannelConsumers(lifecycleBus, GROUP, workflowDispatcher); // reactors ride the broker
```

IR: `DeployableIR += channelSourceNames: string[]` (resolved names, like `dataSources`). Enrich derives, per deployable, the set of **bound channels** it produces into (hosts the owning context) and consumes from (declares an `on(...) via` reactor, or hosts a projection folding a carried event).

Validators (all IR-level, `validate/checks/system-checks.ts` unless noted):

| Code | Rule |
|---|---|
| `loom.channelsource-incompatible` | `delivery`×`retention` vs bound `storage.type` per the matrix in §2 (suggestion-with-alternatives, mirroring the dataSource matrix error). AST-level, `validators/channel.ts`. |
| `loom.channelsource-unsupported-transport` | bound storage type has no channel driver — **`nats` lands here permanently** (pinned decision), as does e.g. `postgres`. Suggests the supported types for the channel's knobs. |
| `loom.deployable-channel-unrelated` | a deployable wires a channelSource but neither hosts the channel's owning context nor consumes any carried event (reactor/projection) — dead wiring, warn. |
| `loom.channelsource-unbound` | a channelSource no deployable wires — declared but inert, warn (today's silent state becomes an honest diagnostic). |
| `loom.channel-consumer-unwired` | a deployable's reactor rides channel `C` via `on(...) via`, some deployable binds `C` to a broker, but this consumer deployable doesn't list the binding — the event would silently never arrive cross-process. Error. |

**Default unchanged:** no `channelSource` bound by any deployable ⇒ zero new output (byte-identical), in-process dispatch as today.

## 2. Transport compatibility matrix (post-NATS)

| `delivery` | `retention` | Compatible `storage.type` | Slice |
|---|---|---|---|
| `broadcast` | `ephemeral` | `inMemory` (in-proc, today), `redis` | 2 |
| `broadcast` | `log` | `kafka` | 4 |
| `queue` | `ephemeral` | `redis` (streams), `rabbitmq` | 3 |
| `queue` | `work` | `rabbitmq`, `kafka` | 3/4 |

Consequences of dropping NATS, recorded: every row keeps ≥1 transport; the ancestor-room/wildcard routing that M-T1.10's relay will need is served by Redis `PSUBSCRIBE` patterns and RabbitMQ topic wildcards (`#`/`*`) — **never Kafka**, which stays the log. `nats` remains in the `StorageType` enum (usable for other roles; removing it is a breaking grammar change with no payoff) but is a permanent `loom.channelsource-unsupported-transport`.

## 3. Wire envelope — CloudEvents 1.0 JSON

Cross-backend interop is the whole point (a Hono producer's event must be consumable by a Python/`.NET`/Java/Phoenix consumer), so the envelope is a **standard**: [CloudEvents 1.0 JSON](https://cloudevents.io) — which also aligns with the `.loom/asyncapi.yaml` we already emit.

```json
{
  "specversion": "1.0",
  "id": "<outbox row id — the idempotency key>",
  "type": "Orders.OrderPlaced",
  "source": "/loom/salesApi/Orders",
  "time": "2026-07-18T12:00:00Z",
  "datacontenttype": "application/json",
  "loomchannel": "Orders.Lifecycle",
  "loomkey": "<value of the channel's key: field, if any>",
  "correlationid": "…", "scopeid": "…", "tenantid": "…",
  "data": { "order": "…", "at": "…" }
}
```

- `data` is the event's existing wire-shape JSON — the same serialization the in-process/SSE path uses today (no second DTO).
- `id` **is the outbox row id** → the consumer-side idempotency marker key (reuses M-T4.3's idempotent-consumer table; a redelivered envelope is a no-op).
- `correlationid`/`scopeid` thread the existing execution-context backbone across services (they later become span links, T7).
- `tenantid` carries the producing scope; consumers **do not trust it for authorization** — reactors run under the existing tenancy scoping of their own deployable; the field is for observability + partition affinity.
- Envelope build/parse is generated per backend from one shared decision tree (§6); a **cross-backend conformance fixture** pins the byte shape (same discipline as `wire-spec.json`).

## 4. Per-broker topology mapping

One shared naming scheme, derived (never configured): channel address `loom.<context>.<channel>` (dot-hierarchical — deliberately leaving suffix room for M-T1.10's room segments, e.g. `loom.Orders.Lifecycle.<room>`); consumer group `<channel-address>.<deployable-name>`.

| | Redis (slice 2/3) | RabbitMQ (slice 3) | Kafka (slice 4) |
|---|---|---|---|
| broker image (compose) | `valkey/valkey:8` (BSD-3; redis-wire-compatible — see §6a) | `rabbitmq:4-management-alpine` (MPL 2.0) | `apache/kafka` official (Apache 2.0, KRaft; **not** bitnami — see §6a) |
| `broadcast` topology | `PUBLISH` to channel address; consumers `PSUBSCRIBE loom.Orders.Lifecycle*` | fanout/topic exchange, one auto-delete queue **per deployable** | topic; one consumer group per deployable (each group sees all) |
| `queue` topology | Redis Stream + `XREADGROUP` (group = deployable) | one durable queue per consuming deployable; replicas compete | same topic; replicas of one deployable share its group |
| ordering | none (ephemeral) | per-queue FIFO | per-partition, partition key = `loomkey` ?? `id` |
| ack / redelivery | `XACK` / `XAUTOCLAIM` for stale pending | manual ack; nack → retry then DLX | offset commit after handler success |
| dead-letter | `XAUTOCLAIM` retry cap → `loom.dlq` stream | DLX `loom.dlx` → `loom.dlq.<channel>` queue | retry topic `…​.retry` then `…​.dlq` (v1: log + park) |
| client lib (Hono ref.) | `ioredis` | `amqplib` | `kafkajs` |

Dead-letter surfaces join M-T4.3's dead-letter observability item — same catalog event, per-transport parking spot.

**Delivery uniformity rule (double-delivery avoidance):** the **channel** defines delivery *semantics* (`delivery` × `retention` — the contract); the **channelSource** only picks the machinery that enforces them. So when a channel is broker-bound, **all** consumption of its events rides the broker — including consumers co-located in the producing deployable. The in-process fan-out for that channel's events is replaced by the broker round-trip (the relay publishes; the deployable's own consumer group receives). This is forced by the semantics, not a style choice: `queue` promises one-of-N across *all* consumers of the group, and a local shortcut that hands co-located consumers every event would silently break that promise the moment a second replica exists. Local vs remote consumers stay behaviorally identical; unbound channels keep today's direct in-process fan-out (whose semantics `broadcast`/`ephemeral` already describes).

## 5. Producer path & the dispatcher seam (the M-T1.10 contract)

### Producer: outbox-drain → broker publish

The broker publisher is **not** called inline in the request transaction. The existing outbox wrapper records durable events in `__loom_outbox` inside the write tx; the **relay** (already a background drainer on Hono/.NET/Python) gains a per-channel routing step:

```
save() tx ──▶ __loom_outbox row
relay drain ──▶ event's channel broker-bound?
                 ├─ yes → transport.publish(address, envelope)   (ack row on broker accept)
                 └─ no  → re-enter local chain (today's behavior)
```

At-least-once end to end: tx-safe capture (outbox) + broker redelivery + envelope-`id` idempotency markers on consume. Channels with `retention: ephemeral` that are broker-bound publish **post-commit via the same relay** (skipping the durable row is a later optimization; v1 keeps one path).

### The seam interface — what every party codes against

Per backend runtime, one generated interface (names per language convention):

```ts
interface ChannelTransport {
  publish(address: string, envelope: LoomEventEnvelope): Promise<void>;
  subscribe(address: string, group: string | null,
            handler: (e: LoomEventEnvelope) => Promise<void>): () => void;
  // group = null  → broadcast (every subscriber sees every envelope)
  // group = name  → competing consumers within the group
}
```

Implementations: `inProcessTransport` (today's dispatcher, refactored under the interface), `redisTransport`, `rabbitmqTransport`, `kafkaTransport` — plus, **owned by M-T1.10, not here**: the SSE tee / edge relay becomes a *broadcast subscriber on this interface* instead of a hardwired decorator. That is the coordination contract: M-T1.10 codes against `subscribe(address, null, …)` and the room-suffix address space (§4), and gains multi-process fan-out for free the day a channel binds Redis; this mission never touches sockets, rooms, or browser wires.

Consumer side: `startChannelConsumers` subscribes each bound channel and dispatches envelopes into the **existing** generated workflow/reactor handler (the same one the in-process path calls) after the idempotency check — reactor bodies are untouched.

## 6. Emitter architecture & layering

- **`src/generator/_channels/`** (new `_`-shared home, à la `_expr`/`_obs`): the shared decision trees only — address/group naming, envelope field set, the compat matrix (single source for validator + docs), per-transport topology descriptors. Pure data + string builders; no backend syntax.
- **Per-backend drivers**: `typescript/emit/channels.ts` (+ the `packages/backend-hono-v5` pins for `ioredis`/`amqplib`/`kafkajs`), `dotnet/emit/channels.ts` (MassTransit-free v1 — thin clients over `StackExchange.Redis` / `RabbitMQ.Client` / `Confluent.Kafka`, DI-registered like the repos), `python/emit/channels.py` emitter (`redis-py`/`pika`/`confluent-kafka`), `java/emit/channels.ts` (Lettuce/`spring-amqp`/`spring-kafka`), `elixir/…` (`Phoenix.PubSub`-fronted Redis / Broadway adapters) — **each a later fan-out slice; Hono is the reference driver**.
- **Compose (phase ⑨, `src/system/`)**: for every storage a bound channelSource uses, emit the broker service — images per the §4 table — with healthchecks, and inject `LOOM_CHANNEL_<NAME>_URL` env per wired deployable. Mirrors the existing Postgres service pattern; k8s chart gets the same as an `enabled`-gated subchart (later slice, with `docs/kubernetes.md` update).

### 6a. Licensing constraint (pinned 2026-07-18: free/OSS only)

Everything provisioned or depended on must be free — free-as-in-cost for generated projects **and** permissively enough licensed that a generated app can ship commercially. Recorded per component; re-check on every version bump (the ecosystem is actively re-licensing):

| Component | Choice | License | The trap avoided |
|---|---|---|---|
| broadcast broker image | **Valkey 8** (`valkey/valkey`) | BSD-3 | Redis 7.4+ left BSD (RSALv2/SSPL); Redis 8 is AGPLv3-tri-licensed — AGPL on a *sidecar we don't link* is arguably fine, but Valkey is drop-in wire-compatible with zero licensing analysis needed. Clients (`ioredis` etc.) speak RESP unchanged; the storage type stays `redis` (the contract names the protocol family, not the vendor). |
| queue broker image | RabbitMQ 4 | MPL 2.0 | — |
| log broker image | `apache/kafka` (KRaft) | Apache 2.0 | **Not** `bitnami/kafka` — Bitnami moved its catalog to the paid "Secure Images" program (2025); the free tags are frozen/legacy. |
| .NET bus framework | none (thin clients) | — | **MassTransit v9 went commercial** (v8 stays Apache 2.0 but is EOL-bound) — this hardens §9 decision 4 from "style choice" to "licensing requirement". |
| clients: node | `ioredis` / `amqplib` / `kafkajs` | MIT / MIT / MIT | — |
| clients: .NET | `StackExchange.Redis` / `RabbitMQ.Client` / `Confluent.Kafka` | MIT / Apache 2.0+MPL 2.0 / Apache 2.0 | — |
| clients: python | `redis-py` / `pika` / `confluent-kafka` | MIT / BSD-3 / Apache 2.0 | — |
| clients: java | Lettuce / `spring-amqp` / `spring-kafka` | Apache 2.0 (all) | — |
| clients: elixir | `phoenix_pubsub` + Redix / Broadway adapters | MIT / Apache 2.0 | — |
- **Obs catalog** (`_obs/log-events.ts`): `channel_published`, `channel_consumed`, `channel_consume_failed`, `channel_dead_lettered` — asserted by the broker e2e.

Layering: `_channels/` sits in `src/generator/`, imported by backends and (for the compose descriptors) `src/system/` — no upward edge; `pipeline-layering.test.ts` and `backend-packages-layering.test.ts` must stay green.

## 7. Service-to-service auth (v1 stance)

Broker-level, per-deployable credentials; claims stay in the envelope for observability only (§3).

- **Redis**: `requirepass` via compose secret; single credential v1 (ACL-per-service deferred).
- **RabbitMQ**: one vhost `loom`, one user per deployable, configure/write/read permissions scoped to its exchanges/queues (the derivable ACL — names are compiler-known).
- **Kafka**: SASL/PLAIN per deployable; topic ACLs deferred with the same rationale.
- Secrets ride the compose/k8s **secret/config split** already established by the chart (T7); no credential in generated source.
- Payload-trust rule restated: consumers authorize by their own scoping, never by envelope claims.

This is slice 5; slices 2–4 run brokers unauthenticated **on the compose-internal network only** (no host port mapping), which is the same trust stance as the current `db` sidecar.

## 8. Slice plan & gates

| # | Scope | Gate |
|---|---|---|
| 1 | `channels:` clause (grammar + IR + print arm) · §1 validators · compat matrix in `_channels/` · envelope spec + conformance fixture · asyncapi gains the binding info | `npm test` (parse / negative-validator / IR / print-completeness) · byte-identical-when-unused fixture |
| 2 | **Redis** `broadcast`/`ephemeral`: compose service · `ChannelTransport` + `redisTransport` + relay routing on **Hono** · consumer loop → reactor · obs events | `LOOM_TS_BUILD` · new **`test:channels`** (`LOOM_CHANNELS_E2E=1`): 2 generated Hono deployables + redis sidecar, `OrderPlaced` in A observed acting in B |
| 2b | second driver: **Python** consumer (proves cross-backend envelope) | channels-e2e cross-backend leg + `python-build` |
| 3 | **RabbitMQ** `queue`/`ephemeral`+`work`: exchange/queue topology, ack/nack, DLX · idempotency markers wired to envelope `id` | channels-e2e asserts **exactly-one-of-N** across 3 consumer replicas + DLQ parking on poisoned message |
| 4 | **Kafka** `broadcast`/`log`: partitions by `loomkey`, per-deployable groups, replay cursor hook (M-T4.2) | channels-e2e ordering-per-key assertion |
| 5 | auth (§7) + k8s subchart + promote `docs/channels.md` from proposal | channels-e2e with auth on · `k8s-build` |
| 6+ | remaining backend fan-out (.NET → Java → Phoenix), one PR per backend per transport, sharing the fixture | per-backend compile gates + channels-e2e legs |

Sequencing gates honored: slice 3 (`queue`) lands **after or with** the M-T4.3 remainder (Phoenix relay is only needed for the Phoenix fan-out in 6+; dead-letter surface co-designs with slice 3). Slices 2/2b have no M-T4.3 dependency beyond what ships today.

## 9. Decisions — **signed off 2026-07-18** (maintainer: continue with recommended; licensing constraint added as §6a)

1. **CloudEvents 1.0** as the envelope (vs a bespoke minimal JSON) — buys interop/AsyncAPI alignment at the cost of a few fixed fields. *Recommended: yes.*
2. **Delivery uniformity rule** (§4): broker-bound channels route co-located consumers through the broker too (no hybrid local shortcut). *Recommended: yes — correctness over latency; the unbound default still covers the monolith.*
3. **`nats` stays in the enum**, permanently gated by `loom.channelsource-unsupported-transport`. *Recommended: yes.*
4. **v1 .NET drivers without MassTransit** (thin official clients, mirroring the no-framework stance of the vanilla Phoenix move). Upgraded from recommendation to **requirement** by §6a: MassTransit v9 is commercially licensed. Flippable later behind the same `ChannelTransport` seam only if a free successor emerges.
5. The **realtime tee migrates onto `ChannelTransport`** in slice 2 (mechanical refactor, byte-diff on generated output reviewed with M-T1.10's owner) — this is the moment the two missions physically meet; doing it early is the whole point.
