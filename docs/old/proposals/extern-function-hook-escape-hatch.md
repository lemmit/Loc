# Extern functions & hooks — frontend logic escape hatches

> Status: **PARTIAL — `function … extern` (React/TS) implemented.**
> The `function f(params): T extern from "<path>"` ui member ships:
> grammar + `UiFunctionIR` + printer, the typed signature
> (`src/lib/extern/<name>.signature.ts`, wire-DTO-typed) + conformance
> shim (`src/lib/<name>.ts`, `export const f: Fn = _impl` — the §3
> fail-fast), shim imports + JSX-expression rendering at body call
> sites, and the stdlib-shadow / duplicate-name validators.  Remaining:
> Phoenix `@spec` + alias (stage 2), `hook … extern` (stage 3 —
> deliberately pulled by a concrete use case, not built speculatively),
> and the void-effect rule (Loom has no `void` type yet). This
> note extends the `extern` family — already shipped for backend
> `operation … extern` ([`docs/extern.md`](../../extern.md)) and frontend
> `component … extern`
> ([`extern-component-escape-hatch.md`](./extern-component-escape-hatch.md)) —
> to the two remaining shapes foreign **frontend logic** takes: pure
> **functions** and stateful React **hooks**. It is the *logic* twin of the
> *render* hatch we already ship.

## TL;DR

`component … extern` lets a page *render* hand-written UI. It says nothing
about *logic*: a page body can't call a hand-written formatter, validator, or
computation, nor bind a hand-written React hook — the closed walker has no seam
for it. The deleted `import helper` tried to fill this but was **untyped**, had
**no real consumer**, and **overloaded the `import` keyword** (reserved for
Loom-file imports) — so it was removed (PR #807).

The right fill reuses the backend's proven pattern. `operation … extern` emits
a **typed contract**, owns the **surrounding plumbing**, and uses a
**fail-fast** while the user implements the body — dual-targeted across Node and
.NET. Translate that to the frontend's two targets (React/TS, LiveView/Elixir),
where linking is compile-time so the fail-fast is `tsc`/`mix`:

```ddd
// pure, framework-neutral
function formatPrice(value: decimal): string extern from "./helpers/price"

// stateful React functionality (React-only), hoisted to component top
hook useFeatureFlag(name: string): bool extern from "./hooks/flags"
```

`extern` becomes the **one** modifier on whichever existing construct matches
the foreign code's *shape*; the construct is what tells Loom how to wire it.

## 1. The principle (lifted from the backend)

`operation … extern` is four moves (`docs/extern.md`):

1. A declaration marks a unit **user-supplied** (`extern`).
2. The generator emits a **typed contract** from the declaration
   (`IConfirmOrderHandler` / the Hono handler type).
3. The framework owns the **surrounding plumbing** and calls in at the right
   point (load → check → dispatch → invariants → save).
4. A **fail-fast** guarantees the impl exists (Node registry verify; .NET
   Scrutor scan); the user implements against the contract.

Two things change on the frontend, and they shape the whole design:

- **Linking is compile-time, not runtime** → the fail-fast is `tsc`/`mix`, not
  a registry. No DI surface, no `register…()`. (Same conclusion as the extern
  component.)
- **There is almost no surrounding lifecycle to own.** The backend owns
  load/save/invariants; the frontend owns *render*, *call*, or *hook-binding* —
  much thinner. So a frontend hatch is mostly "a typed unit of foreign code
  Loom calls/binds," not a lifecycle wrapper.

The dual-backend story (Node **and** .NET) is the precedent for the frontend's
dual-target story (React **and** LiveView). A `function … extern` is naturally
both; a `hook … extern` is React-only (§4) — an honest asymmetry, the way some
backend features are .NET- or Node-shaped.

## 2. `extern` as the universal foreign-code modifier

The backend put `extern` on `operation`; we ship it on `component`. The
generalization: **`extern` modifies whichever existing construct matches the
shape of the foreign code**, and that construct is what tells Loom how to wire
it.

| Foreign code shape | Construct | Wired as | Status |
|---|---|---|---|
| renders UI | `component … extern` | `<X/>` element | **shipped (#802)** |
| pure value / computation | `function … extern` | `f(args)` call | **§3 (this note)** |
| stateful/effectful React functionality | `hook … extern` | hoisted `const x = useX(…)` | **§4 (this note, React-only)** |
| behaviour fired from an event | `action` param (a lambda) | hoisted callback | designed — extern-component Tier 2 |
| side effect (analytics/toast/download) | `function …(): void extern`, called in a handler | `f(args)` in an `action` body | **§5 (a rule, not a new construct)** |

`import` stays reserved for Loom-file imports (`import "./lib.ddd"`); escape
hatches never wear it. There is **no `helper` keyword** — `function` is Loom's
existing pure-function construct (`FunctionDecl`), reused here.

## 3. `function … extern from "…"` — pure functions (framework-neutral)

The typed heir to `import helper`. Reuses `FunctionDecl`'s `(params): returnType`
so the signature is real and in Loom's vocabulary:

```ddd
function initials(name: string): string extern from "./helpers/initials"
```

### What it generates (TypeScript)

Loom owns **two** files and imports the user's module — the function-shaped twin
of the component hatch (`props.ts` + re-export shim → `signature.ts` +
conformance shim):

**① Typed signature** — `src/lib/extern/initials.signature.ts` (machine-owned,
regenerated):
```ts
// AUTO-GENERATED by Loom — typed signature for extern function 'initials'.
export type InitialsFn = (name: string) => string;
```

**② Conformance shim** — `src/lib/initials.ts` (machine-owned): a stable import
for call sites **and** the contract enforcement point:
```ts
// AUTO-GENERATED shim. Loom owns this + './extern/initials.signature'; you own '../helpers/initials'.
import { initials as _impl } from "../helpers/initials";
import type { InitialsFn } from "./extern/initials.signature";

// Compile-time conformance: the hand-written function must match the
// Loom-derived signature, or tsc fails here — the fail-fast.
export const initials: InitialsFn = _impl;
```

**③ Call sites** import the shim and call it:
```ts
import { initials } from "../lib/initials";
// …in a body: {initials(name)}
```

**You** own `src/helpers/initials.ts` (Loom never writes it):
```ts
export function initials(name: string): string { /* … */ }
```

The fail-fast is stronger than the component hatch: a **missing** function →
the shim's `import … from "../helpers/initials"` fails `tsc`; a **mismatched**
signature → `const initials: InitialsFn = _impl` fails `tsc`. The shape is
checked even if the user never imports the type.

### Where the domain wiring bites

An aggregate param uses the **wire DTO** — same discipline as extern-component
props — so a domain change breaks the user's function:

```ddd
function orderLabel(order: Order): string extern from "./helpers/order-label"
```
```ts
// src/lib/extern/orderLabel.signature.ts
import type { OrderResponse } from "../api/order";
export type OrderLabelFn = (order: OrderResponse) => string;
```
The user annotates with the generated type to get the body-level bite:
```ts
import type { OrderLabelFn } from "../lib/extern/orderLabel.signature";
export const orderLabel: OrderLabelFn = (order) => `#${order.id} — ${order.customerId}`;
```
Rename `Order.customerId` → `OrderResponse` regenerates → `order.customerId`
is now a `tsc` error in the user's file. The contract works.

### Cross-framework (the dual-target story)

`function … extern` is **framework-neutral**, because Loom already lowers its
types onto each backend:
- **React/TS** — the shim above; `decimal → number`, aggregate → wire DTO.
- **Phoenix/Elixir** — an `import`/`alias` of the user's function plus a
  `@spec` derived from the same signature (`decimal → Decimal.t()`, aggregate →
  the typed struct). The `@spec` is advisory (Dialyzer, not the compiler), so
  Elixir's fail-fast is weaker than TS's — the honest cost of Elixir having no
  enforced static types. Call sites emit `initials(name)` in HEEx.

### Open: one file or two

The shim alone could inline the type (`export const initials: (name: string) =>
string = _impl`) and skip `signature.ts`. The separate file exists so the user
can import the type to annotate their implementation (the body-level bite
above). Recommend keeping both — the same call made for extern-component props.

## 4. `hook … extern from "…"` — stateful React functionality (React-only)

The genuinely new machinery. React hooks **cannot be called as plain
functions** (rules of hooks: top-level, unconditional), so Loom can't emit
`useFeatureFlag("beta")` inline in a body — it must **hoist** it:

```ddd
hook useFeatureFlag(name: string): bool extern from "./hooks/flags"

page Beta {
  body: match {
    useFeatureFlag("checkout-v2") => CheckoutV2 { … }
    else => Checkout { … }
  }
}
```
→ Loom hoists `const checkoutV2Enabled = useFeatureFlag("checkout-v2")` to the
component top; the body references the bound value.

**This reuses machinery that already exists.** The walker already hoists
`useXxx` query/mutation hooks for api calls (`buildHookUse` / `renderApiHoisting`
on the `WalkerTarget`; `usedApiHooks` on the body-walker context). A
`hook … extern` registers a foreign hook into that same hoisting pass — the
generated files mirror §3 (a `signature.ts` typed as `(args) => T` and a
conformance shim), but the call site is *hoisted-and-bound*, not inline.

The constraints that make this real:

- **Rules of hooks enforced by Loom.** A hook ref Loom can't hoist
  unconditionally — inside an `action` lambda / event handler, or in a position
  that would compile to a conditional hook call — is a validator error
  (`loom.extern-hook-not-hoistable`). The walker's hoist-to-top covers the legal
  case; the validator rejects the rest, so the generated React never violates
  the rules of hooks.
- **React-only, honestly.** LiveView has no client hooks — its stateful logic
  lives in the server module (`mount/3` / `handle_event/3`). So `hook … extern`
  is simply not hostable by a LiveView ui: a clean validator rejection
  (`loom.extern-hook-framework-mismatch`), the same asymmetry the component
  hatch already accepts. The LiveView analogue (a server-side function extern)
  is a separate, later concern.

## 5. Effects are a rule, not a new construct

Analytics, toast, download, clipboard — side-effecting "functionality" — are
just **void functions called from event handlers**:
`function track(event: string): void extern` invoked inside an `action` lambda
(extern-component Tier 2). One validator rule keeps it honest:

- **A void/effect function may be called only in an `action`/handler position,
  never in render/body position** (`loom.effect-in-render`) — side effects
  during render are a React bug.

So effects fall out of §3 + the `action` design with a single rule; no `effect`
keyword.

## 6. The unifying invariant

Across all shapes — and it is the backend's, translated:

> **Loom generates a typed contract from the DSL declaration (in wire/Loom
> types); the foreign module implements it; render/call/hoist sites are checked
> in-DSL; the compiler (`tsc`/`mix`) is the fail-fast.** `extern` is the one
> modifier; `import` stays reserved for Loom files.

That keeps this from being four ad-hoc features — it's one principle applied to
the shapes foreign frontend code actually takes (render / call / hook / effect).

## 7. Validation rules

- `function … extern` declares **no body** (`= <expr>`); a non-extern
  `function` requires one. (`loom.extern-function-has-body` /
  reuse the existing function-body rule.)
- `hook … extern` is rejected outside a React-hosted ui
  (`loom.extern-hook-framework-mismatch`) and when a use site is not
  hoistable to component top (`loom.extern-hook-not-hoistable`).
- A `void` extern function call in render/body position is rejected
  (`loom.effect-in-render`); it is admitted in an `action`/handler body.
- The `from` path is preserved verbatim (caller decides relative / package),
  resolved by the generated project's compiler — a wrong path is the intended
  `tsc`/`mix` fail-fast, not a Loom diagnostic.
- A name must not collide with a walker stdlib primitive (reuse the existing
  shadow check).

## 8. Recommended delivery (staging)

Same discipline as the extern-component proposal — typed, `extern`-family,
usage-pulled:

1. **`function … extern` first**, React (TS) — it is the typed replacement
   people will actually reach for (formatters/validators/computations), and it
   reuses the component hatch's shim+contract emitter shape almost verbatim.
   Gate on a `LOOM_REACT_BUILD` test proving the conformance shim **bites**: a
   correct function compiles; a wrong-signature one fails `tsc`.
2. **Phoenix `function … extern`** next (the `@spec` + alias path) — completes
   the dual-target story.
3. **`hook … extern`** when a concrete widget needs a real hook — it carries
   the new hoisting + rules-of-hooks validator, so it should be pulled by a use
   case, not built speculatively.

## 9. Non-goals (v0)

- No untyped imports — every extern function/hook carries a declared signature.
- No `helper` keyword, no `import`-keyword reuse.
- No server-side (LiveView) hook analogue in this note — deferred with the
  rest of the framework-asymmetry follow-ups.
- No runtime registry — compile-time linking only (the frontend has no DI seam
  to host one, by design).

## 10. Relationship to other proposals

- **[`extern-component-escape-hatch.md`](./extern-component-escape-hatch.md)** —
  the *render* hatch; this is its *logic* twin. Shares the shim+typed-contract
  pattern (`props.ts` ↔ `signature.ts`, re-export shim ↔ conformance shim), the
  `slot`/`action` interactivity design, and the React/LiveView asymmetry.
- **[`../extern.md`](../../extern.md)** — the backend `operation … extern` whose
  four-move pattern (modifier → typed contract → plumbing → fail-fast) this
  lifts. The frontend drops move 3's lifecycle (there is none) and recasts
  move 4 as the compiler.
- **`import helper` (removed, PR #807)** — the cautionary precedent: this note
  exists to do the same job *typed*, in the `extern` family, with a real
  conformance contract — the three things `import helper` lacked.
