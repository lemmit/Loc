# Next.js — a full-stack node foundation (deferred)

> Status: **PROPOSED (deferred).** Reframed from an earlier "parked React
> shell" note: the interesting version of a Next.js target is **not** a
> second React frontend, it is a **full-stack `node` foundation** — one
> deployable owning TS domain logic *and* its React UI, the TypeScript
> analogue of the Phoenix+LiveView foundation. **Deferred**, gated behind
> [`embedded-frontend-composition.md`](./embedded-frontend-composition.md)
> (the host-embeds-framework machinery it reuses) and the realization-axes
> `foundation:` work ([`platform-realization-axes.md`](./platform-realization-axes.md),
> [`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md)).
> Sibling of [`angular-frontend.md`](./angular-frontend.md) (the
> prioritised, clean-fit frontend).

## TL;DR

There are two ways to read "target Next.js," and the first is a trap:

1. **As a React *project shell*** (app-router + optional SSR, still
   calling a separate Loom backend over the wire) — adopts Next.js while
   bypassing the entire reason people choose it (RSC/server actions). The
   "Next.js as a glorified Vite SPA" anti-pattern. Low value; skip.
2. **As a full-stack `node` foundation** — one deployable that owns *both*
   the TS domain logic (server actions / route handlers) *and* the
   server-rendered React UI. This is the **TypeScript analogue of
   Phoenix+LiveView**, and it is the only framing worth keeping.

Reading 2 is coherent and reuses two pieces Loom already has, but it is a
**foundation-level** decision (a collapsed domain+UI deployable), not a
frontend — so it is **deferred behind the Phoenix-foundation +
embedded-frontend work that is already untangling exactly this shape.**

## Next.js is *not* LiveView mechanically — but it can play the same role

To be precise: LiveView is a stateful-server / persistent-WebSocket /
server-pushes-HTML-diffs model. Next.js is a client-side React framework
with server rendering + RPC-style server actions — a different paradigm
(the literal "LiveView for TS" is LiveViewJS; the real LiveView twins are
**Blazor Server** for .NET and **Livewire** for PHP).

What Next.js *can* do is occupy the same **place in Loom's topology** that
Phoenix+LiveView occupies: a **single deployable that owns domain logic
and its own UI**. That topological role — not the diff-over-socket
mechanism — is what makes the analogy useful.

## Why Phoenix+LiveView fits Loom — and what the Next.js parallel requires

LiveView does not break Loom's frontend/backend separation, because in
Loom's model **Phoenix+LiveView is one deployable**: the Elixir backend
owns the domain logic (Ash/Ecto) *and* renders its own UI (the HEEx
walker). There is no wire boundary to cross because there is no separate
frontend. Loom models this as the **`foundation:` axis** on the `elixir`
platform (`ash` | `vanilla`).

The Next.js parallel is a **`node` foundation** that does the same:

| Piece | Phoenix+LiveView | Next.js full-stack node |
|---|---|---|
| Domain logic | Elixir (Ash/Ecto) — `render-expr`/`render-stmt` for Elixir | **TS — `render-expr`/`render-stmt` already exist (the Hono backend)** |
| UI rendering | HEEx walker (`heex-target.ts`) | **React body-walker — already exists** |
| Deployable shape | one app: domain + UI | one app: domain (server actions / route handlers) + React UI |
| Loom axis | `platform: elixir, foundation: …` | `platform: node, foundation: nextjs` (web-framework + structural foundation in one, like Phoenix) |

The reuse is the headline: **both halves already exist** — the TS domain
emission (`TS_TARGET` for `ExprTarget`, `render-stmt.ts`) and the React
body-walker + design packs. A full-stack node foundation *glues them into
the Next.js app-router / server-actions shape*, rather than emitting two
separate deployables with a wire contract between them.

## Why it is still deferred (not now, maybe not soon)

1. **It is a `foundation` decision, not a frontend.** Collapsing domain+UI
   into one deployable re-introduces the **two-axis-freezing** complexity
   that `vanilla-phoenix-foundation.md` + `embedded-frontend-composition.md`
   are *currently untangling* for Phoenix (Phoenix froze domain *and*
   hosted-framework; the fix decomposes it). A node foundation should land
   **on top of** that machinery, reusing it, not reinventing it.
2. **The idiomaticity asymmetry.** LiveView *is* the blessed, dominant way
   to build Phoenix apps — the foundation pays for itself. In TS-land the
   collapsed full-stack model (server actions) is *one* popular option, and
   the **separated SPA-talks-to-API model Loom already does well** is at
   least as common for structured apps. The foundation chases a model that
   is not clearly the ecosystem default.
3. **It forfeits what the split buys.** A collapsed deployable loses the
   versioned wire contract (`.loom/wire-spec.json`), backend-swappability,
   and cross-backend conformance verification. Phoenix accepts that loss
   because LiveView is *the* idiom; Next.js has a weaker claim.

## If/when pursued — scope

- A **`foundation: nextjs` on `platform: node`**, decided on top of
  `embedded-frontend-composition`'s host-embeds-framework model (the node
  deployable hosts + SSRs the React UI, embedded — the `phoenix-embeds-…`
  twin) plus a server-actions/route-handler transport for the domain calls.
- **Reuse, don't fork:** the React body-walker output and the TS
  `render-expr`/`render-stmt` are consumed verbatim; only the
  project-shell + the domain-call-lowering (operation → server action /
  route handler) are new.
- Gate it like the other generated targets: a `generated-nextjs-build.yml`
  matrix doing `next build`.

Success test: the foundation touches the node project-scaffold layer + a
domain-call-lowering seam + a capability set — **never** the React
body-walker, the design packs, the TS expression renderers, or the IR. If
it would, it has drifted into a bespoke backend and should stop.

## Cross-references

- [`embedded-frontend-composition.md`](./embedded-frontend-composition.md)
  — **prerequisite**: host-embeds-framework decoupling; the node
  deployable hosting React is the `phoenix-embeds-react` twin.
- [`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md) /
  [`platform-realization-axes.md`](./platform-realization-axes.md) — the
  `foundation:` axis precedent a `node` foundation copies.
- [`angular-frontend.md`](./angular-frontend.md) — the prioritised
  frontend; a clean distinct-framework fit (the contrast: Next.js is a
  *foundation* question, Angular is a *frontend* one).
- [`docs/page-metamodel.md`](../page-metamodel.md) — the framework-neutral
  page-DSL both reuse unchanged.
