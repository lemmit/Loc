# Frontend state management — the `store` keyword and the lifetime ladder

> **Related:** this note owns the `store` *container* (keyword, lifetime ladder,
> per-frontend lowering). **Named actions over store state** — the transitions
> that mutate it — are [`named-actions-and-stores.md`](named-actions-and-stores.md)
> ("Proposal A"); treat the two as one feature split by concern. Async effects in
> those actions: [`async-actions-and-effects.md`](async-actions-and-effects.md).
>
> Status: **PARTIAL — `store` container + the lifetime ladder SHIPPED on the SPA
> frontends** (2026-07 code-verified). Grammar `Store`/`StoreDecl` + `use <Store>`,
> `StoreIR`, lowering (`store-field`/`store-action` resolution), the encapsulation +
> acyclic-composition validators (`store-checks.ts`), and Zustand/Pinia/Svelte/
> Angular + LiveView emission are live. **The lifetime ladder shipped on
> React/Vue/Svelte/Angular** (`persist: memory|local|session|url`); LiveView is
> memory-only (see below). The old note read:
> **The lifetime ladder SHIPPED on the SPA frontends** (2026-07-03): one keyword
> `persist: memory|local|session|url` (grammar `Store` rule + `lowerStore` →
> `StoreIR.lifetime`). React/Vue/Svelte/Angular emit all four tiers —
> `local`/`session` via each framework's storage idiom (Zustand `persist`
> middleware / hand-rolled `watch`/`$effect`/`effect` write-back; money fields
> revived to `Decimal`), `url` via a bidirectional sync with a typed
> untrusted-input decoder — bound to **each framework's own router where a
> module-level store can reach it**: **Angular** → native `Router`/
> `ActivatedRoute` (`queryParamMap` ↔ `Router.navigate(...merge, replaceUrl)`);
> **Svelte** → SvelteKit's router (reactive `page` from `$app/state` ↔
> `goto(...replaceState)`); both observe every navigation and stay consistent
> with the framework's history. **React and Vue** use `window.location` +
> `history.replaceState` + `popstate` — deliberately, since react-router's
> `useSearchParams` and vue-router's `useRoute` are component-scoped hooks a
> module-store singleton cannot call (its one limitation: in-app `pushState`
> link navigations aren't observed — only back/forward + manual edits — fine
> for store-driven filter state). **LiveView is memory-only** —
> `local`/`session`/`url` are gated by `loom.store-lifetime-liveview-unsupported`
> (a server-side struct has no browser storage; URL state is the page's
> `handle_params`, out of v1 store scope). Two other gates: `loom.store-lifetime-invalid`
> (bad `persist:` value) and `loom.store-url-field-unsupported` (a `url` store's
> fields must be scalar). Remaining: LiveView `url` via `handle_params`/`push_patch`
> (the §5 follow-up). Surface pinned to one keyword (the `url` tier was formerly
> the separate `sync: url`; see §3.1). Named actions over store state
> shipped alongside (Proposal A Stage 1). Supersedes the externally-drafted
> "State Management DSL for Loom" (`state` / `store` / `machine` →
> TypeScript / Zustand / XState). This revision keeps the one good idea in that
> draft (`store`), rejects the two that fight Loom's architecture (`state`
> redefinition, `machine`), and — the substance of this rewrite — organises the
> design around a single axis the draft never named: **lifetime**.

---

## 1. The submitted draft, in one paragraph

The draft proposed three graduated keywords. `state` = a pure typed data shape
→ TS `interface` + zod. `store` = a reactive global container → a Zustand
`create()` store. `machine` = a behavioral state chart → an XState
`createMachine()` wrapped in Zustand. Plus: dependency inference from usage, a
colon as the owned-vs-referenced marker, a `_` wildcard transition,
flat-over-nested, progressive commitment. The generated code was concrete React
+ Zustand + XState. It is coherent **for a single-framework React app** — Loom
emits five frontends from one neutral metamodel, so each keyword has to be
checked against what Loom already ships.

---

## 2. The three keywords vs. Loom reality

### 2.1 `state` — already taken. Reject the redefinition.

Loom already has `state`: a page-/component-scoped block of **reactive local
fields**, shipped and in the grammar.

```ddd
page PlaceOrderWizard {
  state { step: int = 0, draft: PlaceOrderRequest = {} }
  body: match { step == 0 => CreateForm { ... onSubmit: () => step := 1 }, ... }
}
```

- Grammar: `StateBlock` / `StateField` — `src/language/ddd.langium:689`.
- IR: `PageIR.state` / `ComponentIR.state` : `StateFieldIR[]` — `src/ir/types/loom-ir.ts`.
- Read/write seam: `renderStateRead` / `renderStateWrite` / `renderNestedStateWrite`
  — `src/generator/_walker/target.ts:164`. React → `useState`; Vue → refs;
  Svelte → `$state` runes; Angular → signals; LiveView → `socket.assigns`.
- Writes use `:=` (`step := 1`), already a Loom statement form.

The draft's `state` means a **pure data shape** ("TS interface + zod, no
setters"). Loom already has three spellings for that, none a frontend keyword:

| Need | Loom construct |
|---|---|
| Domain data shape with identity/behavior | `aggregate` |
| Immutable domain value | `valueobject` |
| Transport/command/query/response slice (→ TS interface + zod on the wire) | `payload` (`docs/payloads.md`) |

The draft's `state User { id; name; email }` is a `valueobject` (or a `payload`
if it's a request body); `state Pagination { ... }` is a `valueobject`, and
pagination is already first-class (`docs/pagination-design-note.md`).

**Verdict:** keep `state` as the page/component-local reactive block it already
is. Data shapes need no new keyword.

### 2.2 `store` — the one real gap. Adopt.

Today Loom frontend state is **page-local only** — `docs/page-metamodel.md` §14
lists "no global app state" as an open question. There is real demand for state
that **outlives one page and is shared across pages**: a cross-page selection, a
filter shared by a list and a chart, a draft that survives navigation, a
session-wide toggle. TanStack Query's cache (server state) is the wrong tool for
*client-owned* UI state.

`store` is a named, `ui`-scoped block of shared reactive fields. It is the
page-local `state {}` block lifted to `ui` scope. Crucially — and this is the
correction over earlier drafts of *this* document — `store` means exactly what
the ecosystem means by "store": **an in-memory, shared, reactive container**
(the Zustand/Pinia shape). The keyword names the *abstraction*; each frontend
lowers it to its idiomatic realization (§3, §4).

```ddd
ui SalesAdmin {
  framework: react
  api Sales: SalesApi

  store filters {
    query:    string  = ""
    sortBy:   string  = "name"
    sortDesc: boolean = false
  }
  store selection { current: Customer id? = null }   // a wire id, not a domain entity

  page CustomerList {
    route: "/customers"
    body: Stack {[
      Field { bind: filters.query },          // shared store field, dotted access
      QueryView { of: Sales.Customer.all },   // server state stays TanStack Query
    ]}
  }
}
```

**Verdict:** adopt `store` as a new `ui`-scoped `UiMember`. It holds **view
state, never domain rules** — preserving the "frontends consume the wire shape,
own no domain logic" invariant.

### 2.3 `machine` — defer behind a concrete precondition.

The draft's `machine` is a client-side XState chart. It re-opens decisions Loom
made deliberately, and there is exactly one capability it adds that the existing
constructs can't — see §6. **Verdict:** do not ship now; if it ever lands, as a
framework-neutral `flow` reducer sugar, never XState.

---

## 3. What to build — grammar, IR, codegen

**One new keyword: `store`.** A `ui`-scoped block of shared reactive view-state
fields, lowered per-frontend through the existing `WalkerTarget` seam.

### 3.1 Grammar (additive)

```langium
UiMember:
    UiApiParam | UiChannelParam | UiNotification | UiFunction
  | Page | Component | Area | MenuBlock | Store;     // + Store

Store:
    'store' name=ID lifetime=StoreLifetime? '{'
        fields+=StateField*
    '}';

// Lifetime modifier (default = in-memory; see §4). Additive — bare `store`
// keeps the in-memory contract. ONE keyword, four homes for the state.
StoreLifetime:
    'persist' ':' ('memory' | 'local' | 'session' | 'url');
```

> **[2026-07-03 pinned] One keyword `persist:`, not `persist:` + `sync:`.**
> Earlier drafts spelled the URL tier `sync: url` (a second keyword) on the
> theory that reflecting state into the URL is *synchronisation*, not
> *persistence*. Collapsed to a single `persist: memory | local | session |
> url` because the reserved IR is already **one** `lifetime` enum (§3.2) — the
> rungs are mutually exclusive, so a store has exactly one home, which a single
> keyword expresses naturally and without an IR restructure. **Accepted trade:**
> a store cannot be *both* session-durable and URL-shareable at once (they're
> one axis). **Honest caveat the drop papers over:** `local`/`session` are
> private, one-way durability, whereas `url` is **bidirectional and shared** —
> the URL can change *underneath* the store (back/forward, a hand-edited or
> pasted address) and those changes flow back in, so the generated code
> re-decodes on every URL change (the untrusted-input decoder is derived from
> the store's typed fields; §4.1). If a real "URL-shareable **and**
> session-fallback" case ever appears, revisit with an orthogonal second axis
> then — not speculatively.

`StateField` (`name=ID ':' type=TypeRef ('=' init=Expression)?`) and `:=`/`+=`/`-=`
writes are reused unchanged. One production, one `UiMember` arm, one optional
modifier.

### 3.2 IR (additive)

- `StoreIR { name; lifetime: "memory" | "persistLocal" | "persistSession" | "url"; fields: StateFieldIR[] }`.
- `UiIR.stores: StoreIR[]` (alongside `pages`, `components`).
- Lowered in `src/ir/lower/lower-ui.ts`, exactly like a page's `state {}` — no new pass.
- Scope: a dotted `<store>.<field>` resolves against `UiIR.stores`;
  `src/language/ddd-scope.ts` gains the ui-store scope the same way it already
  scopes `apiParam.Aggregate`. This delivers the draft's "usage is declaration"
  and "colon = ownership" for free — the dot *is* the marker the scope provider
  already understands.

### 3.3 Code generation — via `WalkerTarget`

New seam methods on `WalkerTarget` (`src/generator/_walker/target.ts`), parallel
to the existing state seams: `renderStoreModule(store)` emits the per-framework
store module (`src/stores/<name>.ts`); `renderStoreRead`/`renderStoreWrite` emit
use-site access. The per-frontend, per-lifetime lowering matrix is §4.

Illustrative React output for the default (in-memory) tier — Zustand, the
canonical realization, in-grain with the React stack's existing react-only deps:

```typescript
// src/stores/filters.ts
import { create } from "zustand";
interface Filters {
  query: string; sortBy: string; sortDesc: boolean;
  set: (patch: Partial<Omit<Filters, "set">>) => void;
}
export const useFilters = create<Filters>((set) => ({
  query: "", sortBy: "name", sortDesc: false,
  set: (patch) => set(patch),
}));
// read:  const query = useFilters((s) => s.query);   // memoized selector
// write: useFilters.getState().set({ query: v });    // filters.query := v
```

Server state is untouched: TanStack Query stays the source of truth for anything
fetched; `store` is strictly client-owned view state.

---

## 4. The lifetime ladder — the organising axis

The whole design collapses onto **one axis: how long does the state live?** This
is the frame the draft (and earlier drafts of this doc) missed by arguing about
libraries. The distinguishing event between `state` and `store` is **not page
reload — it is navigation.**

| Construct | Survives navigate-away-and-back (SPA) | Survives full reload (F5) | Shareable via link |
|---|---|---|---|
| page `state {}` | ❌ remounts fresh | ❌ | ❌ |
| `store` (in-memory, **default**) | ✅ | ❌ | ❌ |
| `store … persist: local` | ✅ | ✅ (localStorage) | ❌ |
| `store … persist: url` | ✅ | ✅ (URL) | ✅ |

Concretely: CustomerList has `state { query }`. Click a row → CustomerDetail →
Back: the list **remounted**, so `query` is empty — the search is lost. With
`store filters`, the singleton never unmounted, so `filters.query` persists.
*That* — surviving navigation — is the entire reason `store` exists over
`state`, and it's the most common client-state need (carts, filters, wizard
progress, selection). In-memory dies on reload; that's a feature of its tier, and
`persist: local` / `persist: url` are simply **longer lifetimes you opt into**, not rival
definitions of `store`.

So the ladder reads top to bottom as monotonically increasing lifetime:

- **`state`** — one page mount.
- **`store`** — the session (survives navigation; the Zustand sweet spot).
- **`store … persist: local|session`** — survives reload (localStorage / `sessionStorage`).
- **`store … persist: url`** — survives reload *and* is shareable/deep-linkable (bidirectional: the URL can change underneath the store).

### 4.1 Per-frontend lowering, per tier

The DSL is framework-neutral; the *lowering* differs per frontend (as it must).
The URL tier is the one where every frontend — **including LiveView** — has a
clean, idiomatic mechanism, which is why LiveView is first-class there (§5).

| Tier | React | Vue | Svelte | Angular | Phoenix LiveView |
|---|---|---|---|---|---|
| `store` (in-memory) | Zustand `create()` | `reactive()` singleton | module-level `$state` rune | `providedIn:'root'` signal service | ETS row / session process keyed by **ephemeral tab id** (§5) |
| `… persist` | Zustand `persist` middleware | reactive + `localStorage` sync | rune module + `localStorage` sync | signal service + `localStorage` sync | holder keyed by **persistent session cookie**, or DB-backed (§5) |
| `… persist: url` | `useSearchParams` (typed) | Router `route.query` + `replace` | `$page.url.searchParams` + `goto` | `ActivatedRoute.queryParams` + `navigate` | **`handle_params/3` + `push_patch`** (idiomatic) |

### 4.2 Surface form — bare vs dotted

`store` and `state` share the **same verbs** (`:=`, `+=`, `-=`, reads anywhere
an expression appears) and differ only in the **noun**: a store is *named*, so
its fields are reached through the store name; a page's `state {}` is anonymous,
so its fields are bare. That qualification is what lets the two coexist without
collision — and it's the visual cue for the lifetime difference:

```ddd
page CustomerList {
  state { query: string = "" }      // local draft
  body: Stack {[
    Field { bind: query },          // bare   → page-local state (dies on navigate)
    Field { bind: filters.query },  // dotted → ui store        (survives navigate)
  ]}
}
```

This is the same mechanism Loom already uses for `Sales.Customer.all`
(api-param qualification) — the draft's "colon = ownership marker" reduces to
scope resolution that already exists.

### 4.3 Scope tiers — why `store` is `ui`-only

| Scope | Construct | Instance | Lifetime |
|---|---|---|---|
| page / component | `state {}` (anonymous, bare) | per mount | resets on unmount |
| ui | `store X {}` (named, dotted) | one, shared | survives navigation (+ tier) |

`store` is **`ui`-only**, not page/component and not above-`ui`:

- **No page/component `store`** — it would add no semantics over `state {}`, only
  a name; that's cosmetic, violates "minimum keywords," and invites the
  `store`-inside-`page`-inside-`ui` nesting the page-metamodel rejects (flat over
  nested, §4). Named grouping of local state is already a typed `state` field:
  `state { form: CustomerForm = {} }` → `form.email := v`. State shared by a page
  *and its child components* already flows down via params/slots (slots walk in
  the caller's scope — page-metamodel §5.2).
- **No above-`ui` (app/system) `store`** — each `ui` is a separate
  deployable/bundle with no shared client runtime, so there is nothing for a
  cross-`ui` store to share. `ui` is both floor and ceiling.

### 4.4 Runtime scope & SSR caveat

The in-memory store lowers to a **module-level singleton** on every client
frontend (Zustand `create()`, Vue `reactive()` module, Svelte module `$state`,
Angular root service) — i.e. **global within the app bundle**, which is exactly
the runtime face of "`ui`-scoped" (one `ui` = one bundle = one module graph).
This is correct and safe for Loom's **client SPA** frontends (Vite React/Vue/
Svelte, Angular).

It is **unsafe under SSR**: a server-side module singleton leaks state across
requests/users. If the `nextjs-frontend` proposal lands, that target's
`WalkerTarget` must lower the in-memory tier to a **per-request provider**
(React context seeded per request), not a module singleton. For today's SPA
frontends, module-global is the right answer; SSR is a per-target lowering
difference the seam already permits.

---

## 5. LiveView — not rejected; idiomatic per tier

Earlier drafts rejected `store` on `framework: liveview`. That was the easy way
out. LiveView *does* have an answer for each tier — it just forces the question
*which lifetime you mean*, because it has no client singleton (each LiveView is a
process, and `push_navigate` destroys `socket.assigns`).

### 5.1 `persist: url` — the primary, idiomatic path

For serializable view state (filters, pagination, selection ids, current tab) —
which is the overwhelming common case — the idiomatic LiveView lowering is the
URL via `handle_params/3`:

```elixir
def handle_params(params, _uri, socket) do
  filters = %{query: params["query"] || "", sort_by: params["sort_by"] || "name",
              sort_desc: params["sort_desc"] == "true"}
  {:noreply, socket |> assign(:filters, filters)
                    |> assign(:customers, Sales.list_customers(filters))}
end
# `filters.query := v`  →  push_patch(socket, to: ~p"/customers?#{updated_params}")
```

This survives navigation natively (the state is in the URL, not a doomed
process), is deep-linkable, needs zero added runtime, and re-derives the view on
every change — LiveView as designed. It is *better* than an SPA singleton for
view state, and it maps exactly to the `persist: url` tier on the SPA frontends.
**Recommendation: ship `persist: url` first on LiveView; it covers the motivating
use cases.**

### 5.2 In-memory tier — ETS+TTL (preferred) or a session process

The genuinely-in-memory tier (`store` with no modifier, non-URL state that must
survive navigation) is the heavier one. The faithful image is a per-session
holder, and **the keying decision *is* the lifetime contract**:

| Keyed by | Reattaches after… | → Tier |
|---|---|---|
| **ephemeral tab id** (JS var set per page-load, sent via LiveSocket connect params) | navigation ✅, blip ✅, **reload ❌** (new load → new id → fresh holder) | **in-memory `store`** (dies on reload, matches Zustand) |
| **persistent session cookie** | navigation ✅, blip ✅, **reload ✅** | **`store … persist`** (survives reload) |

A plain JS variable holds the tab id perfectly: it persists through
`push_navigate` and reconnects (no page load) but resets on a real reload — so
"dies on reload" falls out **for free** from the key resetting, even with a grace
window, because the remounting LiveView simply can't find the old holder.

**Lifecycle mechanics** (the part that trips up a naive "GenServer per store"):

- **Disconnect does *not* remove the holder.** Navigation, a backgrounded tab,
  and a network blip are indistinguishable from disconnect — the LiveView
  process terminates in all of them — and LiveView auto-reconnects/remounts
  within milliseconds-to-seconds. Killing on disconnect loses state on *every
  navigation*. Removal is triggered by an **idle timeout after the last client is
  gone**, via a monitor refcount (crash, disconnect, and navigation all unify
  into one `:DOWN`):

  ```elixir
  def handle_info({:DOWN, _ref, :process, pid, _}, s) do
    clients = MapSet.delete(s.clients, pid)
    if MapSet.size(clients) == 0,
      do: {:noreply, %{s | clients: clients}, @grace_ms},  # arm idle timer (~30s)
      else: {:noreply, %{s | clients: clients}}
  end
  def handle_info(:timeout, s), do: {:stop, :normal, s}     # nobody returned → die
  ```

- **A missing holder is *not* a forced refresh.** It is the normal cold-start:
  `mount/3` does **get-or-start with the declared defaults** (look up in a
  `Registry`; if absent, start under a `DynamicSupervisor`, seed, attach). A
  forced `window.location.reload()` would be circular, and the state is
  recoverable-to-defaults by definition. The only place a client refresh ever
  matters is a server deploy — and LiveView's auto-reconnect + re-mount + re-seed
  already handles that.

- **Prefer ETS + TTL over a process per session.** A single (or sharded) ETS
  table keyed `{tab_id, store_name} => data`, with a periodic sweeper (or
  Presence-driven eviction) for idle rows, drops the entire per-session process
  lifecycle — no spawn/monitor/timer, just rows with a last-touched stamp. It is
  the lighter, more idiomatic substrate for an ephemeral per-session cache.

### 5.3 What is *not* a `store` on LiveView

SPA Zustand is **per-tab**, so for parity a LiveView store keys per-tab and needs
no cross-tab fan-out. **Cross-tab / cross-user live state** (presence,
collaboration, live dashboards) is a different concept and is **already Loom's
`channel`** (`docs/channels.md`, `delivery: broadcast` over Phoenix.PubSub) — not
`store`. So the heavy "shared live state" category isn't reconstructed here; it's
delegated to the construct that already owns it. Identity/config (current_user,
locale, theme) is `live_session` + `on_mount` + session — auth/i18n's job, not
`store`'s.

**LiveView recommendation:** ship `persist: url` first (idiomatic, no infra); gate
the in-memory tier (ETS+TTL) behind a concrete `framework: liveview` example that
actually needs non-serializable session-lived state; route shared-live to
`channel`.

---

## 6. The deferred `flow` (the draft's `machine`, re-scoped)

`machine` is deferred, not rejected, because there *is* one capability the
existing constructs can't express: **compile-time transition legality on
purely-client state.** A `state { step: int = 0 }` wizard works, but nothing
stops `step := 5`. The only honest justification for a new keyword is *enforced
legal transitions* — named states where the compiler rejects an `event`
inadmissible in the current state. That, and only that, is the gate.

Everything else `machine` wanted is already covered:

- **Async lifecycle** (idle/loading/success/error) is **TanStack Query**, surfaced
  through `QueryView`. The draft's flagship `UserListMachine` *is* this.
- **Durable, multi-aggregate lifecycle** is the backend **`workflow`**.
- **In-memory wizards/branching** are `state` + `match` + block-body lambdas +
  `navigate` (page-metamodel §12) — a deliberate §14 choice.

If a real illegal-state example survives all three, the construct is a **`flow`**,
and it is a *reducer sugar*, never XState:

- **Desugars to a framework-neutral reducer** — states → a discriminated-union/enum
  field, events → `dispatch(e)`, transitions → a `match`-shaped reducer the
  `WalkerTarget` already renders. A reducer has a clean image on every frontend;
  an XState interpreter is React-flavored and antithetical to LiveView's
  server-owned model.
- **`flow` orchestrates; TanStack Query executes async.** The draft's `_` wildcard
  is an internal transition; its `*_SUCCESS`/`*_ERROR` convention is a transition
  into a `loading` state whose action invokes an existing api-param `mutate`/`query`.
- **Scope mirrors `state`/`store`** — page-scoped `flow` for a local wizard,
  `ui`-scoped `flow` (built on `store`) for an app lifecycle such as auth.
- **Line vs `workflow`** — `flow` is ephemeral, client-only, no persistence; its
  terminal action may `call` a `workflow`. `workflow` is the durable server side.

**Decision:** do not build `flow` speculatively. Gate it on a concrete `.ddd`
example needing enforced client-side transition legality.

---

## 7. What the draft asked for, and where it lands

| Draft ask | Disposition in Loom |
|---|---|
| `state` = pure data shape | **Rejected** — use `valueobject` / `payload`; `state` is page-local reactive fields |
| `store` = shared reactive container | **Adopted** — `ui`-scoped `UiMember`, in-memory by default; React → Zustand |
| `machine` = client state chart | **Deferred** (§6) — covered by `workflow` + `QueryView` + `state`/`match`; if ever built, a `flow` reducer sugar, never XState |
| Dependency inference from usage | **Already true** — pages detect `apiParam.X` calls and hoist hooks |
| Colon = ownership marker | **Reframed** — dotted `store.field` vs bare `state` field, via the existing scope provider |
| `_` wildcard transition | **Deferred** with `flow` |
| Flat over nested | **Preserved** — `ui` members are flat; stores shared by name |
| Progressive commitment | **Preserved & sharpened** — the lifetime ladder: `state` → `store` → `store persist: local` → `store persist: url` |
| Async via `*_SUCCESS`/`*_ERROR` | **Rejected for now** — TanStack Query owns async lifecycle |

---

## 8. Open questions / non-goals

- **`persist: session` vs `persist: local`.** `sessionStorage` (per-tab, dies on
  tab close) vs `localStorage` (cross-tab, persistent) — both are admissible
  modifiers; v0 could ship only `local` and add `session` later.
- **URL serialisation limits.** `persist: url` carries small serializable scalars
  only; the validator rejects non-serializable fields under `persist: url`
  (`loom.store-field-not-url-serializable`) with a hint toward `persist`/in-memory.
- **LiveView in-memory tier.** Gated behind a real example (§5.2); `persist: url`
  ships first.
- **SSR target.** A future `nextjs-frontend` needs the per-request-provider
  lowering of the in-memory tier (§4.4).
- **`flow` / `machine`.** Tracked, not designed (§6).

---

## 9. Summary

The draft's instinct — graduated abstraction, minimal syntax, inference over
declaration — is right and already present in Loom. Two of its three keywords
fight the codebase (`state` is taken; `machine` re-opens a closed non-goal and
pins output to React-only XState), and the survivor, `store`, is best understood
not by which library it maps to but by **lifetime**. The single keyword worth
adding is **`store`** — the page-local `state {}` block lifted to `ui` scope, an
in-memory shared reactive container by default (Zustand on React, native
reactivity elsewhere), with two opt-in modifiers that extend its lifetime:
`persist` (survives reload) and `persist: url` (survives reload + shareable). The
distinguishing property over `state` is **surviving navigation**, not surviving
reload. Every tier lowers through the existing `WalkerTarget` seam to each
frontend's idiom — and LiveView, far from being rejected, is *first-class* on the
`persist: url` tier (`handle_params/3`) and served by an ETS/session-holder on the
in-memory tier, with shared-live state delegated to the existing `channel`
construct. Cost: one grammar production, one optional modifier, one IR node — no
violation of Loom's server-first, framework-neutral, domain-logic-free frontend
invariants. The draft's `machine` stays deferred behind one concrete
precondition — enforced client-side transition legality — and, if ever built, as
a framework-neutral `flow` reducer sugar.
