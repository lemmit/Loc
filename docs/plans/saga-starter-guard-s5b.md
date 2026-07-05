# S5(b) — event-sourced saga starter guard (no double-append)

**Status:** in progress (branch `claude/generated-code-ddd-review-ld6gmz`).
**Origin:** `docs/audits/generated-code-ddd-review-2026-07.md` §S5 (P1) — "the
`.NET/Java saga double-append`". Follows the merged S5(a)+S12 (#1675).

## The bug (reproduced on fresh `main` — broader than the audit stated)

An event-sourced workflow (saga) that declares BOTH `create(e) by …` and
`on(e) by …` for the **same** event subscribes two handlers to it. The `on`
handler correctly guards on stream existence (`if stream empty: no-op`), but the
**`create`-by-correlation starter appends UNCONDITIONALLY** — no inverse guard.
So when the event fires for a stream that already exists, both handlers append,
folding the workflow event twice (`archivedCount += 2`).

This is **not** .NET/Java-only — Hono has it too. Hono's `…StartProjectArchived`
has no guard; its on→start dispatch order only saves the *new-stream* case (on
skips the empty stream, start creates it). On an **existing** stream Hono still
double-appends (`on` appends → `start` appends again). The audit's "Hono pins
on→start" is a partial mitigation, not a fix.

## The fix

1. **Starter guard (all five backends):** the `create`-by-correlation starter
   no-ops when the stream already exists — the inverse of the `on` handler's
   emptiness guard (`if stream NON-empty: no-op / event_unrouted`). This alone
   makes the **existing-stream** case correct and order-independent everywhere.
2. **Pin on-before-start order** where the dispatch sequence is controlled
   (Hono / Python / Elixir already call on then start in one dispatcher fn) so
   the **new-stream** case is correct (on skips empty, start creates). For
   .NET (Mediator `INotificationHandler` fan-out) and Java (Spring
   `@EventListener`) the fan-out order is unspecified — route the two handlers
   through a single ordered dispatch (or pin the order) so on precedes start.

With both, each event appends exactly once: a brand-new correlation runs the
`create`; an existing one runs the `on`; never both.

## Scope

Per-backend event-sourced saga dispatch emitters:
`src/platform/hono/v4/workflow-eventsourced-builder.ts`,
`src/generator/dotnet/workflow-eventsourced-emit.ts`,
`src/generator/java/emit/workflow-eventsourced.ts` (+ `dispatch.ts` ordering),
`src/generator/python/workflow-eventsourced-emit.ts`,
`src/generator/elixir/vanilla/workflow-eventsourced-emit.ts`.
Tests: one generator test per backend (starter emits the exists-guard;
on-before-start ordering) + pin the once-only semantics in conformance.

**Out (follow-on §S5 slices):** (c) uniform Java publisher wiring +
.NET/Java saga order; (d) transactional outbox (P2).
