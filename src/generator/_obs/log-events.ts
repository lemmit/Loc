// ---------------------------------------------------------------------------
// Platform-neutral log-event catalog — the single source of truth for every
// structured log line the generated backends emit.
//
// Each entry pins:
//   - the machine-stable `event` name (the value of the `event` envelope key
//     on every emitted line),
//   - its level (= concept, not verbosity tier: see
//     docs/old/proposals/observability.md),
//   - the structured-field names it carries beyond the envelope
//     (envelope = ts, level, event, request_id — auto-supplied by the
//     per-request child logger).
//
// Per-backend renderers consume this catalog — Hono/pino in
// `render-hono.ts`, .NET (`ILogger`) in `render-dotnet.ts`, Phoenix
// (`Logger`) in `render-phoenix.ts` — so the same event surfaces with
// the same level + fields on every backend.  A log consumer (dashboard,
// alert, `jq` query) sees one schema.  This is the `wireShape` pattern
// applied to logs.
//
// Stability: treat the catalog like a wire contract — additive changes
// (new events, new optional fields) are safe; renaming / removing
// requires a downstream-consumer migration.
// ---------------------------------------------------------------------------

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface LogEvent {
  /** Machine-stable name; the value of the `event` envelope key. */
  event: string;
  level: LogLevel;
  /** Field names beyond the envelope (ts/level/event/request_id). */
  fields: readonly string[];
  /** Trace-only entries that may be injected into domain methods — the
   *  one level allowed to do so, gated by the generate-time `--trace`
   *  switch.  Always paired with `level: "trace"`. */
  domain?: boolean;
}

export const LogEvents = {
  // ─── infrastructure ──────────────────────────────────────────────────
  requestStart: { event: "request_start", level: "info", fields: ["method", "path"] },
  requestEnd: {
    event: "request_end",
    level: "info",
    fields: ["method", "path", "status", "duration_ms"],
  },
  serverStarting: { event: "server_starting", level: "info", fields: ["port", "env"] },
  serverListening: { event: "server_listening", level: "info", fields: ["port"] },
  serverShutdown: { event: "server_shutdown", level: "info", fields: ["signal"] },
  serverDrained: { event: "server_drained", level: "info", fields: [] },
  // `dbConnecting` / `dbConnected` are reserved for a future eager-connect
  // path.  Today's emitted backend uses pg's lazy pool (no connect until
  // the first query), so a one-shot "connected" event would either lie
  // or block boot.  Kept in the catalog so a future emitter can light
  // them up without breaking the additive contract.
  dbConnecting: { event: "db_connecting", level: "debug", fields: ["host"] },
  dbConnected: { event: "db_connected", level: "info", fields: ["host", "pool_size"] },
  dbDisconnected: { event: "db_disconnected", level: "warn", fields: ["reason"] },
  // `dbPoolExhausted` is reserved.  pg.Pool doesn't expose an exhaustion
  // event directly; detecting it reliably means polling
  // `pool.waitingCount` vs `pool.options.max` with debouncing, which is
  // out of scope for v1.  The catalog entry stays so a future pool
  // wrapper can fire it without a schema change.
  dbPoolExhausted: { event: "db_pool_exhausted", level: "warn", fields: ["waiters"] },
  dbError: { event: "db_error", level: "error", fields: ["error", "query"] },
  // Migration-runner events are reserved for when the generated backend
  // gains an in-process runner (drizzle-orm's `migrate(db, …)`).  Today's
  // emitted project ships migrations via the drizzle-kit CLI as a build
  // step (`npm run db:migrate`), so there's no in-process seam to emit
  // them from — the catalog entries stay so the future runner can light
  // them up without breaking the additive contract.
  migrationsStarting: { event: "migrations_starting", level: "info", fields: ["count"] },
  migrationApplied: {
    event: "migration_applied",
    level: "info",
    fields: ["id", "name", "duration_ms"],
  },
  migrationsComplete: { event: "migrations_complete", level: "info", fields: ["applied"] },
  migrationFailed: { event: "migration_failed", level: "error", fields: ["id", "name", "error"] },
  healthOk: { event: "health_ok", level: "debug", fields: ["checks"] },
  healthDegraded: { event: "health_degraded", level: "debug", fields: ["checks"] },
  externHandlersRegistered: {
    event: "extern_handlers_registered",
    level: "debug",
    fields: ["aggregate", "count", "ops"],
  },
  authEnabled: { event: "auth_enabled", level: "info", fields: ["required"] },
  // Verifier-registration lifecycle (auth.md).  Emitted once at boot by the
  // backends that wire a token verifier: `auth_oidc_verifier_registered`
  // when a real OIDC verifier is installed, `auth_dev_stub_registered` (warn)
  // when the dev-only accept-everything stub is — the warn level makes a
  // production deploy that forgot to swap the stub loud in the log stream.
  authOidcVerifierRegistered: {
    event: "auth_oidc_verifier_registered",
    level: "info",
    fields: [],
  },
  authDevStubRegistered: { event: "auth_dev_stub_registered", level: "warn", fields: [] },

  // ─── domain — info (business narrative) ──────────────────────────────
  aggregateCreated: { event: "aggregate_created", level: "info", fields: ["aggregate", "id"] },
  operationInvoked: {
    event: "operation_invoked",
    level: "info",
    fields: ["aggregate", "op", "id"],
  },
  eventDispatched: {
    // `event_type` rather than `event` so the domain-event type name
    // doesn't collide with the envelope's `event` key (the log-event
    // name).  A line for an OrderPlaced dispatch reads:
    //   { event: "event_dispatched", event_type: "OrderPlaced", … }
    event: "event_dispatched",
    level: "info",
    fields: ["event_type", "aggregate", "id"],
  },
  // A seed dataset (declared `seed …`) was applied to the database — one
  // line per dataset, emitted by the boot-time seed runner.  `dataset` is
  // the seed's stable name.
  seedApplied: { event: "seed_applied", level: "info", fields: ["dataset"] },
  workflowStarted: { event: "workflow_started", level: "info", fields: ["workflow"] },
  workflowCompleted: { event: "workflow_completed", level: "info", fields: ["workflow"] },
  // An inbound event reached an `on(...)` reactor but no persisted workflow
  // instance existed for its correlation key — the continuation is dropped
  // (channels.md drop+log policy).  `event_type` mirrors `event_dispatched`.
  eventUnrouted: {
    event: "event_unrouted",
    level: "warn",
    fields: ["workflow", "event_type", "key"],
  },
  /** The outbox relay exhausted its retries for a durable event — the row
   *  stays in __loom_outbox (attempts ≥ max) for manual inspection
   *  (dispatch-delivery-semantics.md, the dead-letter surface). */
  eventDeadLettered: {
    event: "event_dead_lettered",
    level: "warn",
    fields: ["type", "attempts", "error"],
  },
  // Outbox relay lifecycle (dispatch-delivery-semantics.md).  The background
  // relay that drains __loom_outbox announces its start, and logs a recoverable
  // error (warn) when a drain pass throws — the relay keeps running.
  outboxRelayStarted: { event: "outbox_relay_started", level: "info", fields: [] },
  outboxRelayError: { event: "outbox_relay_error", level: "warn", fields: ["error"] },

  // Timer sources (scheduling.md §8, M-T4.1).  The infrastructure scheduler
  // that fires tick events on a wall-clock cadence.  Cross-backend parity —
  // every backend that emits a scheduler logs the same four events.
  // Broker channel transport (channels.md; M-T4.4 slice 2).  The producer
  // tee announces each envelope handed to the broker; the consumer loop
  // announces each envelope delivered into the in-process dispatcher, and
  // logs a recoverable warn when a handler (or a malformed envelope) fails —
  // the subscription keeps running.
  channelPublished: {
    event: "channel_published",
    level: "info",
    fields: ["address", "type", "id"],
  },
  channelConsumed: { event: "channel_consumed", level: "info", fields: ["address", "type", "id"] },
  channelConsumeFailed: {
    event: "channel_consume_failed",
    level: "warn",
    fields: ["address", "type", "error"],
  },
  // M-T4.4 slice 3 / M-T4.3 dead-letter surface: a poisoned message exhausts
  // its bounded retries (or is malformed beyond parsing) and parks in the
  // transport's dead-letter spot (`loom.dlq.<address>` on RabbitMQ) — kept,
  // not lost, and announced once.
  channelDeadLettered: {
    event: "channel_dead_lettered",
    level: "warn",
    fields: ["address", "type", "id", "attempts", "error"],
  },

  timerFired: { event: "timer_fired", level: "info", fields: ["timer"] },
  timerSkippedOverlap: { event: "timer_skipped_overlap", level: "info", fields: ["timer"] },
  timerLockContended: { event: "timer_lock_contended", level: "debug", fields: ["timer"] },
  timerEmitFailed: { event: "timer_emit_failed", level: "error", fields: ["timer", "error"] },
  // A boundary missed while every replica was down, replayed once on recovery
  // (coalesce-once catch-up — the durable-driver missed-run path, M-T4.1 Phase 2).
  timerCatchup: { event: "timer_catchup", level: "info", fields: ["timer", "boundary"] },

  // ─── domain — warn (client/domain fault, recoverable) ────────────────
  domainError: {
    event: "domain_error",
    level: "warn",
    fields: ["aggregate", "op", "message", "status"],
  },
  forbidden: {
    event: "forbidden",
    level: "warn",
    fields: ["aggregate", "op", "message", "status"],
  },
  /** A `when` canCommand gate rejected the operation — the aggregate's
   *  current state disallows it (criterion.md use site 2; HTTP 409). */
  disallowed: {
    event: "disallowed",
    level: "warn",
    fields: ["aggregate", "message", "status"],
  },
  /** An optimistic-concurrency guard (a `versioned` aggregate's
   *  `optimistic_lock`) found the row changed since the client read it — the
   *  stale write is rejected (HTTP 409).  Distinct from `disallowed` (a
   *  state-gate rejection) so a dashboard can tell a concurrency conflict from
   *  a business-rule refusal. */
  conflict: {
    event: "conflict",
    level: "warn",
    fields: ["aggregate", "message", "status"],
  },
  notFound: { event: "not_found", level: "warn", fields: ["aggregate", "id", "status"] },

  // ─── domain — error (system fault) ───────────────────────────────────
  externHandlerThrew: {
    event: "extern_handler_threw",
    level: "error",
    fields: ["aggregate", "op", "error"],
  },
  internalError: { event: "internal_error", level: "error", fields: ["error", "status"] },

  // ─── domain — debug (mechanism, live prod diagnosis) ─────────────────
  aggregateLoaded: {
    event: "aggregate_loaded",
    level: "debug",
    fields: ["aggregate", "id", "found"],
  },
  repositorySave: {
    event: "repository_save",
    level: "debug",
    fields: ["aggregate", "id", "children"],
  },
  findExecuted: {
    event: "find_executed",
    level: "debug",
    fields: ["aggregate", "find", "rows"],
  },
  auditRecorded: {
    event: "audit_recorded",
    level: "debug",
    fields: ["action", "target", "actor"],
  },
  provenanceRecorded: {
    event: "provenance_recorded",
    level: "debug",
    fields: ["aggregate", "field", "snapshot_id", "count"],
  },

  // ─── domain — trace (generate-time opt-in via --trace) ───────────────
  // Seam-level trace (no domain injection):
  txBegin: { event: "tx_begin", level: "trace", fields: ["aggregate", "id"] },
  txCommit: { event: "tx_commit", level: "trace", fields: ["aggregate", "id"] },
  txRollback: { event: "tx_rollback", level: "trace", fields: ["aggregate", "id", "error"] },
  childSynced: {
    event: "child_synced",
    level: "trace",
    fields: ["parent", "part", "id", "action"],
  },
  wireIn: { event: "wire_in", level: "trace", fields: ["keys"] },
  wireOut: { event: "wire_out", level: "trace", fields: ["keys"] },
  // Domain-injected trace — only emitted when --trace is on; never present
  // in the default artefact, keeping the domain layer pure by default.
  invariantEvaluated: {
    event: "invariant_evaluated",
    level: "trace",
    fields: ["aggregate", "op", "expr", "passed"],
    domain: true,
  },
  preconditionEvaluated: {
    event: "precondition_evaluated",
    level: "trace",
    fields: ["aggregate", "op", "expr", "passed"],
    domain: true,
  },
  valueComputed: {
    event: "value_computed",
    level: "trace",
    fields: ["aggregate", "field", "value"],
    domain: true,
  },
} as const satisfies Record<string, LogEvent>;

/** Lookup key for any catalog entry — used by per-backend renderers so a
 *  typo at a generator call site is a typecheck error, not a runtime
 *  missing-event surprise. */
export type LogEventKey = keyof typeof LogEvents;
