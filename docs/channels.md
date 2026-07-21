# Channels — cross-deployable eventing over external brokers

A `channel` is a named delivery contract over a context's published events:
which events it `carries:`, whether each envelope goes to every consumer
(`delivery: broadcast`) or one of N competing consumers (`delivery: queue`),
and how long it is kept (`retention: ephemeral | work | log`), with an
optional `key:` naming the partition/ordering field. The contract names no
transport — a system-scope `channelSource` binds a channel to a broker
`storage` (`redis` / `rabbitmq` / `kafka`), and each deployable lists the
bindings it wires in its `channels:` clause. With no `channelSource`, events
stay on the in-process dispatcher (the monolith/test default, byte-identical
output); adding a binding is what activates a broker. Consumers keep their
existing surface — `on(e: Event)` reactors and event-triggered
`create(e: Event) by` workflow starters — and event references resolve
system-wide, so the consuming deployable need not host the producing context.

Design record: [`old/proposals/channels.md`](old/proposals/channels.md) Part I;
signed-off broker design:
[`new-plan/missions/M-T4.4-broker-eventing-design.md`](new-plan/missions/M-T4.4-broker-eventing-design.md).

```ddd
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { order: id, at: now() }
        }
      }
      repository Orders for Order {}
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced }      // broadcast/ephemeral defaults
    }
  }
  subdomain Fulfilment {
    context Shipping {
      aggregate Shipment with crudish { orderRef: Order id  status: string }
      repository Shipments for Shipment {}
      workflow Fulfil {
        orderId: Order id
        create(p: OrderPlaced) by p.order {          // starts on the foreign event
          let s = Shipment.create({ orderRef: p.order, status: "Pending" })
        }
      }
    }
  }
  storage primary { type: postgres }
  storage bus { type: redis }
  resource ordersState   { for: Orders,   kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: node contexts: [Orders]   dataSources: [ordersState]   channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: node contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
```

`generate system` provisions the broker as a compose sidecar and injects the
credentialed URL into every wired deployable as `LOOM_CHANNEL_<NAME>_URL`
(the channelSource name, upper-snaked) — the one seam every driver consumes:

```yaml
  ship_api:
    depends_on:
      bus: { condition: service_healthy }
    environment:
      LOOM_CHANNEL_LIFECYCLE_BUS_URL: "redis://:loom-dev-bus@bus:6379"
  bus:
    image: valkey/valkey:8-alpine
    command: ["valkey-server", "--requirepass", "loom-dev-bus"]
```

An `Order.place()` on `salesApi` publishes the event to the broker;
`shipApi`'s consumer loop receives it and spawns the correlated `Fulfil`
instance + `Shipment` in its own database.

## Broker matrix

The channel's `delivery` × `retention` pair must be realisable by the bound
storage type (`loom.channelsource-incompatible` otherwise; single source of
truth in `src/util/channels.ts`, shipped combos in
`src/generator/_channels/bindings.ts`). All cells ship on **all five
backends** (node/Hono, python/FastAPI, dotnet, java/Spring Boot,
elixir/Phoenix):

| `delivery` | `retention` | Transport | Compose image (§6a licensing) |
|---|---|---|---|
| `broadcast` | `ephemeral` | `redis` (also `inMemory` in-process) | `valkey/valkey:8-alpine` (BSD-3 — never the relicensed `redis:` images) |
| `queue` | `ephemeral` | `rabbitmq` | `rabbitmq:4-management-alpine` (MPL 2.0) |
| `queue` | `work` | `rabbitmq`, `kafka` | as above / `apache/kafka` (Apache 2.0, KRaft — never bitnami) |
| `broadcast` | `log` | `kafka` | `apache/kafka` |

`nats` remains a parseable storage type but is **not** a channel transport —
binding it is rejected by `loom.channelsource-unsupported-transport`
(pinned decision; same code gates e.g. `postgres`).

Per-backend drivers — plain official clients, free/OSS only (no MassTransit,
no framework buses; re-checked per version bump):

| Backend | redis | rabbitmq | kafka |
|---|---|---|---|
| node (Hono) | `ioredis` (MIT) | `amqplib` (MIT) | `kafkajs` (MIT) |
| python | `redis` asyncio (MIT) | `aio-pika` (Apache-2.0) | `aiokafka` (Apache-2.0) |
| dotnet | `StackExchange.Redis` (MIT) | `RabbitMQ.Client` (Apache-2.0) | `Confluent.Kafka` (Apache-2.0) |
| java | Lettuce (Apache-2.0) | `amqp-client` (Apache-2.0) | `kafka-clients` (Apache-2.0) |
| elixir | Redix (MIT) | hex `amqp` (MIT) | brod (Apache-2.0) |

Dependencies are wiring-gated: a project with no wired channel is
byte-identical to one generated before the feature existed.

## The wire — CloudEvents 1.0

Every broker-published event rides a [CloudEvents 1.0](https://cloudevents.io)
JSON envelope, built and parsed per backend from one pinned field list
(`LOOM_ENVELOPE_REQUIRED`/`OPTIONAL` in `src/util/channels.ts`): `specversion`,
`id`, `type` (`<Context>.<Event>`), `source` (`/loom/<deployable>/<context>`),
`time`, `datacontenttype`, `loomchannel`, `data` (the event's existing wire
shape — no second DTO), plus optional `loomkey` (the `key:` field value),
`correlationid`, `scopeid`, `tenantid` (observability/partition affinity only —
never authorization). A Hono producer's envelope parses byte-for-byte in a
Python/.NET/Java/Phoenix consumer; a conformance fixture pins the shape.

**Delivery uniformity:** the channel defines the semantics, the binding only
picks the machinery — so when a channel is broker-bound, **all** consumption
of its events rides the broker, including consumers co-located with the
producer (the local fan-out for those events is dropped). A local shortcut
would break `queue`'s one-of-N promise the moment a second replica exists.
Unbound channels keep today's direct in-process fan-out.

**Producer split (§5):** durable events (`retention: work`/`log`) are recorded
in `__loom_outbox` inside the write transaction and published by the relay on
drain, with the **outbox row id as the envelope `id`** — which doubles as the
consumer-side idempotency key (a redelivered envelope is a no-op).
`ephemeral` events publish inline post-dispatch (the tee). Backends without a
prior outbox tier (java, elixir) gained one with their rabbit legs.

## Per-broker topology

Addresses are derived, never configured: channel address
`loom.<context>.<channel>`; consumer group `<address>.<deployable>` —
replicas of one deployable compete within their group, distinct deployables
get distinct groups.

| | redis | rabbitmq | kafka |
|---|---|---|---|
| topology | `PUBLISH`/`PSUBSCRIBE` on the address (pub/sub) | durable fanout exchange per address; one durable queue per consuming deployable (replicas compete) | topic per address, admin-created idempotently by the first subscriber (3 partitions, rf 1) |
| ordering | none (ephemeral) | per-queue FIFO | per-partition; partition key = `loomkey` ?? envelope id |
| ack | fire-and-forget | manual ack; bounded `x-loom-attempts` retry | consumption always on the deployable's group; offsets commit after the handler resolves |
| dead-letter | — | DLX `loom.dlx` → `loom.dlq.<address>` queue | v1 = log + park onto `<address>.dlq` (the partition keeps moving, never a hot loop) |

Kafka's per-deployable groups realise broadcast ACROSS deployables and
competition WITHIN one — the same two knobs, one mechanism. Every park emits
the `channel_dead_lettered` obs event (catalog: `channel_published`,
`channel_consumed`, `channel_consume_failed`, `channel_dead_lettered`).

## Auth (v1)

Broker-level, per-deployable credentials, riding the `LOOM_CHANNEL_*_URL` env
var — production overrides the URL, drivers need no second credential channel
(`src/generator/_channels/auth.ts`):

- **redis** — `requirepass` on the sidecar, single credential v1
  (`redis://:<pass>@bus:6379`).
- **rabbitmq** — one vhost `loom`, one user per deployable with
  configure/write/read scoped to its compiler-known exchanges/queues, loaded
  from a generated `broker-init/<slug>-definitions.json` (`load_definitions`
  also suppresses the image's default open `guest` account).
- **kafka** — SASL/PLAIN on the client listener, one JAAS user per wired
  deployable (`kafka://user:pass@…`; topic ACLs deferred).

Dev credentials are deterministic — `loom-dev-<storage>[-<user>]`, the
`POSTGRES_PASSWORD: postgres` stance. A credential-**less** URL keeps every
driver on the plain pre-auth contract. Envelope claims (`tenantid` etc.) are
observability-only: consumers authorize by their own deployable's scoping,
never by envelope fields.

## Kubernetes

`generate system --k8s` gives each wired broker storage an enabled-gated
workload in the helm chart (`.Values.brokers.<storage>.enabled`, default
true), auth-provisioned the same way as compose. `LOOM_CHANNEL_*_URL` rides
the shared chart Secret with an in-cluster default and a per-deployable
`.Values.<deployable>.channels.<ENV>` override for managed brokers. See
[`kubernetes.md`](kubernetes.md) § Broker channels.

## Testing

Opt-in runtime gates, per broker × backend (docker sidecars; each boots a
generated multi-deployable system and asserts real cross-process delivery,
exactly-once across competing replicas, ordering-per-key on kafka, DLQ
parking):

```bash
npm run test:channels                # redis, Hono reference   (LOOM_CHANNELS_E2E=1)
npm run test:channels-{python,dotnet,java,elixir}          # redis cross-backend legs
npm run test:channels-rabbit[-{python,dotnet,java,elixir}] # rabbit queue/work legs
npm run test:channels-kafka[-{python,dotnet,java,elixir}]  # kafka broadcast/log legs
npm run test:channels-auth           # all three brokers authed at once + credential-less refusal
```

Per-PR, the generator pin suites (`test/generator/**/channels-*.test.ts`) and
the wiring validators (`loom.channelsource-unbound`,
`loom.deployable-channel-unrelated`, `loom.channel-consumer-unwired`) gate the
structural half.

## Not yet

- **Replay cursor** on `retention: log` (M-T4.2) — the durable log ships;
  consuming it from an arbitrary offset does not.
- **Topic/queue ACLs beyond v1** — rabbit permissions are name-scoped per
  deployable; kafka topic ACLs and redis per-service ACLs are deferred.
- **Browser delivery** (M-T1.10) — the edge relay / room topology consumes
  the same `ChannelTransport` seam but is a separate mission; realtime SSE v1
  remains Hono-only.
- **Elixir/java saga `last_event_id` dedup residual** — the column exists in
  migrations but hosted-durable consumer dedup is wired only on
  node/python/dotnet; elixir and java rely on broker ack semantics +
  idempotent reactors.
