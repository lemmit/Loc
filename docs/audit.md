# Command audit & entity history

Loom's audit facility has two halves: a **write** side that records every
successful public command as an append-only row, and a **read** side that
exposes those rows as an entity's change history.

- Write side — `aggregate X audited { … }` / `operation f() audited`. Ships on
  all five backends.
- Read side — `GET /<aggregates>/{id}/history`. **Under construction on this
  branch** (see the checklist at the bottom).

---

## 1. Declaring audit

```ddd
aggregate Order audited {
  reference: string
  quantity: int
  create(reference: string, quantity: int) { … }
  operation cancel(reason: int) { … }
  private operation recalc() { … }      // NOT audited — `private` is the opt-out
  destroy { }
}
```

`audited` on the aggregate header marks **every public command action** —
`create`, `operation`, `destroy`. A `private operation` is never audited; that
is the opt-out for an internal or high-churn command (there is no negation
keyword). The per-command form marks exactly one action:

```ddd
operation dispatch() audited { dispatched := true }
```

Both forms resolve to the same per-command flag during lowering, so every
backend gate reads one thing.

## 2. What a row records

One row per **successful** command, written inside the *same transaction* as
the aggregate save — the row and the state change commit or roll back
together. The table (`audit_records`, one per module, derived from
`auditTableShape` in `src/system/migrations-builder.ts`) carries:

| Column | Meaning |
|---|---|
| `audit_id` | PK |
| `operation_id` | Stable id of the command that ran |
| `action` | The command's name |
| `target_type` / `target_id` | The aggregate and row it changed |
| `actor` | The principal, as JSON |
| `before` / `after` | Full wire-DTO snapshots (`repoTx.toWire`), nullable |
| `at` | When |
| `status` | Always `"ok"` — see below |
| `correlation_id` / `scope_id` / `parent_id` | Execution-context linkage |

Indexed on `(target_type, target_id)` — the per-entity history read — and on
`correlation_id`, for tracing one command across aggregates.

### How the snapshots are stored — one rule, all five backends

`before` / `after` are **`jsonb`** everywhere. There is no per-backend DDL: the
column comes from the single shared `auditTableShape` above (`{ kind: "json" }`),
rendered once by `sql-pg.ts`.

Every backend binds them as a **JSON object**, never as a serialized string. A
porter indexes the snapshot directly; nobody parses.

| Backend | CLR / runtime binding |
|---|---|
| node (drizzle, MikroORM) | `jsonb` column → plain object |
| .NET (EF, Dapper) | `System.Text.Json.Nodes.JsonNode?` |
| Python (SQLAlchemy) | `Mapped[object \| None]` (`JSONB`) |
| Java (Hibernate) | `@JdbcTypeCode(SqlTypes.JSON) Object` (a `Map`) |
| Elixir (Ecto) | `:map` |

Two consequences worth stating outright:

- **Both sides are genuinely nullable** — a `create` has no `before`, a
  `destroy` has no `after` — and that absence is a real SQL `NULL`, never the
  string `"null"`.
- **Snapshots are not comparable byte-for-byte across backends.** Reading back
  from `jsonb` yields Postgres-normalized values: keys sorted, whitespace
  stripped, duplicate keys collapsed. The cross-backend contract is the
  **derived `changes` output** (§3), pinned by
  `test/behavioral/wire-golden/audit-history.json` — never the stored bytes.

### Only successful commands are recorded

`status` is hardcoded `"ok"` and the insert rides the command's transaction. A
command that throws, trips a `precondition`, or is denied by a `requires` gate
**writes no row** — its transaction rolls back, taking any audit insert with
it.

So this facility answers **"what changed"**, not **"who tried"**. If you need
denied-attempt forensics, that is a different record with a different trigger
point (the authorization decision, not the command boundary) and a different
volume profile; it is not what `audited` gives you. Read the trail as a
complete history of *changes*, and never as a complete history of *access*.

---

## 3. Reading history

An `audited` aggregate automatically serves its own change history:

```
GET /<aggregates>/{id}/history  →  AuditEntry[]
```

Nothing is declared for it. Enrichment derives a `find history(id)` onto the
aggregate's repository — the auto-`findAll` analog, in the same pure pass — and
the backend serves it from `audit_records`.

> **Backend support — all five.** The read endpoint ships on Hono/node,
> FastAPI/python, Spring Boot/java, .NET and Phoenix/elixir, alongside the
> write side. `test/fixtures/corpus/audit-history.ddd` is declared for every
> backend, and each one's behavioral leg diffs its booted responses against
> `test/behavioral/wire-golden/audit-history.json` — minted from node, the
> oracle. A≡golden ∧ B≡golden ⇒ A≡B, so that is a real cross-backend
> equality proof rather than five self-assertions.
### The entry shape

```jsonc
[
  {
    "auditId": "…",
    "at": "2026-08-03T05:19:50.554Z",
    "action": "cancel",
    "operationId": "cancelOrder",
    "actor": { "…": "the principal, as recorded at command time" },
    "correlationId": "…",
    "changes": [
      { "field": "status", "before": 0, "after": 7 }
    ]
  }
]
```

Entries are ordered oldest-first — a timeline reads forwards, and `at` plus the
`(target_type, target_id)` index make it the natural scan order.

### `changes` is derived, not stored

The diff is computed **at read time** by comparing the entry's two snapshots.
Nothing about it is persisted: a stored diff is a cache with no invalidation
story, and the snapshots already contain everything it says.

A field appears in `changes` only if it actually moved. In the example above,
`cancel` also re-saved `reference` and `quantity` unchanged, and neither is
listed — a field that did not move is not a change. A `create` has no `before`,
so every field reads `null → value`; a `destroy` has no `after`.

**Managed and token fields are excluded.** `after` is captured *post-save*, so a
lifecycle stamp (`auditable`'s `updatedAt` / `updatedBy`) and the `versioned`
counter differ on every single entry. Left in, they would be most of the
timeline and would bury the change the reader came for. The surviving set is
exactly what a caller can influence — which is what "what changed" means. Also
excluded, and for a stronger reason: `internal` and `secret` fields, which the
snapshot holds but no API read may disclose.

### Authorization

The snapshots are written server-side **inside the command's transaction**,
where there is no caller to mask against. They therefore hold **raw, unmasked**
values for every field. History is a read surface over already-collected
unmasked data, so each guard the entity read has is re-established on it
explicitly:

| Guard | How history gets it |
|---|---|
| **Read gate** | The synthesized find copies the aggregate's list read (`find all`) `requires` gate. Fails → `403`, before any query runs. Under `enforcement: denyByDefault`, an audited aggregate with an ungated list read is a compile error (`loom.audit-history-ungated`) — declare the gate on `find all` and history inherits it. |
| **Capability filters** (`tenantOwned`, and any `filter` capability) | `audit_records` is machinery: it carries `target_type`/`target_id` and **no tenant column**, so there is nothing on it for a query-filter to scope. Scoping rides the **entity** instead — the handler resolves the row through `findById`, which already carries every capability predicate. A row the caller cannot read yields `404`, the same answer the entity read gives, so history discloses nothing about another tenant's rows, not even their existence. The find's `ignoring` stance is copied from the list read too, so widening one widens both. |
| **`mask unless`** | The same predicate composes into every entry. |

#### A masked field's change is dropped, not redacted

When the caller fails a field's `mask unless` predicate, that field's
`FieldChange` is **omitted from `changes` entirely** — not emitted with a
redacted value.

A redacted-but-present entry would still disclose *that* the field changed,
*when*, and *by whom*. "The admin changed `salary` on the 3rd" is itself the
leak; the number is only part of it. Masking is fail-closed: an unauthenticated
caller has a null principal, so every masked field's entries drop.

#### Why the raw snapshots are not exposed

`AuditEntry` carries the derived `changes` list and not the `before`/`after`
blobs. Publishing them whole would need a recursive redaction pass over
arbitrary JSON with no schema to guarantee it reached every masked key. The
field-keyed diff is a typed projection where the masking rule is exact and
checkable. Point-in-time state reconstruction ("time travel") is a separate
feature and would need its own authorization story.

### What history does *not* answer

Only **successful** commands are recorded (§2). A denied, failed, or
precondition-tripped command leaves no row. Read a timeline as a complete
history of *changes*, never as a complete history of *access* or of *attempts*.
