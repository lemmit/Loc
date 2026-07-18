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
| state-gate (`when` gate)      |  ✅  |  ✅  |   ✅   |   ✅   |✅ B6   |
| sales (core CRUD/VO/assoc)    |  ✅  |  ✅  |   ✅   |   ✅   |  ✅    |
| payments (inheritance)        |  ✅  |  ✅  |   ✅   |✅ B2   |  ✅    |
| ledger (event-sourcing)       |✅ B1 |  ✅  |   ✅   |   ✅   |  ✅    |
| shapes (document/embedded)    |  ✅  |  ✅  |   ✅   |✅ B3   |✅ B5   |
| value-collections (`Money[]`) |  ✅  |  ✅  |   ✅   |✅ B4   |  ✅    |
| provenance / union-find       |  ✅  |  ✅  |   ✅   |  ✅    |  ✅    |
| stamps (auditable)            |  ✅  |  ✅  |   ✅   |  ✅    |✅ B7   |
| paged / criterion-filter      |  ✅  |  ✅  |   ✅   |  ✅    |  ✅    |

Elixir was booted locally via the `elixir:1.16-otp-26` docker image + node 22
(the generated project pins Elixir `~> 1.16` and the CLI needs node ≥21 for
`Object.groupBy`; host apt ships only Elixir 1.14, and the 1.16 binary download is
org-policy-blocked). Two elixir gaps surfaced (B5, B6); the rest pass.

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

## B7 ✅ elixir — `auditable` lifecycle stamps 500 on create

- **Where:** `src/generator/elixir/vanilla/stamp-emit.ts` (the `stampPutChanges`
  changeset write seam).
- **Repro:** `test/fixtures/corpus/stamps.ddd` on elixir — `POST /api/orders` → **500**
  (raw HTML crash). node/java/python/dotnet all round-trip. The `stamp onCreate {
  createdAt := now() }` / `onUpdate { updatedAt := now() }` fields are `NOT NULL`.
- **Root cause (NOT what the initial register note guessed):** the stamps ARE
  wired into the create/update path — the repository `insert`/`update` already
  `put_change`d `created_at`/`updated_at`. The 500 was a datetime-**precision**
  mismatch: the stamp rendered `now()` as bare `DateTime.utc_now()` (microsecond
  precision), but every vanilla datetime column maps to `:utc_datetime` (second
  precision; `schema-emit`'s `mapTypeToEcto`). Ecto **refuses to dump** a
  microsecond `DateTime` into a `:utc_datetime` column, raising an `ArgumentError`
  at `Repo.insert` → the controller surfaces it as a raw HTML 500. `audit-emit`
  and `provenance-emit` already write `DateTime.utc_now() |> DateTime.truncate(:second)`
  into their own `:utc_datetime` columns; the stamp path was the one datetime
  write that had skipped the truncate.
- **Fix:** `renderStampValue` truncates a stamp value bound for a second-precision
  `:utc_datetime` column to `:second` (`… |> DateTime.truncate(:second)`), gated on
  the target field being a `datetime` primitive (`stampFieldIsDatetime`). Principal
  stamps (`created_by`, `tenantId` — id/string columns) are untouched → byte-identical.
- **Class:** this is the general "datetime capability-write must match the column
  precision" seam, not a stamps-only special-case — it truncates ANY datetime-valued
  stamp (`createdAt := now()`, a future `expiresAt := now() + 30.days`), keyed off the
  Ecto column type rather than the specific `now()` literal. Unlike B5/B6 (capability
  hooks that were entirely unwired into the elixir path), the stamp hook here was
  already threaded — only its rendered datetime precision was wrong.
- **Verification:** booted via `elixir:1.16-otp-26` + node 22 — `run-elixir.mjs
  stamps` green (order create + read-back); `state-gate shapes sales ledger`
  still green (no B5/B6/core regression). Pinned by
  `test/generator/elixir/elixir-stamping.test.ts`.
- **Status:** ✅ fixed — `stamps` re-armed (removed from `cases.mjs` elixir skips).

## B6 ✅ elixir — `when` state-gate is not enforced at runtime

- **Where:** `src/generator/elixir/vanilla/` (operation `when` canCommand guard).
- **Repro:** `test/fixtures/corpus/state-gate.ddd` on elixir —
  `POST /api/orders/{id}/cancel` on a **Shipped** order should be rejected 409 (the
  `when this.status != Shipped …` gate), but on elixir the call **resolved**. node/
  java/python/dotnet all return 409.
- **Impact:** a **correctness/consistency control silently not enforced** — every
  `operation … when <guard>` ran unconditionally on elixir, so state-gated
  commands executed in states they should be blocked in.
- **Root cause:** the elixir op emitters hoisted only `requires`/`precondition`
  statements into the `with :ok <- ensure(...)` guard chain — the `op.when`
  predicate field was never rendered at all (the `loom.when-unsupported` validator
  had already added elixir to the supported set, so it generated + booted but
  silently skipped the gate).
- **Fix:** a shared `collectOpGuardClauses(op, rc)` (`operation-returns-emit.ts`)
  prepends `:ok <- ensure(<when-pred>, :disallowed)` to the guard chain of EVERY
  op path (relational named / returning / extern, document, ES command), so the
  predicate evaluates against the loaded aggregate BEFORE the body; a false
  predicate short-circuits to `{:error, :disallowed}`, which every controller maps
  to a **409 Conflict** ProblemDetails (parity with Hono/​.NET/​Java/​Python's
  DisallowedError → 409).  `ensure/2` emission + the controller denial arm gate on
  `opHasWhenGate` so a `when`-free op stays byte-identical.
- **Status:** ✅ fixed — `state-gate` green on elixir (Shipped order → 409); pinned
  by `test/generator/elixir/vanilla-when-gate.test.ts`.

## B5 ✅ elixir — `shape: document` create 422s / `shape: embedded` op write is lost

- **Where:** `src/generator/elixir/vanilla/` (jsonb shape → Ecto changeset/schema
  + embed persist).
- **Repro:** `test/behavioral/systems/shapes.ddd` on elixir (booted via the
  `elixir:1.16-otp-26` docker image + node 22) — TWO distinct bugs (the audit's
  "both 422" was imprecise; only the document create 422'd):
  1. **document** `POST /api/carts` → **422 "Validation failed"** with an EMPTY
     `errors` array.
  2. **embedded** `POST /api/wishlists` **succeeded**, but the follow-up
     `addItem` (`items += WishItem{…}`) did NOT round-trip — the read-back
     `items.length` was `0`, not `1`.
- **Impact:** document aggregates couldn't be created; embedded-shape contained-part
  mutations were silently dropped on write.
- **Root cause (document create 422):** the default-on `versioned` capability
  splices a `version` **token** field onto every non-ES aggregate.  For a document
  aggregate the row stores `version` on the ROOT schema (`field :version`, stamped
  by `document_changeset`), but the emitter also included it in the `<Agg>.Data`
  **embed** — so the embed's `changeset/2` `validate_required(:version)`'d a value
  create never supplies.  The failure lived on the nested `:data` embed changeset,
  so the parent's top-level `errors` was empty (→ 422 with `errors: []`).
- **Fix (document create):** `docFields` drops `access: "token"` fields from the
  `Data` embed (schema + cast + required); the two document serializers
  (`renderWireSerialize` via a new `versionExpr` opt, and `docWireMap`) read
  `version` off the ROOT row (`row.version` / `saved.version`) instead of the
  embed, so the wire shape is unchanged.
- **Root cause (embedded op write lost):** an op that mutates an embedded
  containment rebinds `record.<field>` in the body, then persists via
  `put_embed(:<field>, record.<field>)`.  `put_embed`, like `put_change`, DROPS a
  change equal to the changeset DATA — and the base was the ALREADY-mutated
  `record`, so `Repo.update` ran no SQL.  This is the embed analogue of the
  documented scalar `force_change` trap; embeds have no `force_` variant.
- **Fix (embedded op write):** `renderNamedOpFunction` captures the pre-mutation
  struct as `record_before` and builds the persist changeset off it (gated on
  embedded-containment mutation → byte-identical otherwise), so `put_embed` sees a
  real diff.
- **Status:** ✅ fixed — `shapes` green on elixir (document Cart create + jsonb
  round-trip; embedded Wishlist `addItem` → `items.length` 1).  Pinned by
  `test/generator/elixir/vanilla-document.test.ts` (version out of the embed) +
  `vanilla-op-persist.test.ts` (embedded `put_embed` base).

<!-- Note the asymmetry: dotnet's event-sourced `ledger` PASSES (node's B1 fails);
     node's `payments`/`shapes` PASS (dotnet's B2/B3 fail). Each backend has its
     own behavioural gaps — the whole point of running one test on all targets.
     Add elixir bugs + Slice-4 corpus-block-drain bugs below. -->
