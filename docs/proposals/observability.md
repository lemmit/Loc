# Observability — structured logging via an IR-neutral event catalog

> Status: proposal. Builds on the existing `obs/request-id.ts` middleware
> emitted by every Hono deployable. Distinct from — and complementary to —
> the `audited` operation modifier (see
> [audit-and-logging.md](./audit-and-logging.md)): `audited` produces
> append-only, transactional, queryable rows; the logging here is the
> ordinary structured-log channel for everything else.

> **[2026-06-20 status audit]** SHIPPED (no longer 'proposal') — platform-neutral catalog `src/generator/_obs/log-events.ts` consumed by hono/dotnet/phoenix/java/python with per-backend obs-e2e gates (`package.json` `test:obs*`).

## Problem

A running app must explain itself. The generated Hono backend already
brackets every request with structured `request_start`/`request_end` JSON
lines, but the space between is silent — no business narrative, no
mechanism detail, no fine trace. Today the only emission mechanism is
`console.log(JSON.stringify(...))`: no level filtering, no per-request
context binding, no redaction, no cross-backend parity.

The goal: every generated backend explains what it did — at the
resolution the operator chooses — through a single shared schema.

## Goals

- **Standard logger per platform**: pino for Node/Hono, `ILogger` for
  .NET, `Logger` for Phoenix. No hand-rolled `console.log`.
- **Levels = concepts, not verbosity tiers.** Filtering to `warn` shows
  client/domain faults; `info` shows the domain narrative; `debug` shows
  mechanism; `trace` shows fine detail.
- **Single source of truth.** One IR-neutral catalog pins every event's
  name, level, and field schema. Per-backend emitters consume it. A log
  consumer sees the same `event`+`level`+fields regardless of platform.
- **Runtime gating for info/warn/error/debug; compile-time (generate-time)
  for trace.** Trace bloats output and may leak internals; default off.
- **Domain stays pure** at every level *except* trace (which is
  generate-time opt-in and therefore allowed to inject into domain
  methods).
- **Correlation by `request_id`** v1. Causation chains later.

## Non-goals (this proposal)

- OpenTelemetry tracing spans (orthogonal; can layer on top later).
- A per-field/op `logged` marker (the marker-based variant in
  `audit-and-logging.md`). The compiler already knows the model's
  semantics; logs fall out of the generator without DSL annotation.
- Metrics/counters.
- Log shipping / aggregation / retention.

## The envelope

Every line carries, automatically (via the per-request child logger):

```
{ ts, level, event, request_id, ...event-specific fields }
```

The base logger picks `LOG_LEVEL` from the env (pino default: `info`).
The request-id middleware mints/honours the id and binds a child logger
onto the Hono context (`c.set("log", baseLogger.child({ request_id }))`),
so every downstream seam reads it via `c.get("log")` without re-passing
the id.

## The catalog — two strata, one schema

The same catalog covers both strata. They differ only in *who emits*:

- **Domain-seam events** are emitted by per-model generators (routes,
  repository, workflow, dispatcher). They scale with the `.ddd` — every
  aggregate gets its own `operation_invoked`/`repository_save`/etc.
- **Infrastructure events** are emitted by platform scaffolding (boot
  script, db client, migration runner, health). A fixed set; doesn't
  vary with the model.

`request_start`/`request_end` (already shipped) are infrastructure
events under this split.

### Domain-seam events

**`info` — business narrative (what the system did)**

| event | fields | seam |
|---|---|---|
| `aggregate_created` | aggregate, id | create route, after save |
| `operation_invoked` | aggregate, op, id | operation route, after load |
| `event_dispatched` | event, aggregate, id | repository save → dispatcher |
| `workflow_started` / `workflow_completed` | workflow | workflow routes |

**`warn` — client/domain fault (recoverable, not our bug)**

| event | fields | seam |
|---|---|---|
| `domain_error` | aggregate, op, message, status=400 | router `onError` |
| `forbidden` | aggregate, op, message, status=403 | `onError` |
| `not_found` | aggregate, id, status=404 | `onError` / get-by-id |

**`error` — system fault (our bug / dependency down)**

| event | fields | seam |
|---|---|---|
| `extern_handler_threw` | aggregate, op, error | `onError` (ExternHandlerError) |
| `internal_error` | error, status=500 | `onError` fallback |

**`debug` — mechanism (live prod diagnosis)**

| event | fields | seam |
|---|---|---|
| `aggregate_loaded` | aggregate, id, found | repository `findById` |
| `repository_save` | aggregate, id, children:{name,inserted,updated,deleted} | repository `save` |
| `find_executed` | aggregate, find, rows | repository find methods |
| `audit_recorded` | action, target, actor | audit insert *(ties to `audited` feature)* |
| `provenance_recorded` | aggregate, field, snapshot_id, count | provenance flush |

**`trace` — fine detail (generate-time opt-in only)**

| event | fields | seam |
|---|---|---|
| `tx_begin` / `tx_commit` / `tx_rollback` | aggregate, id | repository transaction |
| `child_synced` | parent, part, id, action | save child loop |
| `wire_in` / `wire_out` | shape/keys | route handler |
| `invariant_evaluated` / `precondition_evaluated` | aggregate, op, expr, passed | **domain method** |
| `value_computed` | aggregate, field, value | **domain method** |

### Infrastructure events

**`info`**

| event | fields | seam |
|---|---|---|
| `request_start` / `request_end` | method, path (+ status, duration_ms) | request-id middleware *(exists)* |
| `server_starting` | env, version | boot script |
| `server_listening` | port, host | boot, post-listen |
| `server_shutdown` | signal | shutdown handler *(replaces current `console.log`)* |
| `server_drained` | pending | drain complete |
| `db_connected` | host, pool_size | db client init |
| `migrations_starting` / `migrations_complete` | count, applied | migration runner |
| `migration_applied` | id, name, duration_ms | migration runner |
| `auth_enabled` | required | boot, when auth: required |

**`debug`**

| event | fields | seam |
|---|---|---|
| `db_connecting` | host | db client init |
| `health_ok` / `health_degraded` | checks | health route |
| `extern_handlers_registered` | aggregate, count, ops | extern registry |

**`warn`**

| event | fields | seam |
|---|---|---|
| `db_disconnected` | reason | db client |
| `db_pool_exhausted` | waiters | db client |

**`error`**

| event | fields | seam |
|---|---|---|
| `db_error` | error, query? | db client / repo (system-level) |
| `migration_failed` | id, name, error | migration runner |

## Mechanism — catalog as code

A platform-neutral module, sibling to `_walker`/`_packs`:

```
src/generator/_obs/
  log-events.ts      # the catalog (single source of truth)
  render-hono.ts     # per-backend renderer — pino call expressions
  render-dotnet.ts   # later — ILogger / Serilog
  render-phoenix.ts  # later — Logger
```

```ts
// log-events.ts
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface LogEvent {
  /** machine-stable name; appears as the `event` field on every line */
  event: string;
  level: LogLevel;
  /** structured-field names beyond the envelope (ts/level/event/request_id) */
  fields: readonly string[];
  /** trace-only entries that may be injected into domain methods (the only
   *  level allowed to do so).  Always paired with `level: "trace"`. */
  domain?: boolean;
}

export const LogEvents = {
  aggregateCreated:  { event: "aggregate_created",     level: "info",  fields: ["aggregate", "id"] },
  operationInvoked:  { event: "operation_invoked",     level: "info",  fields: ["aggregate", "op", "id"] },
  eventDispatched:   { event: "event_dispatched",      level: "info",  fields: ["event", "aggregate", "id"] },
  repositorySave:    { event: "repository_save",       level: "debug", fields: ["aggregate", "id", "children"] },
  findExecuted:      { event: "find_executed",         level: "debug", fields: ["aggregate", "find", "rows"] },
  domainError:       { event: "domain_error",          level: "warn",  fields: ["aggregate", "op", "message", "status"] },
  // …
  invariantEval:     { event: "invariant_evaluated",   level: "trace", fields: ["aggregate","op","expr","passed"], domain: true },
  // …
} as const satisfies Record<string, LogEvent>;
```

Renderer (Hono/pino):

```ts
// render-hono.ts
export function renderHonoLogCall(eventKey: keyof typeof LogEvents, fieldsJs: string): string {
  const e = LogEvents[eventKey];
  return `c.get("log").${e.level}({ event: "${e.event}", ${fieldsJs} });`;
}
```

Per-backend renderers stay thin; the catalog file *is* the cross-backend
contract.

## Trace switch + domain-layer trace

Two coupled questions: **how to turn trace on** and **how trace reaches
the domain layer without breaking purity**.

**Turning trace on (generate-time):** v1 is a CLI flag on
`node bin/cli.js generate system <ddd> -o <out> --trace`. When set,
generators emit the `domain: true` catalog entries (and the trace-level
seam entries — `tx_*`, `wire_*`). When unset, none of those statements
appear in the output. A future `observability:` setting on the deployable
in the grammar can promote this to a declarative knob.

**Reaching the domain layer (AsyncLocalStorage):** without trace, domain
classes don't import a logger at all — purity preserved. With trace on,
the boot script wires Node's `AsyncLocalStorage` to carry the request
logger; the request-id middleware binds it once per request; domain
methods read it via a single helper (`requestLog().trace({...})`). This
is pino's documented pattern for request-scoped context without changing
method signatures, and it stays *entirely inside* the trace-on artefact —
no signature drift, no domain-layer infra import when off.

Runtime gating of info/debug/warn/error happens through pino's level
(`LOG_LEVEL` env), with the level check applied before any field-object
construction (pino does this natively + `isLevelEnabled()` for expensive
fields).

## Library choice — pino

For Node/Hono, **pino** is the standard:

- levels are exactly the taxonomy (`trace`(10) `debug`(20) `info`(30)
  `warn`(40) `error`(50));
- **child loggers** are the request-context binding mechanism
  (`logger.child({ request_id })`);
- lazy (level check before serialization); `isLevelEnabled()` to guard
  expensive fields;
- `redact` paths for PII as the actor / wire payload fields grow;
- emits JSON to stdout — the playground's existing line streaming keeps
  working unchanged;
- `pino-pretty` for the local dev / playground view.

`winston` is the heavier alternative; pino is the right default for a
new high-throughput service.

For other backends the standard library applies natively: **.NET**'s
`ILogger<T>` with message-template structured logging (Serilog as the
JSON sink if we want envelope parity), **Phoenix**'s `Logger` with
metadata.

## Backwards / forwards compatibility

- The current `request_start`/`request_end` shape is preserved (it
  already conforms to the envelope); the emitter changes underneath
  from `console.log(JSON.stringify(...))` to pino's serializer.
- The boot script's existing `console.log("listening on …")` and
  shutdown lines are replaced by their catalog equivalents
  (`server_listening`, `server_shutdown`).
- Catalog changes are additive in v1: new events / new fields don't
  break consumers; renaming/removal would. Treat the catalog as a wire
  contract, same governance as `wireShape`.

## Implementation phases

See the planning thread; this proposal pins the design, not the rollout.
