# S5(a) — Phoenix domain-event delivery: persist-then-dispatch

**Status:** in progress (branch `claude/generated-code-ddd-review-ld6gmz`).
**Origin:** `docs/audits/generated-code-ddd-review-2026-07.md` §S5 (P1) — "right half
raised, wrong half delivered". This slice fixes the **Phoenix (worst)** case.

## The bug (reproduced on fresh `main`)

Generated Phoenix operation bodies broadcast the domain event **before** the
write is persisted, into a PubSub topic the context `Dispatcher` never reads:

```elixir
def place_order(%Api.Ordering.Order{} = record, params) when is_map(params) do
  # ... body computes the mutation + builds the event ...
  Logger.info("event_dispatched", event_type: "OrderPlaced", aggregate: "Order")
  Phoenix.PubSub.broadcast(Api.PubSub, "events", %...OrderPlaced{...})   # ← BEFORE persist
  record
  |> Ecto.Changeset.change(%{status: "placed"})
  |> Api.Ordering.OrderRepository.persist_change()                       # ← persist AFTER
end
```

Two defects:
1. **Phantom events on failed writes** — the broadcast fires even when
   `persist_change` returns `{:error, _}` (changeset invalid, DB constraint,
   optimistic-lock conflict).
2. **Severed saga seam** — the event goes to the raw `"events"` PubSub topic,
   which has zero subscribers; the context `Dispatcher` (the seam a declared
   saga subscribes through) is never invoked, so e.g. an `ArchivalTracker`
   saga can never receive its trigger.

## The fix

Reorder to **persist first, dispatch only on `{:ok, saved}`**, and route the
event through the context `Dispatcher` (post-commit) in addition to / instead
of the raw broadcast:

```elixir
def place_order(%Api.Ordering.Order{} = record, params) when is_map(params) do
  # ... body computes the mutation + builds the event list ...
  changeset = record |> Ecto.Changeset.change(%{status: "placed"})
  case Api.Ordering.OrderRepository.persist_change(changeset) do
    {:ok, saved} ->
      # AFTER the commit: fan each event through the context Dispatcher
      # (saga seam) + PubSub broadcast.
      Enum.each([%...OrderPlaced{...}], fn ev ->
        Logger.info("event_dispatched", event_type: ..., aggregate: "Order")
        Api.Ordering.Dispatcher.dispatch(ev)
      end)
      {:ok, saved}
    {:error, reason} -> {:error, reason}
  end
end
```

Every backend that raises domain events keeps the same ordering guarantee
(events observed iff the write committed) — this brings Phoenix in line with
Hono's after-commit dispatch.

## Scope

**In:** Phoenix vanilla operation / create / returning-op bodies —
`src/generator/elixir/vanilla/{operation-returns-emit,context-emit}.ts` (the
emit-statement hoist + Dispatcher routing). Tests:
`test/generator/elixir/*event*` + a behavioral ordering assertion.

**Out (follow-on slices, same audit §S5):** (b) event-sourced saga starter
guard (`create`-by-correlation no-ops when the stream exists); (c) uniform Java
publisher wiring + .NET/Java saga pinned order; (d) transactional outbox
(P2 upgrade path for the broker story). Tracked but not in this PR.

## S12 — returning-op mutations must persist (folded in, closes the S5a residual)

Investigating the S5a residual (explicit-`return` emitting ops kept the inline
emit) uncovered the real, broader bug beneath it: **a Phoenix vanilla returning
operation does not persist its mutation unless audit / provenance / ref-collection
/ emit *incidentally* forces a transaction.** Two lost-mutation shapes on fresh
`main`:

```elixir
# fall-through, assign-only  (operation adjust(delta): Item or NotFound { quantity := quantity + delta })
def adjust_item(%Item{} = record, params) when is_map(params) do
  delta = Map.get(params, "delta")
  record = %{record | quantity: record.quantity + delta}
  {:ok, %{id: record.id, sku: record.sku, quantity: record.quantity}}   # ← in-memory, NEVER persisted
end

# explicit `return this` (mutating)  → identical: mutates record, returns it, no persist_change
```

Named (non-returning) ops already persist via `case persist_change` in
`renderNamedOpFunction`. The returning-op renderer only persists on the
audit/prov/refcoll/emit branches; the plain `hasSuccessPath` branch returns the
**in-memory** projection and the explicit-`return` branch emits no persist tail
at all — so the DB row is never updated (audit §S12, "Phoenix doesn't overwrite
on update").

**Fix:** decouple the persist decision from the success-path *shape*. A returning
op **persists whenever its body mutates** (`persistPutBodies` non-empty),
regardless of fall-through vs explicit `return this`. The success value is
projected off the **saved** struct; events dispatch after `{:ok, saved}`
(subsuming the S5a hoist for the explicit-return shape). A pure (non-mutating)
returning op keeps the in-memory return (no needless round-trip) and stays
byte-identical.
