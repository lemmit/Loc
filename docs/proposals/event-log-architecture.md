# Event-log architecture — per-aggregate streams vs. a per-context log

> Status: **DRAFT / PROPOSED** (2026-07-11). No code. Scopes the substrate
> question that [`projection.md`](projection.md) §"Deferred — Replay / rebuild"
> leaves open: *what ordered stream does a projection replay from?* Includes a
> full empirical blast-radius audit (all five backends + the shared migration
> layer) so the size of the change is measured, not guessed.

> Depends on / reuses: the event-sourced aggregate & workflow stream tables
> (`workflow-and-applier.md`), the shared `MigrationsIR` (phase ⑨), the
> transactional outbox (`dispatch-delivery-semantics.md`), and the bounded-context
> deployment boundary (each deployable = its own database).

---

## TL;DR

Today every event-sourced aggregate (`persistedAs(eventLog)`) and every
event-sourced workflow gets its **own physical table** — `order_events`,
`payment_events`, `shipment_saga_events` — keyed `(stream_id, version)`, ordered
per-stream, **with no global sequence across tables**. That is correct for
*reconstruction* (load one stream, fold, append) but it cannot hand a projection
a single ordered feed to replay, which is exactly what rebuild needs.

This proposal argues the right unit for an event log is the **bounded context /
database**, not the aggregate:

- **within a context** → one `<ctx>_events` table (Marten's `mt_events` model,
  scoped to a context): `(seq bigserial, stream_type, stream_id, version, type,
  data, occurred_at)`. Reconstruction reads `WHERE stream_type=? AND stream_id=?
  ORDER BY version`; replay reads `WHERE seq > $ckpt ORDER BY seq`.
- **across contexts** → **a broker**, not a table. Contexts are separate
  databases; cross-context consumers subscribe to a durable channel and fold a
  *local* projection. (Out of scope here; see "The three scopes".)

**The audit's headline:** the collapse is **large-but-mechanical and
cross-backend-coordinated — not a foundational rewrite.** The domain fold layer
(`apply`/`from_events`/`row_to_event`), DI wiring, per-aggregate repositories,
optimistic concurrency, and event dispatch are **all untouched**; the per-type
ORM classes actually *collapse N→1* (a simplification). The real cost is that the
table shape lives in one shared place (`migrations-builder.ts`) that every
backend's ORM mapping must match in lockstep, gated by a runtime boot (the
coupling is compile-green but runtime-fatal). The global-`seq` *replay reader* it
enables is **greenfield on every backend** and cleanly separable from the table
collapse.

---

## The three scopes

An "event log" is really three different things at three boundaries. Conflating
them is what makes the design feel harder than it is.

| Scope | Substrate | Ordering | Feeds | Rebuild source |
|---|---|---|---|---|
| One aggregate/workflow **instance** | a *stream* (rows sharing `stream_id`) | per-stream `version` | reconstruction | its own stream |
| One **context / database** | one `<ctx>_events` table | global `seq` (in-context) | same-context projections | scan the local log by `seq` |
| The **system** (cross-context) | a broker topic (Kafka / redis-streams) | broker offset | cross-context projections | re-consume the retained topic |

The rule: **match the log's granularity to the isolation boundary.** Loom's
isolation boundary is the context/database — `renderDbInit` emits `CREATE
DATABASE <slug>` per deployable, so two contexts split across deployables are in
different databases entirely. Per-aggregate tables sit *below* the boundary that
would justify them: aggregates in one context already share one Postgres, one
connection pool, one WAL — they don't scale independently regardless of table
layout, so splitting their events buys a tighter index but fragments the order
for no real isolation gain. Per-*global* (one table across contexts) sits *above*
the boundary: it would couple separate databases into one store — the
distributed-monolith anti-pattern. **Per-context is the Goldilocks unit**, and it
is exactly what Marten does (one `mt_events` per store).

This proposal is about the **middle row** — the per-context log. The top row is
unchanged (a stream is a logical partition of the context table). The bottom row
(cross-context) is a broker, deferred with the durable-channel tier
(`channelSource: kafka | redis-streams`, name-only today).

## Why per-context beats per-aggregate

- **Reconstruction and integration are opposite access patterns.** Reconstruction
  is a point/range read by `stream_id`; replay is a sequential scan in global
  order. Per-aggregate tables optimize the first and make the second impossible
  (no order across tables). One per-context table serves both: the composite key
  `(stream_type, stream_id, version)` keeps reconstruction a tight index range,
  and the `seq` column gives replay its order for free.
- **The "independent parallel writes" gain of per-type tables is illusory within
  a context.** The aggregates are co-located in one database by definition; a
  per-context `seq` is a shared append point, but it sits *below the single DB's
  own write ceiling*, so it is not a bottleneck you would not already hit.
- **It collapses the "outbox vs. reconstruction log" duplication.** Within a
  context, the same table can be both the source-of-truth stream *and* the replay
  feed — no separate per-projection inbox, no double-write of ES events.

## Costs (named honestly)

- A per-context `seq` is a single monotonic append point; a plain `bigserial`
  yields **gaps** (rolled-back / in-flight txns) and commit-order ≠ seq-order, so
  a correct replay reader needs a **high-water-mark** guard (Marten's async
  daemon pattern) — hold the safe-to-read mark below any gap. That machinery is
  part of the *replay reader*, not the table collapse.
- Reconstruction's `_loadAll`/`list` now scans a shared table filtered by
  `stream_type` instead of a dedicated table — same MVP profile, slightly worse
  selectivity; the `seq` index is what a replay path would use.
- Per-stream `dataSource` schema qualification narrows to per-context (all ES
  streams in a context land in one table/schema). Verify no example binds two ES
  aggregates in one context to different schemas.

---

## The change (concrete)

Central, one place — `src/system/migrations-builder.ts::eventLogTableForStream`
(the single helper that today emits the `(stream_id, version, …)` shape, called
per-aggregate at L164 and per-workflow at L231, rendered by `sql-pg.ts`):

- name derivation `snake(agg|wf.name)+"_events"` → `snake(ctx.name)+"_events"`;
- dedup the N per-stream-type calls to **one table per context** that has ≥1 ES
  aggregate or ES workflow;
- add columns `stream_type text not null`, `seq bigserial`;
- PK `(stream_id, version)` → `(stream_type, stream_id, version)` (else two
  aggregates' stream `1/v1` collide); unique index on `seq`.

The `eventLog` capability *need* is already context-scoped
(`enrichments.ts:deriveNeeds` → `{ contextName, kind: "eventLog" }`), so the
datasource/capability layer needs no granularity change.

Then each backend's **runtime ORM + query layer** moves in lockstep to match:

- one shared per-context event-row class replaces the N per-type classes
  (a *reduction*);
- every load / append / group-fold query gains a `stream_type = "<Agg>"` filter;
- inserts stamp `stream_type`; the `max(version)` prior-read gains the filter;
- optimistic concurrency (the `(…, version)` PK unique-violation → 409) is
  preserved by the widened PK;
- the domain fold (`apply`/`from_events`/`row_to_event`) is **unchanged** — see
  the audit's key correction below.

---

## Blast-radius audit (measured, all five backends)

Each backend was audited on fresh `main`. Every verdict came back **MODERATE in
isolation**; the aggregate whole-change verdict is **large-and-coordinated, not
foundational**.

| Backend | Event-store home | Files | ~LOC | Notes |
|---|---|---|---|---|
| **Hono/TS** | Drizzle `emit/schema.ts:emitEventLogTable` + `repository-eventsourced-builder.ts` + `workflow-eventsourced-builder.ts`; **also MikroORM** `emit/mikroorm.ts` | 5 | 250–400 | Two ORM surfaces move together; `_loadAll` type-filter is the silent-corruption trap. |
| **.NET/EF** | `emit/event-store.ts` (POCO+config), `emit/repository.ts`, `emit/efcore.ts` (DbSet), **Dapper** `emit/dapper.ts` self-DDL | 6 | 250–400 | EF model *simplifies* N entity types → 1; PK widens; `seq` maps `ValueGeneratedOnAdd`. |
| **Java/Spring** | `emit/event-store.ts`, `emit/dispatch.ts` (ES branch), `emit/workflow-eventsourced.ts` | 5 | 120–180 | **Easiest** — event store is raw `JdbcTemplate` SQL, *no JPA `@Entity`/`@IdClass`/`@Version`*; ~16 SQL string sites. |
| **Python/FastAPI** | `repository-eventsourced-builder.ts`, `emit/schema.ts:renderEventLogModel`, `workflow-eventsourced-emit.ts` | 4 | 40–70 | Smallest; SQLAlchemy model-per-table → one shared class; `seq` via `Identity()`. |
| **Elixir/Ecto** | `vanilla/eventsourced-emit.ts`, `vanilla/workflow-eventsourced-emit.ts`, `migrations-emit.ts` | 3 | 120–200 | Two genuine renderer gaps: `renderInitialStateFile` emits no indexes; `ectoColumnType` has no `bigserial` arm. |

**Cross-cutting facts the audit established:**

1. **The DDL is centralized.** `eventLogTableForStream` is the one authoritative
   shape; `sql-pg.ts` renders it for TS/.NET, and Java/Python/Elixir hand-write
   ORM mappings that *must match it*. This is why the change **cannot ship one
   backend at a time** — the shared shape drives every backend's DDL, so all five
   ORM mappings flip together or a backend boots against a table its model
   contradicts. (`.NET`/`Java`/`Elixir` do no model-diff; only a runtime boot
   catches a mismatch — so this is co-gated by `generated-stack-verifier` /
   obs-e2e, **not** unit tests.)

2. **The domain fold layer does NOT change and does NOT become a cross-type
   union.** Three auditors independently corrected this: because every
   reconstruction read is `stream_type`-filtered, each repo's
   `from_events`/`apply`/`row_to_event` only ever sees its own event types. A
   union fold is required **only** by the new global-replay reader (`WHERE seq >
   $ckpt`), which is greenfield. A shared table does not force a shared fold.

3. **The replay reader is greenfield on every backend.** No backend reads a
   `seq`/checkpoint today — projections are driven *live* by the in-process
   dispatcher (Hono `projectionTee`, .NET Mediator `INotificationHandler`, etc.),
   never by scanning an event table. So the `seq` column ships **inert**; *using*
   it (the actual rebuild loop + checkpoint + high-water-mark) is entirely new
   code, separable from and larger than the table collapse.

4. **The outbox is orthogonal.** `__loom_outbox` (delivery buffer,
   `dispatch-delivery-semantics.md`) is a separate shared table; the collapse
   does not touch it. (It is *not* emitted on Java or Elixir today — a
   pre-existing cross-backend gap.)

5. **Sharpest per-backend traps:** the `_loadAll`/`list` group-fold must gain the
   `stream_type` filter *everywhere* or it silently folds foreign aggregates'
   rows through the wrong appliers (all backends); Elixir's state-table migration
   renderer emits no indexes and has no `bigserial` type (two real gaps); .NET's
   Dapper path self-applies DDL, a second source of truth for the same table.

### Honest size verdict

- **Table collapse (this proposal):** ~5 emitter files per backend × 5 backends
  + one central `migrations-builder.ts` edit + a shared-DDL data migration for
  existing databases; roughly **900–1300 LOC across ~25 source files + test
  updates**, mostly mechanical (thread a `stream_type` filter, widen a PK,
  collapse N ORM classes → 1). **Large and coordinated, but not a rewrite** — no
  domain-logic, DI, or architectural upheaval, and the ORM model gets *simpler*.
  My earlier "foundational" framing was an overstatement on that axis.
- **Replay/rebuild feature (separate, later):** the greenfield half — a global
  `seq` reader, per-projection checkpoints, a high-water-mark guard, a `ddd
  rebuild <Proj>` command / endpoint, per backend. This is the genuinely large
  piece, and it is what "foundational" should have referred to.

The two are **separable**: the table collapse can land first (shipping an inert
`seq`), de-risking the substrate, with the replay reader as a following slice.

---

## Migration & sequencing

1. **Central DDL** — flip `eventLogTableForStream` to per-context + `stream_type`
   + `seq`; update the `MigrationsIR` snapshot/fixtures.
2. **Five backends in one coordinated change** — each backend's ORM class + query
   filters, co-gated by its `*-build` **and** a stack-boot
   (`generated-stack-verifier`), because the coupling is runtime-fatal, not
   compile-caught.
3. **Existing-DB data migration** — renaming `<agg>_events` → `<ctx>_events` and
   back-filling `stream_type`/`seq` on a live database is a real migration step,
   not just a fresh-emit change; needs a documented upgrade path.
4. **(Later, separable) replay reader** — `seq` cursor + checkpoint +
   high-water-mark + `ddd rebuild`, per backend. Greenfield.

## Open questions

- **Does the outbox subsume, or coexist with, the per-context log?** Both are
  append tables; a per-context log with `seq` could serve durable-channel
  delivery too (a relay drains by `seq`), retiring `__loom_outbox`. Or keep them
  separate (log = replay, outbox = delivery). Decide before building the reader.
- **`seq` gaps vs. serialized commits** — accept `bigserial` + high-water-mark
  (Marten), or serialize appends for a gap-free order (simpler reader, lower
  throughput)? A per-context, single-DB log makes the latter more tenable than it
  would be system-wide.
- **Is the collapse worth doing without the reader?** The table collapse alone
  buys nothing user-visible (the `seq` ships inert); it only de-risks the
  substrate. If replay/rebuild is not on the roadmap, per-aggregate tables keep
  working for pure reconstruction and this stays deferred.
- **Cross-context** stays a broker regardless — this proposal does not attempt a
  system-wide log.
