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
| payments (inheritance)        |  ✅  |  ✅  |   ✅   |   ✅   |  ⏳CI  |
| ledger (event-sourcing)       |🔴 B1 |  ✅  |   ✅   |   ✅   |  ⏳CI  |
| shapes (document/embedded)    |  ✅  |  ✅  |   ✅   |   ✅   |  ⏳CI  |
| value-collections (`Money[]`) |  ✅  |  ✅  |   ✅   |   ✅   |  ⏳CI  |

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

## B2 ✅ dotnet — inheritance (TPH) create 500s at runtime

- **Where:** `src/generator/dotnet/` (inheritance persistence / DTO-insert path).
- **Repro:** `test/behavioral/systems/payments.ddd` on dotnet —
  `POST /api/credit_cards` and `POST /api/bank_accounts` → **500 Internal Server
  Error** (`detail: "internal"`, masked). node + java + python pass.
- **Impact:** polymorphic aggregates can't be created on dotnet at runtime,
  though they compile.
- **Root cause:** the TPH base's `<Base>Configuration.ToTable("vehicles")` was
  emitted WITHOUT the owning context's Postgres schema, while the migration
  (and every concrete config) qualifies it as `"fleet"."vehicles"`. EF issued
  `INSERT INTO "vehicles"` → `relation "vehicles" does not exist`.
- **Fix:** `index.ts` resolves the dataSource for the abstract TPH base and
  threads `schema`/`tablePrefix` into `renderConfiguration`, so the shared-table
  `ToTable` is schema-qualified like every other table.
- **Status:** ✅ fixed — `payments` + `tph` behavioural cases green on dotnet.

> **B2 is general.** Confirmed on a 2nd fixture: `test/fixtures/corpus/tph.ddd`
> (`POST /api/cars` → 500) failed the same way; both are TPH (`extends` /
> sharedTable). Both now pass with the schema-qualification fix.

## B4 ✅ dotnet — inline value-object array (`Money[]`) create 500s

- **Where:** `src/generator/dotnet/` (inline VO-collection persistence).
- **Repro:** `test/fixtures/corpus/value-collections.ddd` on dotnet —
  `POST /api/invoices { lineItems: [{amount,currency}, …] }` → **500**. node +
  java + python round-trip the array fine.
- **Impact:** any aggregate with an inline `<VO>[]` field can't be created on
  dotnet at runtime.
- **Root cause:** TWO bugs. (1) the owned-collection `o.ToTable("invoice_line_items")`
  omitted the context schema (same class of bug as B2) → `relation … does not
  exist`. (2) the child table's composite key `(<owner>_id, ordinal)` left the
  `ordinal` shadow key unpopulated — EF Core has no positional key for a
  table-mapped owned collection, so both items defaulted to `ordinal 0` (a
  track-time duplicate-key conflict), and marking it store-generated omitted it
  from the INSERT (→ NOT NULL violation).
- **Fix:** (1) schema-qualify the child-table `ToTable`; (2) emit a shared
  `OwnedCollectionOrdinalGenerator : ValueGenerator<int>` that numbers each
  owner's items 1,2,3… from the owning navigation at track time (1-based so no
  value equals the int default, which `ValueGeneratedOnAdd` would treat as
  unset). Wired via `o.Property<int>("ordinal").HasValueGenerator<…>()`.
- **Status:** ✅ fixed — `value-collections` green on dotnet; DB rows land with
  ordinals 1,2 in list order.

## B3 ✅ dotnet — `shape: document` / `shape: embedded` crashes on boot (EF)

- **Where:** `src/generator/dotnet/` (jsonb shape → EF Core model/migrations).
- **Repro:** `test/behavioral/systems/shapes.ddd` on dotnet — the app **aborts on
  startup (exit 134)** in EF Core `GetPendingMigrations` / `DbContext`
  construction (`Program.cs:224`, the startup migrate call). node + java + python
  boot + pass.
- **Impact:** any dotnet deployable using a document/embedded jsonb shape fails to
  start — a migrate/DbContext-config error the compile gate can't see.
- **Root cause:** TWO bugs surfaced in sequence. (embedded) the `ToJson` owned
  entity for a contained part never mapped its strongly-typed `<Part>Id` key nor
  ignored its `ParentId` back-reference → EF model validation aborts at boot
  ("property '<Part>.Id' could not be mapped … type '<Part>Id'"). (document) the
  `<Agg>Document` config mapped `Id`/`Data`/`Version` with EF's default
  PascalCase column names, not the migration's `id`/`data`/`version` →
  `column c.Id does not exist` at runtime.
- **Fix:** (embedded) in the `ToJson` branch, emit the part-key `HasConversion`
  and `Ignore(x => x.ParentId)`. (document) map each `<Agg>Document` property to
  its snake_case column (`.HasColumnName("id"|"data"|"version")`, `Id` also
  `ValueGeneratedNever`).
- **Status:** ✅ fixed — `shapes` (both document + embedded cases) green on dotnet.

<!-- Note the asymmetry: dotnet's event-sourced `ledger` PASSES (node's B1 fails);
     node's `payments`/`shapes` PASS (dotnet's B2/B3 fail). Each backend has its
     own behavioural gaps — the whole point of running one test on all targets.
     Add elixir bugs + Slice-4 corpus-block-drain bugs below. -->
