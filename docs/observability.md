# Observability

Every generated backend emits **one shared, machine-parseable log shape**
so a dashboard, alert, or `jq` query written once works across every
deployable platform — Hono (Node.js), .NET (ASP.NET Core), Phoenix
(Elixir), Java (Spring Boot), Python (FastAPI).

The wire-shape pattern, applied to logs. One catalog defines the events;
per-backend renderers consume it; the framework's standard logger on each
platform writes the lines.

## The envelope

Every emitted line is a single JSON object on one line. Four keys are
always present:

| Key | Type | Notes |
|---|---|---|
| `ts` | ISO-8601 timestamp string | UTC, millisecond precision |
| `level` | `"trace"` / `"debug"` / `"info"` / `"warn"` / `"error"` | The emitted JSON value is `"warn"` on every backend; Phoenix's `Logger` API method happens to be named `warning(...)`, but the field in the JSON payload is `"warn"`. |
| `event` | string | The catalog identity (see below) |
| `request_id` | string | Per-request UUID; missing on boot-time lines |

Two further carrier ids ride on every line emitted **inside a request frame**
(absent on boot-time lines), so a log line joins to the audit / provenance rows
written in the same frame:

| Key | Type | Notes |
|---|---|---|
| `scope_id` | string | The frame's id — matches the `scope_id` column on `audit_records` / `provenance_records`. A workflow's child frame surfaces its own scope (Hono / .NET). |
| `actor_id` | string | The principal's id; present only once auth has run (omitted under no-auth / on pre-auth lines). |

Both come from the ambient execution-context carrier — see
[`request-context.md`](architecture/request-context.md).  Each backend binds
them at its native logging seam (pino `mixin`, ASP.NET `BeginScope`, Java `MDC`,
the Python contextvar formatter, Elixir `Logger.metadata`), read at log time so
per-frame accuracy holds.

Catalog-specific structured fields ride alongside the envelope as their
own top-level keys (`method`, `path`, `status`, `duration_ms`,
`aggregate`, `workflow`, …) — not nested under a `data` field. This keeps
`jq '.event == "request_end" | .duration_ms'` working on every backend
without dialect differences.

## The catalog

`src/generator/_obs/log-events.ts` is the single source of truth. Every
event pins its `event` name, level, and field set. Per-backend renderers
(`src/generator/_obs/render-{hono,dotnet,phoenix}.ts`, plus the Java and
Python renderers under their backend dirs —
`src/generator/java/emit/observability.ts` and
`src/generator/python/emit/obs.ts`) consume it; a typo at any generator
call site is a typecheck error, not a runtime missing-event surprise.

Stability promise: **additive only**. New events / new optional fields
won't break consumers. Renaming or removing requires a downstream
migration.

### Levels are concepts, not verbosity tiers

| Level | Meaning | Examples |
|---|---|---|
| `error` | System fault — needs operator action | `internal_error`, `extern_handler_threw`, `migration_failed` |
| `warn` | Client/domain fault, recoverable | `domain_error`, `forbidden`, `not_found`, `db_disconnected` |
| `info` | Business narrative — what the app did | `request_start`, `request_end`, `server_listening`, `aggregate_created`, `workflow_started` |
| `debug` | Mechanism — live-prod diagnosis | `aggregate_loaded`, `repository_save`, `find_executed`, `health_ok` |
| `trace` | Fine detail — generate-time opt-in (`--trace`) | `tx_begin`, `wire_in`, `invariant_evaluated` |

Filter to `warn` and you see only faults. Filter to `info` and you
see the domain narrative without the noise. The `--trace` switch is the
only way to inject trace lines into domain methods (kept off by default
so the default artefact stays pure).

### Catalog excerpt

The full list lives in `src/generator/_obs/log-events.ts`. Highlights:

**Lifecycle bracket** (every backend):
`server_starting` → `server_listening` → `server_shutdown` → `server_drained`

**Request bracket** (every backend):
`request_start` → `request_end` — with `method`, `path`, `status`,
`duration_ms`.

**Domain narrative** (info — emitted on every domain action):
`aggregate_created`, `operation_invoked`, `event_dispatched`,
`workflow_started`, `workflow_completed`.

**Domain faults** (warn — recoverable):
`domain_error`, `forbidden`, `not_found`.

**System faults** (error):
`internal_error`, `extern_handler_threw`, `migration_failed`,
`db_error`.

**Database lifecycle** (info / warn / error):
`db_connecting`, `db_connected`, `db_disconnected` (warn),
`db_pool_exhausted` (warn), `db_error` (error).

**Migrations** (info / error):
`migrations_starting`, `migration_applied`, `migrations_complete`,
`migration_failed` (error).

**Auth and audit** (info / debug):
`auth_enabled`, `audit_recorded` (debug), `provenance_recorded`
(debug).

**Transactions and child sync** (trace):
`tx_begin`, `tx_commit`, `tx_rollback`, `child_synced`.

**Health** (info / debug):
`health_ok`, `health_degraded`.

**Extern lifecycle** (debug):
`extern_handlers_registered`.

This list is an excerpt of what the catalog ships; the file
`src/generator/_obs/log-events.ts` is authoritative.

**Domain trace** (opt-in via `--trace`):
`invariant_evaluated`, `precondition_evaluated`, `value_computed`.

## Per-backend implementation

| Backend | Logger | JSON output | Per-request context |
|---|---|---|---|
| **Hono** | [pino](https://github.com/pinojs/pino) | Native — pino emits JSON by default | `req.log` child logger; envelope auto-bound |
| **.NET** | `ILogger<T>` | `AddJsonConsole` — structured fields land under `State.<Pascal>` | `IHttpContextAccessor` + `BeginScope`; `Activity.Current.TraceId` carries `request_id` |
| **Phoenix** | Elixir `Logger` | Custom `<App>.LogFormatter` — see [`lib/<app>/log_formatter.ex`](https://github.com/lemmit/Loc/blob/main/src/generator/phoenix-live-view/index.ts) | `:telemetry` handlers attach `[:phoenix, :endpoint, :start/:stop]` and translate to catalog identity; the `<App>.RequestContext` Plug stamps `correlation_id`/`scope_id` (and `actor_id` post-auth) into `Logger.metadata`, which the LogFormatter dumps onto every line — see [`request-context.md`](architecture/request-context.md) |
| **Java** | slf4j + Logback | JSON layout; structured fields land on each line | `MDC` carries `request_id`/`scope_id`/`actor_id`, read at log time |
| **Python** | stdlib `logging` | JSON formatter | a `contextvar` carries the per-frame ids, read by the formatter at log time |

The renderers in `src/generator/_obs/` keep the per-backend differences
local. A call site like `renderHonoLogCall("requestEnd", […])` emits the
right `req.log.info(…)` for Hono, the right `_log.LogInformation(…)`
for .NET, the right `Logger.info(…)` for Phoenix — all carrying the
same catalog identity.

## Consuming the stream

```bash
# Pretty-print everything (jq).
docker compose logs -f api | jq -C .

# Just failures and their messages.
docker compose logs api | jq 'select(.level == "warn" or .level == "error") | {ts, event, message}'

# Slowest 10 requests.
docker compose logs api | jq -c 'select(.event == "request_end") | {path, duration_ms, status}' | sort -t: -k2 -rn | head

# Correlate a single request across every log line.
RID=01J6...
docker compose logs api | jq "select(.request_id == \"$RID\")"
```

The same queries work against the .NET, Phoenix, Java, and Python deployables.

## Verification

Five runtime end-to-end suites boot the generated server against a real
postgres, hit `/health`, and assert the JSON stream carries the full
lifecycle + request bracket with the catalog envelope. Opt-in via env
vars (kept out of `npm test` because they're slow):

```bash
LOOM_OBS_E2E=1            npx vitest run test/e2e/observability-events.test.ts
LOOM_OBS_E2E_DOTNET=1     npx vitest run test/e2e/observability-events-dotnet.test.ts
LOOM_OBS_E2E_PHOENIX=1    npx vitest run test/e2e/observability-events-phoenix.test.ts
LOOM_OBS_E2E_JAVA=1       npx vitest run test/e2e/observability-events-java.test.ts
LOOM_OBS_E2E_PYTHON=1     npx vitest run test/e2e/observability-events-python.test.ts
```

Each suite:
1. Generates the backend project from a fixture.
2. Spins up a throwaway `postgres:18-alpine` sidecar.
3. Boots the server.
4. Waits for `server_listening` to appear on stdout.
5. Hits `/health`.
6. `SIGTERM`s the process group; waits for exit.
7. Parses the JSON stream and asserts the catalog envelope + lifecycle order.

`.github/workflows/{hono,dotnet,phoenix,java,python}-obs-e2e.yml` run their
respective suites on every PR that touches the matching generator,
the shared catalog, or the renderer. Each opts in via the
backend-specific env var (`LOOM_OBS_E2E*`) and skips locally when
not enabled.

Prerequisites:
- **Hono**: Node only — runs in pure Node, no sidecar required (the
  generated pg pool is lazy).
- **.NET**: docker (for the postgres sidecar) + `dotnet` SDK 8+.
- **Phoenix**: docker + `mix` + Erlang/OTP.
- **Java**: docker (for the postgres sidecar) + JDK 21 + Gradle.
- **Python**: docker (for the postgres sidecar) + `uv`.

When the env var is set but a prereq is missing, the suite **fails
loudly with an actionable message** rather than skipping silently —
so a misconfigured CI surfaces as a real failure pointing at what to
add to the workflow.

## Extending the catalog

Add an event:

```ts
// src/generator/_obs/log-events.ts
myEvent: { event: "my_event", level: "info", fields: ["foo", "bar"] },
```

Then emit it at the right seam in each backend that should fire it:

```ts
// In a Hono builder
renderHonoLogCall("myEvent", [
  { name: "foo", valueExpr: "foo" },
  { name: "bar", valueExpr: "bar" },
])

// In a .NET emitter
renderDotnetLogCall("myEvent", [
  { name: "foo", valueExpr: "foo" },
  { name: "bar", valueExpr: "bar" },
])

// In a Phoenix emitter
renderPhoenixLogCall("myEvent", [
  { name: "foo", valueExpr: "foo" },
  { name: "bar", valueExpr: "bar" },
])
```

The Java (`src/generator/java/emit/observability.ts`) and Python
(`src/generator/python/emit/obs.ts`) backends consume the same catalog
through their own log-call seams; emit the new event there too for full
five-backend coverage.

The renderer enforces field-set correctness against the catalog at
generate time. A `LOOM_OBS_E2E_*=1` run then verifies the line actually
arrives on stdout with the expected envelope at runtime.

For domain-injected trace events (gated by `--trace`), set
`domain: true` in the catalog entry — the renderer routes through the
domain-log seam (`DomainLog.Current` in .NET, `Logger` directly in
Phoenix where `:telemetry` carries it).

## Further reading

- [`docs/old/proposals/observability.md`](https://github.com/lemmit/Loc/blob/main/docs/old/proposals/observability.md)
  — design rationale, level-as-concept analysis.  (`proposals/`
  isn't deployed to the docs site; link points at GitHub.)
- [`docs/traceability.md`](./traceability.md) — separate concern;
  `audited` operations are append-only DB rows, distinct from the
  structured log channel here.
