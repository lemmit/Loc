# S5(c) — uniform Java event publisher

**Status:** in progress (branch `claude/generated-code-ddd-review-ld6gmz`).
**Origin:** `docs/audits/generated-code-ddd-review-2026-07.md` §S5 (P1/P2) —
"Java's `publishEvents` only logs". Follows the merged S5(a)/S12 (#1675) and
S5(b) (#1695).

## The asymmetry (reproduced on fresh `main`)

Java's `<Agg>Service.publishEvents` published drained domain events through
Spring's `ApplicationEventPublisher` **only when the bounded context had a
subscriber** (`dispatches = ctx.eventSubscriptions.length > 0`). With no
subscriber it emitted the `event_dispatched` narrative line and then **dropped
the event** — never reaching the bus. Every other backend always routes emitted
events through its dispatcher: **.NET** always `await _events.DispatchAsync(ev)`
(a `NoopDomainEventDispatcher` when unsubscribed), **Hono** always
`await this.events.dispatch(event)`, Python/Elixir likewise. Java was the odd
one out (audit §S5c: `BuildPromoted` silently dropped).

It is not an observable drop *today* (subscriptions are same-context, so
"no subscriber" means "no consumer"), but it is a real cross-backend asymmetry
and the exact seam the outbox upgrade path (S5d) relies on.

## The fix

Publish **always** — `dispatches` is now unconditionally true, so every
emitting `<Agg>Service` injects `ApplicationEventPublisher` and calls
`eventPublisher.publishEvent(event)` for each drained event, matching .NET's
always-`DispatchAsync`. Publishing with no `@EventListener` is a harmless no-op
(Spring always provides the publisher; no Noop shim needed). Chosen over a
narrow "aggregate emits events" predicate because a nested `emit` (in a `match`
arm) or an `extern` `_raiseEvent` could slip such a gate and silently drop —
always-publish can't miss.

**Scope:** `src/generator/java/emit/service.ts` + the one Java dispatch test
that had pinned the log-only behavior.

**Out (follow-on §S5):** (d) transactional outbox (`__loom_outbox` written in
the save tx, relayed post-commit) — P2, the broker-story upgrade path.
