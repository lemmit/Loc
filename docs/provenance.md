# Provenance — the `provenanced` field modifier

`provenanced` is a stored-field modifier that captures the **lineage**
of every value the field has ever held.  For each distinct assignment
site to a `provenanced` field, the compiler captures the right-hand
side expression as an immutable **rule snapshot**.  The generated
backend records a runtime trace on every write so a value can later
be explained: "this 128.40 came from `reprice(qty=8, price=16)` via
rule `<snapshotId>`".

Provenance has a runtime on the **Hono (`node`)**, **.NET (`dotnet`)**,
**Java (`java`)**, **Python (`python`)** and **elixir** (plain Ecto/Phoenix)
backends — each emits the co-located lineage column, per-write
trace capture, and the transactional `provenance_records` flush.  The
remaining surface (`react`) parses the keyword but emits no trace code; only the
snapshot capture runs across all backends.

## Surface

```ddd
aggregate Order {
  quantity: int
  unitPrice: int
  discount: int

  total: int provenanced               // marked

  operation reprice(qty: int, price: int) {
    total := qty * price - discount    // write-site #1
  }

  operation applyDiscount(amount: int) {
    total := quantity * unitPrice - amount   // write-site #2
  }
}
```

The grammar admits `provenanced` on any stored property; the
validator rejects it on `derived` properties (their value is
recomputed, not assigned).

**`provenanced` / `sensitive(...)` / the access modifier parse in any
order.** Marking an *existing* `sensitive(...)` or access-modified field
provenanced by appending the keyword at the end just works:

```ddd
total: int sensitive(pii) provenanced   // ✓
total: int provenanced sensitive(pii)   // ✓ — same meaning, either order
total: int managed provenanced          // ✓
```

`= default` and `check ...` still must come **after** all three flags
(see [`language.md`](language.md)'s property-grammar row) — `default`'s
expression can end in a bare identifier, and the access-modifier names
(`managed`, `secret`, …) double as valid identifiers, so a flag keyword
left unconsumed after an in-progress default risks the expression
greedily swallowing it:

```ddd
total: int = 0 provenanced   // ✗ parse error — provenanced can't follow a default
total: int provenanced = 0   // ✓
```

## Rule snapshots

Each distinct assignment site (`:=`, `+=`, `-=`) to a `provenanced`
field is a **rule snapshot**.  Snapshots carry:

| Field | Meaning |
|---|---|
| `snapshotId` | Content-addressed hash of the RHS — identical expressions at different sites collapse to one snapshot. |
| `source` | Source text of the RHS as written. |
| `ir` | The lowered IR fragment for the RHS — the resolved form (names already bound, member types annotated). |
| `aggregate`, `field`, `operation` | Where the assignment is. |

Two writes with the same RHS in different operations share a
`snapshotId`.  This is the canonical example of why snapshots are
content-addressed: identical formulas need one entry, not N.

## The capture step

Snapshot capture is **explicit and separate from code generation**:

```bash
ddd snapshot path/to/system.ddd -o out
# → out/.loom/snapshots/<ts>-<guid>.loomsnap.json
```

The output is one immutable file per system, containing every
`provenanced` write-site's snapshot.  Each capture is timestamped and
GUID-suffixed, so multiple captures can coexist; the latest is used
by the generated runtime at startup.  Run it as an explicit prebuild
step whenever your provenance rules change.

`--dry-run` lists what would be captured without writing.

## Generated runtime (Hono)

For every Hono deployable that contains at least one `provenanced`
field, the generator emits:

- `domain/provenance.ts` — a small module declaring the `ProvLineage`
  type (`{ snapshotId; target; inputs; computedValue }`) consumed by
  every other generated file.
- A per-aggregate **co-located backing field** `_<field>_provenance:
  ProvLineage | null` for each provenanced property, plus a private
  `_provTraces: ProvLineage[]` buffer on the aggregate class.
- **Inline trace capture** at every `provenanced` write site.  The
  generator wraps the assignment with code that snapshots the RHS
  leaf inputs *before* the write (so a self-referential `x := x + n`
  records the pre-write value), performs the write, builds a
  `ProvLineage` value (rule snapshot id + inputs + post-write
  computed value), and routes it both to the backing field
  (current lineage, persisted on the row) and to `_provTraces`
  (drained into the `provenance_records` history table inside the
  save transaction).  The drain happens wherever the aggregate is
  saved: the operation route handler, and equally a **workflow**
  handler — a provenanced write made inside a workflow step (which
  invokes ops inline) is captured, not dropped, and the workflow
  runs the drain inside a child frame so its rows record their
  call-structure position (see below).
- A `drainProv(): ProvLineage[]` method on the aggregate that
  empties the buffer after a save.

A persisted trace carries enough to answer "why is `order.total`
equal to N?": the `snapshotId` it came from (and therefore the
formula), and the inputs that fed it.

There is no separate `recordTrace(...)` function — the trace
capture is inlined statement-by-statement.  See
`src/generator/typescript/render-stmt.ts` (the `withTrace` wrapper)
and `src/generator/typescript/emit/aggregate.ts` (the field +
buffer + `drainProv` plumbing).

## Generated runtime (.NET)

The .NET backend emits the same runtime shape, in EF Core / CQRS terms:

- `Domain/Common/ProvLineage.cs` — the `ProvLineage` / `ProvTarget` /
  `ProvInput` records (System.Text.Json Web defaults, so the jsonb
  shape matches the Hono lineage) plus `ProvJson.Options`.
- A co-located `public ProvLineage? <Field>Provenance { get; private
  set; }` per provenanced field, mapped to a `<field>_provenance` jsonb
  column via a value-converter, plus a private `_provTraces` buffer and
  a `DrainProv()` drainage hook on the aggregate.
- **Inline trace capture** at every provenanced write site in the
  aggregate method body — snapshot the leaf inputs *before* the write,
  build the `ProvLineage`, and route it to both the backing property and
  `_provTraces` (identical to the Hono `withTrace` logic).
- A `ProvenanceRecord` EF entity + configuration for the append-only
  `provenance_records` table; the repository's `SaveAsync` drains
  `DrainProv()` into it *before* `SaveChangesAsync`, so the history
  commits in the aggregate's transaction.
- The current lineage is exposed on the wire INSIDE the field's own
  `<Agg>Response` component — `Provenanced<int> Total`, the shared
  `Domain/Common` generic record (see "The wire shape" below).

The co-located columns ship as one extra EF migration
(`Migrations/<late>_ProvenanceAudit.cs`) that sorts after every module's
initial migration, because they ALTER tables the module migration owns.
The `provenance_records` table itself is a shared **MigrationsIR companion
table** (`provenanceTableShape` in `src/system/migrations-builder.ts`,
alongside the outbox and `audit_records`), so every backend derives its DDL
from one definition and it arrives in the ordinary module migration.  On the
`persistence: dapper` path — which emits no migration files — the self-applied
`DbSchema.cs` bootstrap renders that same shared shape.

## Governance stamps on each history row

Beyond the lineage itself, every `provenance_records` row carries the
ambient execution-context ids, read from the request carrier at flush
time: `correlation_id` (which request), `scope_id` (which frame),
`parent_id` (the caller frame — its call-structure position), and
`actor_id` (the principal's id — the design's "who computed").  These
are the carrier's [request-context](architecture/request-context.md)
slices; the same tuple is stamped on `audit_records`, so a forensic
query can join the two.  On .NET each Mediator dispatch (command,
workflow, or reactor notification) opens a child frame, so `parent_id`
chains to the originating request; on Hono a workflow opens the child
frame explicitly, while a direct operation route runs in the root frame
(null `parent_id`).  Under background/outbox delivery the carrier is a
fresh root frame, so the row still records the write but with a
correlation orphaned from the original request.

## Generated runtime (elixir)

The Elixir backend (plain Phoenix + Ecto) emits the same shape
in Elixir's immutable idiom:

- `lib/<app>/provenance.ex` — the `<App>.Provenance` SDK: a per-process trace
  buffer (`record/1` push, `drain/0` clear) and the transactional history
  flush (`flush/1`).  The BEAM has no AsyncLocal, so the buffer rides the
  **process dictionary** (cleared on drain) — the same per-process discipline
  `RequestContext` uses for `Logger.metadata`.  Alongside it: `<App>.Provenance
  .Json` (a pass-through Ecto type so a scalar `computed_value` and the
  `inputs` list share one jsonb shape) and `<App>.Provenance.Record` (the
  append-only history schema).
- A co-located `field :<field>_provenance, <App>.Provenance.Json` on the
  aggregate's Ecto schema (jsonb column).
- **Inline capture** at every provenanced write site inside a named operation:
  snapshot the leaf inputs *before* the struct rebind, build the lineage map,
  route it to the co-located column AND `<App>.Provenance.record(...)`.
- The named-operation persist runs the save + `<App>.Provenance.flush(Repo)`
  in **one `Repo.transaction`**, so the `provenance_records` rows commit
  atomically with the aggregate update.  Each row is stamped with the ambient
  `RequestContext` ids (correlation / scope / actor / parent).
- The co-located columns ship as one extra migration
  (`…_create_provenance.exs`, a high timestamp so it sorts after every module's
  initial migration), schema-prefixed to match each aggregate's table.  The
  `provenance_records` table comes from the shared MigrationsIR
  (`…_create_provenance_records.exs`) — and is one of the tables the Ecto
  emitter deliberately does NOT bundle `timestamps()` into, since the flush
  inserts plain maps via `insert_all` and a NOT NULL `inserted_at` would reject
  every provenanced write (and roll back the aggregate save with it).

Capture covers **named operations** (the persisting path); returning-op bodies
on vanilla don't persist, so a provenanced write there is a no-op (the
canonical reprice/applyDiscount shape is a named operation).

```elixir
# lib/<app>/<ctx>.ex — total := qty * price - discount, captured:
loom_prov_inputs_1 = [%{path: "qty", value: qty}, %{path: "price", value: price}, %{path: "discount", value: record.discount}]
record = %{record | total: qty * price - record.discount}
loom_lineage_1 = %{snapshot_id: "13d60464", target: %{type: "Order", field: "total"}, inputs: loom_prov_inputs_1, computed_value: record.total}
record = %{record | total_provenance: loom_lineage_1}
_ = MyApp.Provenance.record(loom_lineage_1)
# …then save + MyApp.Provenance.flush(MyApp.Repo) inside Repo.transaction.
```

## The wire shape — `Provenanced<T>`, one carrier on every target

A provenanced field's value and its lineage travel together as ONE wire
object, on all five backends and all six frontends:

```jsonc
// GET /api/orders/:id
{
  "id": "…",
  "quantity": 3,
  "unitPrice": 40,
  "discount": 0,
  "total": {                     // ← the carrier, not a bare 120
    "value": 120,
    "lineage": {                 // null until the field is first written
      "snapshotId": "13d60464",
      "target": { "type": "Order", "field": "total" },
      "inputs": [ { "path": "qty", "value": 3 }, { "path": "price", "value": 40 } ],
      "computedValue": 120
    }
  }
}
```

The shape is declared **once**, in `GENERIC_SHAPES.provenanced`
(`src/ir/stdlib/generics.ts`), and stamped into `wireShape` **once**, by
`wireTypeForField` (`src/ir/enrich/wire-projection.ts`).  Every DTO emitter
reads it from there through `src/generator/_payload/provenanced-wire.ts`, so
the two member names cannot drift between targets:

| Target | Spelling |
|---|---|
| Hono / TS | `total: z.object({ value: z.number().int(), lineage: ProvenanceLineage.nullable() })` |
| .NET | `Provenanced<int> Total` (`public sealed record Provenanced<T>(T Value, ProvLineage? Lineage)`) |
| Java | `Provenanced<Integer> total` (`public record Provenanced<T>(T value, ProvLineage lineage)`) |
| Python | `total: Provenanced[int]` (`class Provenanced(BaseModel, Generic[_ProvT])`) |
| Elixir (vanilla) | `"total" => %{"value" => record.total, "lineage" => record.total_provenance}` |
| React / Vue / Svelte | `total: z.object({ value: …, lineage: provLineageSchema.nullish() })` |
| Angular | `total: { value: number; lineage: ProvLineage | null }` |
| Feliz | `total: Provenanced<int>` (`provenancedDecoder Decode.int`) |
| Flutter | `final Provenanced<int> total;` |

Because the lineage is part of `wireShape`, it is also part of the contract
artifact — `.loom/wire-spec.json` publishes the carrier's two properties, so a
change to the lineage half is now visible to the wire diff.  It equally rides
`forApiRead`'s access filtering and any `mask unless` redaction, which a
bolted-on sibling key did not.

**Storage is unchanged.** The row still carries a typed value column plus a
`<field>_provenance` jsonb column, and the in-memory domain object still keeps
the two apart — the carrier is a DTO/serialization shape only, assembled on the
way out and split on the way in.  That is also why a domain expression reading
`total` (an invariant, a derived, another operation) needs no unwrap: the domain
value never became a carrier.

**On the request side there is no carrier.** A `create` / `update` / operation
body carries the bare value — a caller supplies a value, never a lineage.

## Scaffolded UI — the "?" provenance disclosure (five frontends + the HEEx server render)

The lineage is already on the wire (the carrier's `lineage` member above),
so a **scaffolded detail page** surfaces it: every
`provenanced` field's value pairs with a small **"?" disclosure** that
expands to show where the value came from — the rule it was computed by,
the computed value, and the input list (`path = value`).

Rendered on **five of the six frontends** (all but Flutter) plus the
Phoenix/HEEx server render: **React** (`<details>` + JSX), **Vue**
(`<details v-if>` + `v-for`), **Svelte** (`{#if}` + keyed `{#each}`),
**Angular** (`@if (…; as prov)` + `@for`), **Feliz** (F# `Html.details`, a
`Some`/`None` match over the `ProvLineage option`), and — server-side —
**HEEx** (Phoenix LiveView: a null-guarded `<%= if … %>` `<details>` + a
`<%= for … %>` comprehension). Two things make it work:

1. EVERY frontend's response schema carries the lineage, because it is part
   of the field's own wire type rather than a per-frontend opt-in append —
   the JSON frontends type it as the nullable `provLineageSchema`
   (`src/lib/schemas.ts`), Feliz as `ProvLineage option`, Flutter as
   `ProvLineage?`.
2. The scaffold pairs the value cell with the closed `ProvenanceInfo`
   primitive — a native `<details>`/`<summary>` (no design-pack component,
   no client state, accessible by default).

```ddd
// A scaffolded aggregate with a provenanced field (examples/provenance.ddd):
aggregate Order with crudish {
  quantity: int
  unitPrice: int
  discount: int
  total: int provenanced          // ← the scaffold detail page adds a "?" here

  operation reprice(qty: int, price: int) {
    total := qty * price - discount
  }
}
```

The scaffolded `unfold`-able page body pairs the value with the disclosure:

```ddd
KeyValueRow("Total",
  Group(Text(data.total.value),
        ProvenanceInfo(of: data, field: "total", testid: "orders-detail-total-prov")))
```

Note `data.total.value` — the figure is the carrier's value half; the
disclosure reads the lineage half off the same field.

**A hand-written body may read the field bare.**  `Text { o.total }` and
`Text { o.total.value }` render identically: the body walker appends the
carrier hop itself when a member read lands on a `provenanced` field, so the
field's DECLARED type (`total: int`) keeps meaning what it says and only the
author who wants the lineage has to spell a hop.  Without that, a page body
written by hand — rather than emitted by the scaffold macro, which spells
`.value` — would put the whole `{ value, lineage }` object into a text slot:
a `tsc` error on the JSX frontends, a stringified record on Feliz/Flutter.
The explicit `.value` / `.lineage` spellings are left alone (no
`.value.value`).

The React generator renders the disclosure over `data.total.lineage`:

```tsx
<Text>{orderById.data.total.value}</Text>
{orderById.data.total.lineage != null ? (
  <details className="loom-provenance" data-testid="orders-detail-total-prov">
    <summary aria-label="How this value was computed">?</summary>
    <dl className="loom-provenance-tree">
      <div><dt>Rule</dt><dd><code>{orderById.data.total.lineage.snapshotId}</code></dd></div>
      <div><dt>Value</dt><dd>{String(orderById.data.total.lineage.computedValue)}</dd></div>
      {orderById.data.total.lineage.inputs.map((inp) => (
        <div key={inp.path}><dt>{inp.path}</dt><dd>{String(inp.value)}</dd></div>
      ))}
    </dl>
  </details>
) : null}
```

The disclosure is null-guarded: a field that has never been written has a
null lineage and the "?" simply doesn't render — the value still shows.

**HEEx is the exception to "read the wire".** Phoenix LiveView renders
server-side straight from the Ecto struct, where the pair is still SPLIT — so
there is no carrier to step into.  Both halves read the columns directly: the
walker drops the page body's `.value` hop (`@data.total`, see `renderMember`
in `heex-walker-core.ts`), and the disclosure reads the co-located
`<field>_provenance` jsonb column, which loads as a **string-keyed** map:

```heex
<%= if @data.total_provenance do %>
  <details class="loom-provenance" data-testid="orders-detail-total-prov">
    <summary aria-label="How this value was computed">?</summary>
    <dl class="loom-provenance-tree">
      <div><dt>Rule</dt><dd><code><%= @data.total_provenance["snapshot_id"] %></code></dd></div>
      <div><dt>Value</dt><dd><%= @data.total_provenance["computed_value"] %></dd></div>
      <%= for inp <- @data.total_provenance["inputs"] || [] do %>
        <div><dt><%= inp["path"] %></dt><dd><%= inp["value"] %></dd></div>
      <% end %>
    </dl>
  </details>
<% end %>
```

Note the snake_case keys (`snapshot_id`, `computed_value`) — the shape the
backend *stores*, not the frontends' camelCase JSON wire.

## Other backends

The React **runtime** doesn't *capture* lineage (a frontend runs no domain
logic) — it *consumes* the lineage the backend already recorded, as the
disclosure above.  The snapshot capture still produces a file for the
system as a whole; surfaces that don't implement the runtime half
ignore it.

This is intentional: provenance is opt-in at the deployable level
without being opt-in at the language level — you can declare a
`provenanced` field once and only a runtime-capable deployable
(node/dotnet/java/python/elixir) will exercise it, while the
others ignore the runtime half.

## Cross-references

- [`language.md`](language.md) — the `provenanced` property modifier
  in the property grammar.
- [`tools.md`](tools.md) — the `ddd snapshot` CLI sub-command,
  including `--dry-run`.
- `examples/provenance.ddd` — a single-deployable runnable example.
- `web/src/examples/provenance-system.ddd` — the same domain as a
  multi-deployable Hono + React system, runnable in the playground.
