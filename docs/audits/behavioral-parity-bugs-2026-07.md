# Behavioural-parity bugs — cross-backend runtime gaps (2026-07)

*Living register. Bugs surfaced by running the SAME behavioural test on every
backend (the `test/behavioral/` tier: `run.mjs` + `run-{java,python,dotnet,elixir}.mjs`
over `test/behavioral/systems/*.ddd` + the manifest-derived corpus features).
These are RUNTIME gaps — the code generates and compiles, but the emitted stack
behaves differently on one backend. Not to be confused with the compile-tier
skip-lists (which are generate/compile failures) or the validator gates (honest
"unsupported" rejections).*

**Workflow:** gather here as they surface; fix in a batch at the end, or
distribute one bucket per backend to `language-feature-developer` (backend
generator trees are disjoint — `src/generator/<backend>/` never collide, so the
fixes parallelise cleanly).

Legend: 🔴 confirmed (reproduced) · 🟡 suspected (needs a boot to confirm) · ✅ fixed.

---

## Coverage of this pass

Booted locally against `systems/{sales,payments,ledger,shapes}.ddd` + the
`state-gate` corpus feature:

| System (feature)              | node | java | python | dotnet | elixir |
|-------------------------------|:----:|:----:|:------:|:------:|:------:|
| state-gate (`when` gate)      |  ✅  |  ✅  |   ✅   |   ✅   |  ⏳CI  |
| sales (core CRUD/VO/assoc)    |  ✅  |  ✅  |   ✅   |   ✅   |  ⏳CI  |
| payments (inheritance)        |  ✅  |  ✅  |   ✅   |🔴 B2   |  ⏳CI  |
| ledger (event-sourcing)       |✅ B1 |  ✅  |   ✅   |   ✅   |  ⏳CI  |
| shapes (document/embedded)    |  ✅  |  ✅  |   ✅   |🔴 B3   |  ⏳CI  |

⏳CI = elixir has no host toolchain (needs the `hexpm/elixir` docker image + the
hex-mirror for egress); its bugs will be gathered from `behavioral-e2e-elixir.yml`
once this branch's CI runs, and appended here.

---

## B1 ✅ node — event-sourced `create` checks invariants before folding the create event

- **Where:** `src/generator/typescript/emit/aggregate.ts` (the node/Hono
  event-sourced `create` factory — shared TS emitter the Hono backend drives).
- **Repro:** `test/behavioral/systems/ledger.ddd` on node —
  `POST /api/accounts { owner: "alice" }` → **400 "Invariant violated: balance >= 0"**.
- **Expected (java, python pass):** `create(owner)` emits `Opened`; `apply(Opened)`
  sets `balance := 0`; the `invariant balance >= 0` holds. node evaluated the
  invariant BEFORE the create event folded initial state, so `balance` was unset/
  negative at check time.
- **Root cause:** the ES `create` factory built the empty shell with the
  constructor's default `trustStore = false`, so the ctor ran
  `_assertInvariants()` against the pre-fold (unset) state, before `_init`
  emitted-and-folded the creation event. Java (no-arg JPA ctor) and Python
  (`__new__`) build the shell without running the ctor check, so they fold first.
- **Fix:** build the shell with `trustStore = true` and assert invariants ONCE
  after `_init` folds the creation event(s) — the fold-then-check order Java/
  Python already use. Node-only (`src/generator/typescript/emit/aggregate.ts`).
- **Second bug this unmasked (harness):** with the 400 gone, the node
  behavioural boot then 500'd on the event-log insert — `synthDDL`
  (`web/src/runtime/ddl.ts`, the in-process PGlite DDL synth) rendered
  `occurred_at timestamptz NOT NULL` but **dropped the `.defaultNow()` DEFAULT**,
  and the repository omits that column so the row relies on the default. The
  event-log table is the first corpus row to depend on a DB default; older cases
  never exercised it. Fixed by rendering column `DEFAULT` clauses in `synthDDL`
  (serial types skip — the type provides the sequence).
- **Verification:** `node run.mjs ledger` → both e2e tests green; full node
  suite `node run.mjs` → 20/20. Pinned by
  `test/generator/typescript/typescript-eventsourced-creation.test.ts`.
- **Status:** ✅ fixed; `ledger` re-armed (removed from `cases.mjs` node skips).

## B2 🔴 dotnet — inheritance (TPC/TPH) create 500s at runtime

- **Where:** `src/generator/dotnet/` (inheritance persistence / DTO-insert path).
- **Repro:** `test/behavioral/systems/payments.ddd` on dotnet —
  `POST /api/credit_cards` and `POST /api/bank_accounts` → **500 Internal Server
  Error** (`detail: "internal"`, masked). node + java + python pass.
- **Impact:** polymorphic aggregates can't be created on dotnet at runtime,
  though they compile. Server-side cause TBD (EF insert / discriminator / owned
  type mapping) — needs the app's stderr on the failing request.
- **Status:** confirmed 500; root cause pending.

> **B2 is general.** Confirmed on a 2nd fixture: `test/fixtures/corpus/tph.ddd`
> (`POST /api/cars` → 500) fails the same way as `payments.ddd`. Both are TPH
> (`extends` / sharedTable) — dotnet inheritance persistence create is broken at
> runtime regardless of the fixture. node/java/python pass both.

## B4 🔴 dotnet — inline value-object array (`Money[]`) create 500s

- **Where:** `src/generator/dotnet/` (inline VO-collection persistence).
- **Repro:** `test/fixtures/corpus/value-collections.ddd` on dotnet —
  `POST /api/invoices { lineItems: [{amount,currency}, …] }` → **500**. node +
  java + python round-trip the array fine.
- **Impact:** any aggregate with an inline `<VO>[]` field can't be created on
  dotnet at runtime.
- **Status:** confirmed 500; jsonb/owned-collection EF mapping suspect.

## B3 🔴 dotnet — `shape: document` / `shape: embedded` crashes on boot (EF)

- **Where:** `src/generator/dotnet/` (jsonb shape → EF Core model/migrations).
- **Repro:** `test/behavioral/systems/shapes.ddd` on dotnet — the app **aborts on
  startup (exit 134)** in EF Core `GetPendingMigrations` / `DbContext`
  construction (`Program.cs:224`, the startup migrate call). node + java + python
  boot + pass.
- **Impact:** any dotnet deployable using a document/embedded jsonb shape fails to
  start — a migrate/DbContext-config error the compile gate can't see.
- **Status:** confirmed boot crash; the EF model config for the jsonb shape is
  the suspect.

<!-- Note the asymmetry: dotnet's event-sourced `ledger` PASSES (node's B1 fails);
     node's `payments`/`shapes` PASS (dotnet's B2/B3 fail). Each backend has its
     own behavioural gaps — the whole point of running one test on all targets.
     Add elixir bugs + Slice-4 corpus-block-drain bugs below. -->
