# T10 — New targets

*Policy: **frozen by default.** Every new backend/frontend multiplies the open missions in T1–T6 and, until M-T9.2 (persistence-emit seam) lands, costs the full hand-written emit surface. The in-flight Feliz frontend completes (M-T1.16); nothing below starts without an explicit owner decision that overrides the freeze.*

## M-T10.1 — Go backend — `frozen` · **XL**
net/http + Chi + sqlc over Postgres; Phases 1–4 scoped; decisions to pin (router, SQL layer, error model, generics for collection ops, pointers-for-optionals). ~5–8 weeks to parity pre-seam.
Sources: [go-backend](../old/proposals/go-backend.md).

## M-T10.2 — PHP backend — `frozen` · **XL**
Symfony + Doctrine; the DDD-native study; money/decimal is the one real language gap. Ranked behind NestJS by the corpus.
Sources: [php-backend](../old/proposals/php-backend.md).

## M-T10.3 — NestJS flavor — `frozen` · **L** ⚠ needs re-derivation
Was designed as `foundation: nest` on `platform: node` — but the `foundation:` axis was REMOVED (2026-07-12). Re-derive the mechanism (likely a versioned backend package per D-BACKEND-PKG) before any work.
Sources: [nestjs-backend](../old/proposals/nestjs-backend.md), D-REALIZATION-AXES supersession.

## M-T10.4 — Blazor Server frontend — `frozen` · **XL**
R1 linchpin (pluggable `ExprTarget` in the walker leaf renderer, byte-identical-gated) is independently valuable and could land under T9 seams work; R2/R3 + `BLAZOR_TARGET` + razor pack format stay frozen.
Sources: [blazor-server-frontend](../old/proposals/blazor-server-frontend.md).

## M-T10.5 — HTMX server-rendered frontend — `frozen` · **L**
Scoped to Go + Python only; explicitly sequenced after the Go backend.
Sources: [htmx-server-rendered-frontend](../old/proposals/htmx-server-rendered-frontend.md).

## M-T10.6 — Next.js frontend — `frozen` · **L**
Path A (wire-separated, node-running frontend deployable shape) recommended; Path B (RSC server-coupled) deferred. Gated behind embedded-frontend-composition completion (M-T7.8).
Sources: [nextjs-frontend](../old/proposals/nextjs-frontend.md).

## M-T10.7 — Rails / other studies — `frozen`
Platform-expansion-roadmap Phase I and anything not listed above. Write a study first; the java-backend study → shipped-backend arc is the calibration.
Sources: [platform-expansion-roadmap](../old/plans/platform-expansion-roadmap.md).
