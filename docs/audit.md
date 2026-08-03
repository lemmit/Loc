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

*(This section lands with the read-path slices on this branch.)*

## Status on this branch

- [ ] Slice 1 — `AuditEntry` wire shape, derived `find history(id)`, `GET /<agg>/{id}/history` on Hono, wire golden
- [ ] Slice 2 — authorization: mask composition, inherited read gate, tenancy filters
- [ ] Slice 3 — .NET, Java, Python, Elixir against the golden
- [ ] Slice 4 — `Timeline` walker primitive + scaffolded History tab
