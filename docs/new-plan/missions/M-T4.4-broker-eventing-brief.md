# M-T4.4 kickoff brief — cross-deployable eventing (external brokers)

*Kickoff brief for the implementing agent. This mission is **design-first**: the first deliverable is a design doc for maintainer sign-off, not code. Read this whole brief, then follow [`../RUNBOOK.md`](../RUNBOOK.md). Owning proposal: [channels.md](../../old/proposals/channels.md) (Part I; §"Surface — transport binding", §"Choosing the broker", §"Slice plan").*

## Problem — "declared, not provisioned"

`channelSource` parses and lowers, then goes nowhere. Audited 2026-07-18 on `main` (58f3a40):

- `ChannelSourceIR` is `{name, channelName, storageName}` (`src/ir/types/loom-ir.ts:2258`), lowered in `src/ir/lower/lower.ts:722`, consumed by exactly **one** thing: `src/system/asyncapi.ts` (the `.loom/asyncapi.yaml` doc). No generator reads it.
- No broker is provisioned in `docker-compose.yml`, no producer/consumer clients are emitted, `delivery: queue` competing-consumer semantics don't exist at runtime, and there is no service-to-service auth.
- The proposal's deployable wiring clause (`channels: [lifecycleBus]`) is **not in the grammar** — only the system-scope `ChannelSource` declaration is (`ddd.langium:1253`).

So a microservice-shaped system is decorative: events cross deployables only if both happen to share a process. Channels.md slice 1 is done; this mission is slices 3+ (the transports).

## Pinned decision — brokers: redis → rabbitmq → kafka, **no NATS** (user, 2026-07-18)

The rollout is **one broker per slice, in this order**:

1. **Redis** (Pub/Sub + Streams) — `broadcast`/`ephemeral` fan-out first; the pragmatic start (lightest ops, doubles as the future cache/invalidation/relay backplane per channels.md Part II).
2. **RabbitMQ** — `queue`/`ephemeral` + `queue`/`work`: competing consumers, acks, DLQ (ties into M-T4.3's dead-letter surface).
3. **Kafka** — `broadcast`/`log`: durable partitioned streams, partition by `key:`, replay-from-cursor (the M-T4.2 projection-replay enabler).

**NATS is dropped.** The proposal called NATS "the one broker that covers the whole matrix *with* the wildcards our routing wants" — with it gone, the design must record the consequences instead of inheriting that escape hatch:

- The transport compatibility matrix (channels.md §"Transport compatibility matrix") loses its `nats` entries; every row still has ≥1 supported transport (redis/rabbitmq for ephemeral rows, kafka for `log`, redis/rabbitmq/kafka for `work`).
- The hierarchical ancestor-room routing (publish-to-leaf, subscribe-to-ancestors) must ride **Redis `PSUBSCRIBE` patterns or RabbitMQ topic wildcards** — Kafka stays a log, not a router; don't design routing that assumes wildcard support on the `log` transport.
- `nats` remains a parseable `StorageType` (`ddd.langium:569`) — the design must pick: reject it in the `channelSource` compat validator with a suggestion carrying the supported alternatives (recommended; keeps the storage type for cache/other roles), or remove it from the enum (a breaking grammar change — needs its own justification).

## Hard constraints

1. **Transport-neutral contract.** The `channel` declaration names no broker (channels.md invariant). Binding a `channelSource` is what activates a transport; **no `channelSource` = today's in-process dispatcher, byte-identical output**. Every slice must keep the unused path byte-identical (the M-T4.1 discipline).
2. **No target-backend IR** (CLAUDE.md §Architecture). Broker drivers are per-backend emitters over `LoomModel` + `ChannelSourceIR`; if a shared decision tree emerges (envelope shape, consumer-group naming, retry policy), it lives in a `src/generator/_channels/` sibling à la `_expr`/`_obs`, at the layer its consumers sit.
3. **Sequencing vs M-T4.3 (outbox).** The broker **producer rides the outbox relay** — publish-to-broker happens from the outbox drain, not inline in the request transaction. M-T4.3's remaining items (Phoenix/Oban relay, LISTEN/NOTIFY upgrade, dead-letter surface) are upstream of slices 2–3 here. The design doc settles the outbox→broker handoff now; implementation of `queue`/`work` semantics lands after (or folds in) the M-T4.3 remainder.
4. **Boundary vs M-T1.10 (realtime to the frontend) — the collision to avoid.** M-T1.10 (SSE/WS wire, edge relay, rooms, notification planes) is taking off in parallel. This mission **excludes browser delivery entirely** — but the design doc must **specify the dispatcher publish/subscribe seam both missions consume**, so the frontend work doesn't bake in in-process-only assumptions the broker slice then has to unwind. Channels.md deliberately ordered broker transport (slice 3) before UI realtime (slice 4): the edge relay is two-hop and expects a backplane underneath once past one process. Coordinate via the seam contract, not shared code.
5. **Validators, not silence.** `loom.channelsource-incompatible` (delivery×retention vs `storage.type`, suggestion-with-alternatives shape mirroring the dataSource matrix) ships with slice 1. A backend that lacks a driver for a bound transport gets an honest `loom.*` gate, never a TODO in generated output (parity-auditor discipline).
6. **Observability + gating.** New obs catalog events (`channel_published`/`channel_consumed`/`channel_consume_failed`/dead-letter) ride the existing log-catalog seam (`src/generator/_obs/`). Runtime proof is a docker e2e patterned on `tenancy-e2e`/`obs-e2e`: two generated deployables + broker sidecar, an event produced in one arrives in the other (and, for `queue`, in exactly one of N competing consumers). Compile gates alone are structurally blind to this mission.

## Deliverable 1 (for sign-off): the design doc

Before any code, produce `M-T4.4-broker-eventing-design.md` covering:

1. **Wiring surface** — the deployable `channels:` clause (grammar + IR + validators: a bound channel's context must be served by the deployable; a `channelSource` bound by no deployable warns).
2. **Envelope + topology mapping** — the wire envelope (event name, payload, `correlationId`/`scopeId`, tenancy claims) and the per-broker topology derivation: channel→`topic`/`exchange`/`subject-pattern`, consumer-group naming per deployable, `key:` → partition/routing key. Cross-backend: a Hono producer's envelope must be consumable by a Python consumer — pin it with a conformance fixture.
3. **Producer path** — outbox-drain → broker publish (constraint 3); idempotent-consumer markers on the consume side (reuse M-T4.3's markers).
4. **The dispatcher seam** (constraint 4) — the interface the in-process dispatcher, the broker consumers, and (later) M-T1.10's edge relay all implement/consume.
5. **Service-to-service auth stance** — broker-level (SASL/ACL per service credential) vs payload-level claims; per-broker credentials in the compose emission (secret/config split mirroring the k8s chart's).
6. **Slice plan** with per-slice gates (below is the frame; the design doc owns the detail).

## Slice frame (after design sign-off)

| Slice | Scope | Gate |
|---|---|---|
| 1 | `channels:` deployable wiring + compat validator (minus nats) + envelope spec | `npm test` (parse/validator/IR tests) |
| 2 | **Redis** `broadcast`/`ephemeral`: compose service + producer/consumer drivers, Hono + one compiled backend first, then the remaining three | per-backend compile gates + broker-e2e (new) |
| 3 | **RabbitMQ** `queue`: competing consumers, ack/nack, DLQ ↔ M-T4.3 dead-letter | broker-e2e asserts exactly-one-of-N delivery |
| 4 | **Kafka** `broadcast`/`log`: partitions, `retention: log`, replay cursor | broker-e2e + M-T4.2 projection replay hook |
| 5 | service-to-service auth + docs (`docs/channels.md` promotion from proposal) | e2e with auth enabled |

Backend fan-out within a slice follows the M-T4.1 pattern: land the reference driver (Hono) with the runtime e2e, then port per-backend as sibling PRs sharing the fixture.

## Verify-first notes for the implementing agent

- Re-audit on fresh `main` before each slice — M-T4.3 and M-T1.10 are both expected to move under you; the outbox seam and the dispatcher interface are the two files most likely to drift.
- Check `list_pull_requests` for M-T1.10 drafts before touching anything under the dispatcher; the seam contract (deliverable 4) is the coordination artifact, keep it current in the PR body.
