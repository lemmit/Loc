# Todo → full system: a Loom build journey

Five runnable `.ddd` stages that grow one app from a no-code-feeling scaffolded
todo into a fully hand-customized, multi-framework system — built to test Loom's
promise: *start fast like no-code, then have a full app with no excuses.*

| File | Stage |
|---|---|
| [`01-todo.ddd`](01-todo.ddd) | Scaffolded CRUD todo — one aggregate, full stack from 35 lines. |
| [`02-domain.ddd`](02-domain.ddd) | Real domain: enums, invariants, guarded operations, events, tests. |
| [`03-projects.ddd`](03-projects.ddd) | Multi-aggregate: Projects own Tasks, FK, criterion, retrieval, view, workflow. |
| [`04-saas.ddd`](04-saas.ddd) | The SaaS turn: tenancy, auth, `tenantOwned`/`auditable`/`softDeletable`/`versioned`, permissions. |
| [`05-custom.ddd`](05-custom.ddd) | "No excuses": fully hand-written UI served to **React + Vue** off one backend. |

Every stage was verified by **actually compiling the emitted target** (`tsc` /
`vue-tsc` / `vitest`), not just by "generation succeeded" — which is how the
findings below were caught.

**[`FINDINGS.md`](FINDINGS.md)** is the build journal: what was easy, what was
missing, and the three silent codegen bugs the "compile the output" discipline
surfaced (two of which are fixed in this branch, with regression tests).

Run any stage:

```bash
node bin/cli.js parse journey/03-projects.ddd
node bin/cli.js generate system journey/03-projects.ddd -o /tmp/out && (cd /tmp/out && docker compose up)
```
