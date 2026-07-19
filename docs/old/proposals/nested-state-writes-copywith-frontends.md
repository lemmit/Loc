# Nested page-state writes on the `copyWith` frontends (Flutter, Feliz)

> Status: **WRITE EMISSION SHIPPED (2026-07).** Nested page-state writes
> (`order.shipping.zip := v`) in a named action now fold into an immutable
> rebuild on **both** immutable-record frontends: a **`copyWith` chain** on
> Flutter (Riverpod) and a nested **record `with`** update on Feliz (Elmish) —
> the twin of React's inside-out spread, which already shipped. On Flutter this
> is fully at React parity (the wire models now carry `copyWith`; the chain
> compiles). On Feliz the *write* emission is correct, but record-typed page
> state is not yet end-to-end functional there for a **deeper, separate reason**
> (see "Remaining gap"). Surfaced while building the Flutter state-write
> projection. Implemented in the PR that supersedes this proposal.

## The observation

A page/component `state {}` field can be written at a **nested path**, not just at
its root:

```ddd
page Checkout {
  state { order: Order = ... }
  action setZip(z: string) { order.shipping.zip := z }   // ← nested write
}
```

The shared body walker (`src/generator/_walker/walker-core.ts`) already routes any
multi-segment write through a dedicated target seam:

```ts
// walker-core.ts — stateWrite()
if (seg.length === 1) return `${ctx.target.renderStateWrite(stateRef, valueJs)};`;
return `${ctx.target.renderNestedStateWrite(seg, valueJs)};`;   // ← nested seam
```

React's is representative — an inside-out immutable spread onto the root setter:

```tsx
// react/walker/tsx-target.ts
setOrder({ ...order, shipping: { ...order.shipping, zip: z } })
```

**The nested types cooperate for free** — a spread (`{ ...order.shipping, zip }`)
needs nothing from the `shipping` type.

## Why Flutter and Feliz were different — and why it surfaced during Flutter work

Flutter and Feliz do **not** hold page state as loose fields with per-field setters.
They hold it as **one immutable record** and rebuild it with `copyWith` / F# `with`:

- **Flutter (Riverpod):** `state = state.copyWith(field: value)`, projected in
  `riverpod-emit.ts` (`renderNotifierStmt`), NOT in the walker seam. (Inline writes
  in render-tree lambdas are rejected by `loom.effect-in-lambda`; named actions
  project through the Notifier.)
- **Feliz (Elmish):** `{ model with Field = value }`, projected in `update-emit.ts`.

For a single-segment write both are fine. For a **nested** write the immutable model
forces a **deep rebuild down the whole chain**, and before this change both
projectors dropped the tail:

- Flutter emitted a `// TODO(flutter full-parity): nested state write …` comment.
- Feliz emitted the **silently-wrong** `{ model with Draft = z }` (a string assigned
  to a record field — would fail Fable compile; no showcase exercised it).

The blocker was that the nested types are wire-model classes that had no `copyWith`.
React's spread sidesteps this by never asking the nested type for anything; the
`copyWith`/`with` model *requires* every level to expose a rebuild method. That is
why it surfaced during Flutter: it is the one write shape where the immutable-record
state model diverges structurally from the setter/spread model.

## What shipped

1. **Flutter — `copyWith` on wire models + a folded chain.** `dart-model-emit.ts`
   now emits a `copyWith({...})` on every wire model (aggregate/part/value-object),
   the same shape `renderStateDataClass` emits for `<Page>State`.
   `riverpod-emit.ts`'s `renderNotifierStmt` folds a multi-segment target inside-out:

   ```dart
   // order.shipping.zip := z
   state = state.copyWith(
     order: state.order.copyWith(
       shipping: state.order.shipping.copyWith(zip: z)));
   ```

   The single-segment case collapses to `state.copyWith(field: v)` (byte-identical to
   before). `+=`/`-=` fold the compound value back through the same chain. Compile-
   verified against the Flutter SDK (standalone + the showcase's model `copyWith`).

2. **Feliz — nested record `with`.** `update-emit.ts`'s `nestedFsWith` folds the
   segment list into `{ model with Root = { model.Root with <wire> = … } }`; the root
   is the Model field (PascalCase, via `targetModelField`), nested segments are wire-
   record fields (exact lowercase source names). F# records already support `with`,
   so no model-emitter change was needed.

3. **Shared:** no grammar or IR change — the write already lowers to an `assign` (or
   `add`/`remove`) StmtIR with a multi-segment `target`. Purely a per-backend
   emission gap. Tests: `test/generator/flutter/nested-state-write.test.ts`,
   `test/generator/feliz/nested-state-write.test.ts`.

## Remaining gap — record-typed page-state *initialization* (universal)

Nested writes need a record-typed state field, and **initializing** one is a separate,
pre-existing gap that affects **every** frontend, not just the `copyWith` ones:

- `state { draft: Shipping = Shipping.create({...}) }` — the `.create({...})`
  constructor call is unsupported in a state-init position on **all** frontends:
  React/Flutter emit `/* TODO … */ undefined` (a compile error), Feliz **hard-throws**
  at generation (`renderFsMethodCall`).
- On **Feliz** specifically it is worse: the referenced value-object records are only
  emitted when reachable via a *read*, and a no-init record field defaults to a
  placeholder (`Draft = ""`) — so a record-typed page state does not Fable-compile
  regardless of the write.

React ships nested writes today with this same init gap open (its `walker-multiseg-state`
test pins the `.tsx` write output without a full compile). This change brings Flutter and
Feliz to that same bar: **the write is correct and pinned; end-to-end record-typed state
awaits a construction-expression fix** — a bigger, cross-frontend feature (render
`VO.create({...})` as a real constructor call, and emit the VO records unconditionally on
Feliz). That is the natural follow-up and is out of scope here.

## Open questions (follow-up)

- **Optional intermediates.** `order.shipping?.zip := v` needs a null guard in the
  `copyWith` chain — validator error (`loom.nested-write-through-optional`) or emitted
  guard?
- **Collection intermediates.** `order.lines[0].qty := n` (index mid-path) is a strictly
  bigger feature; the static-bundle frontends don't obviously support it either. Out of
  scope.
- **Record-state construction.** The `VO.create({...})` → constructor-call fix above is
  the real unlock for end-to-end record-typed page state on every frontend.

## Pointers

- Shared seam + single/nested split: `src/generator/_walker/walker-core.ts` (`stateWrite`).
- React reference impl: `src/generator/react/walker/tsx-target.ts` (`renderNestedStateWrite`).
- Flutter chain + wire-model `copyWith`: `src/generator/flutter/riverpod-emit.ts` (`nestedCopyWith`), `src/generator/flutter/dart-model-emit.ts` (`copyWithMethod`).
- Feliz nested `with`: `src/generator/feliz/update-emit.ts` (`nestedFsWith`).
