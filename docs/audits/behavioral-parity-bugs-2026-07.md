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
| ledger (event-sourcing)       |🔴 B1 |  ✅  |   ✅   |   ✅   |  ⏳CI  |
| shapes (document/embedded)    |  ✅  |  ✅  |   ✅   |🔴 B3   |  ⏳CI  |

⏳CI = elixir has no host toolchain (needs the `hexpm/elixir` docker image + the
hex-mirror for egress); its bugs will be gathered from `behavioral-e2e-elixir.yml`
once this branch's CI runs, and appended here.

---

## B1 🔴 node — event-sourced `create` checks invariants before folding the create event

- **Where:** `src/generator/hono/` (node event-sourcing repository/aggregate path).
- **Repro:** `test/behavioral/systems/ledger.ddd` on node —
  `POST /api/accounts { owner: "alice" }` → **400 "Invariant violated: balance >= 0"**.
- **Expected (java, python pass):** `create(owner)` emits `Opened`; `apply(Opened)`
  sets `balance := 0`; the `invariant balance >= 0` holds. node evaluates the
  invariant BEFORE the create event folds initial state, so `balance` is unset/
  negative at check time.
- **Impact:** every event-sourced aggregate whose opening event establishes a
  field an invariant guards is uncreatable on node. Silent until now because
  event-sourcing behaviour was python-only in the behavioural tier.
- **Interim:** `cases.mjs` skips `ledger` on node (documented, not silent).
- **Fix sketch:** on node, fold the create-emitted events into initial state
  *before* running invariants (match java/python order: emit → apply → validate).
- **Status:** skip-listed; awaiting fix.

## B2 🔴 dotnet — inheritance (TPC/TPH) create 500s at runtime

- **Where:** `src/generator/dotnet/` (inheritance persistence / DTO-insert path).
- **Repro:** `test/behavioral/systems/payments.ddd` on dotnet —
  `POST /api/credit_cards` and `POST /api/bank_accounts` → **500 Internal Server
  Error** (`detail: "internal"`, masked). node + java + python pass.
- **Impact:** polymorphic aggregates can't be created on dotnet at runtime,
  though they compile. Server-side cause TBD (EF insert / discriminator / owned
  type mapping) — needs the app's stderr on the failing request.
- **Status:** confirmed 500; root cause pending.

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
