# Route A — converge the vanilla-Elixir `shape(document)` path onto struct rehydration

**Status:** planned (design validated; not yet implemented). Follow-on to DEBT-07
(#1653), which shipped the map-based document find/op surface.

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

1. **`<Agg>Data` embedded schema + schema/changeset/repository CRUD.** Emit the
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
2. **Converge ops onto the relational renderer.** Replace `renderDocNamedOpFunction`
   / `renderDocReturningOpFunction` (map mode) with the `record = row.data` shim
   over `renderReturningStmt` + a `put_embed` persist tail. Delete `renderDocOpStmt`.
   Un-gate audited + provenanced + derived-reading ops.
3. **In-memory finds in struct mode.** Rewrite `renderDocFindFn` to
   `Repo.all |> Enum.filter(fn row -> <pred over row.data> end)` with the
   predicate rendered in struct mode (`record.field`, `record = row.data`),
   reusing the relational in-memory predicate. Add paged-envelope + union-tag
   builders (both in-memory).
4. **Containments.** Drop the `document` case from `validateVanillaContainmentSupport`
   (parts now nest via `embeds_many`); wire containment-mutating ops (`lines += …`)
   through the reused relational add/remove arm (`put_embed`).
5. **Delete the fork.** Remove `RenderCtx.docMap` from `render-expr.ts` and the
   doc-mode branch in `function-emit.ts`; delete the residual
   `validateVanillaDocumentScope` (or narrow to the genuinely-unsupported tail).

## Risks (all boot-only — the compile gate is blind to them)

1. **Wire format drift.** `embeds_one` dumps by field name; verify the stored
   jsonb keys + the response JSON are byte-identical to today (snake keys in the
   blob, camelCase on the wire, enum declared-casing, `@primary_key false` so no
   `id` leaks into embeds). The §14/§15 tests + a boot are the gate.
2. **Value objects.** Converging `this.money.amount` onto the relational renderer
   (`record.subtotal.amount` = struct-dot) requires VOs to be `embeds_one`
   embedded schemas, **not** `:map` (a `:map` is a string-keyed map → `.amount`
   raises `BadMapError` at runtime). This is a change the relational path may also
   want; scope it to document if relational VO-subfield support differs.
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
