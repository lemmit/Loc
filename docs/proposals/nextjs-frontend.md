# Next.js frontend — considered, parked

> Status: **PROPOSED (parked — considered, not pursued).** Records *why*
> a Next.js target is not on the roadmap despite Next.js being the
> dominant choice for new React projects, so the question isn't
> re-litigated cold. Sibling of [`angular-frontend.md`](./angular-frontend.md)
> (the frontend that *is* prioritised) and
> [`embedded-frontend-composition.md`](./embedded-frontend-composition.md)
> (the host/framework decoupling any non-React frontend depends on).

## TL;DR

**Do not target Next.js now.** It is tempting on adoption — `create-next-app`
is the de-facto new-React starter — but it is a poor architectural fit for
Loom and adds little marginal value for the kind of app Loom generates.
If it is ever pursued, scope it as a **second React *project-shell*
variant** (app-router + optional SSR, wire boundary preserved), **not** a
full-stack target. Ranked below Angular and below the in-flight Vue/Svelte.

## The core problem: Next.js isn't a new framework, it's React

Loom **already targets React** (Vite + the body-walker + the
Mantine/shadcn/MUI/Chakra design packs). Next.js is a *meta-framework* on
top of React, so "target Next.js" really means *render the same
body-walker components into a Next.js project shell instead of a Vite
one*. The React component output, the design packs, and `wireShape`
consumption are largely reusable. What changes is the shell: file-based
app-router instead of React Router, server vs client components, the
data-fetching model, and the build/deploy story.

That makes the value proposition thin **and** the architectural fit
hostile at the same time.

## Why it fights Loom's architecture

Next.js's reason for existing is **React Server Components (RSC) +
Server Actions** — it deliberately *blurs* the frontend/backend boundary.
A Next.js app can *be* the backend: server components fetch domain data
server-side; server actions invoke operations directly.

Loom's architecture is the **opposite**, and the opposition is enforced,
not stylistic:

- The pipeline is a strict `frontend` deployable talking to a `backend`
  deployable over a **versioned wire contract** (`.loom/wire-spec.json`).
- `test/platform/pipeline-layering.test.ts` enforces one-directional
  layering; the frontend **runs no domain logic** (React skips
  `render-expr`/`render-stmt` precisely because of this).

So there are only two ways to target Next.js, and both are unsatisfying:

| Approach | What it is | Why it disappoints |
|---|---|---|
| **A. Conservative** (wire preserved) | Next.js in client/SSR mode, app-router, still calling a separate Loom backend over the wire | Adopts Next.js while **bypassing the entire reason people choose it** (RSC/server actions) — the "Next.js as a glorified Vite SPA" pattern the Next team discourages. You fight the framework's grain for a different project shell. |
| **B. Idiomatic** (full-stack) | Server components fetch domain data server-side; server actions call domain operations | Puts a Node server in front of / instead of the backend and forces the page-DSL to lower domain calls into server actions — **breaking the "frontend runs no domain logic" invariant** the wire-spec contract rests on. |

## Why the marginal value is low *for Loom's app shape*

Next.js's headline wins are **SSR/SEO** and **server-side data fetching**.
Loom's sweet spot is internal, CRUD-over-aggregates line-of-business apps,
where SSR/SEO matters little and the existing client-rendered React/Vite
target already serves the need. So you would pay to fight your own
architecture for benefits the target apps mostly don't want.

## Where it ranks

Below Angular and below the in-flight Vue/Svelte:

- **Angular / Vue / Svelte** are genuinely *distinct* frameworks used
  idiomatically — each is a clean new `WalkerTarget` + design pack with no
  conflict with the wire boundary.
- **Next.js** is "React you already have, plus a paradigm that opposes
  your wire boundary." The distinct-framework expansion budget is better
  spent on the three above.

## If it is ever pursued

Scope it explicitly and narrowly:

1. **A React project-shell variant, not a full-stack target.** Reuse the
   existing React body-walker output verbatim; swap React Router for the
   app-router; keep `'use client'` components calling the generated API
   client over the wire. Optional SSR for the shell only.
2. **No server actions, no RSC-fetches-domain.** The wire boundary stays;
   `wire-spec.json` remains the contract.
3. **Gate it like React** — a `generated-nextjs-build.yml` matrix
   (`example × pack`) doing `next build`.

Success test (mirroring `embedded-frontend-composition.md`): adding the
Next.js shell touches the React generator's project-scaffold layer and a
capability set — **never** the body-walker, the design packs, or the wire
contract. If a Next.js target would require touching any of those, it has
drifted into approach B and should stop.

## Cross-references

- [`angular-frontend.md`](./angular-frontend.md) — the prioritised
  frontend; a clean distinct-framework fit (the contrast that makes the
  Next.js case weak).
- [`embedded-frontend-composition.md`](./embedded-frontend-composition.md)
  — host/framework decoupling; a static-export Next.js shell would host
  like React does today.
- [`docs/page-metamodel.md`](../page-metamodel.md) — the framework-neutral
  page-DSL a shell variant would reuse unchanged.
