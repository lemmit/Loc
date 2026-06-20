# Frontend state management — `store` (and why not `state` / `machine` as drafted)

> Status: **proposal** (unadopted). Supersedes the externally-drafted
> "State Management DSL for Loom" (the `state` / `store` / `machine` →
> TypeScript / Zustand / XState design). This document keeps the good idea in
> that draft, rejects the two that fight Loom's architecture, and re-grounds
> the survivor in Loom's actual seams.

---

## 1. The submitted draft, in one paragraph

The draft proposed three graduated keywords. `state` = a pure typed data shape
→ TS `interface` + zod. `store` = a reactive global container → a Zustand
`create()` store. `machine` = a behavioral state chart → an XState
`createMachine()` wrapped in Zustand. Dependency inference from usage, a colon
as the owned-vs-referenced marker, a `_` wildcard transition, flat-over-nested,
progressive commitment. The generated code was concrete React + Zustand +
XState.

It is a coherent design **for a single-framework React app**. Loom is not that.
Below, each keyword is checked against what Loom already ships.

---

## 2. Where the draft meets Loom reality

### 2.1 `state` — **already taken, with a different meaning. Reject the redefinition.**

Loom already has `state`. It is a page-/component-scoped block of **reactive
local fields**, shipped and in the grammar:

```ddd
page PlaceOrderWizard {
  state {
    step:  int               = 0
    draft: PlaceOrderRequest = {}
  }
  body: match {
    step == 0 => CreateForm { ... onSubmit: () => step := 1 }
    ...
  }
}
```

- Grammar: `StateBlock` / `StateField` — `src/language/ddd.langium:689`.
- IR: `PageIR.state` / `ComponentIR.state` : `StateFieldIR[]` —
  `src/ir/types/loom-ir.ts`.
- Read/write seam: `renderStateRead` / `renderStateWrite` /
  `renderNestedStateWrite` — `src/generator/_walker/target.ts:164`. React lowers
  to `useState`; Vue to refs; Svelte to `$state` runes; Angular to signals;
  LiveView to `socket.assigns`.
- Writes use `:=` (`step := 1`), already a Loom statement form
  (`docs/page-metamodel.md` §6, §8).

The draft's `state` means something else entirely — a **pure data shape with no
behavior** ("TS interface + zod, no setters, no reactivity"). Loom already has
**three** spellings for that, and none of them is a frontend keyword:

| Need | Loom construct |
|---|---|
| Domain data shape with identity/behavior | `aggregate` |
| Immutable domain value | `valueobject` |
| Transport/command/query/response slice (→ TS interface + zod on the wire) | `payload` (`docs/payloads.md`) |

The draft's `state User { id; name; email }` is a `valueobject` (or, if it's a
request body, a `payload`). Its `state Pagination { page; pageSize; total }` is a
`valueobject` — and pagination specifically is already first-class
(`docs/pagination-design-note.md`).

**Verdict:** keep `state` as the page/component-local reactive block it already
is. Do **not** repurpose it for data shapes — that would collide with shipped
grammar *and* duplicate `valueobject`/`payload`. The draft's data-shape examples
need no new keyword.

### 2.2 `store` — **the one real gap. Adopt, but re-ground it.**

This is the genuinely new idea. Today Loom frontend state is **page-local only**.
`docs/page-metamodel.md` §14 lists exactly this as an open question:

> **URL-synced state.** Deferred. v0 state is in-memory only.
> ... no global app state.

There is real demand for state that outlives one page and is shared across
pages: the signed-in user, a theme/locale toggle, a cross-page selection, a
filter shared by a list page and a chart page, a "draft" that survives
navigation. Today the only carrier is TanStack Query's cache (server state) —
which is the wrong tool for *client-owned* UI state.

So `store` fills a real hole. **But the draft's framing has to change on two
axes to fit Loom:**

1. **The DSL stays framework-neutral; each frontend lowers to its own idiom.**
   The constraint Loom actually imposes is on the *keyword* — `store` must say
   nothing about any library — not on the per-frontend lowering. Loom emits five
   frontends from one neutral metamodel (React, Vue, Svelte, Angular, Phoenix
   LiveView), and each already carries its own framework-only deps (React ships
   `@tanstack/react-query` + `react-hook-form`). So `store` lowers through the
   existing `WalkerTarget` seam (`src/generator/_walker/target.ts`) to each
   framework's idiomatic store — Zustand is a legitimate React choice, in-grain
   with the React stack's existing react-only deps:

   | Frontend | `store` lowering |
   |---|---|
   | React | a Zustand `create()` store (~1 KB, React-only) — in-grain with the existing React-only deps; selector memoization and a `persist` middleware come for free |
   | Vue | a `reactive()` singleton module (Pinia optional, not required) |
   | Svelte | a `.svelte.ts` module exporting `$state` runes |
   | Angular | an `@Injectable({providedIn:'root'})` signal service |
   | Phoenix LiveView | **no client store** — shared state is `socket.assigns`, seeded from a session/PubSub; a `store` either degrades to per-LiveView assigns or is rejected for LiveView (validator) |

   This mirrors how `state {}` already lowers per-framework — `store` is the
   *cross-page* sibling of the page-local `state {}` block. The keyword imposes
   no runtime; each `WalkerTarget` picks the idiomatic one.

2. **`ui`-scoped, not free-floating top-level.** Everything client lives under
   `ui { ... }` (`UiMember` — `ddd.langium`, near the `Page`/`Component`/`Area`
   members). A `store` is a new `UiMember`, visible to every page/component in
   that `ui`. This keeps the "frontends consume the wire shape, own no domain
   logic" invariant: a `store` holds **view state**, never domain rules.

```ddd
ui SalesAdmin {
  framework: react
  api Sales: SalesApi

  store filters {
    query:    string  = ""
    sortBy:   string  = "name"
    sortDesc: boolean = false
  }

  store selection {
    current: Customer id? = null      // references a wire id, not a domain entity
  }

  page CustomerList {
    route: "/customers"
    body: Stack {[
      Field { bind: filters.query },                 // read+write a store field
      QueryView { of: Sales.Customer.all },          // server state stays TanStack Query
      ...
    ]}
  }
}
```

Store fields read/write with the same `:=` the page-local `state {}` already
uses (`filters.query := v`); the only difference is the target's **scope** (ui,
not page), which the lowerer already has to resolve for `apiParam.X` references
anyway. The draft's "colon is the ownership marker" reduces, in Loom, to **scope
resolution that already exists** — a dotted `store.field` resolves to the
ui-scoped store; a bare name resolves to page-local `state`. No new ownership
keyword, exactly as the draft wanted, but via Loom's existing scope provider
rather than a Zustand/XState split.

**Verdict:** adopt `store` as a new `ui`-scoped `UiMember`, lowered per-frontend
through `WalkerTarget`. It is the page-local `state {}` block lifted to ui scope.
No new third-party runtime dependency on any frontend.

### 2.3 `machine` — **defer. It re-opens decisions Loom made deliberately.**

The draft's `machine` is a client-side XState chart. Three things in Loom push
back hard:

1. **Behavioral lifecycle is a backend `workflow`.** Loom already has a
   first-class behavioral construct — `workflow` (`docs/workflow.md`) — with
   named instance states, typed events, and transition actions. The draft's
   `UserListMachine` (idle/loading/success/error around a fetch) is, in Loom
   terms, *server state*: TanStack Query already models idle/loading/success/
   error per query (`isPending`/`isError`/`data`) and surfaces it through the
   `QueryView { of:, loading:, error:, empty:, data: }` primitive
   (`docs/page-metamodel.md` §9). The draft's flagship example **is the thing
   Loom already auto-generates** — re-implementing it as a hand-written XState
   machine is a step backward.

2. **Wizards/flows are explicitly composition, not a keyword.**
   `docs/page-metamodel.md` §12 ("Wizard via composition") and §14 ("Multi-step
   named flows — **not** in v0") record a deliberate decision: the
   `state` + `match` + block-body-lambda + `navigate` quartet covers realistic
   client lifecycles without a state-chart construct. The draft's `machine`
   re-opens a closed non-goal.

3. **It breaks framework neutrality the hardest.** XState is a heavy React-flavored
   runtime; there is no clean Vue/Svelte/Angular/LiveView image of an XState
   chart that the `WalkerTarget` seam can render uniformly. LiveView's whole
   point is that the *server* owns the state chart.

**Verdict:** do **not** ship `machine` now. If a future need survives `store` +
`QueryView` + backend `workflow`, the right shape is a small **`flow`** sugar
that desugars to the existing `state` + `match` pattern (a framework-neutral
reducer the `WalkerTarget` already knows how to render) — *not* an XState
dependency. Track it as a follow-up, gated on a concrete example the current
quartet can't express. (The draft's `_` wildcard transition and `*_SUCCESS`/
`*_ERROR` async convention belong with that future `flow`, not with `store`.)

---

## 3. Revised design — what to actually build

**One new keyword: `store`.** A `ui`-scoped block of shared reactive view-state
fields, lowered per-frontend through `WalkerTarget`. Everything else the draft
asked for is either already shipped (`state`, data shapes, dependency inference,
server lifecycle) or deliberately deferred (`machine`).

### 3.1 Grammar (additive)

```langium
// New UiMember — sits beside Page / Component / Area / UiApiParam.
UiMember:
    UiApiParam | UiChannelParam | UiNotification | UiFunction
  | Page | Component | Area | MenuBlock | Store;     // + Store

// Reuses the existing StateField rule verbatim — a store is a named,
// ui-scoped state block.
Store:
    'store' name=ID '{'
        fields+=StateField*
    '}';
```

No new field rule, no new expression form, no new operators — `StateField`
(`name=ID ':' type=TypeRef ('=' init=Expression)?`) and `:=` writes are reused
unchanged. This is the cheapest possible language lift: one production, one
`UiMember` arm.

### 3.2 IR (additive)

- New `StoreIR { name; fields: StateFieldIR[] }` in `src/ir/types/loom-ir.ts`,
  reusing `StateFieldIR`.
- `UiIR.stores: StoreIR[]` (alongside `pages`, `components`).
- Lowered in `src/ir/lower/lower-ui.ts` (the page/ui lowerer), exactly like a
  page's `state {}` — no new pass.
- Scope resolution: a dotted `<store>.<field>` reference resolves against
  `UiIR.stores`; `src/language/ddd-scope.ts` gains the ui-store scope the same
  way it already scopes `apiParam.Aggregate`. This delivers the draft's
  "usage is declaration" and "colon = ownership" for free — the colon is just
  the dotted-access the scope provider already understands.

### 3.3 Code generation — framework-neutral via `WalkerTarget`

Two new seam methods on `WalkerTarget` (`src/generator/_walker/target.ts`),
parallel to the existing `renderStateRead`/`renderStateWrite`:

- `renderStoreModule(store: StoreIR): string` — emits the per-framework store
  module (`src/stores/<name>.ts`).
- `renderStoreRead(ref) / renderStoreWrite(ref, value)` — emit the read/write at
  a use site (page body). For most frontends these are identical to the existing
  state seams pointed at the store module instead of a local hook.

Illustrative React output (Zustand — the React stack already carries react-only
deps, so this is in-grain; `persist` middleware is the path to §4's
`persist: local`):

```typescript
// src/stores/filters.ts
import { create } from "zustand";

interface Filters {
  query: string;
  sortBy: string;
  sortDesc: boolean;
  set: (patch: Partial<Omit<Filters, "set">>) => void;
}

export const useFilters = create<Filters>((set) => ({
  query: "",
  sortBy: "name",
  sortDesc: false,
  set: (patch) => set(patch),
}));
// use site: const query = useFilters((s) => s.query);   // memoized selector
//            useFilters.getState().set({ query: v })     // filters.query := v
```

Svelte output is a `filters.svelte.ts` exporting a `$state` rune; Vue a
`reactive()` singleton; Angular a signal service; LiveView is rejected at
validation (or degrades to per-LiveView assigns) — surfaced as
`loom.store-unsupported-on-liveview`. Server state is untouched: TanStack Query
stays the source of truth for anything fetched; `store` is strictly
**client-owned view state**.

### 3.4 What the draft asked for, and where it lands

| Draft ask | Disposition in Loom |
|---|---|
| `state` = pure data shape | **Rejected** — use `valueobject` / `payload`; `state` already means page-local reactive fields |
| `store` = shared reactive container | **Adopted** — new `ui`-scoped `UiMember`; the keyword is framework-neutral, React lowers to Zustand, other frontends to their native reactivity |
| `machine` = client state chart | **Deferred** — backend `workflow` + `QueryView` + `state`/`match` cover it; revisit as a `flow` sugar, never XState |
| Dependency inference from usage | **Already true** — pages already detect `apiParam.X` calls and hoist hooks |
| Colon = ownership marker | **Reframed** — dotted `store.field` vs bare `state` field, resolved by the existing scope provider |
| `_` wildcard transition | **Deferred** with `machine`/`flow` |
| Flat over nested | **Already true** — `ui` members are flat; stores shared across pages by name |
| Progressive commitment | **Preserved** — `state` (page) → `store` (ui) → (future) `flow` |
| Async via `*_SUCCESS`/`*_ERROR` | **Rejected for now** — TanStack Query already owns async lifecycle |

---

## 4. Open questions / non-goals

- **URL-synced stores.** Same deferral as page `state` (§14). A later
  `store filters { ... } sync: url` could push fields to query params.
- **Persistence.** `localStorage`-backed stores (theme, locale) are an obvious
  follow-up flag (`store theme { ... } persist: local`); out of scope here.
- **LiveView stores.** v0 rejects `store` on `framework: liveview` rather than
  guessing a `socket.assigns`/PubSub topology. Revisit when a concrete
  cross-LiveView-state example forces it.
- **`flow` / `machine`.** Tracked, not designed — see §4.1.

### 4.1 The deferred `flow` (the draft's `machine`, re-scoped)

`machine` is deferred rather than rejected because there *is* one capability the
existing quartet can't express: **compile-time transition legality on
purely-client state.** A `state { step: int = 0 }` wizard works, but nothing
stops `step := 5`. The only honest justification for a new keyword is *enforced
legal transitions* — named states where the compiler rejects an `event` that
isn't admissible in the current state. That, and only that, is the gate.

Everything else the draft's `machine` wanted is already covered, which is why
the residual need is narrow:

- **Async lifecycle** (idle/loading/success/error) is **TanStack Query** — surfaced
  through `QueryView { of:, loading:, error:, empty:, data: }`. The draft's
  flagship `UserListMachine` *is* this; re-expressing it as a client chart is
  redundant.
- **Durable, multi-aggregate, transactional lifecycle** is the backend
  **`workflow`** (`docs/workflow.md`).
- **In-memory wizards/branching** are `state` + `match` + block-body lambdas +
  `navigate` (`docs/page-metamodel.md` §12) — a deliberate §14 choice.

If a real illegal-state-prevention example survives all three, the construct is
a **`flow`**, and it is a *reducer sugar*, never XState:

- **Desugars to a framework-neutral reducer**, not an interpreter — states become
  a discriminated-union/enum field, events become `dispatch(e)`, transitions
  become a `match`-shaped reducer the `WalkerTarget` already renders. A reducer
  has a clean image on every frontend; an XState interpreter is React-flavored
  and has none on Vue/Svelte/Angular — and LiveView's whole model is *server*-owned
  state, so a client chart is antithetical there. This is the same
  framework-neutrality reason `store` doesn't mandate Zustand at the DSL level.
- **`flow` orchestrates; TanStack Query executes async.** The draft's `_` wildcard
  is an internal transition (action, no state change); its `*_SUCCESS`/`*_ERROR`
  convention is a transition into a `loading` state whose action invokes an
  existing api-param `mutate`/`query` — not an XState actor.
- **Scope mirrors what exists** — a page-scoped `flow` for a local wizard, a
  `ui`-scoped `flow` (built on `store`) for an app lifecycle such as auth; same
  split as `state` (page) vs `store` (ui).
- **Line vs `workflow`** — `flow` is ephemeral, single-session, client-only, no
  persistence; its terminal action may `call` a `workflow`
  (`call placeOrder(draft)`). `workflow` is the durable server side.

Decision: **do not build `flow` speculatively.** It carries real new grammar,
new IR, and new validation (the legality check) for a capability that `state` +
`match` mostly already deliver. Build it only against a concrete `.ddd` example
that needs enforced client-side transition legality — and even then, as a
reducer sugar over `store` + `match` + api-params.

---

## 5. Summary

The draft's instinct — *graduated abstraction, minimal syntax, inference over
declaration* — is right and already deeply present in Loom. But two of its three
keywords fight the codebase: `state` is taken (and data shapes are
`valueobject`/`payload`), and `machine` re-opens the deliberately-closed
"client state chart" non-goal while pinning the output to React-only XState.
The single keyword worth adding is **`store`** — the page-local `state {}` block
lifted to `ui` scope, lowered to each frontend's idiomatic store through the
existing `WalkerTarget` seam (Zustand on React, native reactivity elsewhere;
the keyword itself names no library). That delivers the draft's actual missing
capability (shared cross-page client state) at the cost of one grammar
production and one IR node, without violating Loom's server-first,
framework-neutral, domain-logic-free frontend invariants. The draft's `machine`
stays deferred behind a single concrete precondition (§4.1) — enforced
client-side transition legality — and, if ever built, as a framework-neutral
reducer sugar, not XState.
