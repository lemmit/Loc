# Provenance — the `provenanced` field modifier

`provenanced` is a stored-field modifier that captures the **lineage**
of every value the field has ever held.  For each distinct assignment
site to a `provenanced` field, the compiler captures the right-hand
side expression as an immutable **rule snapshot**.  The generated
backend records a runtime trace on every write so a value can later
be explained: "this 128.40 came from `reprice(qty=8, price=16)` via
rule `<snapshotId>`".

Provenance has a runtime on the **Hono (`node`)** and **.NET (`dotnet`)**
backends — both emit the co-located lineage column, per-write trace
capture, and the transactional `provenance_records` flush.  The
remaining backends (`phoenixLiveView`, `react`) parse the keyword but
emit no trace code; only the snapshot capture runs across all backends.

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
- The current lineage is exposed on the wire as a trailing
  `<Field>Provenance` field on the aggregate's `<Agg>Response` DTO.

The `provenance_records` table + the co-located columns ship as one
extra EF migration (`Migrations/<late>_ProvenanceAudit.cs`) that sorts
after every module's initial migration.

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

## Other backends

`phoenixLiveView` and `react` parse `provenanced` and treat it as a
no-op at runtime.  The snapshot capture still produces a file for the
system as a whole; backends that don't implement the runtime half
ignore it.

This is intentional: provenance is opt-in at the deployable level
without being opt-in at the language level — you can declare a
`provenanced` field once and only a node/dotnet deployable will exercise
it, until a runtime is wired up for the others.

## Cross-references

- [`language.md`](language.md) — the `provenanced` property modifier
  in the property grammar.
- [`tools.md`](tools.md) — the `ddd snapshot` CLI sub-command,
  including `--dry-run`.
- `examples/provenance.ddd` — a single-deployable runnable example.
- `web/src/examples/provenance-system.ddd` — the same domain as a
  multi-deployable Hono + React system, runnable in the playground.
