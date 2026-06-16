# RFC: `schedule` — time-triggered workflows

**Status:** Draft / Proposed (design only — no grammar, IR, or generator work
scheduled).

**Scope:** Add a single trigger form, `schedule`, that fires a workflow body on
a recurring wall-clock cadence. This is the time-based sibling of the existing
event triggers (`on(e: Event)`, `create(e: Event) by`) — the producer is the
clock instead of a domain event. It is the smallest missing integration
primitive: there is today no way to say "run this nightly / every 5 minutes".

Companions:

- [`workflow.md`](../workflow.md) — workflow bodies and the existing event
  triggers this mirrors.
- [`channels.md`](./channels.md) — the in-process dispatcher + saga-state
  persistence a scheduled workflow reuses for its run record.
- [`resources.md`](../resources.md) — scheduled bodies consume resources
  (`jobs.enqueue`, `files.delete`, `rates.get`) through the same verb vocabulary.

---

## 1. The problem

Loom can react to *events* but not to *time*. Real systems need:

- **Reaping / expiry** — cancel unpaid orders after 30 min, purge soft-deleted
  rows nightly.
- **Polling** — pull an external API on a cadence (no webhook available).
- **Digests / rollups** — compute a daily summary, send a weekly report.
- **Maintenance** — refresh a cache, re-derive a projection, compact an event log.

Every one is "run this workflow body, no input, on a clock." Today the only
recourse is hand-written code in a `.loomignore`-pinned file per backend —
exactly the escape-hatch sprawl Loom exists to eliminate.

## 2. The model in one screen

A `schedule` is a workflow **trigger**, declared like the event triggers, with a
**structured cadence** (not a raw cron string) and a workflow body:

```ddd
context Orders {
  // Reap unpaid orders every 5 minutes.
  workflow ExpireStaleOrders {
    schedule every 5m {
      for-each order in Orders.unpaidOlderThan(minutes(30)) {
        order.cancel(reason: "payment-timeout")
      }
    }
  }

  // Nightly digest at 02:00 in the system timezone.
  workflow NightlyDigest {
    schedule daily at "02:00" {
      let stats = Orders.dailyStats()
      jobs.enqueue({ kind: "digest", date: today(), placed: stats.count })
    }
  }
}
```

The cadence grammar is a **closed, readable vocabulary** that lowers to a
canonical cron/interval representation internally — the same philosophy as the
resource verb vocabulary (typed surface, vendor cron underneath), with a raw
escape hatch for cases the vocabulary can't express.

### Cadence forms

| Form | Meaning | Lowers to |
|---|---|---|
| `every <duration>` | fixed interval (`30s`, `5m`, `1h`, `12h`) | interval timer |
| `daily at "HH:MM"` | once per day at wall-clock time | cron `M H * * *` |
| `weekly on <day> at "HH:MM"` | once per week | cron `M H * * <dow>` |
| `monthly on <n> at "HH:MM"` | once per month, day-of-month `n` | cron `M H n * *` |
| `cron("<expr>")` | raw 5-field cron escape hatch | passthrough |

`<duration>` reuses the existing duration literal (`30s` / `5m` / `1h`); `<day>`
is `monday`…`sunday`. Times are interpreted in the **system timezone** (a new
`system { timezone: "Europe/Amsterdam" }` key; default `UTC`), with an optional
per-schedule `in "<tz>"` override.

## 3. Semantics — the hard part, decided

Scheduling is easy to declare and easy to get wrong under scale. The contract:

- **Single-fire under replication.** When a deployable scales to N replicas,
  each tick fires **exactly once**, not N times. v1 default is a Postgres
  advisory lock keyed by `(context, workflow)` acquired around the tick;
  backends with a clustering-native scheduler (Oban, Quartz-clustered, Hangfire)
  delegate to it instead. A deployable with no relational `state` resource
  cannot host a schedule (validator error) — single-fire needs the shared lock.
- **At-least-once, idempotency is the author's job.** A crash mid-body may
  re-run on the next tick. The body should be written idempotently (the same
  guidance as event reactors); this is documented, not enforced.
- **No overlap.** If a tick is still running when the next is due, the next is
  **skipped** (logged as `scheduled_task_skipped_overlap`), not queued. An
  explicit `overlap: allow` opts into concurrent runs.
- **Catch-up: none.** A schedule that was down over its window does **not**
  back-fill missed ticks on restart; it resumes at the next boundary. (Durable
  catch-up is a Phase-2 `missed: run` knob.)
- **No input, ambient `now`.** A scheduled body takes no parameters; `now()` /
  `today()` are in scope (the only place wall-clock time is a first-class input,
  mirroring how `currentUser` is ambient in authenticated bodies).
- **Not transactional across external effects.** Same rule as resource-ops: a
  `jobs.enqueue` / `api.post` inside a schedule body can't roll back with the DB
  transaction (`loom.resource-op-in-transaction` still applies).
- **Run record.** Each fire writes a saga-state-style row
  (`scheduled_run(context, workflow, fired_at, status, duration_ms)`) reusing the
  channels saga-state table machinery — gives `ddd verify` and observability a
  trace, and powers overlap detection.

## 4. The scheduler owner

Exactly one backend deployable per context owns schedule execution, picked the
same way enrichment picks `migrationsOwner` (phase ⑥): the first backend
deployable hosting the context, recorded as `scheduleOwner` on the context IR.
Frontends and additional backends never emit a scheduler. This keeps "who runs
the clock" deterministic and single-sourced, exactly like migration ownership.

## 5. What each backend emits

The cadence lowers to one canonical `ScheduleIR` (`{ cadence, timezone, overlap,
body }`); each backend renders its idiomatic scheduler, with the body reusing the
**existing workflow renderer** (a schedule body *is* a workflow body — same
`render-stmt`, same resource-verb dispatch, same `for-each`):

| Backend | Scheduler | Single-fire |
|---|---|---|
| Hono / node | `node-cron` (or a bare interval) + PG advisory lock | `pg_try_advisory_lock` |
| .NET | `BackgroundService` + `PeriodicTimer`, or Quartz.NET | Quartz cluster / advisory lock |
| Phoenix / Elixir | **Oban** cron plugin (Ash) / Quantum (vanilla) | Oban's native uniqueness |
| Python / FastAPI | APScheduler | advisory lock |
| Java / Spring | `@Scheduled` + `TaskScheduler`, or Quartz | Quartz cluster / advisory lock |

No new dev sidecar is required (the advisory lock rides the existing Postgres);
Oban already rides the app's Ecto repo. Deployables hosting no schedule are
byte-identical.

## 6. Validation

- `loom.schedule-needs-state` — a scheduled workflow's owning deployable must
  bind a relational `state` resource (single-fire lock needs it).
- `loom.schedule-bad-cadence` — malformed time (`"25:00"`), interval below a
  floor (`< 1s`), or a `cron(...)` that doesn't parse.
- `loom.schedule-body-params` — a `schedule` body declares no parameters.
- Reuses `loom.resource-op-in-transaction` for external effects in a
  `transactional` span.
- Print/round-trip: add a `schedule` arm to `print-stmt.ts` (the
  `print-completeness.test.ts` gate forces it).

## 7. Observability

New catalog events in `src/generator/_obs/log-events.ts` (cross-backend parity,
same as every other catalog event):

`scheduled_task_started` · `scheduled_task_completed` (with `duration_ms`) ·
`scheduled_task_failed` (with error) · `scheduled_task_skipped_overlap` ·
`scheduler_lock_contended` (another replica holds the lock — info-level).

## 8. Phased delivery

**Phase 1 — interval + daily, Hono + one backend.**
`every <duration>` and `daily at "HH:MM"`; `ScheduleIR`; `scheduleOwner`
enrichment; advisory-lock single-fire; node-cron + .NET `BackgroundService`;
run-record row; catalog events; validators. CI: a `schedule`-bearing example
generates byte-identically where unused, and a fast unit test asserts the cron
lowering + lock SQL.

**Phase 2 — full cadence + all backends.**
`weekly` / `monthly` / `cron(...)`; timezone (`system { timezone }` + per-schedule
`in`); Phoenix/Oban, Python/APScheduler, Java/Spring; `overlap: allow`.

**Phase 3 — durability knobs.**
`missed: run` (catch-up of missed ticks), `retry: <n>` with backoff, and a
`ddd verify` join so a never-fired schedule surfaces as a coverage gap.

## 9. Open questions

- **Cadence floor.** Hard minimum interval (1s? 10s?) to keep advisory-lock
  churn sane — or leave it to the author and just warn under 10s.
- **Timezone + DST.** `daily at "02:00"` during a DST transition can fire twice
  or zero times. Document the standard cron semantics (skip/duplicate) rather
  than invent our own.
- **Testing surface.** Should `test` blocks be able to *trigger* a schedule body
  deterministically (a `fire <Workflow>` test verb) without waiting on the
  clock? Likely yes — the body is just a workflow.
- **Manual trigger.** Expose a scheduled workflow as a `POST /schedules/<name>`
  admin endpoint for on-demand runs (gated by auth)? Defer to Phase 2.

## 10. Why a trigger, not a new top-level declaration

`schedule` is *not* a new sibling of `workflow` / `channel`. A scheduled task is
a workflow with a clock as its producer — identical body, identical resource
access, identical run-record persistence. Modelling it as a third workflow
trigger (alongside `on` and `create … by`) means the entire body pipeline
(lowering, `render-stmt`, resource verbs, `for-each`, observability) is reused
unchanged; only the *trigger* and a per-backend *scheduler shell* are new. One
small seam, not a new subsystem.
