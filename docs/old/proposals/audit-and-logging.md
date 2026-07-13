# Audit & logging markers — `audited`, `logged`

> Status: PARTIAL. Builds on the
> [execution-context backbone](./execution-context.md).

> **[2026-07-03 status audit]** `audited` (boolean) is a real modifier on
> operations **and** lifecycle create/destroy, emitting on **all five
> backends** — `AUDIT_OP_BACKENDS`/`AUDIT_LIFECYCLE_BACKENDS = {node,
> dotnet, java, python, elixir}` in `system-checks.ts`, per-backend
> `emit/audit.ts`, with who/what/when + before/after snapshots. The
> earlier "Hono + .NET only" note was stale. **The real remaining slice is
> the argument form `audited(actions | access | events | off)`** — a
> grammar+IR change on the three `(audited?='audited')?` productions
> (`ddd.langium:1496/1509/1520`), the prerequisite for the access-audit
> mode. `logged` also remains a proposal.

## Problem

Teams need an explicit, compiler-supported way to say *"this matters for
audit"* — distinct from ordinary diagnostics logging and distinct from
[value provenance](./provenance.md). Today this is ad-hoc logging. The
goal is a small, non-overlapping set of markers that produce
**audit-grade** (append-only, immutable, queryable, retained) records
where declared, and plain structured logs elsewhere.

## The marker taxonomy

Three markers, deliberately non-overlapping (a longer list —
`commandLogged`, `eventLogged`, `viewAccessLogged`, … — was considered
and folded down):

| Marker | Means | Produces |
|---|---|---|
| `provenanced` | "explain where this value came from" | lineage graph (see [provenance.md](./provenance.md)) |
| `audited` | "record this action/access with formal guarantees" | append-only audit record |
| `logged` | "emit a technical log line here" | ordinary structured log |

`audited` subsumes what would otherwise be separate command/event/view
markers — they become *parameters* of `audited`, not new keywords.

## Surface

Loom's idiom for a declaration modifier is a leading bare keyword
(`private operation`, `transactional`). So `audited` / `logged` are
**prefix modifiers**, and — like `transactional(serializable)` — they
take an optional parenthesised option list:

```ddd
context Admissions {

  // Aggregate-level: audit propagates to this aggregate's commands and
  // views unless a member overrides it.
  audited aggregate Patient {
    id: Patient id
    firstName: string
    lastName: string

    audited(actions) operation admit(firstName: string, lastName: string) { … }
    audited(actions) operation discharge(reason: string) { … }
  }

  // A view that returns sensitive columns marks the read as PII-bearing
  // (see sensitivity-and-compliance.md). `containsPii` lets the read
  // audit flag the access without storing the values.
  audited(access, containsPii) view PatientMedicalDetails = Patient
    where id == currentUser.patientId

  // Opt a specific view out of inherited auditing.
  audited(off) view DailyAdmissionsCount { … }

  // Purely technical — not an audit record.
  logged(debug) operation recalculateRiskScore() { … }
}
```

### Option vocabulary

| On | Option | Meaning |
|---|---|---|
| `audited(...)` | `actions` | record command/operation executions (the intent) |
| | `access` | record reads/queries (intent + count, not values) |
| | `events` | also emit a dedicated domain event to the event store |
| | `containsPii` | tag emitted records as PII-bearing |
| | `off` | opt this member out of inherited aggregate-level auditing |
| `logged(...)` | `debug` / `info` / `error` | log level |

> Module-wide "audit every command" is **config, not a marker** — a
> framework rule, kept out of the DSL so `audited` stays a precise,
> per-declaration statement of intent.

## Audit record shape

Every `audited` record carries (drawing on the
[context backbone](./execution-context.md) for the ids):

`eventId`, `timestamp`(+tz), `actorId`, `actorType`/`authContext`,
`operationId`, `scopeId`, `parentId`, `correlationId`,
`targetType`+`targetId`, `action`, `status`/`resultCode`,
`beforeSnapshot`/`afterSnapshot` (or hashes), `tenantId`, `requestId`/`traceId`,
`version`.

A **strict tier** adds: per-entry hash / hash-chain, system signature,
monotonic sequence number, reason/justification, **policy decision id**,
and **approval id**. (The last two reference the authorization engine —
see [`policies-supplementary-note.md`](./policies-supplementary-note.md).)

## Lowering & generation

- **Aggregate-level `audited` propagates** to its commands and views in
  the IR (a view `= Patient` inherits `RequiresQueryAudit` from
  `Patient.audited`), with member-level `audited(off)` / overrides
  winning.
- **Action audit** (`audited(actions)`) wraps the command handler:
  record actor + target + before/after at the operation boundary.
- **Access audit** (`audited(access)`) sits in the query pipeline —
  on .NET, a Mediator pipeline behaviour
  (`QueryAuditBehavior<TRequest,TResponse>`) writes a `ViewAuditLog`
  capturing the **intent** (query type, serialised params,
  `ReturnedRecordsCount`, `ContainsPii`) — *never the returned values*.
- **Write-side field change audit** flows from **domain events**, not a
  parallel CRUD-diff system: an `audited(events)` aggregate emits
  change events (e.g. `PatientPersonalDataChanged { changedFields,
  changedAt, changedBy, pii }`) and the event store *is* the change
  log. See [sensitivity-and-compliance.md](./sensitivity-and-compliance.md).
- **`logged`** lowers to the platform's structured logger at the named
  level, scoped to the current context frame.

## Open questions

- Whether `events` stays an `audited` option or `eventLogged` returns
  as a first-class marker.
- Final naming for sub-grain (`audited(actions)` vs dotted
  `audited/actions`).
- Where the "audit all commands in module X" config lives (settings
  file vs system-level block).
