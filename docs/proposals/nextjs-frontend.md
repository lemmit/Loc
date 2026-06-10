# Next.js — a node-hosted frontend, or a full-stack node foundation

> Status: **PROPOSED (deferred).** Two *coherent* framings, and the choice
> of backend decides which applies:
>
> - **(A) Next.js as a frontend paired with — or hosted by — a
>   domain-owning node backend (`foundation: nest` / Hono).** The concrete,
>   recommended path. It **rehabilitates the "React shell" reading**: with
>   the domain living in the backend, Next's server tier becomes a
>   legitimate BFF/SSR layer rather than a bypassed feature.
> - **(B) Next.js as a standalone full-stack `node` foundation** — one
>   deployable owning TS domain logic *and* its React UI, the TypeScript
>   analogue of Phoenix+LiveView. Heavier and contentious; deferred.
>
> Both are gated behind
> [`embedded-frontend-composition.md`](./embedded-frontend-composition.md)
> (the host-embeds-framework machinery) and the realization-axes
> `foundation:` work ([`platform-realization-axes.md`](./platform-realization-axes.md),
> [`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md)).
> Sibling of [`angular-frontend.md`](./angular-frontend.md) (the
> prioritised, clean-fit frontend) and
> [`nestjs-backend.md`](./nestjs-backend.md) (the natural pairing).

## TL;DR — the framing depends on who owns the domain

The earlier draft of this note called the "React project shell" reading a
*trap*. That is only true **standalone**. The correcting insight:

| Reading | Standalone | Paired with a domain-owning backend (Nest/Hono) |
|---|---|---|
| **Shell** (Next as a frontend; wire preserved) | **anti-pattern** — adopts Next.js while bypassing RSC/server-actions, the reason it exists | **correct** — the backend owns the domain, so Next's server tier is a real **BFF/SSR** layer, not a bypassed feature |
| **Full-stack foundation** (Next's server actions own the domain) | coherent but heavy (Path B); breaks the wire boundary | **redundant** — two domain owners fight; don't |

So the trap is only the *combination* of "standalone" + "shell." Add a
domain-owning backend and the shell reading becomes the cleanest Next.js
path Loom has. The one inviolable rule across everything below:

> **Exactly one domain owner.** When a Nest/Hono backend is present, *it*
> owns the domain; Next.js stays a frontend (its server tier = BFF/SSR,
> never `server-action → domain-operation`). The moment Next reaches into
> domain logic, the wire contract is broken.

## Path A — Next paired with a domain-owning node backend (recommended)

This is the mainstream real-world stack (NestJS API + Next.js frontend),
and it drops straight into Loom's default frontend/backend split:

- a **`foundation: nest`** (or Hono) backend deployable owns the domain
  and serves the API;
- a **Next.js frontend** owns the UI and talks to that API over Loom's
  versioned wire contract — even when co-hosted, the calls stay on the
  contract.

Because the backend owns the domain, Next's server-side capabilities
(SSR + a thin BFF that proxies/aggregates the backend API, handles the
session) have a legitimate job. Nothing about Next is "bypassed," and the
domain-ownership conflict that makes standalone full-stack Next awkward
(Path B) simply never arises.

### Two topologies — separate, or co-hosted

| Topology | Deployables | How |
|---|---|---|
| **Separate** | 2 | Standalone Next deployable + the backend, same origin via proxy. Most idiomatic Next; independent scaling of UI vs API. |
| **Co-hosted (host embeds Next)** | 1 | The backend **`hosts:`** the Next UI in one process. The `dotnet/phoenix-embeds-React` pattern — but a node host can embed *more* than static (below). |

### Co-hosting: a node backend can host Next's SSR (others can only host static)

This is the elegant part, and it falls straight out of
`embedded-frontend-composition`'s capability principle — *a host can serve
a `ui` iff it provides the runtime that framework requires*:

| Host | Embed Next (static `output: export`) | Embed Next (**SSR**, e.g. `nest-next`) |
|---|---|---|
| **`foundation: nest` / Hono (node)** | ✅ (`ServeStaticModule`) | ✅ — *because it is a node runtime* (Nest's Express hosts Next's request handler; one process, one port) |
| dotnet / elixir | ✅ (serves the static assets) | ❌ — no node runtime to run Next's server |

So `nest hosts: <next-ui>` is the **node-runtime twin of
phoenix-embeds-React**, and the SSR capability is *derived* from the host
being node — not special-cased. Hosting is a **deployment-topology**
choice; it does **not** change the layering (domain in the backend, UI in
Next fetching the API), so the one-domain-owner rule is untouched even in a
single process.

**Caveat to pin:** in the co-hosted SSR case, keep Next → backend as the
wire contract (localhost/in-process client), never an in-process reach
into domain services. And note Next's custom-server mode (the SSR
integration) disables some Next optimizations and is mildly discouraged by
the Next team — so offer SSR co-hosting as an opt-in (`hosts: next { ssr }`),
with **static embed as the clean default** and **two deployables** as the
scale-out option.

### Why Path A is cheap

Next-as-frontend reuses the React body-walker + design packs verbatim (it
*is* React); the only new surface is a **Next project-shell** (app-router,
static-export or custom-server scaffold) and a **node-running frontend
deployable shape** — `isFrontend: true`, `needsDb: false`, but *not static*
(unlike React/Vite), so it carries its own `composeService`. No domain
logic, no new IR. Gated behind `embedded-frontend-composition` like any
frontend.

## Path B — standalone full-stack node foundation (deferred)

The heavier framing: **no separate backend**; one Next.js deployable owns
*both* the TS domain logic and the React UI — the topological analogue of
Phoenix+LiveView.

To be precise, Next.js is **not** LiveView *mechanically* (LiveView is
stateful-server / persistent-WebSocket / HTML-diffs; Next is client-React +
SSR + RPC-style server actions — the literal "LiveView for TS" is
LiveViewJS; the real twins are **Blazor Server** for .NET, **Livewire** for
PHP). What it shares is the **topological role**: a single deployable that
owns domain *and* UI.

| Piece | Phoenix+LiveView | Next.js full-stack node |
|---|---|---|
| Domain logic | Elixir (Ash/Ecto) | **TS — `render-expr`/`render-stmt` already exist (Hono)** |
| UI rendering | HEEx walker | **React body-walker — already exists** |
| Deployable shape | one app: domain + UI | one app: domain (server actions) + React UI |
| Loom axis | `platform: elixir, foundation: …` | `platform: node, foundation: nextjs` |

Both halves already exist; a full-stack node foundation would glue them
into Next's app-router/server-actions shape. **Why it stays deferred:**

1. **It is a `foundation` decision, not a frontend** — collapsing
   domain+UI re-introduces the two-axis-freezing complexity
   `vanilla-phoenix-foundation.md` + `embedded-frontend-composition.md` are
   *currently untangling* for Phoenix. Land on top of that machinery, not
   beside it.
2. **Idiomaticity asymmetry** — LiveView *is* the blessed Phoenix way; the
   foundation pays for itself there. In TS-land the collapsed full-stack
   model is *one* option, and the separated model (Path A, which Loom
   already does well) is at least as common.
3. **It forfeits the split's value** — the versioned wire contract,
   backend-swappability, cross-backend conformance. Path A keeps all of it;
   Path B trades it away for a weaker idiomatic claim than LiveView's.

If pursued: `foundation: nextjs` on `node`, on top of
`embedded-frontend-composition`, reusing the React body-walker and TS
`render-expr`/`render-stmt` verbatim; only the project-shell + the
domain-call-lowering (operation → server action) are new. Success test: it
touches the node scaffold + a domain-call-lowering seam + a capability set
— **never** the body-walker, design packs, TS expression renderers, or IR.

## Recommendation

Pursue **Path A** when Next.js is wanted — it is concrete, cheap, reuses
the React frontend, and is *rehabilitated* by any domain-owning backend
(the Nest pairing especially). Keep **Path B** on ice behind the Phoenix
foundation work. Either way, **one domain owner**, and Next.js earns its
place through SSR/SEO + a BFF tier, not by owning domain logic.

## Cross-references

- [`nestjs-backend.md`](./nestjs-backend.md) — the natural Path-A pairing;
  a node backend that can *host* Next's SSR (the node-runtime capability).
- [`embedded-frontend-composition.md`](./embedded-frontend-composition.md)
  — **prerequisite**: host-embeds-framework decoupling + the
  runtime-capability derivation that makes "node hosts SSR Next" fall out.
- [`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md) /
  [`platform-realization-axes.md`](./platform-realization-axes.md) — the
  `foundation:` precedent Path B copies.
- [`angular-frontend.md`](./angular-frontend.md) — the prioritised frontend
  (a clean distinct-framework fit; Next is a *topology/foundation*
  question, Angular a *frontend* one).
- [`docs/page-metamodel.md`](../page-metamodel.md) — the framework-neutral
  page-DSL both paths reuse unchanged.
