# Vanilla Phoenix backend — feature gaps after Ash removal

When the Ash foundation was removed (`platform: elixir` is now vanilla-only —
plain Ecto/Phoenix LiveView), a handful of features that the Ash foundation
emitted have **no vanilla equivalent yet**. The cross-backend parity / generator
tests that asserted the Ash output were updated to drop the elixir leg (or the
specific assertion) so the suite stays green, but each one is a real gap to close
on the vanilla backend later — this file is the tracked list.

Each entry records: what Ash emitted, what vanilla does today, and where the
coverage was dropped (so the test can be restored alongside the fix).

## 1. Paged wire envelope (`find ... paged`)

- **Ash:** returned the `{ items, page, pageSize, total, totalPages }` paged
  envelope, matching the cross-backend `Paged<T>` wire shape.
- **Vanilla today:** the paged find returns a **bare serialized array** — no
  envelope.
- **Dropped from:** `test/conformance/paged-wire-parity.test.ts` (Phoenix leg
  removed; Hono + .NET parity kept).
- **To close:** emit the paged-envelope map in the vanilla find-controller /
  context read path and restore the Phoenix leg in the parity test.

## 2. Discriminated-union per-variant struct tagging

- **Ash:** tagged each union variant with its own per-variant struct (the
  `tag_<union>` tagger), so the wire carried a per-variant field shape.
- **Vanilla today:** tags the **success variant inline** (whole-record serialize
  + `type:`), but emits no per-variant struct-key tagging.
- **Dropped from:** `test/conformance/union-wire-parity.test.ts` (Phoenix leg
  removed; Hono + .NET parity kept).
- **To close:** emit per-variant tagging in the vanilla union find path; restore
  the Phoenix leg.

## 3. `sensitive(...)` inspect-redaction

- **Ash:** emitted a `def inspect/1` that redacted `sensitive` fields (and nested
  VO fields) from struct inspection.
- **Vanilla today:** plain Ecto schema, **no `def inspect/1`** — sensitive fields
  are not redacted from `inspect/1` output.
- **Dropped from:** `test/generator/_walker/inspect-redaction-cross-backend.test.ts`
  (Phoenix case removed; elixir dropped from the cross-backend envelope test).
- **To close:** emit an `Inspect` protocol impl on the vanilla schema that
  redacts `sensitive` fields; restore the Phoenix coverage.

## 4. `contains`-in-`where` membership predicate (ref-collection)

- **Ash:** a `find ... where this.<refColl>.contains(param)` lowered to an Ash
  `exists(<rel>, id == ^arg(:<param>))` filter against the join relationship.
- **Vanilla today:** the membership branch in
  `src/generator/elixir/render-expr.ts` (`renderMember` `contains` arm +
  `relationshipNameFor` → `<field>_through`) **still emits the Ash-shaped
  `exists(...)` / `^arg(:...)` tokens**, which are NOT valid Ecto query syntax,
  and the relationship name (`<field>_through`) does not match the vanilla
  schema's `many_to_many :<field>`. This path is reachable but unverified
  (`test/generator/elixir/vanilla-ref-collection.test.ts` only asserts the
  schema / migration / repository m2m wiring, not the `where`-clause output, and
  no `mix compile` gate covers it).
- **To close:** rewrite the `contains`-membership filter as a real Ecto join /
  subquery over the m2m table, and add a test asserting the `where` output (plus
  a `mix compile` case).

## 5. Workflow `isolationLevel` transaction option

- **Ash:** threaded `resolveWorkflowIsolation` into an `Ash.transaction`
  `isolation_level:` option.
- **Vanilla today:** vanilla `Repo.transaction/1` is emitted **without** an
  `isolation_level:` option — the knob is a no-op on elixir.
- **Dropped from:** `test/system/datasource-isolation.test.ts` (Phoenix case
  retargeted to assert the plain `Repo.transaction/1` shape).
- **To close:** set the transaction isolation on the vanilla `Repo.transaction`
  (e.g. an explicit `SET TRANSACTION ISOLATION LEVEL` statement) and restore the
  isolation assertion.

## 6. Vue / Svelte SPA embedding under a Phoenix host

- **Ash:** a phoenix host embedding a `framework: vue` (or svelte) UI emitted the
  SPA under `assets/` and suppressed the LiveView pages.
- **Vanilla today:** the vanilla phoenix host emits **no embedded Vue/Svelte
  SPA** (no `assets/src/App.vue`, no svelte bundle, no embedded-mode endpoint
  wiring) — only the React embed path is covered.
- **Dropped from:** `test/generator/vue/vue-embedding.test.ts` (phoenix `it`
  deleted; dotnet + java kept). The Svelte sibling is in the same state.
- **To close:** port the embedded-SPA emit (assets tree + `priv/static` endpoint
  serving) to the vanilla host for vue/svelte; restore the embedding tests.

## 7. Phoenix `mix format` + Dialyzer CI gates

- **Ash era:** `generated-elixir-ash-format.test.ts` (`mix format --check`) and
  `generated-elixir-ash-dialyzer.test.ts` (Dialyzer) gated the generated
  Phoenix output; the `test:format-phoenix` / `test:dialyzer-phoenix` npm
  scripts and their CI legs ran them.
- **Today:** those tests/scripts/workflows were deleted with the Ash build; there
  is **no `mix format` / Dialyzer gate on the vanilla output** — only
  `mix compile --warnings-as-errors` (`generated-elixir-vanilla-build.test.ts`,
  `elixir-vanilla-build.yml`).
- **To close:** add `mix format --check` + Dialyzer cases against the generated
  vanilla project and wire matching npm scripts / CI legs.

## 8. Aggregate-inheritance shared-table (TPH) wiring — **CLOSED**

- **The bug (runtime 500, compiled green):** for `inheritanceUsing(sharedTable)`
  the migration correctly created ONE shared `parties` table (`kind`
  discriminator + every subtype's columns), but the generated Ecto schemas
  pointed a concrete at `schema "customers"` / `schema "vendors"` — tables the
  migration never creates — so every read 500'd with "relation customers does
  not exist" (invisible to `mix compile`).  The abstract base also emitted a full
  CRUD repo/changeset/controller over degenerate base structs (no `kind`, no
  polymorphic hydration).
- **Fixed (vanilla elixir backend only):**
  - A TPH **concrete** schema now points at the SHARED base table and carries
    `kind`; its repository filters every read by `kind == "<Concrete>"` and
    stamps `kind` on insert (`src/generator/elixir/vanilla/schema-emit.ts`,
    `repository-emit.ts`).
  - The TPH **base** schema declares the column union + `kind`; a read-only
    polymorphic reader (`list`/`find_by_id` over the shared table) backs
    `find all <Base>`.
  - Abstract bases (TPH and TPC) emit a read-only surface — no changeset, no
    write seam, read-only controller (`changeset-emit.ts`, `context-emit.ts`,
    `api-emit.ts`).
  - TPC (`ownTable`) concrete output is unchanged; the TPC base reader now
    delegates to the concrete repos instead of querying a phantom base table.
  - Centralised in `src/generator/elixir/vanilla/inheritance-emit.ts` (wraps the
    platform-neutral `ir/util/inheritance.ts` predicates).
- **Test:** `test/generator/elixir/vanilla-inheritance.test.ts` asserts the
  subtype schema uses the shared table + `kind`, the repo's `kind` filtering +
  insert stamp, the base polymorphic reader, the read-only controller, and the
  unchanged TPC concrete.

## 9. Operation `requires`/`when` guard referencing `currentUser`

- **Symptom:** `mix compile` fails with `undefined variable "current_user"` —
  an operation guard like `requires currentUser.role == "manager"` renders
  `current_user.role` inside the context function (e.g. `confirm_<agg>/2`), but
  `current_user` is not a parameter there.
- **Vanilla today:** the auditable create/update path already threads
  `current_user \\ nil` into its context functions (and the controller passes
  `conn.assigns[:current_user]`); named operations with a principal-referencing
  guard do **not** thread it, so the reference is undefined at compile time.
- **Gated out:** `test/e2e/fixtures/elixir-vanilla-build/pending/vanilla-auth-op-gate.ddd`.
- **To close:** thread `current_user` into the named-operation context function
  (reusing the auditable mechanism) and have the controller pass
  `conn.assigns[:current_user]`; move the fixture back up to re-gate it.

## 10. Destroy-form bang destroy function (`destroy_<agg>!/1`)

- **Symptom:** `mix compile` warns `<Ctx>.destroy_<agg>!/1 is undefined or
  private` (a `--warnings-as-errors` failure) — the destroy-form path calls the
  bang destroy function, but the context module never emits it.
- **Gated out:** `test/e2e/fixtures/elixir-vanilla-build/pending/vanilla-destroy-form.ddd`.
- **To close:** emit `def destroy_<agg>!/1` on the context module for aggregates
  with a destroy form; move the fixture back up to re-gate it.

## 11. Full-showcase compile (conformance-parity deferral)

- **Symptom:** the vanilla Phoenix backend can't `mix compile` the full
  `examples/showcase.ddd` — it hits §9 (workflow-level `currentUser`, distinct
  from the now-fixed op-level threading) and an aggregate-`function`-call gap (a
  `function passed(): bool = …` used in an operation `precondition passed()`
  renders a bare `passed()` in the context module instead of qualifying it to the
  aggregate's domain-core module), and likely more behind those.
- **Deferred:** `conformance-parity.yml` sets `LOOM_E2E_SKIP_PHOENIX=1`, so the
  per-PR OpenAPI parity runs over node/.NET/Java/Python (the phoenix legs of the
  `e2e.test.ts` parity cross-check are dropped). The elixir deployable stays in
  `showcase.ddd` for the other gates (k8s validate, etc. — which don't mix-compile
  it).
- **To close:** (a) thread `current_user` into workflow `run`/`run_inner` (+ the
  workflow controller), reusing the op-level mechanism; (b) qualify aggregate
  `function` calls in op/workflow bodies to the domain-core module; drain any
  further showcase compile errors; then remove `LOOM_E2E_SKIP_PHOENIX` from
  `conformance-parity.yml` and restore the phoenix parity legs.
