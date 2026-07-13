# Domain-seam structured-log parity audit

> **(Superseded 2026: the Ash foundation was removed — `platform: elixir` is plain Ecto/Phoenix only, `foundation: ash` is now a validation error. The `ash` foundation entries below, and the foundation split, are historical; on current `main` only the `vanilla` Phoenix surface emits.)**

**Snapshot:** 2026-06-22, fresh `main` @ `ea6fa41e`.
**Scope:** the DOMAIN-SEAM tier of the neutral log-event catalog
(`src/generator/_obs/log-events.ts`) across the five domain-logic backends —
Hono/TS (`node`), .NET (`dotnet`), Phoenix/Elixir (`elixir`, foundations
`ash` + `vanilla`), Python/FastAPI (`python`), Java/Spring (`java`).
Infrastructure events (`request_*`, `server_*`, `db_*`, `migration*`, `health_*`,
`auth_*`) and the `--trace`-gated seam/domain events (`tx_*`, `wire_*`,
`child_synced`, `invariant_evaluated`, `precondition_evaluated`,
`value_computed`) are out of scope.

> **The code wins.** Every cell below is re-derived from the cited `file:line`
> on this commit. Where this prose and a cited line ever disagree, the line is
> authoritative; flip the cell.

This is an AUDIT + PROPOSAL. No emitter source was changed. The gap-list in §3
is the hand-off package for `language-feature-developer`.

---

## 0. What "domain-seam" means here, and the in-flight caveat

The catalog tiers events by *concept* (`docs/old/proposals/observability.md`). The
**domain-seam** subset is the 18 events that fire from the generated domain /
application / repository layers — the business narrative, the client/domain
faults, the system faults, and the mechanism-debug lines. These are the lines a
log consumer (`jq`, dashboard, alert) pivots on to reconstruct what the system
*did*, and the contract promise is that one schema surfaces identically on every
backend.

Three of the five backends emit through a shared call-site renderer
(`renderHonoLogCall` / `renderDotnetLogCall` / `renderPhoenixLogCall` in
`src/generator/_obs/`). Python emits via a runtime `log(level, event, **fields)`
facade (`src/generator/python/emit/obs.ts`), call sites written as string
literals in the generator. Java emits via `CatalogLog.event(...)`
(`src/generator/java/emit/observability.ts`) for infra, but its **domain** lines
on current `main` go out as plain slf4j `log.info/warn(...)` — *off the catalog
JSON channel entirely*.

**In-flight: PR #1508** (`feat(obs/java): unify Java logging onto one
catalog-JSON channel`, open/draft, stacked on
`claude/generated-apps-telemetry-b23erg`) reroutes Java's slf4j domain
emissions onto `CatalogLog`. Its net effect on this matrix: `aggregate_created`,
`internal_error`, `event_unrouted` move onto the JSON channel (already emitted,
just wrong channel today), and the generic `domain_event` line becomes a real
catalog **`event_dispatched`**. It does **not** add `operation_invoked`, the
client-fault quartet, the repository-debug trio, or audit/provenance. Java's
post-#1508 domain-seam coverage is therefore ~4 events, all the rest still gaps.
Below, Java cells are scored **on current `main`** with a `[#1508]` note where
the PR changes the picture.

A second emission-idiom subtlety the audit surfaced: **`event_dead_lettered` is
emitted via the raw module logger, not the catalog renderer** — Hono uses
`baseLogger.warn({ event: "event_dead_lettered", … })`
(`src/platform/hono/v4/workflow-builder.ts:904`) and .NET uses
`_log.LogWarning("{Event} …", "event_dead_lettered", …)`
(`src/generator/dotnet/emit/outbox.ts:222`). A `renderXLogCall`-only grep misses
these; they are genuine emissions and are scored ✓.

---

## 1. The who-emits-what matrix

Legend: **✓** emitted · **✗** silent gap (seam exists, backend produces no line) ·
**N/A** structurally absent (no such seam on this backend) · **[#1508]** changes
under the in-flight Java PR.

| # | Catalog event (key → `event`) | Hono | .NET | Phoenix | Python | Java | Seam (where it fires) |
|---|---|:--:|:--:|:--:|:--:|:--:|---|
| **info — business narrative** |
| 1 | `operationInvoked` → `operation_invoked` | ✓ | ✓ | ✗ | ✗ | ✗ | per-operation route/handler entry |
| 2 | `aggregateCreated` → `aggregate_created` | ✓ | ✓ | ✓ (ash) | ✗ | ✓ | create route/controller after persist |
| 3 | `eventDispatched` → `event_dispatched` | ✓ | ✓ | ✗ | ✗ | ✗ `[#1508]→✓` | repository save / event publish |
| 4 | `workflowStarted` → `workflow_started` | ✗ | ✗ | ✓ (ash) | ✗ | ✗ | workflow `run` entry |
| 5 | `workflowCompleted` → `workflow_completed` | ✗ | ✗ | ✓ (ash) | ✗ | ✗ | workflow success path |
| 6 | `eventUnrouted` → `event_unrouted` | ✓ | ✓ | ✓ (both) | ✓ | ✓ | `on(...)` reactor, no instance for key |
| 7 | `eventDeadLettered` → `event_dead_lettered` | ✓ | ✓ | N/A | ✓ | N/A | outbox relay exhausted retries |
| **warn — client/domain fault** |
| 8 | `domainError` → `domain_error` | ✓ | ✗ | ✗ | ✓ | ✗ | error-mapping middleware (4xx domain) |
| 9 | `forbidden` → `forbidden` | ✓ | ✗ | ✗ | ✓ | ✗ | authz reject (403) |
| 10 | `disallowed` → `disallowed` | ✓ | ✗ | ✗ | ✓ | ✗ | `when`/canCommand gate reject (409) |
| 11 | `notFound` → `not_found` | ✓ | ✗ | ✗ | ✓ | ✗ | load-miss (404) |
| **error — system fault** |
| 12 | `externHandlerThrew` → `extern_handler_threw` | ✓ | ✓ | ✗ | ✓ | ✗ | extern handler raised |
| 13 | `internalError` → `internal_error` | ✓ | ✓ | ✗ | ✗ | ✓ | catch-all 500 handler |
| **debug — mechanism** |
| 14 | `aggregateLoaded` → `aggregate_loaded` | ✓ | ✓ | ✗ | ✗ | ✗ | repository `getById` |
| 15 | `repositorySave` → `repository_save` | ✓ | ✓ | ✗ | ✗ | ✗ | repository `save` |
| 16 | `findExecuted` → `find_executed` | ✓ | ✓ | ✗ | ✗ | ✗ | repository find/query |
| 17 | `auditRecorded` → `audit_recorded` | ✗ | ✗ | ✗ | ✗ | ✗ | audit-row insert (see §2) |
| 18 | `provenanceRecorded` → `provenance_recorded` | ✗ | ✗ | ✗ | ✗ | ✗ | provenance flush (see §2) |
| | **DOMAIN-SEAM COUNT (current main)** | **13** | **9** | **4** | **7** | **3** | |
| | **post-#1508 Java** | | | | | **~4** | |

### Per-cell citations (✓ cells)

**Hono** (13) — `src/platform/hono/v4/routes-builder.ts`: `operation_invoked`
:837, :1062; `aggregate_created` :466; `domain_error` :645; `forbidden` :633;
`disallowed` :639; `not_found` :650; `extern_handler_threw` :655;
`internal_error` :660. `event_dispatched` / `aggregate_loaded` /
`repository_save` / `find_executed` across
`src/generator/typescript/repository-{document,embedded,eventsourced}-builder.ts`
and `repository-{find,save}-builder.ts` (e.g. save-builder `repository_save`
:146, `event_dispatched` :156; find-builder `aggregate_loaded` :312/:323,
`find_executed` :370+). `event_unrouted`
`src/platform/hono/v4/workflow-builder.ts:1041,1142`. `event_dead_lettered`
`workflow-builder.ts:904` (raw `baseLogger`).

**.NET** (9) — `src/generator/dotnet/emit/api.ts`: `operation_invoked` :460
(`renderOperationActionBlock`), `aggregate_created` :293 (`renderController`),
`extern_handler_threw` :587, `internal_error` :599 (`renderExceptionFilter`).
`src/generator/dotnet/emit/repository.ts`: `aggregate_loaded` :290/:608/:778,
`repository_save` :334/:354/:639/:820, `find_executed` :182/:200/:236/:558/:725,
`event_dispatched` :364/:645/:826. `event_unrouted`
`src/generator/dotnet/workflow-emit.ts:404,433`. `event_dead_lettered`
`src/generator/dotnet/emit/outbox.ts:222` (raw `_log.LogWarning`).

**Phoenix** (4, all ash except where noted) —
`aggregate_created` `src/generator/elixir/api-emit.ts:835`
(`renderAggregateController`); `workflow_started`
`src/generator/elixir/workflow-emit.ts:102`; `workflow_completed`
`workflow-emit.ts:564,591`; `event_unrouted` — ash
`src/generator/elixir/dispatch-emit.ts:446`, vanilla
`src/generator/elixir/vanilla/workflow-eventsourced-emit.ts:416`.

**Python** (7) — `src/generator/python/index.ts`: `extern_handler_threw` :833,
`forbidden` :838, `disallowed` :843, `domain_error` :848, `not_found` :853 (the
`_extern`/`_forbidden`/`_disallowed`/`_domain`/`_not_found` exception handlers).
`src/generator/python/dispatch-builder.ts`: `event_unrouted` :350,:439;
`event_dead_lettered` :570 (`outboxBlock`).

**Java** (3, current main, plain slf4j) —
`src/generator/java/emit/api.ts`: `aggregate_created` :244
(`renderJavaController`), `internal_error` :373 (`renderApiExceptionAdvice`).
`src/generator/java/emit/dispatch.ts`: `event_unrouted` :274,:360. Infra
events go via `CatalogLog` (`emit/observability.ts`) but domain lines do not yet;
the generic `domain_event` slf4j line (service.ts:388, event-store.ts:156,
workflow.ts:202) is **off-catalog** and becomes `event_dispatched` only under
`[#1508]`.

### Reading the matrix — the three failure shapes

- **Everyone-blank rows (17, 18).** `audit_recorded` / `provenance_recorded` are
  in the catalog and the underlying features ship, yet **no backend emits
  them.** This is not a per-backend gap; it's a catalog promise with zero
  producers. §2 dissects the seams.
- **Disagreement, not degradation.** The backends don't emit a *subset* of a
  common set — they emit *different* sets. Hono leads on the HTTP-edge faults
  (rows 8–11) and the repository-debug trio (14–16); Phoenix is the *only*
  backend emitting the workflow lifecycle (4, 5) but emits none of the
  faults or repo-debug; Python emits the fault quartet (8–11) but none of the
  repo-debug or info-narrative beyond `event_unrouted`/`event_dead_lettered`.
  A consumer cannot write one alert that works across backends.
- **`N/A` is legitimate for two cells.** `event_dead_lettered` (7) fires only
  from a durable **outbox relay**. Phoenix and Java have no outbox-relay seam on
  `main` (Phoenix dispatch is inline/transactional; Java has no relay loop —
  `rg outbox src/generator/java` finds only JPA-persistence column refs). So
  Phoenix/Java are N/A, not silent, for row 7. Every other blank is a true
  SILENT gap against an existing seam.

---

## 2. `audit_recorded` / `provenance_recorded` — the zero-producer events

Both features ship and persist correctly today; the *log line* announcing the
write is simply never emitted. The question for the baseline is whether lighting
them up is mechanical (logger + catalog fields both already in scope at the write
seam) or needs design.

### `audit_recorded` (fields: `action`, `target`, `actor`) — level `debug`

The audit row is inserted in the request/command scope on the four
history-table backends, with `action` (op name), `target` (aggregate/type+id),
and `actor` all in local scope — i.e. **mechanical**:

| Backend | Insert seam | In scope | Verdict |
|---|---|:--:|---|
| Hono | `src/platform/hono/v4/routes-builder.ts` ~:920–940, `emitNonReturningOperationRoute`, inside `db.transaction` | action/target/actor + reqCtx ids | **mechanical** |
| .NET | `src/generator/dotnet/cqrs/commands.ts` ~:293–310, `emitOperationCommandAndHandler`, `_audit.Stage(new AuditRecord(...))` | op.name/agg.name/id + `RequestContext.Current` | **mechanical** |
| Java | `src/generator/java/emit/service.ts` ~:255–268, `renderPublicOperationMethod`, `auditRecords.save(...)` inside `@Transactional` | op.name/agg.name/id + `RequestContext.*` | **mechanical** (but see channel caveat) |
| Python | `src/generator/python/repository-builder.ts` ~:854–885, `recordAuditMethod`, `self._session.add(AuditRecordRow(...))` | all audit fields as params + contextvars | **mechanical** |
| Phoenix (ash + vanilla) | NO history table — audit is **lifecycle stamps** (`created_by`/`updated_by` columns) put on the aggregate row itself (`src/generator/elixir/domain/actions.ts` `renderStampBlock`; vanilla `src/generator/elixir/vanilla/stamp-emit.ts`) | stamp values only | **DESIGN** |

> **Phoenix audit is a different shape.** It has no `audit_records` history
> table — `audited` lowers to column stamps on the row. There is no discrete
> "audit row inserted" seam to announce. Lighting up `audit_recorded` on Phoenix
> would either (a) re-interpret the stamp write as the seam (semantically
> different from the other four — one line per state change, not per audited
> op), or (b) require a new history table. Either is a **design decision**, not a
> mechanical emit. The honest interim is to scope `audit_recorded` to the
> history-table backends and document Phoenix's stamp model as the divergence.

### `provenance_recorded` (fields: `aggregate`, `field`, `snapshot_id`, `count`) — level `debug`

Provenance flushes a per-request lineage buffer into `provenance_records` inside
the save transaction. The `snapshot_id`, target aggregate/field, and the drained
**count** are all in scope at the flush — **mechanical** on every backend that
wires the flush:

| Backend | Flush seam | Verdict |
|---|---|---|
| Hono | `src/platform/hono/v4/routes-builder.ts` ~:945–959, loop over `aggregate.drainProv()` → `tx.insert(provenanceRecords)` | **mechanical** |
| .NET | `src/generator/dotnet/emit/repository.ts` ~:136–156, `DrainProv()` → `_db.ProvenanceRecords.Add` | **mechanical** |
| Java | `src/generator/java/emit/repository.ts` ~:598–611, `drainProv()` → `provenanceRecords.save` in `@Transactional` | **mechanical** |
| Python | `src/generator/python/repository-builder.ts` ~:745–769 (`saveMethod`), `drain()` → `session.execute(insert(ProvenanceRecord))` | **mechanical** |
| Phoenix **vanilla** | `src/generator/elixir/vanilla/provenance-emit.ts:184–205` `flush/1` (`repo.insert_all`), called from `context-emit.ts:249` | **mechanical** |
| Phoenix **ash** | NO flush wired — co-located `<field>_provenance` columns stamped, but no `provenance_records` history flush | **DESIGN / pre-existing feature gap** |

> The single `count` field is exactly what's cheapest to log: emit one
> `provenance_recorded` line per flush with `count = len(drained)` rather than
> one per lineage — matching the catalog's `count` field. Phoenix-ash's missing
> flush is a *pre-existing provenance feature gap*, not a logging gap; it should
> be tracked against the provenance feature, and `provenance_recorded` on ash
> rides on that being closed first.

---

## 3. Recommended REQUIRED BASELINE

The baseline is the *minimal set a backend MUST emit when it has the relevant
feature seam*. It is deliberately level-stratified — `info` lines are the
operator's first-line narrative and must be universal; `debug`/mechanism lines
carry less cross-backend value and several are genuinely backend-shaped.

### Tier B0 — MUST emit (every backend, every seam present)

These are the lines an operator needs to answer "what happened to this request
and did it succeed", and every backend has the seam in request scope. The
operator value is highest and the emit is mechanical everywhere.

| Event | Level | Rationale | Backends missing it today |
|---|---|---|---|
| `operation_invoked` | info | the per-op "something started" anchor; every fault line below correlates to it | Phoenix, Python, Java |
| `aggregate_created` | info | lifecycle birth; already emitted by 4/5 | Python |
| `event_dispatched` | info | the domain-event narrative; consumers of the event bus pivot on it | Phoenix, Python, Java(main) |
| `domain_error` | warn | the single most-queried line — "why did this request 4xx" | .NET, Phoenix, Java |
| `forbidden` | warn | authz audit trail; security-relevant | .NET, Phoenix, Java |
| `disallowed` | warn | state-guard reject; distinguishes 409 from 403 | .NET, Phoenix, Java |
| `not_found` | warn | the other half of "why did this request fail" | .NET, Phoenix, Java |
| `extern_handler_threw` | error | external-dependency failure; on-call signal | Phoenix, Java |
| `internal_error` | error | unhandled 500; the page-the-human line | Phoenix |

### Tier B1 — MUST emit when the feature is present

Feature-conditional, but where the feature ships the line must too.

| Event | Level | Condition | Backends missing it |
|---|---|---|---|
| `workflow_started` | info | project declares a workflow | Hono, .NET, Python, Java |
| `workflow_completed` | info | project declares a workflow | Hono, .NET, Python, Java |
| `event_unrouted` | warn | has `on(...)` reactors | — (all 5 emit) |
| `event_dead_lettered` | warn | has a durable outbox relay | — (all relay-bearing backends emit; Phoenix/Java N/A — no relay) |
| `audit_recorded` | debug | has an `audited` op **and a history table** | Hono, .NET, Java, Python (Phoenix = design, excluded) |
| `provenance_recorded` | debug | has a `provenanced` field **and a flush seam** | Hono, .NET, Java, Python, Phoenix-vanilla (Phoenix-ash blocked on flush) |

### Tier B2 — SHOULD emit (mechanism/debug; nice-to-have, lower priority)

The repository-debug trio is genuinely useful for live diagnosis but is the
weakest cross-backend contract (Phoenix's Ash/Ecto data layer has no single
"repository" seam that maps cleanly; emitting these is more invasive there).
Recommend SHOULD, not MUST, and only chase Hono/.NET parity here (already done)
plus Python/Java where the repo seam is explicit.

| Event | Level | Note |
|---|---|---|
| `aggregate_loaded` | debug | Hono+.NET emit; Python/Java have explicit repo `getById` seams; Phoenix data-layer-shaped |
| `repository_save` | debug | same |
| `find_executed` | debug | same |

### Baseline rationale, by operator level

- **`error` (B0: internal_error, extern_handler_threw)** — these are the lines
  that page a human. A backend silent here means a 500 storm is invisible in the
  log stream. Highest priority; Phoenix is the glaring hole (emits *neither*).
- **`warn` (B0: domain_error/forbidden/disallowed/not_found)** — the "why did
  this request fail" quartet, and the security audit trail (`forbidden`). .NET
  and Phoenix and Java are all silent on the full quartet; Python and Hono are
  the reference. This is the biggest single parity gap by row-count.
- **`info` (B0: operation_invoked/aggregate_created/event_dispatched; B1:
  workflow_*)** — the business narrative. Without `operation_invoked` (silent on
  3/5) a consumer can't anchor the fault lines to an operation.
- **`debug` (B1: audit/provenance; B2: repo trio)** — mechanism. Audit and
  provenance are compliance-adjacent (someone *will* want "prove this field was
  computed from these inputs at this time"), so they're B1-when-present despite
  being `debug`. The repo trio is pure diagnosis convenience → B2.

---

## 4. Per-backend gap-list (hand-off to `language-feature-developer`)

Each gap names the **exact emitter file + function** to add the line, and the
**analog backend** whose call site to mirror. All B0/B1 emits below are
mechanical (logger + fields in scope) unless flagged DESIGN.

### Phoenix (`elixir`) — largest gap: 0/9 B0 faults+narrative, 0 repo-debug
Emit via `renderPhoenixLogCall(eventKey, args)` (`src/generator/_obs/render-phoenix.ts`).

| Event | Add at | Mirror |
|---|---|---|
| `operation_invoked` | `src/generator/elixir/api-emit.ts`, operation action body (alongside the existing `aggregate_created` site :835 and `wireIn` :786) | Hono routes-builder.ts:837 |
| `event_dispatched` | dispatch/save seam — `src/generator/elixir/dispatch-emit.ts` (ash) / `vanilla/*` publish | .NET repository.ts:364 |
| `domain_error` / `forbidden` / `disallowed` / `not_found` | the controller error→HTTP mapping (FallbackController / action error clauses) in `src/generator/elixir/api-emit.ts` | Python index.ts:838–853 (the `_forbidden`/`_disallowed`/`_domain`/`_not_found` analogs) |
| `extern_handler_threw` | extern-handler invocation rescue clause (elixir extern emit) | Hono routes-builder.ts:655 |
| `internal_error` | the catch-all 500 in the FallbackController | Hono routes-builder.ts:660 |
| `aggregate_loaded` / `repository_save` / `find_executed` (B2) | Ash resource read/create + Ecto data-layer — **shape-divergent, defer** | .NET repository.ts |
| `audit_recorded` | **DESIGN** — no history table; see §2 | — |
| `provenance_recorded` (ash) | **DESIGN/feature-gap** — flush not wired on ash; vanilla flush at `vanilla/provenance-emit.ts:204` is mechanical | Python repository-builder.ts:760 |

### Java (`java`) — sequence AFTER #1508 merges (it owns the channel unification)
Post-#1508 Java emits via `CatalogLog.event(name, level, kvs...)`.

| Event | Add at | Mirror |
|---|---|---|
| `operation_invoked` | `src/generator/java/emit/service.ts` `renderPublicOperationMethod` entry (the audit seam at ~:255 is adjacent) | .NET api.ts:460 |
| `domain_error`/`forbidden`/`disallowed`/`not_found` | `src/generator/java/emit/api.ts` `renderApiExceptionAdvice` (the `internal_error` site :373 lives here — add sibling `@ExceptionHandler` branches) | Python index.ts:838–853 |
| `extern_handler_threw` | same advice class, extern-exception branch | Hono routes-builder.ts:655 |
| `aggregate_loaded`/`repository_save`/`find_executed` (B2) | `src/generator/java/emit/repository.ts` getById/save/find (the prov flush at :598 is in `save`) | .NET repository.ts |
| `workflow_started`/`workflow_completed` | `src/generator/java/emit/workflow.ts` | Phoenix workflow-emit.ts:102,564 |
| `audit_recorded` | `src/generator/java/emit/service.ts` ~:255–268, after `auditRecords.save` — **mechanical** | (new line) |
| `provenance_recorded` | `src/generator/java/emit/repository.ts` ~:598–611, after `drainProv` loop — **mechanical** | Python repository-builder.ts:760 |

### Python (`python`)
Emit via the `log(level, event, **fields)` string idiom.

| Event | Add at | Mirror |
|---|---|---|
| `operation_invoked` | `src/generator/python/routes-builder.ts`, per-op route body (the audit `record_audit` call is in this scope) | Hono routes-builder.ts:837 |
| `aggregate_created` | create route in `src/generator/python/routes-builder.ts` | Hono routes-builder.ts:466 |
| `event_dispatched` | `src/generator/python/dispatch-builder.ts` / repository save | .NET repository.ts:364 |
| `internal_error` | `src/generator/python/index.ts` — add a catch-all handler beside `_domain`/`_not_found` (:848/:853) | Hono routes-builder.ts:660 |
| `aggregate_loaded`/`repository_save`/`find_executed` (B2) | `src/generator/python/repository-builder.ts` getById/save/find | .NET repository.ts |
| `audit_recorded` | `src/generator/python/repository-builder.ts` `recordAuditMethod` ~:854–885, after `session.add` — **mechanical** | (new line) |
| `provenance_recorded` | `src/generator/python/repository-builder.ts` `saveMethod` ~:745–769, after `drain()` — **mechanical** | (new line) |

### .NET (`dotnet`)
Emit via `renderDotnetLogCall(eventKey, args)`.

| Event | Add at | Mirror |
|---|---|---|
| `domain_error`/`forbidden`/`disallowed`/`not_found` | `src/generator/dotnet/emit/api.ts` `renderExceptionFilter` (the `extern_handler_threw`:587 / `internal_error`:599 branches live here — add domain-fault branches) | Python index.ts:838–853 |
| `workflow_started`/`workflow_completed` | `src/generator/dotnet/workflow-emit.ts` | Phoenix workflow-emit.ts:102,564 |
| `audit_recorded` | `src/generator/dotnet/cqrs/commands.ts` ~:293–310, after `_audit.Stage` — **mechanical** | (new line) |
| `provenance_recorded` | `src/generator/dotnet/emit/repository.ts` ~:136–156, after `DrainProv` loop — **mechanical** | (new line) |

### Hono (`node`) — reference backend; only the universal gaps remain
| Event | Add at | Mirror |
|---|---|---|
| `workflow_started`/`workflow_completed` | `src/platform/hono/v4/workflow-builder.ts` (the `event_unrouted` sites :1041/:1142 are here) | Phoenix workflow-emit.ts:102,564 |
| `audit_recorded` | `src/platform/hono/v4/routes-builder.ts` ~:920–940, after the audit `tx.insert` — **mechanical** | (new line) |
| `provenance_recorded` | `src/platform/hono/v4/routes-builder.ts` ~:945–959, after the prov flush loop — **mechanical** | (new line) |

---

## 5. Gap-drain — reviewable PR-sized slices

Slices are cut **by seam** (so each touches a disjoint set of emitter files and
can mirror one analog) and ordered by operator value. Pure-parity slices (the
seam + analog both exist) are independent and can fan out one
`language-feature-developer` run per backend. DESIGN slices are flagged — they
need a decision before code.

| # | Slice | Events | Backends | Kind | Depends on |
|---|---|---|---|---|---|
| **S1** | **Error-mapping faults** | `domain_error`, `forbidden`, `disallowed`, `not_found`, `extern_handler_threw`, `internal_error` | .NET (faults+extern), Phoenix (all 6), Java (faults+extern, post-#1508) | **pure parity** — mirror Python's `index.ts` handlers + Hono's mapping | Java waits on #1508 |
| **S2** | **Info narrative** | `operation_invoked`, `aggregate_created`, `event_dispatched` | Phoenix, Python, Java | **pure parity** — mirror Hono/.NET op-entry + save sites | Java waits on #1508 |
| **S3** | **Workflow lifecycle** | `workflow_started`, `workflow_completed` | Hono, .NET, Python, Java | **pure parity** — mirror Phoenix workflow-emit.ts (the *only* current emitter) | — |
| **S4** | **Audit + provenance (history-table backends)** | `audit_recorded`, `provenance_recorded` | Hono, .NET, Java, Python (+ Phoenix-vanilla provenance) | **pure parity** — all seams mechanical (§2); one line per insert/flush | — |
| **S5** | **Repository mechanism trio** | `aggregate_loaded`, `repository_save`, `find_executed` | Python, Java (Phoenix deferred) | **pure parity** (B2, lower priority) — mirror .NET repository.ts | — |
| **S6 (DESIGN)** | **Phoenix audit + ash provenance** | `audit_recorded` (Phoenix), `provenance_recorded` (ash) | Phoenix | **needs design** — no audit history table (stamp model); ash provenance flush not wired (pre-existing feature gap) | resolve §2 design Qs first |

### Sequencing notes

- **S1 first** (error/warn carry the most operator value and Phoenix is wholly
  silent on the `error` tier — a 500 is currently invisible there).
- **S1, S2, S3, S4, S5 are mutually independent** across disjoint emitter trees
  (`src/generator/{elixir,python,dotnet,java}/` and `src/platform/hono/`), so a
  single turn can fan out one `language-feature-developer` per backend per slice.
- **Java is gated on #1508** for S1/S2 — its domain channel isn't catalog-JSON
  until that lands. Do Java's S1/S2 *after* #1508 merges (or stack on its
  branch); the other backends proceed immediately.
- **S4 is the highest-leverage quick win**: it closes the two zero-producer
  catalog events on 4–5 backends with mechanical one-liners at already-cited
  seams, and turns a misleading catalog (events nobody emits) honest.
- **S6 is the only slice needing a product decision**: (a) does Phoenix get an
  `audit_records` history table to match the others, or does the catalog
  acknowledge a stamp-model divergence and scope `audit_recorded` to
  history-table backends; (b) ash provenance flush is a pre-existing feature gap
  to close before `provenance_recorded` can ride it. Surface to a human; do not
  default-build.

---

## Method notes

- Read at `ea6fa41e` (fresh `origin/main`, fetched + hard-reset this session).
- Catalog: `src/generator/_obs/log-events.ts` (18 domain-seam keys, lines 91–178).
- Renderers: `render-hono.ts` / `render-dotnet.ts` / `render-phoenix.ts` (call-site
  builders, gated by `test/generator/_obs/log-events-catalog.test.ts`); Python facade
  `src/generator/python/emit/obs.ts`; Java `CatalogLog`
  `src/generator/java/emit/observability.ts`.
- Each ✓ verified by grepping the backend generator tree for the event
  key/string AND reading the enclosing function. The two raw-logger emissions
  (`event_dead_lettered` on Hono/.NET) were found by grepping `event:
  "event_dead_lettered"` / `"event_dead_lettered"` directly, *not* via the
  `renderXLogCall` grep — a renderer-only sweep undercounts them.
- `N/A` for `event_dead_lettered` on Phoenix/Java verified by absence of an
  outbox-relay seam (`rg -n "outbox|dead.?letter" src/generator/{elixir,java}` —
  no relay loop emitting the event).
- Audit/provenance seams (§2) verified by reading the dedicated emit files
  (`emit/audit.ts`, `emit/provenance.ts`, `repository-builder.ts`, vanilla
  `provenance-emit.ts`) and the insert/flush call sites; "mechanical vs design"
  is whether the catalog fields + a logger handle are both in scope at the seam.
- #1508 scope read from the live PR body (open/draft, head
  `claude/obs-java-log-unify`, base `claude/generated-apps-telemetry-b23erg`):
  reroutes Java domain slf4j → `CatalogLog`, adds `event_dispatched`, does not add
  the fault quartet / repo trio / audit / provenance.
