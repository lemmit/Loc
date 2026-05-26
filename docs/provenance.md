# Provenance — the `provenanced` field modifier

`provenanced` is a stored-field modifier that captures the **lineage**
of every value the field has ever held.  For each distinct assignment
site to a `provenanced` field, the compiler captures the right-hand
side expression as an immutable **rule snapshot**.  The generated
backend records a runtime trace on every write so a value can later
be explained: "this 128.40 came from `reprice(qty=8, price=16)` via
rule `<snapshotId>`".

Today provenance is a **Hono-only** runtime feature.  Other backends
parse the keyword but emit no trace code — only the snapshot capture
runs across all backends.

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

- `domain/provenance.ts` — a small runtime SDK with `recordTrace(...)`
  for writing trace records and a snapshot loader that reads the
  latest `.loom/snapshots/*.loomsnap.json` at startup.
- A `recordTrace(...)` call placed after each `provenanced`
  assignment in the relevant operation.  The call records the active
  `snapshotId`, the operation, and the input values.

A trace record carries enough to answer "why is `order.total` equal
to N?": the snapshot it came from (and therefore the formula), and
the inputs that fed it.

## Other backends

`.NET`, `phoenixLiveView`, and `react` parse `provenanced` and treat
it as a no-op at runtime.  The snapshot capture still produces a file
for the system as a whole; backends that don't implement the runtime
half ignore it.

This is intentional: provenance is opt-in at the deployable level
without being opt-in at the language level — you can declare a
`provenanced` field once and only the Hono deployable will exercise
it, until a runtime is wired up for the others.

## Cross-references

- [`language.md`](language.md) — the `provenanced` property modifier
  in the property grammar.
- [`tools.md`](tools.md) — the `ddd snapshot` CLI sub-command,
  including `--dry-run`.
- `examples/provenance.ddd` — a single-deployable runnable example.
- `web/src/examples/provenance-system.ddd` — the same domain as a
  multi-deployable Hono + React system, runnable in the playground.
