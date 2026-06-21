# Headless behavioral test tier

Boots the **generated** Hono backend on **PGlite** (Postgres-in-WASM,
in-process — no docker, no separate Postgres) and runs the suites Loom
**emits** from the DSL:

- **api** — the generated `e2e/<Sys>.e2e.test.ts` (from `test e2e "…"
  against <node backend>`), dispatched straight into `app.fetch`.
- **unit** — the generated pure-domain `*.test.ts` (from aggregate
  `test "…"` blocks).

## Why

The behavioral domain assertions otherwise run **only nightly**, in the
docker `conformance-full` leg (`LOOM_E2E=1`). Everything per-PR is
*structural* — typecheck / build / lint / string-match generator tests
(`expect(out).toContain(...)`) — which proves code is *emitted*, not that
it *behaves*. This tier promotes the behavioral layer (for the Hono/TS
backend + pure domain) to a **fast, per-PR, docker-free gate**.

It reuses the **playground's own** runners (`web/src/testing/*`,
`web/src/runtime/ddl.ts`) and the same `createHarness()` the in-browser
*Tests* tab uses — so the node tier and the browser tier share one
execution path. The cross-backend (.NET/Java/Phoenix/Python) and
cross-pack UI behavioral coverage stays in the docker/nightly legs; this
tier is *additive*.

## Run

```bash
cd test/behavioral
npm ci                 # once — pins the generated-project runtime deps (isolated from the repo's)
node run.mjs           # whole corpus
node run.mjs sales-system    # one case
```

The repo toolchain must be built first (`npm run build` at the root) so
`bin/cli.js generate system` emits current output — a **stale `out/`**
will generate old code and produce misleading failures.

Both tiers gate: any `api` or `unit` failure, or a boot/infra error,
fails the run.

## Corpus

`corpus.json` is a curated allowlist. **Constraint:** each system has
exactly one `platform: node` (Hono) deployable, so dispatch
(host-agnostic, path-matched, like the playground) is unambiguous.
Multi-backend systems (`examples/showcase.ddd`, `examples/acme.ddd`)
stay in the docker `conformance-full` leg.

## How it works

Per case: `generate system` → locate the one node deployable → esbuild
bundles a tiny boot entry (its `createApp` + `schema` + drizzle/pglite +
the repo's `synthDDL`/runners) → PGlite → `exec(synthDDL)` →
`drizzle(pglite,{schema})` → `createApp(db)` → run the emitted suites
against `app.fetch`. All third-party deps stay external (resolved from
this dir's `node_modules`), so there is one drizzle instance and PGlite's
wasm assets load normally.
