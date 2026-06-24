# Vanilla Phoenix backend — feature gaps after Ash removal

When the Ash foundation was removed (`platform: elixir` is now vanilla-only —
plain Ecto/Phoenix LiveView), a handful of features that the Ash foundation
emitted have **no vanilla equivalent yet**. The cross-backend parity / generator
tests that asserted the Ash output were updated to drop the elixir leg (or the
specific assertion) so the suite stays green, but each one is a real gap to close
on the vanilla backend later — this file is the tracked list.

> **Re-audited 2026-06-24 on fresh `main` (post-#1568).** Four parallel audits
> generated the gated fixtures + synthetic deployables and inspected the actual
> generated Elixir. The list below is corrected against what ships today — several
> entries had rotted (already closed, or mis-framed), and three are **worse** than
> first documented (two are live runtime/contract bugs, not just missing features).
> Each entry carries a **Status** line with the audited verdict and the exact
> emitter site to change.

## Status summary

| # | Gap | Verdict | Size | Priority |
|---|---|---|:---:|---|
| §8 | TPH shared-table inheritance | **REAL — runtime 500 bug** | M–L | **1 (correctness)** |
| §11a | Workflow `currentUser` threading | REAL | M | 2 (parity) |
| §11b | Aggregate-`function` call emit + qualify | REAL | M | 2 (parity) |
| §11c | Nested relational entity parts | honest validator gate | L | 2 (parity, blocks showcase-on-elixir) |
| §1 | Paged wire envelope | REAL | M | 3 |
| §10 | Destroy-form bang `destroy_X!/1` | REAL | S | 3 |
| §3 | `sensitive(...)` inspect-redaction | REAL | S | 3 |
| §5 | Workflow `isolationLevel` | REAL | S–M | 3 |
| §6 | SPA embed under Phoenix host | **REAL — react path also unwired** | L | 4 |
| §7 | `mix format` / Dialyzer CI gates | REAL (output fails `mix format`) | M (+defer Dialyzer) | 4 |
| §9 | Op-level `currentUser` guard | **CLOSED** (#1568) | — | done |
| §2 | Union per-variant struct tagging | **effectively CLOSED** (doc mis-framed) | S | doc/test only |
| §4 | `contains`-in-`where` membership | **CLOSED** (doc stale) | S | dead-code cleanup only |

Restoring the 5-backend `conformance-parity` gate (removing
`LOOM_E2E_SKIP_PHOENIX=1` and re-adding the elixir deployable to
`examples/showcase.ddd`) requires §11a + §11b + §11c.

---

## 1. Paged wire envelope (`find ... paged`)

- **Status (REAL, size M):** the paged find returns a **bare serialized array**
  and applies **no `limit`/`offset` at all** — it ignores the `paged` carrier
  entirely (worse than first documented). The auto `index`/`all` action emits a
  partial `%{items: …}` (no `page`/`pageSize`/`total`/`totalPages`).
- **Ash:** returned the `{ items, page, pageSize, total, totalPages }` paged
  envelope, matching the cross-backend `Paged<T>` wire shape (1-based page).
- **Target / reference:** Hono `routes-builder.ts` (`c.json({ ...result, items })`);
  .NET `emit/repository.ts` (`totalPages = ceil(total/pageSize)`).
- **Emitters to change:** `src/generator/elixir/vanilla/repository-emit.ts`
  `renderFindFn` (accept `page`/`page_size`, apply `limit`/`offset`, run a
  `Repo.aggregate(:count)` for `total`, return the envelope) +
  `src/generator/elixir/vanilla/find-controller.ts` `renderFindActions` (read
  `page`/`pageSize` params, emit the envelope map). Detect via
  `find.returnType.kind === "genericInstance" && ctor === "paged"`.
- **To close:** restore the Phoenix leg in
  `test/conformance/paged-wire-parity.test.ts`; the `vanilla-paged.ddd` fixture
  is already in the `mix compile` gate.

## 2. Discriminated-union per-variant struct tagging — *effectively closed*

- **Status (effectively CLOSED — doc mis-framed):** the "per-variant struct
  tagging" Ash emitted has **no cross-backend analogue**. A union find is
  validator-pinned (`loom.union-find-shape-unsupported`,
  `structural-checks.ts`) to exactly `<Agg> or <Error>` / `<Agg> option` — one
  success aggregate variant plus one *absent* variant. The absent variant never
  rides a 200 body on any backend (it becomes a 404 / RFC-7807 ProblemDetails),
  so the only 200-body variant is the success aggregate, tagged `{ "type": "<Tag>",
  …fields }` on every backend. Vanilla emits
  `json(conn, Map.put(serialize(record), :type, "Order"))` — **byte-equivalent**
  to Hono (`{ type, ...toWire }`) and .NET (`[JsonPolymorphic("type")]`).
- **Remaining (S, no emitter change):** restore the Phoenix discriminator
  assertion in `test/conformance/union-wire-parity.test.ts` (assert the vanilla
  controller `:type`-tags the success body); the per-variant-struct framing is an
  Ash artifact and is retracted here.

## 3. `sensitive(...)` inspect-redaction

- **Status (REAL, size S — IR groundwork already done):** the generated Ecto
  schema is plain (`field :ssn, :string`); no `defimpl Inspect` / `def inspect`
  anywhere — the `sensitive(...)` tag is a no-op on elixir.
- **IR already synthesizes the fix:** `src/ir/enrich/enrichments.ts`
  (`synthesizeInspect`) puts a `derived inspect: string` on every
  `EnrichedAggregateIR`, with sensitive leaves replaced by the literal
  `"<redacted>"` (the same member TS/.NET emit — see
  `src/generator/typescript/emit/aggregate.ts`).
- **Emitter to change:** `src/generator/elixir/vanilla/schema-emit.ts`
  `renderSchema` — append a `defimpl Inspect, for: <Module>` rendering the IR's
  synthesized `inspect` expression via the existing `ELIXIR_TARGET`
  (`render-expr.ts`); gate on any field carrying `f.sensitivity?.length`.
- **To close:** restore the Phoenix case + elixir leg in
  `test/generator/_walker/inspect-redaction-cross-backend.test.ts`.

## 4. `contains`-in-`where` membership predicate (ref-collection) — *closed*

- **Status (CLOSED — doc was stale):** the repository emitter short-circuits the
  membership find and emits **valid Ecto** — a `join: join_row in assoc(record,
  :<field>)` over the `many_to_many` relationship, with `where: join_row.id ==
  ^arg`. The relationship name matches the schema (`:party`, not `:party_through`).
  See `src/generator/elixir/vanilla/repository-emit.ts`
  (`containsRefCollField(f.filter, agg)` → direct join query); the filter never
  reaches `render-expr.ts`.
- **Remaining (S, cleanup only):** the Ash-shaped `contains` arm in
  `src/generator/elixir/render-expr.ts` (the `exists(...)` / `^arg(:…)` branch +
  `relationshipNameFor`) is dead for the *find* path. **Caution:** `ctx.agg` is
  also set during action-body rendering, so prove the arm is unreachable from
  operation bodies before deleting it — it is not provably dead. Optionally add a
  `where`-output assertion (`join_row.id == ^…`) to
  `test/generator/elixir/vanilla-ref-collection.test.ts`.

## 5. Workflow `isolationLevel` transaction option

- **Status (REAL, size S–M):** the vanilla transaction is emitted as bare
  `Repo.transaction(fn -> commit_result(run_inner(params)) end)` — the
  `isolationLevel` knob is a no-op. The IR carries it (`wf.isolation` +
  `resolveWorkflowIsolation`), and `test/system/datasource-isolation.test.ts`
  currently *pins* the bare shape.
- **Emitter to change:** `src/generator/elixir/vanilla/workflow-execution-emit.ts`
  (transactional ~`:1110-1112`, non-transactional ~`:1137-1138`). Ecto has no
  `isolation_level:` option — emit an explicit
  `Repo.query!("SET TRANSACTION ISOLATION LEVEL <LEVEL>")` as the first statement
  inside the transaction fn (map levels SQL-92-style, mirroring
  `dotnet/workflow-emit.ts` `csIsolationLevel`; omit when unset).
- **Plumbing:** `renderWorkflowModule` must receive `ctx`/`sys` to pick up the
  dataSource-level default (it has `wf.isolation` but not the dataSource today).
- **To close:** retarget the Phoenix assertion in `datasource-isolation.test.ts`
  to expect the `SET TRANSACTION ISOLATION LEVEL …` line.

## 6. Vue / Svelte SPA embedding under a Phoenix host

- **Status (REAL — worse than documented, size L):** the whole Phoenix-host SPA
  embed path is unwired — **including React**. `src/generator/elixir/vanilla/index.ts`
  computes an `embedReact` flag but uses it *only* to suppress LiveView pages;
  nothing emits the SPA. For a `platform: elixir` deployable hosting a
  `framework: react|vue|svelte` UI, the project has no `assets/` tree, no
  `SpaController` (`renderSpaController` in `shell/web.ts` is **dead code** — never
  imported), no `/app` route + `Plug.Static` mount, and no spa-build Dockerfile
  stage (`renderDockerfile`'s `embedReact`/`spaOutDir` params are never passed).
  `phx+react`, `phx+vue`, `phx+svelte` all generate identical UI-less projects.
- **Reference:** the `.NET`/Java embed dispatch (`src/generator/java/index.ts`
  ~`:578-624`) — dispatch on `uiFramework`, call
  `generate{React,Vue,Svelte}ForContexts(..., { apiBaseUrl: "/api", pathPrefix })`,
  skip the frontend's project-root files, set Dockerfile/dockerignore with
  `embeddedSpa + spaOutDir` (`svelte → build`, vite → `dist`), honor `viteBase`/
  `paths.base = "/app"`.
- **To close:** wire the embed in `vanilla/index.ts` (+ `/app` Plug.Static +
  SpaController in the endpoint/router emitters); restore the phoenix `it` in
  `test/generator/vue/vue-embedding.test.ts`, add the svelte sibling (and the
  referenced-but-missing `test/generator/elixir/phoenix-embeds-svelte.test.ts`),
  and ensure `test/e2e/embed-react-elixir.test.ts` actually runs (no workflow sets
  `LOOM_EMBED_E2E_PHOENIX` today).

## 7. Phoenix `mix format` + Dialyzer CI gates

- **Status (REAL, size M for format / M–L + defer for Dialyzer):** only
  `mix compile --warnings-as-errors` gates the vanilla output
  (`generated-elixir-vanilla-build.test.ts`, `elixir-vanilla-build.yml`). No
  `mix format` / Dialyzer gate; generated `mix.exs` has no `:dialyxir` dep.
- **Blocker for format:** the current output **fails `mix format --check`** on
  ~53% of `lib/*.ex` files — long lines over the 98-col default and missing blank
  lines between `case`/function clauses. So the gate needs an **emitter
  formatting cleanup first** (the `lines(...)` callers across the vanilla + shell
  emitters), else it paints `main` red on landing.
- **To add:** `test/e2e/generated-elixir-vanilla-format.test.ts`
  (`mix deps.get && mix format --check-formatted` in docker, gated
  `LOOM_PHOENIX_VANILLA_FORMAT=1`, mirror-aware via `startHexMirror()` —
  `.formatter.exs` `import_deps` needs deps fetched) + npm `test:format-phoenix`
  + a CI leg reusing `elixir-vanilla-build.yml`'s BEAM/hex-mirror setup.
- **Dialyzer:** slow, PLT-flaky, surfaces type-inference noise on extern stubs —
  **recommend nightly-only or deferral**; needs `:dialyxir` added to the generated
  `mix.exs` dev deps + PLT caching.

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

## 9. Operation `requires`/`when` guard referencing `currentUser` — *op-level closed*

- **Status (op-level CLOSED in #1568):** named operations with a
  `requires currentUser…` guard now thread `current_user \\ nil` into the context
  function and the controller passes `conn.assigns[:current_user]`
  (`predicates.ts` `opUsesCurrentUser`, `operation-returns-emit.ts`,
  `context-emit.ts`, `api-emit.ts`). The gated fixture
  `pending/vanilla-auth-op-gate.ddd` can be moved back up to re-gate it.
- **Workflow-level remains** — see §11a (same concept, separate emitter).

## 10. Destroy-form bang destroy function (`destroy_<agg>!/1`)

- **Status (REAL, size S):** the destroy-form LiveView calls
  `<Ctx>.destroy_<agg>!(id)` (`liveview-emit.ts`), but the context module emits
  only non-bang `delete_<agg>`/`get_<agg>` defdelegates
  (`src/generator/elixir/vanilla/context-emit.ts` ~`:135-141`) — no
  `destroy_<agg>!/1`, so `mix compile --warnings-as-errors` fails
  ("undefined or private").
- **To close:** emit `def destroy_<agg>!(id)` (load + `Repo.delete!`) on the
  context module for aggregates with a destroy form; move
  `pending/vanilla-destroy-form.ddd` back up to re-gate it.

## 11. Full-showcase compile → 5-backend parity restoration

`#1568` removed the elixir deployable from `examples/showcase.ddd` and set
`LOOM_E2E_SKIP_PHOENIX=1` in `conformance-parity.yml`, so per-PR OpenAPI parity
runs over node/.NET/Java/Python. Re-adding elixir + restoring the phoenix parity
legs requires the three sub-gaps below (all independent codegen fixes; (c) is the
heavy one).

### 11a. Workflow-level `currentUser` threading — REAL (M)

- Workflow `run(params)`/`run_inner(params)` carry no `current_user`, so a
  `requires currentUser.role == …` guard renders an **unbound `current_user`**
  (`workflow-execution-emit.ts` ~`:1110-1112`, `:1137-1138`, `:1156-1157`). Every
  other backend already threads it via `workflowUsesCurrentUser(wf)` /
  `callsUserGatedOp` (`loom-ir.ts`; Hono/.NET/Python/Java workflow builders) —
  vanilla is the only one missing it. The fix must also pass `current_user`
  through to the op calls the workflow makes (else the op guard raises at runtime).

### 11b. Aggregate-`function` call emit + qualification — REAL (M)

- A `function passed(): bool = …` used in an op `precondition passed()` renders a
  bare `passed(record)` in the context module — but `function`s are **never
  emitted on vanilla** (`domain-core-emit.ts` `renderAggregatePureCore` iterates
  `agg.operations` only, and only runs when `agg.tests.length > 0`), *and* the
  call is rendered unqualified (`render-expr.ts` `callKind: "function"`).
- **Fix:** emit `agg.functions` on the domain-core/schema module (unconditionally
  when referenced, not test-gated) **and** qualify the `"function"` call to that
  module (cf. TS `this.passed()`).

### 11c. Nested relational entity parts — honest validator gate (L)

- An aggregate with a nested `entity` part on a *relational* shape (e.g. showcase
  `Catalog.Project contains entity Pipeline`) trips an honest validator error on
  elixir — the relational child-table emit is not wired. This **blocks generating
  showcase-on-elixir** before any compile step. Options: implement relational
  child-table emit on vanilla (schema-emit + migrations), or reshape the showcase
  aggregate (`shape(embedded)` / value-object remodel). Note `shape(embedded)`
  carries its own cross-backend caveats (see git history — it broke .NET EF for a
  strongly-typed contained id), so the principled fix is the relational emit.

### To restore the gate

Land 11a + 11b + 11c, re-add the elixir deployable to `examples/showcase.ddd`,
remove `LOOM_E2E_SKIP_PHOENIX` from `conformance-parity.yml`, and restore the
phoenix legs of the `e2e.test.ts` parity cross-check (the spec-fetch, the diff
pairs, and the 403 runtime-authorization target).
