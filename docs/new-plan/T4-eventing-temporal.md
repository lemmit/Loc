# T4 — Eventing, workflow & temporal

*Weak-spot #4: nothing in the language schedules work — no timers, no jobs, no saga deadlines — and deployables are runtime islands (in-process dispatch + outbox, but no cross-service transport). The saga/workflow core is otherwise solid and at full 5-backend parity.*

## M-T4.1 — `timerSource` (scheduling) — `open` · **XL** · P1 (design-first)
The temporal hole. Time as an event source: a system-scope `timerSource` binding emitting tick events; workflows react via existing `on(e)`/`create(e) by` triggers — zero new workflow grammar (the `schedule every 5m {}` shape was explicitly rejected). Needs per-backend durable drivers (pg-cron/poller, Quartz, Oban, Hangfire-analogue, APScheduler) + saga-deadline sugar on top. Design now — cost grows with every backend.
Sources: [scheduling.md](../old/proposals/scheduling.md), weak-spots §4, completeness-audit Tier 1.

## M-T4.2 — `projection` read models — `open` · **L** · P2
`projection <Name> keyed by <field>` folded from foreign events, reusing the ES-saga machinery on all five backends; `GET /projections/<name>` read surface; 8 validators. Deferred v1.1: projection-as-view-source, replay/rebuild (needs durable log), snapshots.
Sources: [projection.md](../old/proposals/projection.md) (draft 2026-07-05), [workflow-and-applier](../old/proposals/workflow-and-applier.md) §projections, production-readiness §3.5.

## M-T4.3 — Outbox & delivery completion — `partial` · **M** · P2
Outbox + idempotent-consumer markers ship on Hono/.NET/Python (+Java ⚠ verify). Remaining: Phoenix/Oban relay, S5(d) close-out from the DDD review, LISTEN/NOTIFY upgrade over polling, dead-letter surface + observability event, the opt-in knob decision (reuse `retention:`).
Sources: [dispatch-delivery-semantics](../old/proposals/dispatch-delivery-semantics.md), ddd-review S5(d).

## M-T4.4 — Cross-deployable eventing (external brokers) — `open` · **XL** · P2 (design-first)
`channelSource` parses but is "declared, not provisioned" — a microservice-shaped system is decorative. Provision redis/kafka/nats from `channelSource`, emit producer/consumer clients, `delivery: queue` competing-consumer semantics, service-to-service auth. The real distributed-systems work; sequence after M-T4.3.
Sources: [channels.md](../old/proposals/channels.md) §brokers, production-readiness §3.3, weak-spots (runtime islands).

## M-T4.5 — Saga hardening slices (in-flight review remediation) — `in-flight` · **S–M** · P1
Live branches from the generated-code DDD review: S5(a) Phoenix persist-then-dispatch (+S12), S5(b) ES saga starter exists-guard (all 5 backends), S5(c) Java unconditional publisher, Phoenix op guards 403/422. Land or re-drive each; they're small and correctness-grade.
Sources: [phoenix-event-delivery-s5a](../old/plans/phoenix-event-delivery-s5a.md), [saga-starter-guard-s5b](../old/plans/saga-starter-guard-s5b.md), [java-uniform-publisher-s5c](../old/plans/java-uniform-publisher-s5c.md), [phoenix-op-guards-403-422](../old/plans/phoenix-op-guards-403-422.md).

## M-T4.6 — Day-one batteries: `job`, `email`, object `storage` — `open` · **L** · P1
The ~100%-of-apps integrations: an email adapter (resource kind — smtp/ses/sendgrid), object-storage `File`/`Upload` surface (resource verbs `files.put/get/signedUrl` already render — wire the type + UI via M-T1.2), and `job` (folds into M-T4.1 timers).
Sources: [quickstart-and-day-one-batteries](../old/proposals/quickstart-and-day-one-batteries.md) §5, completeness-audit Tier 1.

## M-T4.7 — Workflow family v2 — `open` · **L** · P3
Deferred reframes: workflow-as-aggregate `on(...)` handler surface; snapshots (aggregate + saga state); the sagas compensation contract; `repo-let` arrays/nullables (gated); ES workflow instance *pages* (list/detail — the one open slice from workflow-debt parity).
Sources: [workflow-and-applier](../old/proposals/workflow-and-applier.md), [workflow-debt-backend-parity](../old/plans/workflow-debt-backend-parity.md) next-slice, global-plan T3.5/T3.6.

## M-T4.8 — Resource-model completion — `partial` · **M** · P3
Remaining `sourceType`/`interface` registry entries + vendor emission beyond the shipped verb set; broader `need ⊆ sourceType` activation; the `contract` typed-resource declaration (inbound `from openapi(...)` typed clients) as the follow-on.
Sources: [resource-model-and-source-types](../old/proposals/resource-model-and-source-types.md), [workflow-resource-consumption](../old/proposals/workflow-resource-consumption.md), [contract-typed-resources](../old/proposals/contract-typed-resources.md).

## M-T4.9 — Read caching tier — `open` · **L** · P3 (proposal needed)
`cached(ttl)` + `CacheAdapter` + invalidation keyed by the channel/resource vocabulary (channels Part II — entirely unstarted).
Sources: [channels.md](../old/proposals/channels.md) Part II, production-readiness §3.4.

## M-T4.10 — Backend-to-backend calls — `open` · **L** · P3 (proposal needed)
Typed inter-deployable invocation (peer-URL IR, client emission, authn between services). Referenced by production-readiness §3.10 and deployable-networking's out-of-scope note; no owning proposal yet — write it.
