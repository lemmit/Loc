# TODO (later) — Audited lifecycle actions (`audited create` / `audited destroy`)

**Status:** deferred / design-first · **Opened:** 2026-06-21 · supersedes the
"lifecycle" half of DEBT-16 and Workstream W3(b)
([`backend-parity-plan.md`](./backend-parity-plan.md)).

## TL;DR

**Should `create` / `destroy` be auditable? Yes — and it's higher-value than the
per-operation `audited` we're landing now.** Creation and deletion are the
highest-stakes events in any compliance/forensics story ("who created this
account?", "who deleted this record, and when?" — SOX, HIPAA, GDPR
right-to-erasure proof). An audit trail that captures arbitrary `operation`s but
**not** the lifecycle is missing exactly where auditors look first.

It is **deferred**, not dismissed, because — unlike the per-op `audited` parity
ports — it is **not expressible today** and so is a *grammar-first feature*, not
a codegen gap-fill.

## Why it's blocked today (the vaporware finding)

1. **No grammar surface.** `ddd.langium` `Operation` (≈:1385) carries
   `(audited?='audited')?`; `Create` (≈:1397) and `Destroy` (≈:1408) do **not**.
   You cannot type `audited create(...)`.
2. **Lowering hardcodes it off.** `lowerCreate` / `lowerDestroy`
   (`src/ir/lower/lower-members.ts` ≈:247/:263) set `audited: false`
   unconditionally ("no grammar slot").
3. **The gate is aspirational.** `AUDIT_LIFECYCLE_BACKENDS = new Set(["node"])`
   (`src/ir/validate/checks/system-checks.ts` ≈:1883) gates a flag nothing can
   set — and node's instrumentation iterates only `agg.operations`, so **no
   backend, node included, emits a lifecycle audit row.** The gate advertises a
   capability that ships nowhere.

> **Cheap honesty fix, do independently of the full feature:** either empty
> `AUDIT_LIFECYCLE_BACKENDS` or comment it as aspirational, so validation stops
> claiming lifecycle-audit support. (~10 min; removes a live lie in the gate.)

## The two examples (what we want)

`.ddd` — currently a **parse error** (no `audited` slot on lifecycle actions):

```
aggregate Invoice in Billing {
  total: money
  audited create(total: money) { this.total := total }
  audited destroy { }
}
```

Generated (target shape — reuse the existing `audit_records` sink from per-op
`audited`, adapting the before/after pair to the lifecycle asymmetry):

```ts
// create handler, inside the same tx as the insert
const created = await repoTx.insert(row);
await tx.insert(schema.auditRecords).values({
  operationId: "create", action: "create",
  targetType: "Invoice", targetId: created.id,
  actor: currentUser, before: null, after: repoTx.toWire(created), // ← before is null
  at: now, status: "ok", ...reqCtx,
});

// destroy handler — snapshot BEFORE the delete, audit row is the last trace
const before = repoTx.toWire(existing);
await tx.insert(schema.auditRecords).values({
  operationId: "destroy", action: "destroy",
  targetType: "Invoice", targetId: existing.id,
  actor: currentUser, before, after: null,           // ← after is null (hard delete)
  at: now, status: "ok", ...reqCtx,
});
await repoTx.delete(existing.id);
```

## Why it isn't just "copy the per-op path" — the real design questions

1. **before/after asymmetry.** The per-op emitter assumes both a `before` and an
   `after` wire snapshot. **Create has no `before`** (`before: null`, `after =`
   created wire); **destroy has no `after`** (`before =` last wire, `after: null`).
2. **Insert ordering.** Create's audit row needs the **generated id**, so it must
   be staged *after* the insert. Destroy must snapshot *before* the delete. The
   `audit_records` table is polymorphic (`target_type`/`target_id`, **no FK** to
   the aggregate) — good, because a hard delete must not orphan/abort the audit
   row.
3. **Soft-delete is a fork.** On a `with softDelete` aggregate, `destroy` flips
   `isDeleted` rather than removing the row — so there *is* an "after". Decide:
   does `audited destroy` then record `after =` the tombstoned row (it's really an
   update), or normalise to `after: null` for a uniform "destroyed" semantic?
   **Recommend:** record the real tombstone `after` (it's the truthful state) and
   keep `action: "destroy"` to distinguish intent.
4. **Event-sourced aggregates.** When `persistedAs(eventLog)`, destroy is a
   tombstone event already in the stream. Decide whether the audit row is
   redundant (skip) or still wanted for the actor/correlation envelope
   (**recommend keep** — the event log records *what*, the audit row records
   *who/why/when* with the governance stamps).
5. **Surface choice.** Keep the **explicit per-action flag** (`audited create` /
   `audited destroy`) for consistency with `operation … audited` and granularity.
   Note that `with audit` is a *separate* mechanism (`contextStamps` — `created_by`
   / `updated_by` columns *on the row*), not the append-only trail; don't conflate
   them. A context-level `audit lifecycle` default (auto-audit every create/destroy
   when the context opts into audit at all) is an ergonomics option to weigh at
   design time — most teams who want any audit want lifecycle covered.

## Scope when picked up (grammar-first; walks ① ④ ⑤ ⑦ ⑧ ⑨)

1. **① Grammar** — add `(audited?='audited')?` to `Create` and `Destroy` in
   `ddd.langium`; `npm run langium:generate`; commit regenerated AST.
2. **print** — emit the `audited` keyword in `print-structural.ts` for
   create/destroy (`print-completeness.test.ts` will fail until added).
3. **⑤ Lower** — stop hardcoding; read the parsed flag in `lowerCreate` /
   `lowerDestroy`.
4. **⑦ Validate** — repurpose `AUDIT_LIFECYCLE_BACKENDS`; **start it empty** and
   grow it per backend as each real emitter lands (the `#1442→#1447/#1449`
   narrowing pattern). Emit `loom.audited-backend-unsupported` for the rest.
5. **⑧ Emit — node FIRST** (the reference), then .NET, then Java/Python (which
   gain the `audit_records` sink from W3). Reuse the per-op audit emission;
   the only new logic is the before/after asymmetry + insert ordering above.
6. **⑨ Migrations** — extend the "context has audit" predicate that gates the
   `audit_records` DDL so the table emits when **only** lifecycle actions are
   audited (today it keys off audited *operations*).
7. **Tests** — 1 parsing (`audited create` parses), 1 negative validator
   (unsupported backend → `loom.audited-backend-unsupported`), 1 generator test
   per backend (create→before:null, destroy→after:null), a `LOOM_*_BUILD`
   fixture, and `docs/audit-and-logging.md`.

## Sequencing

Land **after W3** (per-op `audited` on Java/Python) so the lifecycle emitter
reuses the `audit_records` sink on all five backends instead of building it
twice. Effort: **M** for grammar + lowering + the node reference emitter, then
**S** per backend to port.
