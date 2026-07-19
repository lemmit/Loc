# Nested page-state writes on the `copyWith` frontends (Flutter, Feliz)

> Status: **PROPOSAL — idea capture (2026-07).** Nested page-state writes
> (`order.shipping.zip := v`) SHIP on the four static-bundle frontends
> (React/Vue/Svelte/Angular) via the shared `renderNestedStateWrite` walker seam;
> they are **unimplemented on the two immutable-record frontends** — Flutter
> (Riverpod) and Feliz (Elmish). This doc records *why* the gap is specific to
> those two, and the proposed fix (emit `copyWith` on nested wire-model classes so
> the deep-rebuild chain has something to call). Surfaced while building the
> Flutter state-write projection. No code yet.

## The observation

A page/component `state {}` field can be written at a **nested path**, not just at
its root:

```ddd
page Checkout {
  state { order: Order = ... }
  action setZip(z: string) { order.shipping.zip := z }   // ← nested write
}
```

This works today on **React, Vue, Svelte, Angular**. The shared body walker
(`src/generator/_walker/walker-core.ts`) routes any multi-segment write through a
dedicated target seam:

```ts
// walker-core.ts — stateWrite()
if (seg.length === 1) return `${ctx.target.renderStateWrite(stateRef, valueJs)};`;
return `${ctx.target.renderNestedStateWrite(seg, valueJs)};`;   // ← nested seam
```

and each of the four static-bundle targets implements `renderNestedStateWrite`.
React's is representative — an inside-out immutable spread onto the root setter:

```tsx
// react/walker/tsx-target.ts — renderNestedStateWrite(["order","shipping","zip"], "z")
setOrder({ ...order, shipping: { ...order.shipping, zip: z } })
```

Vue/Svelte mutate in place; Angular has its own idiom. **The nested types cooperate
for free** — a spread (`{ ...order.shipping, zip }`) needs nothing from the
`shipping` type; it just copies a plain object.

## Why Flutter and Feliz are different — and why it surfaced during Flutter work

Flutter and Feliz do **not** hold page state as loose fields with per-field setters.
They hold it as **one immutable record** and rebuild it with `copyWith` / F# `with`:

- **Flutter (Riverpod):** state is a generated `<Page>State` data class; a write is
  `state = state.copyWith(field: value)`, projected in `riverpod-emit.ts`
  (`renderNotifierStmt`), NOT in the walker seam. (The walker's
  `flutterTarget.renderNestedStateWrite` is unreachable — inline writes in
  render-tree lambdas are rejected upstream by `loom.effect-in-lambda`, and named
  actions project through the Notifier.)
- **Feliz (Elmish):** state is the `Model` record; a write is `{ model with Field = value }`,
  projected in `update-emit.ts`. Its `felizTarget.renderNestedStateWrite` is a `() => "()"`
  stub for the same reason.

For a **single-segment** write both are fine (`copyWith(count: …)` / `{ model with Count = … }`).
For a **nested** write, the immutable model forces a **deep rebuild down the whole
chain** — every intermediate level must be reconstructed:

```dart
// Flutter — what order.shipping.zip := z MUST become
state = state.copyWith(
  order: state.order.copyWith(
    shipping: state.order.shipping.copyWith(zip: z),
  ),
);
```

```fsharp
// Feliz — the F# twin
{ model with Order = { model.Order with Shipping = { model.Order.Shipping with Zip = z } } }
```

The blocker: **the nested types are wire-model classes that have no `copyWith`.**
`src/generator/flutter/dart-model-emit.ts` emits `Order` / `Shipping` as plain data
classes with a `fromJson` / `toJson` — zero `copyWith` methods (verified:
`grep -c copyWith dart-model-emit.ts` → 0). Feliz records support `with` natively at
the F# language level, but the Feliz projector still only reads `segments[0]` and
drops the tail. React's spread sidesteps the whole problem because it never asks the
nested type for anything; the `copyWith` model *requires* every level to expose a
rebuild method.

So both projectors currently emit a visible, non-silent placeholder rather than wrong
code — Flutter:

```dart
// TODO(flutter full-parity): nested state write order.shipping.zip := z
```

This is why the idea "came out" during Flutter: it is the one write shape where the
immutable-record state model diverges structurally from the setter/spread model, and
that divergence is invisible until you implement the deep-rebuild arm.

## Scope of the real gap

| Frontend | State model | Single-segment write | Nested write |
|---|---|---|---|
| React | `useState` per field | ✅ setter | ✅ immutable spread |
| Vue | reactive refs | ✅ | ✅ in-place |
| Svelte | runes/stores | ✅ | ✅ in-place |
| Angular | signals | ✅ | ✅ |
| **Flutter** | immutable `<Page>State` + `copyWith` | ✅ `copyWith` | ❌ nested types lack `copyWith` |
| **Feliz** | immutable `Model` + `with` | ✅ `with` | ❌ projector drops the tail |

It is **not** a mobile quirk and **not** Flutter-specific — it is a shared property of
the two `copyWith`/`with`-based frontends. HEEx (Phoenix) renders state through its own
engine and is out of scope here.

## Proposed approach

1. **Flutter — emit `copyWith` on wire-model classes.** Extend
   `dart-model-emit.ts` so every generated data class (aggregate/part/value-object
   wire model) gets a `copyWith({...})` alongside `fromJson`/`toJson` — exactly the
   shape `renderStateDataClass` already emits for `<Page>State`. Then implement the
   nested arm in `riverpod-emit.ts`'s `renderNotifierStmt`: fold the segment list
   inside-out into a `copyWith` chain rooted at `state.copyWith(<root>: …)` (the
   Flutter twin of React's inside-out spread). The chain reads each intermediate
   level from the current `state` (`state.order`, `state.order.shipping`), so no new
   IR is needed — the segment list + per-level `copyWith` is sufficient.

2. **Feliz — fold the segment list into a nested `with` record update** in
   `update-emit.ts` (F# records already support `with`, so no model-emitter change
   is required — only the projector must stop reading just `segments[0]`).

3. **Shared:** neither needs a grammar or IR change — the write already lowers to an
   `assign` StmtIR with a multi-segment `target`. This is purely a per-backend
   emission gap. Add a corpus/generator test per frontend and grow the
   `generated-flutter-build.yml` / `generated-feliz-build.yml` showcases with one
   nested-write page so the SDK gate proves the deep rebuild compiles.

## Open questions

- **Optional intermediates.** If an intermediate level is `T?` (`order.shipping?` is
  optional), the `copyWith` chain needs a null guard (`state.order.shipping == null ?
  state : …`). Decide whether a nested write through an optional is a validator error
  (`loom.nested-write-through-optional`) or an emitted guard.
- **Collection intermediates.** `order.lines[0].qty := n` (index into a collection mid-path)
  is a strictly bigger feature — the four static-bundle frontends don't obviously
  support it either. Keep it out of this proposal (record-only nested paths).
- **Whether to unify** the Flutter `copyWith`-emit with `renderStateDataClass` so the
  `<Page>State` class and the wire models share one emitter (they already share the
  shape).

## Pointers

- Shared seam + single/nested split: `src/generator/_walker/walker-core.ts` (`stateWrite`).
- React reference impl: `src/generator/react/walker/tsx-target.ts` (`renderNestedStateWrite`).
- Flutter projector + current TODO: `src/generator/flutter/riverpod-emit.ts` (`renderNotifierStmt`, `assign` arm).
- Flutter wire models (no `copyWith` today): `src/generator/flutter/dart-model-emit.ts`.
- Feliz projector (drops the tail): `src/generator/feliz/update-emit.ts`.
