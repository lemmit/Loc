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
| single-containment            |  ✅  |  ✅  |   ✅   |✅ B8   |✅ B9   |
| seeding                       |  ✅  |  ✅  |   ✅   |  ✅    |✅ B10  |
| operation-returns (`T or Err`)|  ✅  |  ✅  |   ✅   |  ✅    |✅ B11  |
| core-domain                   |  ✅  |  ✅  |   ✅   |  ✅    |  ✅    |
| document (crudish)            |  ✅  |  ✅  |   ✅   |✅ B12  |  ✅    |
| inheritance (TPH/TPC)         |  ✅  |  ✅  |   ✅   |  ✅    |  ✅    |
| views (where-filtered)        |  ✅  |  ✅  |   ✅   |  ✅    |✅ B13  |
| embedded (containment fold)   |  ✅  |  ✅  |   ✅   |  ✅    |  ✅    |
| embedded-optional (`Memo?`)   |✅ B14|  ✅  |   ✅   |✅ B14  |  ✅    |
| saga (in-process cascade)     |  ✅  |✅ B15|   ✅   |  ✅    |  ✅    |

### Note — the java behavioural boot now needs JDK 25 + Gradle 9.1

A recent `main` bumped the generated Java toolchain to `JavaLanguageVersion.of(25)`,
which requires **Gradle 9.1+** (the host ships Gradle 8.14.3 + JDK 21). Local java
boots now run in a `gradle:9.1.0-jdk25` docker image + node 22 (committed
`loom-java:node22`), mounting `/root/.ccr` and passing the host's
`JAVA_TOOL_OPTIONS` (proxy truststore) so Gradle can resolve the Spring Boot
plugin through the egress proxy. `SPRING_DATASOURCE_URL=jdbc:postgresql://127.0.0.1:5432/app`
against the shared docker postgres.

Elixir was booted locally via the `elixir:1.16-otp-26` docker image + node 22
(the generated project pins Elixir `~> 1.16` and the CLI needs node ≥21 for
`Object.groupBy`; host apt ships only Elixir 1.14, and the 1.16 binary download is
org-policy-blocked). Every elixir gap the drain surfaced (B5/B6/B7/B9/B10/B11/B13) is
now fixed; all corpus cases boot green on all five backends.

---

## B18 🔴 elixir — a derived field has no domain-struct accessor (domain test can't read it)

- **Where:** `src/generator/elixir/vanilla/` — the domain module (`domain-core-emit.ts`) emits no accessor for a `derived` field, and the domain-test emitter (`tests-emit.ts`) renders `o.<derived>` as a plain struct-field read.
- **Repro:** `test/fixtures/corpus/core-domain.ddd` domain `test` with `expect(o.isDraft).toBe(true)` on elixir → the emitted `assert o.is_draft == true` fails: the Ecto schema has no `is_draft` field. Elixir computes the derived value **only inline at the wire boundary** (`order_controller.ex`: `"isDraft" => record.status == :Draft`), with no domain-level function or virtual struct field. node/java/dotnet/python all expose derived fields as a getter/property on the domain object, so `o.isDraft` works there.
- **Impact:** a domain `test "…"` (unit tier) that reads a derived field is un-runnable on elixir only. The derived value's *wire* correctness is still covered by the api tier's read. Surfaced once the unit tier broadened past `sales` (which has no derived field).
- **Status:** OPEN. `core-domain`'s domain test drops the derived assertion for now (keeping the enum/VO-decimal/containment/matcher assertions, which pass ×5). Fix = emit a derived accessor on the elixir domain module (`def is_draft(%__MODULE__{} = r), do: r.status == :Draft`, rendered via the same render-expr path as invariants/functions) and render derived member-access as that function call in `tests-emit.ts` — an elixir-only follow-up.

---

## B17 ✅ elixir — pure `create` leaves a collection containment as `NotLoaded` (domain op crashes)

- **Where:** `src/generator/elixir/vanilla/domain-core-emit.ts` (the pure-domain `create/1` core).
- **Repro:** `test/behavioral/systems/sales.ddd` domain `test` block on elixir — `Order.create(...)` then `order.add_line(...)` → `** (ArgumentError)` on `:erlang.++(#Ecto.Association.NotLoaded<…>, [line])`; `confirm()` → `Protocol.UndefinedError (Enumerable not implemented for Ecto.Association.NotLoaded)` on `Enum.count(order.lines)`. A freshly-built Ecto struct's `has_many` defaults to `Ecto.Association.NotLoaded`, and the pure-domain path never loads it. The op bodies guard with `record.lines || []`, but `NotLoaded` is a truthy struct so the guard doesn't catch it.
- **Impact:** any aggregate with a relational collection containment (`contains … []`) whose domain `test` mutates the collection crashes on elixir — the pure-domain (no-DB) tier only. The HTTP path is unaffected (rows are DB-preloaded → a real list). Surfaced only once the elixir behavioural runner gained a **unit tier** (`mix test`) — the domain tests compiled but were never executed before.
- **Fix:** `create/1` now initialises every collection containment to `[]` on the applied struct (`{:ok, %{record | lines: []}}` via a `with`), so the pure-domain shape matches the loaded/persisted one. Embedded `embeds_many` already default to `[]` (harmless reset).
- **Verification:** `run-elixir.mjs sales` green (unit `mix test` 3/3 + api 4/4) in docker `hexpm/elixir`; was 3 failures before. The api tier (which persists + reads lines) stays green, confirming the reset doesn't disturb persistence.

---

## B16 ✅ java + dotnet — domain-test emitter passes raw literals where the factory/op wants a strong type

- **Where:** `src/generator/java/emit/tests.ts` + `src/generator/dotnet/emit/tests.ts` (the `test "…"` → JUnit/xUnit emitters).
- **Repro:** `test/behavioral/systems/sales.ddd` domain `test` on java/dotnet — the emitted `Order.create(customerId: "…guid…", …, placedAt: "…iso…")` and `order.addLine("…guid…", 2)` don't COMPILE: the domain factory/op take strong types (`CustomerId`/`ProductId` records wrapping `UUID`/`Guid`, `Instant`/`DateTime`) but the test rendered the DSL string literal verbatim (`String cannot be converted to CustomerId` / `to Instant`). Enums were fine (they render as `Enum.Value` refs). Never caught because the `sales` java/dotnet domain test was never compiled in CI (build gates fixture-scope, and the behavioural runners didn't run the unit tier).
- **Impact:** any domain `test` that constructs an aggregate or calls an op with an id/datetime argument fails to compile on java + dotnet — the pure-domain unit tier. node/python are structurally typed (branded strings), so unaffected; elixir is dynamic.
- **Fix:** a shared per-backend coercion (`coerceLiteralToJavaType` / `coerceLiteralToCsType`) wraps id literals in the Id type (a `guid` value type wraps the string in `UUID.fromString` / `Guid.Parse` first) and `datetime` literals in `Instant.parse` / `DateTime.Parse`, at both the `create` inputs and the operation-call args (the op signature resolved via the method-call's `receiverType`). Mirrors wire.ts's `wireToDomain` but from a raw literal.
- **Verification:** `run-java.mjs sales` + `run-dotnet.mjs sales` green (unit 3/3 + api 4/4); was a compile failure before.

---

## B15 ✅ java — a find with an ID-typed query param 500s (no `String → <Agg>Id` converter)

- **Where:** `src/generator/java/emit/api.ts` (find-route controller param binding).
- **Repro:** `test/fixtures/corpus/saga.ddd` on java — `GET /api/shipments/by_order?order=<uuid>` → 500. The controller bound `@RequestParam OrderId order` (the value-typed id wrapper), but Spring MVC has no registered `Converter<String, OrderId>`, so it can't bind the query string → request-time exception. The path-variable getById avoids this by binding `@PathVariable UUID id` and wrapping `new OrderId(id)`; the find route didn't mirror it. (First surfaced by `saga` — the earlier drains' java boots only exercised path-variable ids and string/int find params, never an id-typed `@RequestParam`.)
- **Impact:** any `find byX(y: T id)` is unreachable on the java backend (500 on every call). node/python/dotnet/elixir already bind/convert the id param.
- **Fix:** an id-typed find param now binds its RAW underlying type (`javaValueTypeForId(p.type.valueType)` → `UUID`/`long`/…) and wraps into the id class at the service call (`new <Target>Id(<name>)`), mirroring getById; the raw type's import (`java.util.UUID`) is pulled in. Non-id params (string/int/enum) are unchanged. Pinned by `test/generator/java/find-id-param-binding.test.ts`.
- **Verification:** `run-java.mjs saga` green (docker `gradle:9.1.0-jdk25`); was 500 before the fix. node/python/dotnet/elixir already green.

## B14 ✅ node + dotnet — an OPTIONAL single containment on `shape: embedded` isn't null-safe

- **Where:** `src/generator/typescript/emit/schema.ts` + `repository-embedded-builder.ts` (node); `src/generator/dotnet/dto-mapping.ts` + `emit/efcore.ts` (dotnet).
- **Repro:** `test/fixtures/corpus/embedded-optional.ddd` — a `shape: embedded` aggregate with `contains note: Memo?` left unset (null jsonb cell). A COLLECTION containment (`contains lines: LineItem[]`) folds fine everywhere (defaults `[]`), but the OPTIONAL SINGLE containment breaks node + dotnet because the null cell isn't handled. **java, python, elixir already pass** — used as the reference.
- **Root cause:** the wire shape DOES carry the optionality (`wireFieldsForAggregate` sets `optional: !!c.optional && !c.collection` on the containment `WireField`), but the containment's wire *type* stays a bare `entity` (optionality rides the flag, not the type). Several emitters read the type / iterate `agg.contains` and hardcoded non-null, ignoring `c.optional`:
  - **node (1)** `emitEmbeddedTable` hardcoded `.notNull()` on every containment jsonb column → an unset `note` fails the NOT-NULL constraint on `INSERT` (`500`, `null value in column "note"`). The shared migration DDL already emits the column `nullable: true`, so the Drizzle schema was the one out of step.
  - **node (2)** `hydrateLocals` loaded a single containment as `const note = memoFromDoc(row.note as MemoDoc)` with no null guard → `memoFromDoc(null)` crash on read of an unset containment.
  - **dotnet (1)** `responseRecordParams` declared the containment response field `[property: Required] MemoResponse Note` (non-nullable) — reading an unset containment couldn't satisfy the required schema.
  - **dotnet (2)** `projectEntityArgs` projected `new MemoResponse(found.Note.Id.Value, …)` unguarded → `NullReferenceException` dereferencing the null owned nav.
  - **dotnet (3)** the embedded `.ToJson(...)` `OwnsOne` owned nav lacked `IsRequired(false)` — EF treats the non-nullable CLR nav as required and throws materialising the null JSON cell (same class as B8's relational path, which already had the fix).
- **Fix:** derive nullability from `c.optional` / `WireField.optional` at each site. node: `emitEmbeddedTable` drops `.notNull()` for an optional single containment (collection stays `.notNull()`); `hydrateLocals` guards `row.note == null ? null : memoFromDoc(...)`. dotnet: `responseRecordParams` appends `?` when `wf.optional` (idempotent `endsWith("?")` guard); `projectEntityArgs` guards `found.Note is null ? null : new MemoResponse(...)`; the embedded `OwnsOne` appends `builder.Navigation(x => x.Note).IsRequired(false)` when `c.optional`. **No enrichment/wireShape change** — the wire shape was already correct, so java/python/elixir (which already consult the flag / carry a nil guard) were untouched.
- **Verification:** all five backends boot `embedded-optional` green via the behavioural harness (node PGlite; java host JDK; python/dotnet on postgres; elixir `loom-elx:node22` docker). Pinned by `test/generator/typescript/embedded-optional-containment.test.ts`, `test/generator/dotnet/embedded-optional-containment.test.ts`, `test/generator/elixir/vanilla-embed-optional.test.ts` (the elixir one pins the already-null-safe `embeds_one` + `serialize_<part>(nil)` guard against regression).
- **Status:** ✅ fixed — `embedded-optional` added to the corpus (`backends: ALL`), green on all five.

## B13 ✅ elixir — where-filtered view route returns a `{data: […]}` envelope, not a bare array

- **Where:** `src/generator/elixir/vanilla/view-emit.ts` (the `ViewsController` action bodies).
- **Repro:** `test/fixtures/corpus/views.ddd` on elixir — `GET /api/views/big_orders` returns `{"data": [...]}`, so the e2e `bigs.length` is `undefined` (`expected undefined to be 1`). Every other backend returns a **bare array** `[...]`, and elixir's OWN declared response schema is `OrderListResponse` = `type: :array` — so the controller contradicted both its OpenAPI and the cross-backend wire.
- **Impact:** any client reading a view off the elixir backend gets a differently-shaped body than off node/java/python/dotnet — a silent wire-parity break (found the moment a view was booted behaviourally on elixir).
- **Fix:** both `ViewsController` action bodies (auth-gated + plain) now emit `json(conn, data)` instead of `json(conn, %{data: data})`. Pinned by `test/generator/elixir/view-controller-shape.test.ts`. Verified: `run-elixir.mjs views` green (was `expected undefined to be 1`); node/java/python/dotnet already green. (The `projections-emit.ts` / `workflow-instances-emit.ts` sites still envelope — those are the workflow-sourced-view path, deferred to the `workflow-view` drain where a real boot will confirm the target shape.)

## B12 ✅ dotnet — `with crudish` on a `shape: document` aggregate won't compile

- **Where:** `src/generator/dotnet/emit/repository.ts` (crudish repo interface vs document-shape repo impl).
- **Repro:** `test/fixtures/corpus/document.ddd` with `aggregate Article shape: document, with crudish` on dotnet — `dotnet build` fails **CS0535: `ArticleRepository` does not implement `IArticleRepository.DeleteAsync(Article, …)`**. The `crudish` capability adds `DeleteAsync` to the repo interface, but the document-shape repository emitter doesn't emit a `DeleteAsync` body (the two paths — crudish interface, document impl — disagree). node/java/python compile + round-trip.
- **Impact:** you can't add CRUD (needed to create/delete) to a document-shaped aggregate on dotnet. Found by the Slice-4 drain (needed crudish for a create path to test document behaviourally).
- **Fix:** added a `canonicalDestroy`-gated `DeleteAsync` arm to `renderDocumentRepositoryImpl`, mirroring the relational impl's placement. Since the DbSet holds `<Agg>Document` (JSONB) rows keyed by the raw id value, it loads the row by `id.Value` via `FirstOrDefaultAsync` and `Remove`s it (missing row = no-op) — not the relational path's bare `_db.Set.Remove(aggregate)`. Verified: `run-dotnet.mjs document` green; `LOOM_DOTNET_BUILD=1` corpus build clean; `test/generator/dotnet/crudish-document.test.ts` pins both the interface declaration and the impl body.

## B11 ✅ elixir — `T or Error` union with a PRIMITIVE success type emits an invalid module name

- **Where:** `src/generator/elixir/vanilla/openapi-emit.ts` (union-return OpenApiSpex
  schema module naming).
- **Repro:** `test/fixtures/corpus/operation-returns.ddd` on elixir — `mix ecto.create`
  (compile) fails: **`invalid module name: …DWeb.Api.Schemas.stringOrNotFound`**.
  The op `reject(): string or NotFound` has a union return whose success arm is the
  PRIMITIVE `string`; elixir mints a schema module named `stringOrNotFound` (lower
  camel, off a primitive) — not a valid Elixir alias. node/java/python/dotnet all
  round-trip (`reject` → the NotFound error → 404).
- **Impact:** any exception-less op returning `<primitive> or <Error>` breaks
  elixir codegen. (A union over an aggregate/record success type — the common case
  — works; only the primitive success arm was the gap.) Found by the Slice-4 drain.
- **Root cause:** the union DTO name is `unionInstanceName(variants)` — a join of
  each variant's `variantTag`. A primitive variant tags by its own **lowercase**
  name (`string`), so a union whose FIRST variant is a primitive yields a
  lower-camel stem (`stringOrNotFound`). That is a valid class name on every other
  backend — Java emits it as a lowercase `sealed interface`, TS as a const — but an
  Elixir module alias MUST be uppercase-first, so `defmodule …Schemas.stringOrNotFound`
  is rejected at compile. The elixir emitter fed the raw `unionInstanceName` straight
  into the alias.
- **Fix:** a local `unionSchemaAlias(variants)` = `upperFirst(unionInstanceName(…))`
  supplies the module segment at all three emit sites (the schema `defmodule` +
  `title`, the schemas-file name, and the op's 200-response `schema:` reference) —
  `…Schemas.StringOrNotFound`. Only the Elixir alias is uppercased; the wire `type`
  discriminator tags (`string`, `NotFound`) still come from `variantTag`, so the
  serialized union is byte-identical to every other backend. Union-*find* returns
  are unaffected (their success arm is always the aggregate → already PascalCase).
- **Verification:** booted via `elixir:1.16-otp-26` + node 22 — `run-elixir.mjs
  operation-returns` green (`reject` → NotFound → 404; app compiles clean); the
  `sales ledger payments shapes state-gate stamps single-containment seeding`
  regression set still green (record/aggregate-typed unions + the other elixir
  fixes unaffected). Pinned by `test/generator/elixir/vanilla-openapi-spec.test.ts`
  (the primitive-success-arm alias case).
- **Status:** ✅ fixed — `operation-returns` re-armed (removed from the elixir
  behavioural skips).

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

## B9 ✅ elixir — single (non-collection) `contains` emits an undefined function

- **Where:** `src/generator/elixir/vanilla/context-emit.ts`
  (`contextMutatesRelationalContainment` gate + `renderPutAssocPartsHelper`).
- **Repro:** `test/fixtures/corpus/single-containment.ddd` on elixir — `mix ecto.create`
  (compile) fails: **`undefined function __put_assoc_parts/1`**. node/java/python/dotnet
  round-trip.
- **Root cause:** TWO bugs on the single (`has_one`) containment path. (1) The
  persist tail (`operation-returns-emit.ts`) emits
  `put_assoc(:<f>, __put_assoc_parts(record.<f>))` for ANY relational containment
  field it sees assigned — collection OR single. But the helper-emission gate
  `contextMutatesRelationalContainment` only fired for `add`/`remove` **collection**
  mutations (`lines += Line{…}`), never the `assign` a single containment uses
  (`shipment := Shipment{…}`). So the call was emitted but the `defp` never was →
  compile error. (2) Even once defined, the helper's sole `when is_list(list)`
  clause couldn't take a lone `has_one` struct (the single-value call passes
  `record.shipment`, one struct, not a list).
- **Fix:** (1) the gate now matches `assign`/`add`/`remove` against any
  relational-containment field (dropping the collection-only requirement), mirroring
  the persist-tail emission condition exactly, so a single-containment mutation arms
  the helper. (2) `renderPutAssocPartsHelper` is now multi-clause: the `is_list`
  clause maps a `has_many` list element-wise back through the shared per-element
  clauses (`Enum.map(list, &__put_assoc_parts/1)`), and those per-element clauses
  (`%Ecto.Changeset{}` / `%{__struct__: _}` / catch-all) ALSO normalise a single
  `has_one` struct directly. Every clause stays reachable given the live call sites,
  so `--warnings-as-errors` stays quiet (verified: generated app compiles clean).
- **Verification:** booted via `elixir:1.16-otp-26` + node 22 — `run-elixir.mjs
  single-containment` green (create → ship → read-back `shipment.carrier` = "UPS");
  `sales ledger payments shapes state-gate stamps` still 12/12 (the collection
  `put_assoc` path — `sales` add-line-to-order — unaffected). Pinned by
  `test/generator/elixir/vanilla-relational-parts.test.ts` (single-containment case)
  + the updated helper-text assertion. Sibling of B8 (dotnet single-containment).
- **Status:** ✅ fixed — `single-containment` re-armed (removed from the elixir
  behavioural skips).

## B10 ✅ elixir — migration references a table before it exists (FK order)

- **Where:** `src/generator/elixir/migrations-emit.ts` (`emitInitial` parent-table
  ordering).
- **Repro:** `test/fixtures/corpus/seeding.ddd` on elixir — `mix ecto.migrate` fails:
  **`relation "catalog.widgets" does not exist`**. node/java/python/dotnet apply fine.
- **Root cause (NOT a seed bug — a MIGRATION-ORDERING bug).** The seeding system has
  two PARENT aggregates where `Gadget { widgetId: Widget id }` is a cross-aggregate
  `X id` reference → an inline `references(:widgets)` FK (`on_delete: :restrict`).
  The shared `MigrationsIR` already orders its `createTable` steps FK-topologically
  (`orderTablesByFkDependency` in `migrations-builder.ts` — widgets before gadgets),
  but the elixir emitter splits the steps into parent/part/join tiers and re-derives
  sequential timestamps per tier, sorting parent tables **alphabetically**
  (`a.name.localeCompare(b.name)`). `gadgets` < `widgets`, so `create_gadgets` got
  the earlier timestamp and ran first — its inline `references(:widgets)` hit a table
  that didn't exist yet. (Elixir emits no `seeds.exs`, so no seed INSERT is even
  involved; the audit's "seed references a table" framing was imprecise.)
- **Fix:** a local `orderParentTablesByFk` topological sort replaces the alphabetical
  one — a parent whose FK targets another parent (a cross-aggregate reference) is
  emitted after its target; FK-independent tables keep alphabetical order for stable
  timestamps; best-effort on a cycle. Mirrors the IR-level `orderTablesByFkDependency`.
- **Verification:** `run-elixir.mjs seeding` green (`create_widgets` → BASE+0,
  `create_gadgets` → BASE+1; `mix ecto.migrate` applies, create/getById round-trips).
  Pinned by `test/generator/elixir/phoenix-migrations-emit.test.ts` (parent-table
  FK-topological ordering case).
- **Status:** ✅ fixed — `seeding` re-armed (removed from the elixir behavioural skips).

## B8 ✅ dotnet — single (non-collection) `contains` crashes on boot (EF)

- **Where:** `src/generator/dotnet/emit/efcore.ts` (`containmentConfigLines`, the
  relational single-containment owned-entity EF model).
- **Repro:** `test/fixtures/corpus/single-containment.ddd` on dotnet — the app
  **aborts on startup (exit 134)** in EF Core `GetMigrations`/`DbContext`
  construction (same signature as B3). node/java/python boot + round-trip. A
  `contains shipment: Shipment` (single, non-collection) owned entity isn't
  mapped in a way EF accepts.
- **Impact:** any aggregate with a single (non-collection) containment fails to
  start on dotnet. Found by the Slice-4 drain (batch: single-containment/seeding).
- **Root cause:** TWO bugs surfaced in sequence — a sibling of B3, but on the
  RELATIONAL owned-entity path, not the jsonb one. (1, boot crash) the
  `!c.collection` branch emitted a bare, UNCONFIGURED `OwnsOne<Shipment>(x =>
  x.Shipment)`. But `tableForPart` (migrations-builder) gives EVERY part its own
  table regardless of cardinality — `shipments` (`id` PK + `order_id` FK +
  flattened columns) — so the bare `OwnsOne` both table-splits the part onto the
  owner (no `ToTable`) AND leaves the strongly-typed `ShipmentId` key +
  `OrderId ParentId` back-reference unmapped → EF model validation aborts at boot
  (the same "property could not be mapped … type '<…>Id'" class as B3-embedded).
  (2, runtime 500) once mapped, `GetByIdAsync` threw `InvalidCastException` on
  `GetGuid` — a single containment starts unset (`= default!`) and is filled by an
  op, so the Order is created and loaded BEFORE the `shipments` row exists. EF
  treated the non-nullable CLR nav as a REQUIRED dependent, inner-joined
  `shipments`, and read the NULL `id` of the absent row.
- **Fix:** (1) the single-containment branch now emits the same explicit
  table/key/FK/id-conversion config as the collection path — `OwnsOne<Part>(x =>
  x.Part, o => { o.ToTable(<part>, <schema>); o.WithOwner().HasForeignKey(
  "ParentId"); o.Property("ParentId").HasColumnName("<parent>_id"); o.HasKey(x =>
  x.Id); o.Property(x => x.Id).HasConversion(…); … })` (mapping the public nav
  directly — no `Ignore` + private-backing-field indirection), recursing into
  nested containments. (2) append `builder.Navigation(x => x.<Name>).IsRequired(
  false)` so EF LEFT-joins and returns a null nav when the dependent row is
  absent.
- **Verification:** `run-dotnet.mjs single-containment` → green (create → ship
  → read-back `shipment.carrier` = "UPS"); `sales shapes payments
  value-collections tph state-gate` → 11/11 (no regression); `LOOM_DOTNET_BUILD=1`
  single-containment → `dotnet build /warnaserror` 0 warnings. Pinned by
  `test/generator/dotnet/single-containment.test.ts`.
- **Status:** ✅ fixed — `single-containment` re-armed (removed from the dotnet
  behavioural skips). Was a sibling of B3 (owned-entity mapping), on the
  relational path rather than jsonb, plus the optional-nav bug B3 didn't have.

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
