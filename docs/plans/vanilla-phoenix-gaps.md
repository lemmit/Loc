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
| §8 | TPH shared-table inheritance | **CLOSED** (#1573) — was a runtime 500 bug | M–L | done |
| §11a | Workflow `currentUser` threading | **CLOSED** (#1579) | M | done |
| §11b | Aggregate-`function` call emit + qualify | **CLOSED** (#1581) | M | done |
| §11c | Nested relational entity parts | **CLOSED** — persist + preload + op-mutation (`+=`/`-=` via `put_assoc`) wired | L | done |
| §1 | Paged wire envelope | **CLOSED** (#1578) | M | done |
| §10 | Destroy-form bang `destroy_X!/1` | **CLOSED** (#1575) | S | done |
| §3 | `sensitive(...)` inspect-redaction | **CLOSED** | S | done |
| §5 | Workflow `isolationLevel` | **CLOSED** (#1574) | S–M | done |
| §6 | SPA embed under Phoenix host | **REAL — react path also unwired** | L | 4 |
| §7 | `mix format` / Dialyzer CI gates | REAL (output fails `mix format`) | M (+defer Dialyzer) | 4 |
| §9 | Op-level `currentUser` guard | **CLOSED** (#1568) | — | done |
| §2 | Union per-variant struct tagging | **effectively CLOSED** (doc mis-framed) | S | doc/test only |
| §4 | `contains`-in-`where` membership | **CLOSED** (doc stale) | S | dead-code cleanup only |
| §12 | `shape(document)` + custom ops/finds | honest validator gate | M | 3 (untracked find) |
| §13 | LiveView operation-action bang fns | **CLOSED** | S–M | done |
| §14 | Success-response wire shape (snake_case keys + leaked Ecto timestamps) | **FIX in #1628** — wireShape-driven serializer, boot-verified | M–L | done |
| — | Ecto migration `default: now()`/`gen_random_uuid()` not `fragment(...)` | **FIX in #1628** — event-store table wouldn't compile; boot-blocker | S | done |
| §15 | Inbound nested-containment camelCase key normalization | **FIXED** — every nested changeset snakes its own keys | M | done |

Restoring the 5-backend `conformance-parity` gate (removing
`LOOM_E2E_SKIP_PHOENIX=1` and re-adding the elixir deployable to
`examples/showcase.ddd`) — §11a (#1579), §11b (#1581), the §11c **core**
(relational persist + preload), AND the §11c **follow-up** (`put_assoc`
op-mutation, `pipelines += Pipeline{…}`) have all shipped.  The follow-up persists
the mutated child list via `put_assoc(:f, __put_assoc_parts(record.f))` — the
context helper normalises the part-struct list to `put_assoc`-ready maps (a bare
struct with a nil PK is silently NOT inserted by `put_assoc`; boot-verified).  The
`loom.vanilla-containment-mutation-unsupported` gate is retired.

---

## 1. Paged wire envelope (`find ... paged`) — **CLOSED** (#1578)

- **Was (REAL, size M):** the paged find returned a **bare serialized array** and
  applied **no `limit`/`offset`** — it ignored the `paged` carrier entirely.
- **Fixed (vanilla elixir backend only):**
  - `src/generator/elixir/vanilla/repository-emit.ts` `renderFindFn` — a paged
    find threads `page`/`page_size` (1-based defaults `1`/`20`), runs
    `Repo.aggregate(query, :count, :id)` for `total`, applies
    `limit(^page_size)`/`offset(^offset)`, and returns the
    `%{items, page, pageSize, total, totalPages}` envelope (atom keys →
    canonical camelCase JSON via Jason). Detected via
    `find.returnType.kind === "genericInstance" && ctor === "paged"`.
  - `src/generator/elixir/vanilla/find-controller.ts` reads `page`/`pageSize`
    query params (via a `page_param/3` coercion helper) and serialises the
    envelope `items`; `context-emit.ts` carries the matching defdelegate arity.
  - Non-paged finds are byte-identical.
- **Test:** `test/generator/elixir/vanilla-paged-envelope.test.ts`; restored the
  Elixir leg of `test/conformance/paged-wire-parity.test.ts` (back to a
  3-backend parity gate). Compiles green under `mix compile` (`vanilla-paged.ddd`
  fixture).

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

## 3. `sensitive(...)` inspect-redaction — **CLOSED**

- **Was (REAL, size S — IR groundwork already done):** the generated Ecto
  schema was plain (`field :ssn, :string`); no `defimpl Inspect` / `def inspect`
  anywhere — the `sensitive(...)` tag was a no-op on elixir.
- **IR already synthesized the fix:** `src/ir/enrich/enrichments.ts`
  (`synthesizeInspect`) puts a `derived inspect: string` on every
  `EnrichedAggregateIR`, with sensitive leaves replaced by the literal
  `"<redacted>"` (the same member TS/.NET emit — see
  `src/generator/typescript/emit/aggregate.ts`).
- **Fixed (vanilla elixir backend only):** a new
  `src/generator/elixir/vanilla/inspect-emit.ts` (`renderInspectImpl`) renders
  the IR's synthesized `inspect` expression through `ELIXIR_TARGET`
  (`render-expr.ts`, receiver bound as `record`) into a
  `defimpl Inspect, for: <Module> do … string(<expr>) … end` block;
  `schema-emit.ts` appends it after the schema module.  Gated on
  `aggHasSensitiveLeaf` (any top-level field OR embedded-VO field carrying
  `f.sensitivity?.length`) — an aggregate with no sensitive field emits NO
  impl, byte-identical to before.
- **Test:** `test/generator/elixir/vanilla-inspect-redaction.test.ts` (focused)
  + the restored elixir leg in
  `test/generator/_walker/inspect-redaction-cross-backend.test.ts` (the
  cross-backend acceptance gate now asserts all three backends — TS/.NET/Elixir
  — share the redaction contract and structural envelope).

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

## 5. Workflow `isolationLevel` transaction option — **CLOSED** (#1574)

- **Was (REAL, size S–M):** the vanilla transaction was emitted as bare
  `Repo.transaction(fn -> commit_result(run_inner(params)) end)` — the
  `isolationLevel` knob was a no-op.
- **Fixed:** `src/generator/elixir/vanilla/workflow-execution-emit.ts` now resolves
  `resolveWorkflowIsolation(wf, ctx, sys)` and, when a level resolves, injects
  `Repo.query!("SET TRANSACTION ISOLATION LEVEL <NAME>")` as the first statement
  inside the `Repo.transaction(fn -> … end)` fn (Ecto has no `isolation_level:`
  option). A new `elixirIsolationSql` helper maps the four DSL levels to SQL-92
  names; output is byte-identical to before when no level resolves. `ctx`/`sys`
  threaded into `renderWorkflowModule`.
- **Test:** `test/system/datasource-isolation.test.ts` asserts the
  `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` line for the `repeatableRead`
  dataSource and the bare wrap (no SET) when unset.

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

## 10. Destroy-form bang destroy function (`destroy_<agg>!/1`) — **CLOSED** (#1575)

- **Was (REAL, size S):** the destroy-form LiveView calls
  `<Ctx>.destroy_<agg>!(id)` (`liveview-emit.ts`), but the context module emitted
  only non-bang `delete_<agg>`/`get_<agg>` defdelegates — no `destroy_<agg>!/1`,
  so `mix compile --warnings-as-errors` failed ("undefined or private").
- **Fixed:** `src/generator/elixir/vanilla/context-emit.ts` now emits
  `def destroy_<agg>!(id)` (load via the existing `get_<agg>` seam, then
  `Repo.delete!`, raising `Ecto.NoResultsError` if not found; threads
  `current_user` for principal-filtered aggregates) for any aggregate with a
  `destroy` action.
- **Test:** `test/generator/elixir/vanilla-destroy-form.test.ts`;
  `vanilla-destroy-form.ddd` moved out of `pending/` to re-gate `mix compile`.

## 11. Full-showcase compile → 5-backend parity restoration

`#1568` removed the elixir deployable from `examples/showcase.ddd` and set
`LOOM_E2E_SKIP_PHOENIX=1` in `conformance-parity.yml`, so per-PR OpenAPI parity
runs over node/.NET/Java/Python. Re-adding elixir + restoring the phoenix parity
legs requires the three sub-gaps below (all independent codegen fixes; (c) is the
heavy one).

### 11a. Workflow-level `currentUser` threading — **CLOSED** (#1579)

- Was: a workflow `run(params)`/`run_inner(params)` carried no `current_user`, so
  a `requires currentUser.role == …` guard rendered an **unbound `current_user`**
  → `mix compile --warnings-as-errors` failure. Fixed in
  `workflow-execution-emit.ts`: `current_user \\ nil` is threaded into the
  workflow fn (and passed through to the gated op calls it makes) when the
  workflow names `currentUser` or calls a `currentUser`-gated op; the controller
  binds it off `conn.assigns`. No-actor workflows are byte-identical.
  Compile-gated fixture `vanilla-workflow-auth.ddd`.

### 11b. Aggregate-`function` call emit + qualification — **CLOSED** (#1581)

- Was: a `function passed(): bool = …` was **never emitted on vanilla**, so a
  call to it failed to compile. Fixed: new `function-emit.ts`
  (`renderAggregateFunctions`) emits each `function` member on the domain module
  (struct-guarded clause head; receiver underscore-prefixed when the body doesn't
  read it, so an argless `function noop()` doesn't trip `--warnings-as-errors`),
  and the `callKind: "function"` call site is qualified. Compile-gated fixture
  `vanilla-functions.ddd`.

### 11c. Nested relational entity parts — **CLOSED** (persist + read + op-mutation wired)

**Core slice landed.** An aggregate with a nested `entity` part on the *relational*
(default) shape now persists + reads on vanilla — the runtime side of the
child-table migration that was already emitted:

- **Schema** (`src/generator/elixir/vanilla/schema-emit.ts`): a relational owner
  `has_many`s/`has_one`s the part (`foreign_key: :<owner>_id, on_replace: :delete`)
  instead of `embeds_many`/`embeds_one`; the part is emitted as a **table-backed**
  `schema "<plural(part)>"` with `belongs_to :<owner>, …, foreign_key: :<owner>_id`
  + `timestamps(type: :utc_datetime)` (the migration's NOT-NULL `inserted_at`/
  `updated_at`), instead of an `embedded_schema`. Gated on
  `effectiveSavingShape === "relational"` via the new exported
  `usesRelationalContainments(agg, ctx, sys)`; `shape(embedded)` keeps the inline
  `embeds_many` path byte-identical.
- **Changeset** (`changeset-emit.ts`): `cast_assoc(:<part>, with: &<PartMod>.changeset/2)`
  instead of `cast_embed` (replace-on-update via `on_replace: :delete`).
- **Repository** (`repository-emit.ts`): the relational containment is added to the
  read preload list (so the `has_many` materialises on the wire — an unloaded assoc
  is `%Ecto.Association.NotLoaded{}`, which Jason can't encode → 500), and the
  update path preloads it before `cast_assoc`.

This mirrors the value-object collection (`charges: Money[]`) `has_many` pattern
already in-tree.

**Follow-up landed (op-mutation).** An operation that mutates a relational
containment (`pipelines += Pipeline{…}` / `-=`) now persists via
`put_assoc(:<part>, __put_assoc_parts(record.<part>))` in the op's persist tail
(`operation-returns-emit.ts` `persistPutBodies`, branched on the new
`relationalContainments` set the caller derives from `usesRelationalContainments`).
The `__put_assoc_parts/1` context helper (`context-emit.ts`, gated by
`contextMutatesRelationalContainment`) normalises the mutated part-struct list to
`put_assoc`-ready **maps** — a bare part struct with a nil PK is silently NOT
inserted by `put_assoc` (Ecto reads a struct as an already-persisted row → empty
changeset; **boot-verified** against real Postgres), whereas a map without `id`
inserts and one with `id` is kept/updated.  `loom.vanilla-containment-mutation-unsupported`
is retired.  Embedded (`put_embed`) output stays byte-identical.

**Still gated:**

1. **Part-in-part nesting** (a part that itself declares `contains`) on a relational
   owner — the shared `tableForPart` migration emits no child table for a part's own
   containments, so there's no backing storage. Stays `loom.vanilla-containment-unsupported`.
   (`shape(document)` containments stay gated too.)

### 11d. Pure-domain-core `requires currentUser` threading — **CLOSED**

- Was: a `requires currentUser.<…>` (or any `currentUser` reference) on an
  **aggregate operation** renders `current_user.role` in the **pure domain-core**
  fn (the aggregate schema module, emitted by `domain-core-emit.ts` only when the
  aggregate carries `test` blocks — `schema-emit.ts`: `agg.tests.length > 0`).
  That fn was `def <op>(record, params)` with no actor → `undefined variable
  "current_user"` → `mix compile --warnings-as-errors` failure. §11a (#1579) fixed
  the **context** wrapper + **workflow** paths but left the pure core out — caught
  only when the showcase (`Catalog.Project.rename/archive`, both tested + guarded)
  was compiled on elixir.
- Fixed: `domain-core-emit.ts` `renderPureOp` appends `, current_user \\ nil` to
  the op `def` when `opUsesCurrentUser(op)` (the helper already in
  `domain/predicates.js`, already used by context-emit) — mirroring the context
  wrapper's arity. Regression: `vanilla-op-action-bang.test.ts` (pure-core
  signature) + the compile-gated fixture
  `vanilla-op-principal-guard.ddd` (a tested aggregate with a `requires
  currentUser` op → `mix compile`; boot-verified green via the
  `generated-elixir-vanilla-build` harness).

### 11e. Domain-test actor threading for a `requires currentUser` op call — **CLOSED**

- Was: a generated domain `test` that **calls** a `requires currentUser` op
  (`expect(p.rename("")).toThrow()` / `o.cancel(...)`) lowered to
  `<Agg>.<op>(record, params)` — no actor — so the pure-core guard (§11d) read a
  nil `current_user` (`nil.role` → `BadMapError`, not the `ArgumentError` a
  `requires` raises). The test mis-fails at `mix test`.
- Fixed: `tests-emit.ts` `renderOp` threads a synthetic privileged actor
  (`TEST_ACTOR` = `%{id: "00…0", role: "admin", permissions: ["*"]}`) as the
  trailing arg when `opUsesCurrentUser(op)` — the parity sibling of node's
  `TEST_ACTOR` (`emit/tests.ts`). Elixir `.field` access works on a plain map, so
  no `%User{}` struct is needed; ungated ops stay byte-identical. Regression:
  `exunit-tests-emit.test.ts` (threads the actor) + the `vanilla-op-principal-guard.ddd`
  fixture gained an "an admin can cancel" test that **calls** the guarded op —
  **boot-verified green at runtime** (`mix test`, 1 passed: admin actor → guard
  passes → `status := "cancelled"` → assert).

**Showcase flip** — with 11a–11e closed, the full showcase **compiles + boots +
migrates** on elixir. A first flip attempt (PR #1612, closed) surfaced two more real
gaps via the `conformance-parity` job — **both now CLOSED** (§11f, §11g below) — so
the flip is **re-attempted** (re-add elixir + drop `LOOM_E2E_SKIP_PHOENIX`); the
authoritative 5-backend parity match is verified by the flip PR's own
`conformance-parity` job.

### §11f. Phoenix emits no OpenAPI spec (`/openapi.json` → 404) — **CLOSED** (#1615)

- Was: `GET /openapi.json` → **404** — the elixir backend emitted no OpenAPI document
  or route, so it couldn't join the OpenAPI-parity diff.
- Fixed: **recovered** the `OpenApiSpex`-based, IR-driven emitter deleted in #1568
  (mislabeled Ash-coupled; it isn't — 99% reusable verbatim) as
  `src/generator/elixir/vanilla/openapi-emit.ts`, wired the `emitOpenApiSpec` call +
  the `{:open_api_spex, "~> 3.0"}` dep + a root `GET /openapi.json` route.
  Boot-verified: phoenix serves the spec → **200** (openapi/paths/components).

### §11g. WorkflowsController collided across contexts (→ runtime 500) — **CLOSED** (#1610)

- Was NOT a stale test target: `registerProject` is a real showcase workflow whose
  router route dispatched to an **undefined action** because the controller was
  emitted **once per context** at a fixed path → later contexts overwrote earlier
  ones (`register_project` lost to `promote_to_production`). Runtime 500.
- Fixed (#1610): emit **one deployable-level WorkflowsController** across all hosted
  contexts, each action dispatching to its own context's `Workflows.<Name>` module.
  (A parallel duplicate fix of mine was dropped on rebase — #1610 landed first.)

*Separately* (NOT flip-blocking): the showcase's own domain `mix test` still has
**further** elixir test-emit gaps beyond 11e (staging the showcase as a vanilla-build
fixture surfaces a remaining `mix test` failure). The conformance-parity gate never
runs domain `mix test` on the showcase, so it doesn't gate the flip; it's a follow-up
toward "showcase fully green under `mix test` on elixir".

- **Verify:** `test/generator/elixir/vanilla-relational-parts.test.ts` (schema /
  changeset / repo / migration shape + the op-mutation `put_assoc(__put_assoc_parts)`
  body) + the compile-gated fixtures
  `test/e2e/fixtures/elixir-vanilla-build/vanilla-relational-parts.ddd` (persist +
  read) and `…/vanilla-relational-mutation.ddd` (op-mutation `+=` →
  `mix compile --warnings-as-errors`; boot-verified child-row round-trip against
  real Postgres).

### To restore the gate

Land 11a + 11b + 11c, re-add the elixir deployable to `examples/showcase.ddd`,
remove `LOOM_E2E_SKIP_PHOENIX` from `conformance-parity.yml`, and restore the
phoenix legs of the `e2e.test.ts` parity cross-check (the spec-fetch, the diff
pairs, and the 403 runtime-authorization target).

## 12. `shape(document)` aggregate with custom operations / finds — honest validator gate (M)

- **Status (REAL — honest gate, surfaced by the 2026-06-28 Ash-parity re-audit):**
  a `shape(document)` aggregate on elixir emits the **CRUD surface only**; if it
  *also* declares a named `operation` or a custom `find`, validation rejects it
  with `loom.vanilla-document-unsupported`
  (`src/ir/validate/checks/system-checks.ts` ~`:521`, message: "shape(document)
  on elixir … emits the CRUD surface only in v1"). node / .NET / Python / Java
  host the full document surface (ops + finds); elixir is the only backend gated
  here. Safe (it fails fast at validate time, never mis-emits) but a real
  capability gap.
- **Not an Ash regression** — the Ash-era Phoenix backend was relational-focused,
  so document-shape custom ops/finds almost certainly never worked there either.
  This is a standing backend gap, not something the vanilla migration dropped;
  it's tracked here because the Ash-parity re-audit found it and the rest of this
  doc didn't list it.
- **To close (feature work, outside the current gap-drain campaign):** emit the
  named-operation / custom-find surface for `shape(document)` aggregates on
  vanilla (the CRUD path already exists), then narrow the gate to drop the
  `customOps` / `customFinds` guard.

## 13. LiveView operation-action bang functions (`<op>_<agg>!/1` + `get_<agg>!/1`) — **CLOSED**

- **Was (REAL — `mix compile --warnings-as-errors` failed; surfaced 2026-06-28
  un-pending `vanilla-auth-op-gate.ddd`):** a LiveView `Detail` page with an
  `Action { c.<op> }` button on a **non-destroy operation** emits a
  `handle_event/3` that calls bang context functions
  (`record = <Ctx>.get_<agg>!(id)` then `<Ctx>.<op>_<agg>!(record)`), but the
  context emitted only the non-bang `get_<agg>(id)` (`{:ok|:error}`) and
  `<op>_<agg>(record, params)` → compile failed with *"`get_customer!/1` /
  `confirm_customer!/1` is undefined."*  Sibling of §10 (which added only
  `destroy_<agg>!/1`).
- **Fixed (`src/generator/elixir/vanilla/context-emit.ts`):** for any aggregate
  carrying operations, emit `def get_<agg>!(id)` (load-or-raise; arity-1 — the
  exact call-site arity, and the non-bang getter's `current_user \\ nil` default
  makes it resolve for principal aggregates too) and, per operation,
  `def <op>_<agg>!(record)` that runs the op with empty params and raises on
  `{:error, _}`. A `currentUser`-gated op's bang takes `record, current_user \\ nil`
  and threads it through (the arity-1 call site uses the default). Aggregates with
  no operations are byte-identical.
- **Test:** `test/generator/elixir/vanilla-op-action-bang.test.ts`;
  `vanilla-auth-op-gate.ddd` promoted out of `pending/` — **verified green** under
  `mix compile --warnings-as-errors` (hex mirror).
- **Known follow-on (runtime, not compile):** the LiveView `handle_event` calls the
  gated bang as `<op>_<agg>!(record)` (arity-1), so `current_user` defaults to
  `nil` there — the action-button auth gate isn't actor-threaded from
  `socket.assigns` yet. The HTTP/controller path (the primary API auth) already
  threads it (#1568). Threading the actor through the LiveView action is a small
  follow-up (`liveview-emit.ts` ~`:397` → pass `socket.assigns[:current_user]` for
  gated ops).

## 14. Success-response wire shape — snake_case keys + leaked Ecto timestamps (M–L, boot-found)

- **Status (REAL, runtime-only — invisible to every per-PR gate):** the vanilla
  success-path `serialize/1` (`record |> Map.from_struct() |> Map.drop([:__meta__,
  :__struct__])`, emitted by `api-emit.ts` and mirrored in `view-emit.ts`,
  `eventsourced-emit.ts`, `document-emit.ts`, `context-emit.ts`, `audit-emit.ts`,
  `workflow-execution-emit.ts`) dumps the raw Ecto struct. Two divergences from the
  canonical cross-backend wire the other four backends (Hono / .NET / Java / Python)
  emit:
  1. **snake_case keys.** A multi-word field ships `commit_sha` / `build_state` /
     `started_at`, but Hono emits `commitSha` / `buildState` / `startedAt`. Single-word
     fields (`name`, `visibility`) coincidentally match, which is why it looked fine.
  2. **Leaked `inserted_at` / `updated_at`.** `Map.from_struct` includes Ecto's
     auto-`timestamps()` columns, which are **not** in the aggregate's `wireShape` and
     no other backend emits. (Distinct from a *declared* `createdAt`/`updatedAt`, which
     maps to `created_at`/`updated_at` and *is* wire.)
- **Why it's invisible per-PR:** the OpenAPI **spec** emitter declares camelCase
  (`projects_api_spec.ex:commitSha`), so `conformance-parity`'s schema-diff passes —
  a spec/runtime mismatch. `paged-wire-parity.test.ts` only diffs the *envelope* keys
  (`items/page/pageSize/total/totalPages`, hand-written camelCase atoms), never the
  inner item field keys. And Elixir isn't booted per-PR (behavioral-e2e is node-only;
  cross-backend runtime is nightly `conformance-full`). Found only by booting the
  showcase Phoenix backend on real Postgres and reading a create response.
- **Why it's not a one-line camelize pass:** nested child structs carry their own
  wire allow-list — `pipeline.ex` has `@derive {Jason.Encoder, only: [:id, :label,
  :run_count]}` — so a generic recursive `Map.from_struct` flatten would *leak*
  `project_id` / the `belongs_to` assoc / timestamps the allow-list deliberately
  hides. The correct fix is a **`wireShape`-driven serializer** (the shape every
  other backend already emits from): project exactly the enriched `agg.wireShape`
  fields, camelCased, recursing into value-object embeds and relational containments
  by *their* wire shapes, with `DateTime`/`Decimal`/`Date` scalars passed through for
  Jason. This threads `wireShape` into the serialize emitters and replaces the
  `Map.from_struct` dump at all ~7 sites (plus the ref-collection id-array projection,
  which already exists and stays). Rebaselines the elixir generator snapshot tests and
  needs a boot + `conformance-full` re-verify.
- **Blast radius:** every vanilla success response of an aggregate with a multi-word
  field or any aggregate at all (timestamp leak is universal). High user-visible
  impact (a shared frontend talking to a phoenix backend gets the wrong keys), which
  is why this is priority 1 despite being newly found.

## 15. Inbound nested-containment camelCase key normalization — **FIXED**

- **Fixed (compositional):** the aggregate `base_changeset` already snaked its
  top-level keys, but `cast_assoc`/`cast_embed` recurse into a nested changeset
  (the entity part's / value-collection's own `changeset/2`) with the sub-map
  still camelCase. Rather than deep-recurse the top-level normalizer (which would
  wrongly snake plain `json`/`map` jsonb columns), **every** generated changeset
  now snakes its OWN top-level keys via a shared `__normalize_keys/1`
  (`src/generator/elixir/vanilla/key-normalize.ts`), so each level of the Ecto
  recursion casts cleanly. Applied to the aggregate, entity-part
  (`schema-emit.ts`), and value-object-collection (`value-collection-schema-emit.ts`)
  changesets. Boot-verified: `POST /api/projects {"pipelines":[{"runCount":3}]}`
  now 201s and round-trips `"runCount":3`.
- **Not covered (separate, murkier):** standalone value-object schemaless
  validation (`valueobject-emit.ts`) casts `snake(@types)` keys but stores the VO
  as a verbatim `:map` — so validation and storage would disagree on casing if
  normalized there. Left as-is (the demonstrated §15 bug is the relational
  child path).

### Original report (REAL, runtime-only — boot-found while verifying §14):
- the vanilla
  request-key normalization (#1620, `Macro.underscore` camelCase→snake before
  `Ecto.cast`) runs on the TOP-LEVEL attrs only. A create body whose **nested
  containment items** use the canonical camelCase wire keys —
  `POST /api/projects {"name":"x","pipelines":[{"label":"l","runCount":3}]}` —
  reaches `cast_assoc(:pipelines, ...)` with the raw `runCount` key, which the
  child `cast(attrs, [:label, :run_count])` doesn't match, so `run_count` stays
  unset → the child INSERT omits it → `23502 not_null_violation` (500). Sending
  the snake key (`run_count`) round-trips fine, confirming it's a key-normalization
  gap, not a persistence bug.
- **Scope:** only bites containment/value-collection creates that carry nested
  objects with multi-word fields. The showcase's own create smoke (empty
  containment) never hit it; found by POSTing a populated `pipelines` list.
- **Fix (M):** make the camelCase→snake normalization recurse into nested
  maps/lists before `cast_assoc`/`cast_embed` (the inbound mirror of §14's
  outbound wireShape serializer — the top-level normalizer is
  `src/generator/elixir/vanilla/*` request-key underscore helper). Needs a boot +
  nested-create round-trip to verify.
