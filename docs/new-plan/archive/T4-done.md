# T4 — Eventing, workflow & temporal — completed missions

*Archived 2026-09-02 from [`../T4-eventing-temporal.md`](../T4-eventing-temporal.md). Every mission below is closed (`done` / `shipped` / `closed` / `concluded` / `withdrawn`); the bodies are moved verbatim (links re-based one level deeper) so the evidence trail stays readable. Nothing here is open work — the live track file lists what remains.*

## M-T4.4 — Cross-deployable eventing (external brokers) — `done` · **XL** · P2 (slice plan complete 2026-07-21; residuals: java/elixir saga `last_event_id` dedup — broker-ack stance recorded in 7c/7d; M-T4.2 replay-cursor hook stays future)
Sources: [channels.md](../../old/proposals/channels.md) §brokers, production-readiness §3.3, weak-spots (runtime islands).

## M-T4.5 — Saga hardening slices (review remediation) — `done` · **S–M** · P1 (all four slices landed + test-pinned on `main`, re-verified 2026-07-27, #2228 — note: this `done` was silently reverted by #2283's stale-base doc merge and re-applied 2026-08-05; a status flip is as exposed to the stale-base hazard as code)
Sources: [phoenix-event-delivery-s5a](../../old/plans/phoenix-event-delivery-s5a.md), [saga-starter-guard-s5b](../../old/plans/saga-starter-guard-s5b.md), [java-uniform-publisher-s5c](../../old/plans/java-uniform-publisher-s5c.md), [phoenix-op-guards-403-422](../../old/plans/phoenix-op-guards-403-422.md).

## M-T4.11 — (withdrawn) Event-sourcing storage parity — see [M-T6.34](../T6-backend-parity.md)
Minted 2026-08-10 from M-T9.27 register unit 9, then found to duplicate **M-T6.34** (same scope, same two register codes, same source) — the cross-track duplicate this plan exists to prevent. M-T6.34 owns the gap; this ID is retired, kept as a tombstone so it is never re-minted.

**2026-08-17:** M-T6.34 has since **closed on an overturned premise** — `EVENT_SOURCING_BACKENDS` and `EVENT_SOURCING_WORKFLOW_BACKENDS` are both 5/5, so there was no parity gap to own. Both halves of the withdrawn scope are therefore settled; nothing routes back here.
