# M-T9.26 — `RouteTarget`: seal the HTTP-emission surface behind a contract

> **STATUS: DRAFT BRIEF — claiming, design in progress.** Scope below; the
> divergence audit + seam contract follow in this PR (design-first per
> [`RUNBOOK.md`](../RUNBOOK.md) step 3 — no extraction code lands until signed off).

## Scope

Extract the HTTP-emission surface of the node/Hono backend behind a
`RouteTarget` contract, the way `ExprTarget` (`src/generator/_expr/target.ts`)
and `WalkerTarget` (`src/generator/_walker/target.ts`) already seal expression
rendering and page walking. Byte-identical-gated against today's Hono output.

**Files in scope (claim boundary):** `src/generator/_route/` (new),
`src/platform/hono/v4/{routes-builder,explicit-handlers-builder,workflow-builder,projection-query-routes-builder,realtime-builder,auth-emit}.ts`,
`src/generator/typescript/emit/routes.ts`, plus this doc + `T9-toolchain-health.md`.

Not in scope: adding a second framework. That is the *motivation*, not the mission.
