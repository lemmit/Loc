# Route A — converge the vanilla-Elixir `shape(document)` path onto struct rehydration

**Status:** planned (design validated; not yet implemented). Follow-on to DEBT-07
(#1653), which shipped the map-based document find/op surface.

> **Scope update (2026-07-05, post-#1664/#1670).** Risk 2 below originally said
> typed VO `embeds_one` struct modules were **mandatory** — the only sound fix for
> the #1660 VO-subfield crash. That is **no longer true.** #1664 fixed the crash a
> different way: the relational VO-subfield renderer (`render-expr.ts:435`) and the
> wire serializer (`wire-serialize.ts:82`) now read VO subfields via a
> key-type-agnostic fallback (`Map.get(vo, :k, Map.get(vo, "k"))`) that works on a
> `:map` VO regardless of atom/string keying, and #1670 added a boot gate for it.
> **Consequence:** Route A can bind `record = row.data` and run the relational
> renderers **while keeping VOs as `:map` fields** in the `<Agg>Data` embedded
> schema — no net-new typed-VO-struct emission (the thing that made slice 1 "bigger
> than it looks"). Typed VO structs become an *optional* wire-cleanliness nicety,
> not a prerequisite. This also means Route A's original **bug-driver is already
> resolved** — it is now a pure fork-removal + document-feature-un-gating refactor,
> not a correctness fix. Weigh it as cleanup, and prefer the lean `:map`-VO slice 1.

## Why

Today the vanilla-Elixir document path is the **only** backend where the saving
*shape* leaks into the **domain-logic renderer**. node / .NET / Python / Java all
handle `shape(document)` by **rehydrating the jsonb blob into the same rich
domain object the relational path uses**, then running byte-identical
operation/derived/invariant/audit code — the shape differs *only* in the
repository (`save`/`getById`/`find`). Elixir instead forked a second, map-mode
renderer (`RenderCtx.docMap`) that reads `data["field"]` directly, which is why
it carries a residual gate (`loom.vanilla-document-unsupported`) the others don't:
audited/provenanced ops, derived reads, containments, and paged/union finds each
need re-wiring for the map because the map path is a parallel universe.

**Target architecture (matches the other four): saving shape is a persistence
concern only; the domain-logic layer is blind to it.**

## The design

Make a document aggregate persist as one `embeds_one :data, <Agg>Data` — an
**embedded schema** that carries the domain fields + `embeds_many` parts — so
Ecto round-trips the whole blob to/from the jsonb `data` column for free. Then
the key shim:

```elixir
def <op>_<agg>(%<Agg>{} = row, params) when is_map(params) do
  record = row.data                       # a %<Agg>Data{} struct with every field
  <relational op body, rendered VERBATIM> # renderReturningStmt: `record = %{record | f: v}`
  row
  |> Ecto.Changeset.change(%{version: row.version + 1})
  |> Ecto.Changeset.put_embed(:data, record)
  |> Repo.update()
end
```

Because `renderReturningStmt` / derived / functions / `renderWireSerialize` are
all hard-rooted at a `record` var holding a **struct with all fields**, binding
`record = row.data` lets the **existing relational renderers run unchanged** — no
`docMap`, no fork. The document-specific code collapses to: the schema (thin
`embeds_one` root + the `<Agg>Data` embedded schema), the repository (cast_embed
CRUD + in-memory finds + `put_embed` persist), and that one binding line.

### Schema (the crux)

```elixir
defmodule Api.Cart.Order do              # persistence schema — table (id, data, version)
  @primary_key {:id, :binary_id, autogenerate: true}
  schema "orders" do
    embeds_one :data, Api.Cart.Order.Data, on_replace: :update
    field :version, :integer, default: 1
    timestamps(type: :utc_datetime)
  end
end

defmodule Api.Cart.Order.Data do         # THE domain shape — ops run against this
  @primary_key false                     # <- no `:id` leak into the blob
  @derive {Jason.Encoder, only: [:status, :subtotal, :item_count, :lines]}
  embedded_schema do
    field :status, Ecto.Enum, values: [:open, :checkedOut]
    embeds_one  :subtotal, Api.Cart.Order.Money   # VO -> embeds_one, NOT :map (see risk 2)
    field :item_count, :integer
    embeds_many :lines, Api.Cart.OrderLine        # containment -> embeds_many
  end
  def changeset(struct, attrs), do: struct |> cast(__norm(attrs), [...]) |> cast_embed(:subtotal) |> cast_embed(:lines) |> <invariants>
end
```

The migration stays `create table(:orders) do add :data, :map; add :version …`.

## Slice sequence (each lands green + independently verifiable)

1. **✅ LANDED (2026-07-05).** **`<Agg>Data` embedded schema + schema/changeset/repository CRUD.** Emit the
   `embeds_one :data` root + the `<Agg>Data` embedded schema (reuse
   `renderPartSchema`/`renderFieldLine`/`mapTypeToEcto` from `schema-emit.ts`;
   VOs become `embeds_one` embedded schemas — see risk 2). Rewrite
   `document_changeset` → `cast_embed(:data, with: &Data.changeset/2)`; rewrite
   the repository `insert`/`update`/`get`/`list` to use it; rewrite `serialize/1`
   to reuse `renderWireSerialize` rooted at `record.data`. **Keep ops/finds
   temporarily gated.** Gate: `mix compile` + the §14/§15 wire-parity unit tests
   (`vanilla-wire-camelcase`, `vanilla-wire-key-normalization`) MUST stay green,
   and a **Postgres boot** (`test:obs-phoenix` or a k8s-e2e cell) must confirm
   the blob round-trips and the wire is byte-identical to today.
2. **✅ LANDED (2026-07-05).** **Converge ops onto the relational renderer.** Replaced `renderDocNamedOpFunction`
   / `renderDocReturningOpFunction` (map mode) with the `record = row.data` shim
   over `renderReturningStmt` + a `put_embed(:data, Map.from_struct(record))`
   persist tail (a bare struct trips Ecto's `on_replace: :update` guard — a map is
   required). Deleted `renderDocOpStmt`/`docOpBodyLines`. Functions converted to
   the `%<Agg>.Data{}` struct receiver. **Un-gating deferred** (audited/provenanced/
   derived ops stay gated for now — the persist tail there needs the transactional
   audit/prov machinery; a clean follow-up now that the renderer is unified).
   Boot-verified in `hexpm/elixir` + postgres (ops mutate + re-embed with version
   bump, finds filter in struct mode).
3. **✅ LANDED (2026-07-05, with slice 2).** **In-memory finds in struct mode.** Rewrote `renderDocFindFn` to
   `Repo.all |> Enum.filter(fn row -> record = row.data; <pred over record> end)`
   in struct mode (via the new `docStruct` render flag: struct field access + string
   enums, no bracket). **✅ PAGED LANDED (2026-07-05, slice 4c):** `renderDocFindFn`
   now builds the `%{items, page, pageSize, total, totalPages}` wire envelope IN
   MEMORY for a `paged` find (filter the whole table → `Enum.slice` the page); the
   shared paged find-controller action maps `serialize/1` over `items`.
   **✅ UNION LANDED (2026-07-05, slice 4d):** a union-returning find (`Cart or NotFound`)
   is a single-get whose in-memory `{:ok, List.first(results)}` is exactly the
   `{:ok, nil}`/`{:ok, record}` tuple the SHARED find controller already translates
   to the tagged union wire (found → 200 body, absent → 404 / RFC-7807 via
   `problem_variant/5`) — the doc find fn, defdelegate arity, and controller action
   were all already correct, so only the `badFinds` union gate came out. Boot-verified
   (`by_ref?reference=R-1` → 200 found, `?reference=R-9` → 404 ProblemDetails).
   Paged/union both un-gated; only non-scalar find predicates stay gated. Boot-verified
   paged (3 tickets, `?page=1&pageSize=2` → 2 items totalPages 2, page 2 → 1 item).
4. **Containments.** Drop the `document` case from `validateVanillaContainmentSupport`
   (parts now nest via `embeds_many`); wire containment-mutating ops (`lines += …`)
   through the reused relational add/remove arm (`put_embed`).
   **✅ PERSIST + READ LANDED (2026-07-05).** Dropped the `validateVanillaContainmentSupport`
   document hard-error (parts now fold into `<Agg>.Data` via `embeds_many`/`cast_embed`,
   emitted since slice 1). Switched the document controller `serialize/1` to the shared
   `renderWireSerialize` rooted at the embed (`record = row.data`, `id` off the root row
   via a new `idExpr`/`headVar`/`bind` opts) so containments project through the shared
   `serialize_<part>/1` camelCase helpers — wire byte-identical for non-containment docs.
   Deleted the bespoke `renderDocSerialize`. Boot-verified: `POST /orders {lines:[…]}` →
   201 → `GET` round-trip with parts nested inline in the jsonb blob + camelCase wire.
   **✅ MUTATION LANDED (2026-07-05, slice 4b).** In-op containment mutation
   (`lines += OrderLine{…}`) on a document aggregate: `docStmtUnsupported` now admits a
   `s.collection` add/remove whose target is a CONTAINMENT (ref/value collections stay
   gated), with a doc-safe part-ctor value; the relational add arm already appends the
   part struct in struct mode and the op re-embeds via `put_embed(Map.from_struct(record))`
   (the struct-list casts into `embeds_many`). Boot-verified (create 1 line → addLine → GET
   2 lines, nested inline in jsonb).
5. **✅ PARTLY LANDED (2026-07-05, with slice 2).** **Delete the fork.** Removed `RenderCtx.docMap` (the whole map-mode
   render path — `this-prop`/`renderMember` bracket, enum-string check, function
   receiver) from `render-expr.ts` and the doc-mode branch in `function-emit.ts`,
   replaced by the `docStruct` flag (struct field access + string-enum target). The
   fork is GONE. **Still standing:** the `validateVanillaDocumentScope` /
   `validateVanillaContainmentSupport` gates (slice 4 containments + the
   audited/provenanced/derived/paged/union un-gating remain — the renderer now
   supports the struct path, so those become validator + persist-tail follow-ups).

### Find/op un-gate follow-ups (drained after the fork removal)

- **✅ PAGED finds (slice 4c)** and **✅ UNION finds (slice 4d)** — see slice 3 above.
- **✅ AUDITED named ops (slice 4e, 2026-07-05).** `docOpUnsupported` now admits an
  audited NAMED op; `renderDocNamedOpFunction` records the audit row (`Api.Audit.record`)
  INSIDE the persist `Repo.transaction`, so the history row commits atomically with the
  embed re-write. `audit_before`/`after` use the document `wireSnapshot(_, isDoc)` form
  (`Map.merge(%{id: r.id}, Map.from_struct(r.data))`). Boot-verified: `touch`/`bump`
  audited ops → total persists (5→6→9), `audit_records` carries before/after totals, a
  guarded `bump by:0` denies 403 with NO audit row.
- **✅ RETURNING ops now PERSIST (#1774, 2026-07-05).** A mutating returning op re-embeds +
  `persist_change`s its write, projecting the aggregate wire off the SAVED embed (fall-through
  AND trailing `return this`, both normalized onto the persist path; shape-C — a non-aggregate
  success return — persists then re-renders over `record = saved.data`). A non-committing body
  (pure read / unconditional error return) stays in-memory (byte-identical). The persist gate is
  the SAME `returningOpPersistsChangeset` predicate the shared returning-op controller uses for
  its `{:error, %Ecto.Changeset{}}` clause, so op fn + controller never disagree. Boot-verified:
  `bumpFall`/`bumpReturn` → total persists (5→6→7), a non-mutating `peek` stays in-memory, `GET`
  reflects the persisted value.
- **Audited RETURNING ops stay gated — now unblocked by #1774, but still needing the
  audit-transaction wrapping on the returning path (a clean follow-up; the persist tail is now
  the same `put_embed` the named-op audit path wraps).**
- **Derived reads stay gated — a shared bug, NOT a missing document feature:**
  - **Derived reads**: the RELATIONAL
    op-body path emits `record.<derived>` against a schema with no such column → runtime
    500 (KeyError; the compiler only warns). Filed as **#1765**. The document gate is
    correct — un-gating would replicate the bug.
- **Provenanced ops** can't be supported on a jsonb blob (no co-located
  `<field>_provenance` columns to drain a history buffer into) — stays gated by design.

## Risks (all boot-only — the compile gate is blind to them)

1. **Wire format drift.** `embeds_one` dumps by field name; verify the stored
   jsonb keys + the response JSON are byte-identical to today (snake keys in the
   blob, camelCase on the wire, enum declared-casing, `@primary_key false` so no
   `id` leaks into embeds). The §14/§15 tests + a boot are the gate.
2. **Value objects are provenance-ambiguous → typed VO structs are MANDATORY,
   not optional (issue #1660).** Verified 2026-07-04: a vanilla VO is an untyped
   `:map` whose **key type depends on origin** — a VO built in-memory (a `Money{…}`
   ctor, or a VO-typed op/service param) is **atom-keyed** (`%{amount: 5}`), while
   a VO loaded from jsonb (`this.<vo>`) is **string-keyed** (`%{"amount" => 5}`).
   So `record.<vo>.amount` (struct-dot) crashes with `KeyError` on the DB-loaded
   case, and `record.<vo>["amount"]` (bracket) returns `nil` / breaks the
   in-memory case — **neither form is universally correct** (a naive bracket
   switch was tried and regressed `domain-service-reading/mutating` +
   `vanilla-inspect-redaction`). The ONLY sound fix is making VOs `embeds_one`
   embedded schemas (`%Money{}`), so `record.<vo>` is a real struct on *every*
   path and `.amount` is genuine struct access. This means slice 1 **must** emit
   typed VO modules — it is not a "later" nicety. Filed as #1660 (a standalone
   relational bug independent of this refactor); this refactor should land on top
   of that fix, or subsume it.
   This is **net-new VO-module emission** (VOs are `:map` everywhere today, no VO
   struct module exists) and is the reason slice 1 is bigger than it looks.
   Options: (a) emit a document-local VO embedded schema and converge document
   only; (b) make VOs `embeds_one` across the elixir backend (fixes relational
   too, but touches the heavily-tested relational path). Recommend (a) first,
   file (b) as a separate correctness fix.
3. **Inbound key normalization (§15).** `cast_embed` casts by field atom; incoming
   camelCase (`itemCount`) must be snake-normalized before the cast, per the
   nested-changeset convention (#1632). Reuse it.
4. **`@primary_key false` on `<Agg>Data` + every VO/part embedded schema**, else
   Ecto injects a `binary_id :id` that lands in the blob and on the wire.

## Files

`src/generator/elixir/vanilla/document-emit.ts` (rewrite),
`schema-emit.ts` (reuse/extend part+field rendering for the `Data` schema),
`changeset-emit.ts` (reuse `base_changeset` shape for `Data.changeset`),
`context-emit.ts` (the `record = row.data` op shim), `render-expr.ts` +
`function-emit.ts` (delete `docMap`), `system-checks.ts` (drop the residual +
document-containment gates). Tests: `vanilla-document.test.ts`,
`saving-shape-support.test.ts`, and a boot cell for the round-trip.
