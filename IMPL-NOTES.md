# wave2-validator — emitter-half work this packet deliberately did NOT do

The `validator-diagnostics` packet is boundary-scoped to `src/ir/**`,
`src/diagnostics/**`, `src/language/**`. Where a row's full fix needs an
emitter change, the validator half landed and the emitter half is written down
here so the next packet does not have to re-derive it.

## M-T3.15-B0-mask-launder — projection-row read redaction (the real fix)

**Landed (validator):** `loom.field-mask-projection-source#fold` refuses a
folded projection whose `on(e: …)` folds an event that carries a `mask unless`
value (taint computed per masked aggregate over `emit` field values, following
`derived` reads and `let` chains).

**Emitter half (not done, `src/generator/**`):** make a projection ROW
mask-aware, so the fold can be allowed instead of refused.

- `ProjectionIR` (`src/ir/types/loom-ir.ts`) carries no mask marker on
  `stateFields`. The enrichment pass would have to propagate `maskUnless` from
  the source aggregate field through the `emit` payload into the projection's
  own field, and `wireShape` would have to carry it.
- Each backend's projection read route would then project through the same
  `toWireMasked` / `to_wire_masked` / `fromMasked` / `serialize` redaction the
  aggregate read routes already use, which today means threading a principal
  into a read that has none: node `d/http/projections.ts` `GET /<proj>` and
  `GET /<proj>/{key}` return `db.select().from(schema.<proj>)` raw; dotnet /
  java / python / elixir emit the same shape.
- Until then the refusal above is the honest position (it mirrors the
  already-shipping query-time bound for the `from` and `join` roads).

## domainservice-member-chained-repo-read — widening the repo-read detector

**Landed (validator):** `loom.domain-service-read-unsupported` refuses
`Repo.find(...).member` in a `domainService` body.

**Real fix (spans lowering + every backend):**

- `src/ir/lower/repo-read.ts` — every matcher requires
  `expr.suffixes.length === 1`, so a repo call is only recognised when it is the
  WHOLE postfix chain. Widen it to recognise a repo call as the PREFIX of a
  longer chain and hand the caller back the remaining suffixes.
- `src/ir/lower/lower-domain-service.ts` — lower the recognised prefix to a
  `repo-read` Call and re-apply the remaining member suffixes on top of it.
- `src/ir/util/domain-service-tier.ts:classifyDomainServiceTier` and each
  backend's `readPortArgs` threading then pick it up unchanged (they key off
  `callKind === "repo-read"`).
- Add a corpus fixture: no corpus/example system declares a `reading`-tier
  service today, which is why neither corpus-build nor the behavioral tier ever
  compiles one. GitHub issue #2649 tracks the node-only half.

## M-T5.9 / reserved-not-emitted — actually wiring the reserved clauses

`loom.reserved-not-emitted` now WARNS on the three inert surfaces; each row in
`src/ir/validate/checks/reserved-surfaces.ts` is deleted by the PR that wires
its emitter.

- `timerSource … in: "<tz>"` — every backend's cron driver has the seam: node
  pg-boss `boss.schedule(…, { tz })`, .NET Hangfire `RecurringJobOptions
  .TimeZone`, Java JobRunr `CronExpression` + `ZoneId`, Python procrastinate
  `periodic(cron=…)` + zoneinfo, Elixir `Oban.Plugins.Cron` `:timezone`.
- `timerSource … overlap: allow` — skip the `pg_try_advisory_xact_lock` wrap in
  `scheduler.ts` / `TimerService` / `TimerScheduler` / `scheduling.py` / the
  timer GenServer.
- `storage … connection:` — thread `StorageIR.connection` into
  `src/system/index.ts` compose env derivation, `src/system/kubernetes.ts`
  (replacing the `Host=db;` heuristic with `valueFrom.secretKeyRef` for
  `secret(n)` / a passthrough for `env(N)`), `src/system/helm.ts`, and the
  per-backend connection-string readers.

## eventlog-shape-silently-ignored — honouring `shape:` as the ES snapshot format

`loom.shape-on-event-sourced` now refuses the clause. The L-sized real feature
is snapshot rehydration in a document/embedded shape (docs/new-plan/
T2-data-evolution.md), which also unblocks the `every:` / `retain:` knobs the
`loom.datasource-knob-unwired` pass already warns about. Delete the gate in the
same PR that lands it.
