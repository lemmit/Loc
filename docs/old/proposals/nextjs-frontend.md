# Next.js — a wire-separated frontend, or the node LiveView (server-coupled UI)

> Status: **PROPOSED (deferred).** Next.js is a **`ui` framework**, like
> React and LiveView — it **never owns the domain**. A node **foundation**
> (the "vanilla node" domain that Hono runs today, or `foundation: nest`)
> owns the domain; Next.js is a UI *coupled* to it. The only question is
> **how the UI reaches the domain**, which gives two modes:
>
> - **(A) wire-separated** — like React: hosted standalone or co-hosted,
>   talks to the backend over the wire. Concrete, recommended.
> - **(B) server-coupled** — the **node twin of LiveView**: RSC /
>   server-actions call the domain **in-process**. Coupled to (not owner
>   of) whichever node foundation owns the domain, *exactly as LiveView
>   couples to `ash` or `vanilla`*. Deferred on ROI/sequencing, **not
>   architecture**.
>
> **(Superseded 2026: the Ash foundation was removed.)** Where this proposal cites Elixir's `ash` vs `vanilla` foundations as the precedent for how a UI couples to a domain-owning foundation, note that `platform: elixir` now resolves to `foundation: vanilla` (plain Ecto/Phoenix) only — `foundation: ash` is a validation error. LiveView still couples to the (now single) Elixir foundation; read the `ash`/`vanilla` pairing below as historical.
>
> So there is **no `foundation: nextjs`** — that earlier framing conflated
> the UI with the foundation. Both are gated behind
> [`embedded-frontend-composition.md`](./embedded-frontend-composition.md)
> (framework + host-runtime capability) and informed by the `foundation:`
> precedent ([`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md),
> [`platform-realization-axes.md`](./platform-realization-axes.md)).
> Sibling of [`angular-frontend.md`](./angular-frontend.md) (the
> prioritised, clean-fit frontend) and
> [`nestjs-backend.md`](./nestjs-backend.md) (a node foundation it can
> couple to).

## TL;DR — the domain is always a foundation's; Next is always a UI

The question is never "does Next own the domain" (it doesn't); it is "how
does the UI **reach** the domain." That gives Next two modes:

| Next.js mode | Analogue | UI → domain | Domain owned by |
|---|---|---|---|
| **wire-separated** (shell / static export) | React | over the wire (HTTP) | a node foundation — separate *or* co-hosted deployable |
| **server-coupled** (RSC / server actions) | **LiveView** | **in-process call** | the node foundation it is **embedded in** |

The one inviolable rule, stated correctly:

> **The domain lives in exactly one place — a foundation — and the UI
> *calls* it, never reimplements it.** Both Next modes obey this: mode A
> calls over the wire, mode B calls in-process. The only way to break it is
> a wire-separated Next that *also* runs domain logic in its server tier —
> then two places own the domain. Don't do that.

This corrects the earlier "shell is a trap / Next owns the domain" framing
on two counts: the **shell** reading is correct whenever a domain-owning
backend is present (mode A, below), and the **full-stack** reading does not
make Next a domain *owner* — it makes Next a *coupled UI*, the node
LiveView (mode B, below).

## Path A — wire-separated (recommended)

The mainstream real-world stack (e.g. a NestJS API + a Next.js frontend).
It drops straight into Loom's default frontend/backend split:

- a node foundation deployable (`foundation: nest`, or Hono's vanilla node
  domain) owns the domain and serves the API;
- a **Next.js frontend** renders the UI and reaches the domain **over the
  wire** — even when co-hosted, the calls stay on the contract.

Because the domain is owned by the foundation, Next's server-side
capabilities (SSR + a thin BFF that proxies/aggregates the API, handles the
session) have a legitimate job — nothing is "bypassed."

### Two topologies — separate, or co-hosted

| Topology | Deployables | How |
|---|---|---|
| **Separate** | 2 | Standalone Next deployable + the backend, same origin via proxy. Most idiomatic Next; independent scaling of UI vs API. |
| **Co-hosted (host embeds Next)** | 1 | The backend **`hosts:`** the Next UI in one process. The `dotnet/phoenix-embeds-React` pattern — but a node host can embed *more* than static (below). |

### Co-hosting: a node backend can host Next's SSR (others can only host static)

Falls straight out of `embedded-frontend-composition`'s capability
principle — *a host can serve a `ui` iff it provides the runtime that
framework requires*:

| Host | Embed Next (static `output: export`) | Embed Next (**SSR**, e.g. `nest-next`) |
|---|---|---|
| **`foundation: nest` / Hono (node)** | ✅ (`ServeStaticModule`) | ✅ — *because it is a node runtime* (the host's Express serves Next's request handler; one process) |
| dotnet / elixir | ✅ (serves the static assets) | ❌ — no node runtime to run Next's server |

`nest hosts: <next-ui>` is the **node-runtime twin of phoenix-embeds-React**,
the SSR capability *derived* from the host being node. Co-hosting is a
**deployment-topology** choice; the layering is unchanged (domain in the
foundation, Next fetching it over the wire), so the one-rule above holds
even in a single process.

**Caveat:** in co-hosted SSR, keep Next → backend on the wire
(localhost/in-process *client*), never a direct import of domain functions
— that would silently flip you into mode B. Next's custom-server mode also
disables some optimizations and is mildly discouraged by the Next team, so
offer SSR co-hosting as opt-in (`hosts: next { ssr }`), with **static embed
as the clean default** and **two deployables** as the scale-out option.

### Why Path A is cheap

Next-as-frontend reuses the React body-walker + design packs verbatim (it
*is* React); the only new surface is a **Next project-shell** (app-router,
static-export or custom-server scaffold) and a **node-running frontend
deployable shape** — `isFrontend: true`, `needsDb: false`, but *not static*
(unlike React/Vite), so it carries its own `composeService`. No domain
logic, no new IR.

## Path B — server-coupled: the node LiveView (deferred)

The fused framing, **stated correctly**: there is no separate frontend;
Next's RSC / server actions call the domain **in-process**. Next does
**not** own the domain — it is a server-rendered UI **coupled** to the node
foundation that owns it, *exactly as LiveView is a UI coupled to the Ash or
vanilla foundation*. This is the role parallel that matters:

| | Domain-owning **foundation** | Coupled in-process **server UI** | Wire-separated **client UI** |
|---|---|---|---|
| **Elixir** | `vanilla` (plain Ecto/Phoenix; `ash` removed 2026) | **LiveView** | — |
| **Node** | vanilla-node (Hono's domain) / `nest` | **full-stack Next.js** (RSC + server actions) | React / Vue / Svelte / Angular (+ Next, mode A) |

Like LiveView — which couples to *either* Elixir foundation — Next's
server-coupled mode would couple to *either* node foundation (vanilla node
*or* `nest`). It is **not** a foundation; it is a `ui` framework whose
server-coupled mode **requires a node domain runtime** to call in-process,
so it is embedded in the foundation's deployable — the precise capability
shape `embedded-frontend-composition` already gives LiveView ("requires the
phoenix runtime").

### Mechanism (why it's *coupled*, not *owning*)

The domain functions are the **same TS Loom already emits** (operations /
invariants / appliers / repositories — `render-expr`/`render-stmt` output).
Server-coupled Next just calls them:

```ts
// app/orders/actions.ts        — command
'use server'
import { placeOrder } from '@/domain/order/operations'   // generated
export const placeOrderAction = (cmd: PlaceOrderCommand) =>
  placeOrder(orderRepo, cmd)                              // in-process call
```
```tsx
// app/orders/page.tsx          — query, a server component
import { findAllOrders } from '@/domain/order/queries'    // generated
export default async () => <OrderList orders={await findAllOrders(orderRepo)} />
```

`placeOrder` / `findAllOrders` are the very functions a Hono route would
call. The **only new Loom work is the domain-call-lowering seam** (operation
→ server action, query → RSC fetch) + the project shell — *not* a new
foundation. The domain layer is whatever node foundation you already have.

### Why it's deferred — ROI/sequencing, not architecture

The earlier draft over-stated this as "breaks the wire boundary." It does
not *break* a rule; like LiveView it **foregoes** the wire boundary — a
trade Loom already takes for Elixir. The honest reasons it waits:

1. **Sequencing.** It rides on the embedded-frontend / `foundation:`
   machinery still being untangled for Phoenix. Build it *on top of* that,
   reusing the same framework-requires-runtime capability, not beside it.
2. **Marginal value / fit.** LiveView is *the* singular blessed Phoenix
   idiom, so its coupled UI pays for itself. Next's server-coupled mode is
   *one* TS option among several, and **Path A (wire-separated, cheaper,
   reuses the React frontend) already covers most of the same need** — so
   it overlaps heavily with machinery Loom already has. Lower marginal
   value, not wrongness.

If pursued: a server-coupled **mode of the Next `ui` framework** (the node
LiveView), on top of `embedded-frontend-composition`, reusing the React
body-walker and the existing node-foundation domain verbatim; only the
domain-call-lowering seam + project shell are new. Success test: it touches
the node scaffold + a domain-call-lowering seam + a host-runtime capability
— **never** the body-walker, design packs, TS expression renderers, or IR.

## Recommendation

Pursue **Path A (wire-separated)** when Next.js is wanted — concrete, cheap,
reuses the React frontend, rehabilitated by any domain-owning node backend
(the Nest pairing especially). Keep **Path B (the node LiveView)** on ice
behind the Phoenix foundation work; it is legitimate (the LiveView twin),
just lower-ROI than Path A. Either way Next.js is a **UI** — it earns its
place through SSR/SEO + a BFF tier or, in mode B, as the coupled server UI;
**never** by owning the domain.

## Cross-references

- [`nestjs-backend.md`](./nestjs-backend.md) — a node foundation Next can
  pair with (Path A) or couple to (Path B); and a host that can embed Next's
  SSR (the node-runtime capability).
- [`embedded-frontend-composition.md`](./embedded-frontend-composition.md)
  — **prerequisite**: the framework + host-runtime capability model that
  makes both "node hosts SSR Next" (A) and "server-coupled Next requires a
  node runtime" (B) fall out — the same machinery that types LiveView.
- [`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md) /
  [`platform-realization-axes.md`](./platform-realization-axes.md) — the
  `foundation:` precedent: LiveView couples to `ash`/`vanilla` just as
  server-coupled Next would couple to the node foundations.
- [`angular-frontend.md`](./angular-frontend.md) — the prioritised frontend
  (a clean distinct-framework fit; Next is a *coupling-mode* question,
  Angular a *frontend* one).
- [`docs/page-metamodel.md`](../../page-metamodel.md) — the framework-neutral
  page-DSL both modes reuse unchanged.
