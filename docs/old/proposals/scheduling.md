# RFC: `timerSource` — time as an event source

**Status:** Draft / Proposed (design only — no grammar, IR, or generator work
scheduled).

**Scope:** Let a workflow run on a recurring wall-clock cadence **without adding
a new trigger**. Time is modelled as a *source that emits tick events*, bound at
system scope exactly like `channelSource`; workflows react to those ticks with
the **existing, unchanged** `on(e: Event)` / `create(e: Event) by` triggers. This
is the smallest missing integration primitive — there is today no way to say
"run this nightly / every 5 minutes" — and it adds *zero* new workflow grammar.

Companions:

- [`workflow.md`](../../workflow.md) — the `create` / `handle` / `on` trigger model
  this reuses verbatim.
- [`channels.md`](./channels.md) — the `channel` / `channelSource` domain↔infra
  split this mirrors, and the in-process dispatcher + saga-state persistence a
  tick-driven workflow reuses for its run record.
- [`resources.md`](../../resources.md) — tick-driven bodies consume resources
  (`jobs.enqueue`, `files.delete`, `rates.get`) through the same verb vocabulary.

---

## 1. The problem

Loom can react to *events* but not to *time*. Real systems need:

- **Reaping / expiry** — cancel unpaid orders after 30 min, purge soft-deleted
  rows nightly.
- **Polling** — pull an external API on a cadence (no webhook available).
- **Digests / rollups** — compute a daily summary, send a weekly report.
- **Maintenance** — refresh a cache, re-derive a projection, compact an event log.

Every one is "run a workflow body on a clock." Today the only recourse is
hand-written code in a `.loomignore`-pinned file per backend — exactly the
escape-hatch sprawl Loom exists to eliminate.

## 2. The design tension that shapes this RFC

A scheduled task *looks* like it wants a new trigger — `schedule every 5m { … }`.
That shape was the first draft of this RFC and was **rejected** (see §9). Three
problems sank it:

1. **It breaks trigger uniformity.** The three workflow triggers share one head —
   `create`/`on`/`handle` are all `(params) [by <correlation>] { … }`,
   discriminated by the *type* of the thing that triggers them (a command or an
   event). A cadence sublanguage (`every` / `daily at` / `weekly on`) is a
   parallel grammar that reads as a foreign construct in the member list.
2. **A schedule has no instance identity.** Workflows are state-bearing saga
   entities keyed by correlation; `create` allocates an instance, `on` routes to
   one. A recurring tick has no correlation — a bare `schedule` member sits
   awkwardly among members whose whole job is instance lifecycle.
3. **It leaks infrastructure into the domain.** Loom deliberately splits domain
   policy (`channel`) from transport binding (`channelSource`). `every 5m` is an
   *operational* knob — it should be slow in dev, fast in prod, swappable per
   environment — not a fact baked into the domain context.

The resolution: don't add a trigger. **Make a clock tick an event**, and let the
existing reaction machinery do the rest. The cadence — the infrastructure half —
moves to a system-scope binding, mirroring the `channel` / `channelSource` split.

## 3. The model in one screen

```ddd
context Orders {
  // A tick is an ordinary event — a fact, like OrderPlaced.
  event NightlyTick { at: datetime }
  event SweepTick   { at: datetime }
  event HealthTick  { at: datetime }

  // React with the EXISTING trigger — no new grammar.
  workflow NightlyDigest {
    on(t: NightlyTick) {
      let stats = Orders.dailyStats()
      jobs.enqueue({ kind: "digest", date: t.at, placed: stats.count })
    }
  }

  workflow ExpireStaleOrders {
    on(t: SweepTick) {
      for-each order in Orders.unpaidOlderThan(minutes(30)) {
        order.cancel(reason: "payment-timeout")
      }
    }
  }
}

// System scope — infrastructure binding, mirrors `channelSource`.
// The cadence lives HERE, swappable per environment.
timerSource nightly { for: NightlyTick, cron: "0 2 * * *", in: "Europe/Amsterdam" }
timerSource sweep   { for: SweepTick,   cron: "*/5 * * * *" }   // every 5 min — standard cron
timerSource healthz { for: HealthTick,  every: 15s }            // sub-minute — cron can't
```

- **`event … { at: datetime }`** — a tick is a normal event. Workflows that don't
  exist yet can ignore it; ones that care react with `on`. The `at` field carries
  the fire time so the body can use it (`t.at`).
- **`timerSource name { for: <Event>, (cron: <string> | every: <duration>), in: <tz>? }`**
  — the system-scope binding that fires the event on a cadence. Shape mirrors
  `channelSource { for: <Channel>, use: <Storage> }`: a `for:` naming what it
  drives, the realization details alongside.

### Two cadence modes — real cron, not a bespoke vocabulary

Cron and interval are genuinely different beasts, and a draft of this RFC got
this wrong (a `cadence:` string sublanguage — `"daily at 02:00"` — that just
lowered to cron anyway; see §9.1). The decision instead is **exactly one of two
explicit fields**, the second existing only because cron literally cannot express
it:

| Field | For | Notes |
|---|---|---|
| `cron: "<expr>"` | **everything cron can say** — including most intervals | a **real 5-field cron expression**, passed through to each backend's native scheduler. Standard intervals are cron: `*/5 * * * *` (every 5 min), `0 */6 * * *` (every 6 h). Nicknames work too — `@daily` / `@hourly` / `@weekly` / `@monthly` — readability with *zero* invented vocabulary. |
| `every: <duration>` | only what cron **can't** | sub-minute (`15s` — below 5-field cron's minute granularity) and non-dividing intervals (`90m`, `7m` — where `*/7` is a foot-gun that gaps, not a true interval). The narrow escape hatch, not the primary interval surface. |

**`cron:` is the default for intervals too.** Any interval that evenly divides
its unit — 5/10/15/30 min, 1/2/3/6/12 h — is a standard cron expression and
should be written as one. `every:` is *not* a second way to say "every 5
minutes"; it exists strictly for the cases portable 5-field cron cannot express
(`loom.timer-cadence` rejects an `every:` whose interval *is* cleanly
cron-expressible, steering it back to `cron:` and avoiding two-ways-to-say-it).

Why real cron over a structured cadence vocabulary:

- **No translation layer.** A `cron:` value is the cron the backend already runs —
  no parse-and-remap, no half-built sugar that punts to a `cron(...)` escape hatch
  for anything non-trivial ("weekdays at 9 and 17", "first monday of the month").
- **Right audience.** Cadence is infra config on the infra binding — written by
  whoever runs ops, who already speaks cron. Optimizing the surface for
  cron-illiterate readers optimizes for a reader who isn't here.
- **Still validated.** "Real cron" ≠ "unchecked string": IR validation parses the
  expression and range-checks each field, exactly as it would a bespoke
  vocabulary. Validatability never depended on inventing words.
- **Two fields, not one `cadence:`.** Keeping `cron`/`every` distinct makes each
  field mono-typed (a cron expr vs a duration), so the validator and every backend
  emitter branch on *which field is set*, never on parsing a mode out of a string.

## 4. Why `create(t: Tick) by …` also just works

Two reaction styles fall out for free, both using **existing** triggers:

- **`on(t: Tick) { … }`** — a stateless recurring procedure (the common case).
- **`create(t: Tick) by t.at { … }`** — a *new workflow instance per tick*, when
  you want a durable per-run saga record keyed by fire time. Identical to today's
  event-triggered starter; the tick is just the event.

Nothing in the trigger pipeline changes — lowering already discriminates
event-triggered `create`/`on` by parameter type and `by` correlation.

## 5. Semantics — the hard part, decided

Time delivery is easy to declare and easy to get wrong under scale. The
`timerSource` carries the contract:

- **Single-fire under replication.** When the owning deployable scales to N
  replicas, each tick is emitted **exactly once**, not N times. v1 default: a
  Postgres advisory lock keyed by `(timerSource)` around the emit; backends with a
  clustering-native scheduler (Oban, Quartz-clustered, Hangfire) delegate to it.
  A `timerSource` whose owner binds no relational `state` resource is a validator
  error (the lock needs it).
- **At-least-once, idempotency is the author's job.** A crash mid-body may re-run
  on the next tick — the same guidance event reactors already carry. Documented,
  not enforced.
- **No overlap.** If a body is still running when the next tick is due, the tick
  is **skipped** (logged), not queued. `overlap: allow` on the `timerSource` opts
  into concurrent runs.
- **No catch-up.** A source that was down over its window does not back-fill
  missed ticks; it resumes at the next boundary. Durable catch-up is a Phase-3
  `missed: run` knob.
- **The tick is a real event.** It drains through the existing
  `DomainEventDispatcher` (channels in-process dispatch) — so a tick can fan out
  to multiple `on` reactors, and the run record is the existing saga-state row.
  This reuse is the whole payoff.

## 6. The timer owner

A tick event is emitted by *infrastructure*, not by an aggregate's `emit` — so it
needs an owner that runs the clock. Exactly one backend deployable hosting the
`timerSource`'s context owns emission, picked the same way enrichment picks
`migrationsOwner` (phase ⑥) and recorded as `timerOwner` on the system IR.
Frontends and additional backends never emit a scheduler. Deterministic,
single-sourced — identical to migration ownership.

## 7. What each backend emits

A `timerSource` lowers to one canonical `TimerSourceIR` (`{ event, cadence,
timezone, overlap }`). Each backend renders its idiomatic scheduler whose tick
**constructs the event struct and dispatches it** into the existing reactor path
— it emits no body of its own:

| Backend | Scheduler | Single-fire |
|---|---|---|
| Hono / node | `node-cron` (or a bare interval) | `pg_try_advisory_lock` |
| .NET | `BackgroundService` + `PeriodicTimer`, or Quartz.NET | Quartz cluster / advisory lock |
| Phoenix / Elixir | **Oban** cron plugin / Quantum | Oban native uniqueness |
| Python / FastAPI | APScheduler | advisory lock |
| Java / Spring | `@Scheduled` + `TaskScheduler`, or Quartz | Quartz cluster / advisory lock |

No new dev sidecar (the advisory lock rides existing Postgres; Oban rides the
app's Ecto repo). Deployables hosting no `timerSource` are byte-identical.

## 8. Validation, print, observability

- `loom.timer-event-shape` — a `timerSource`'s `for:` event must be a plain event
  (and, by convention, carry an `at: datetime`); the validator allows it to be
  emitted by infrastructure rather than only by aggregate/workflow `emit`
  (the one new emission category this RFC introduces).
- `loom.timer-needs-state` — the owning deployable must bind a relational `state`
  resource (single-fire lock).
- `loom.timer-cadence` — neither or both of `cron:` / `every:` set; an
  unparseable / out-of-range cron expression; an interval below the floor; or an
  `every:` whose interval *is* cleanly cron-expressible (steer it to `cron:`,
  avoiding two-ways-to-say-it).
- `loom.timer-source-unbound` — a `timerSource` whose `for:` event no workflow
  reacts to (warning — a tick with no listener is dead config).
- **Print/round-trip:** `timerSource` is a top-level declaration — add a
  `print-structural.ts` arm (`print-completeness.test.ts` gates it). No
  `print-stmt` / `print-expr` change, because no new statement or expression.
- **Observability:** new catalog events in `src/generator/_obs/log-events.ts`
  (cross-backend parity): `timer_fired` · `timer_skipped_overlap` ·
  `timer_lock_contended` · `timer_emit_failed`. The downstream
  `workflow_started` / `_completed` events already exist (the reactor is a normal
  workflow).

## 9. Rejected alternative: `schedule` as a fourth trigger

The first draft added a trigger member:

```ddd
workflow ExpireStaleOrders {
  schedule every 5m { for-each order in … { order.cancel(…) } }
}
```

Rejected for the three reasons in §2: it breaks the `(params) by correlation`
trigger uniformity, it gives a stateless schedule an awkward seat among
instance-lifecycle members, and it bakes an operational cadence into the domain
context. The `event` + `timerSource` shape keeps the trigger grammar untouched,
keeps cadence on the infra binding (swappable per environment), and reuses the
in-process dispatch + saga-state machinery wholesale. The cost is one new
emission category (infrastructure-emitted events, §8) — a far smaller surface
than a parallel trigger grammar.

A middle option — a system-scope `schedule { for: <Workflow>, cadence }` pointing
at a paramless workflow — was also considered. It avoids the domain leak but
needs a *new* paramless workflow entry shape (workflows are members-only today),
reintroducing a bespoke trigger by the back door. Reusing `on(e: Event)` is
strictly less new surface.

### 9.1 Rejected sub-decision: a structured `cadence:` vocabulary

The first cadence design was a single `cadence:` string with a closed pseudo-DSL
(`"every 5m"`, `"daily at 02:00"`, `"weekly on monday at 09:00"`, plus a
`"cron(…)"` escape hatch). Rejected: every form lowered to cron anyway, so it was
a translation layer over a *partial* vocabulary that punted to raw cron for
anything real ("weekdays at 9 and 17", "first monday"); it optimized readability
for domain modelers when the actual author is ops (cron-fluent); and a single
string conflated two genuinely different modes. Replaced by explicit `cron:`
(real cron, with standard `@daily`/`@hourly`/… nicknames for readability) and
`every:` (the interval mode cron cannot express). See §3.

## 10. Phased delivery

**Phase 1 — `cron:` + `every:`, Hono + one backend.**
`timerSource` declaration with both cadence fields; `TimerSourceIR`; `timerOwner`
enrichment; infrastructure-emit validator relaxation; advisory-lock single-fire;
node-cron + .NET `BackgroundService` tick→dispatch; cron parse/range validation
(nicknames included) + interval floor; catalog events. CI: a `timerSource`-bearing
example generates byte-identically where unused; a fast unit test asserts the cron
passthrough + interval-timer wiring + lock SQL.

**Phase 2 — all backends + timezone.**
Phoenix/Oban, Python/APScheduler, Java/Spring (each consuming the same `cron:` /
`every:` pair); timezone (`in:` + a `system { timezone }` default);
`overlap: allow`.

**Phase 3 — durability + env overrides.**
`missed: run` (catch-up), `retry: <n>` with backoff, per-environment cadence
override (the env-swap mechanism `D-ENV-SWAP` is already pinned for storage), and
a `ddd verify` join so a never-fired timer surfaces as a coverage gap.

## 11. Open questions

- **Tick event hygiene.** Should tick events be a marked subtype (`event … timer`)
  so they're visibly infrastructure-emitted, or stay plain events distinguished
  only by being a `timerSource` target? Leaning plain — fewer concepts — with the
  `timer-event-shape` validator as the guard.
- **Cadence floor + DST.** Hard minimum interval to keep lock churn sane;
  document standard cron DST semantics (skip/duplicate at the transition) rather
  than invent our own.
- **Deterministic test firing.** A `fire <Event>` test verb to trigger a
  tick-driven workflow without waiting on the clock — the body is just a workflow,
  so this is likely cheap and worth Phase 1.
- **Manual trigger.** Expose a `POST /timers/<name>` admin endpoint for on-demand
  fires (auth-gated)? Defer to Phase 2.
