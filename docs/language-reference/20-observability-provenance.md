# 20. Observability & provenance

Two cross-cutting runtime concerns the compiler wires in for you — no DSL keyword for the first, one stored-field modifier for the second. **Observability**: every backend emits the same machine-parseable JSON log envelope, drawn from one platform-neutral event catalog, so a `jq` query written once works against any deployable. **Provenance**: mark a stored field `provenanced` and every assignment to it becomes an immutable rule snapshot, with a per-write runtime trace the backend persists so a computed value can be explained long after the fact. Reach for this chapter when you need a uniform log stream across a polyglot stack, or value-lineage you can audit.

> **Grammar:** `provenanced` property modifier (observability is emitter-level, no surface syntax) · **Validators:** `provenanced` rejected on `derived` properties; rejected on Ash-hosted aggregates · **Docs:** [`../observability.md`](../observability.md), [`../provenance.md`](../provenance.md)

## The catalog envelope

Every log line is a single JSON object. The catalog (`src/generator/_obs/log-events.ts`) is the one source of truth — each entry pins an `event` name, a `level`, and the structured fields it carries beyond the envelope. The envelope keys (`ts`, `level`, `event`, `request_id`, and — inside a request frame — `scope_id` / `actor_id`) are auto-supplied; the catalog fields ride alongside as their own top-level keys, never nested under a `data` blob.

There is no `.ddd` for this — it is on by every backend that boots a server. The proof that it's *one* shape is that the same catalog event renders to the same envelope on every backend. Here is `request_end` (catalog: `level: "info"`, fields `method`/`path`/`status`/`duration_ms`) as emitted by each backend from the same system:

::: tabs backend
== node
```ts
// obs/request-id.ts — pino, JSON native; ts/level/event/request_id auto-bound
log.info({
  event: "request_end",
  method: c.req.method,
  path: url.pathname,
  status: c.res.status,
  duration_ms: Date.now() - startedAt,
});
```
== dotnet
```csharp
// Middleware/RequestLoggingMiddleware.cs — ILogger, AddJsonConsole
_log.LogInformation(
  "{Event} method={Method} path={Path} status={Status} duration_ms={DurationMs}",
  "request_end", ctx.Request.Method, ctx.Request.Path.Value ?? "/",
  ctx.Response.StatusCode, sw.ElapsedMilliseconds);
```
== java
```java
// config/RequestCatalogFilter.java — slf4j + JSON layout
CatalogLog.event(
  "request_end",
  "info",
  "method", request.getMethod(),
  "path", request.getRequestURI(),
  "status", response.getStatus(),
  "duration_ms", durationMs);
```
== python
```python
# app/obs/middleware.py — stdlib logging + JSON formatter
log(
    "info",
    "request_end",
    method=request.method,
    path=request.url.path,
    status=response.status_code,
    duration_ms=int((time.monotonic() - started) * 1000),
)
```
::: end

Four different loggers (pino, `ILogger`, slf4j, stdlib `logging`), one line on stdout:

```json
{"ts":"2026-06-22T18:51:32.823Z","level":"info","event":"request_end","request_id":"01J6…","method":"POST","path":"/orders/…/reprice","status":204,"duration_ms":7}
```

so `jq 'select(.event == "request_end") | {path, duration_ms, status}'` works unchanged on any deployable. Elixir (Phoenix LiveView) consumes the same catalog via `:telemetry` and a custom `LogFormatter`; the field in the JSON payload is always `"warn"`, even though Elixir's `Logger` method is named `warning(...)`.

The catalog spans the full lifecycle: lifecycle bracket (`server_starting` → `server_listening` → `server_shutdown`), request bracket (`request_start`/`request_end`), domain narrative (`aggregate_created`, `operation_invoked`, `event_dispatched`, `workflow_started`), domain faults at `warn` (`domain_error`, `forbidden`, `not_found`), system faults at `error` (`internal_error`, `migration_failed`, `db_error`), and trace-level detail (`tx_begin`, `invariant_evaluated`) that only appears when codegen runs with `--trace`. Levels are *concepts*, not verbosity tiers — `warn` means "client/domain fault, recoverable", so filtering to `warn` shows faults regardless of how chatty the run is. The stability promise is additive-only: new events and new optional fields are safe; renaming or removing one is a downstream-consumer break. Full catalog + per-backend logger wiring: [`../observability.md`](../observability.md).

## `provenanced` fields

`provenanced` is a stored-field modifier that captures the **lineage** of every value the field holds. For each distinct assignment site (`:=` / `+=` / `-=`), the compiler content-addresses the right-hand-side expression into a **rule snapshot**, and the backend records a runtime trace on every write — enough to later answer "why is `order.total` 128?".

```ddd
aggregate Order ids guid with crudish {
  reference: string
  quantity: int
  unitPrice: int
  discount: int

  total: int provenanced               // marked

  operation reprice(qty: int, price: int) {
    quantity := qty
    unitPrice := price
    total := qty * price - discount    // write-site → snapshot 13d60464
  }
  derived display: string = reference
}
```

The grammar admits `provenanced` on any stored property; it is a compile error on a `derived` property (its value is recomputed, not assigned). Provenance has a runtime on **node**, **dotnet**, **java**, **python**, and **elixir on the `vanilla` foundation**; **elixir on `ash`** and **react** parse the keyword but emit no trace code (snapshot capture still runs for the whole system) — on Ash the validator rejects the field outright, the same as event-sourced storage. Honest gap, by design: declare the field once and only a runtime-capable deployable exercises it.

### Per-backend trace emission

Each provenanced write site is wrapped: the generator snapshots the RHS leaf inputs *before* the write (so a self-referential `x := x + n` records the pre-write value), performs the write, builds a lineage value (`snapshotId` + inputs + post-write `computedValue`), and routes it to both a co-located backing field and a per-aggregate trace buffer. There is no standalone `recordTrace(...)` function — the capture is inlined statement-by-statement.

::: tabs backend
== node
```ts
// domain/order.ts — operation reprice, the inlined trace capture
this._quantity = qty;
this._unitPrice = price;
const __prov_4 = [
  { path: "qty", value: qty },
  { path: "price", value: price },
  { path: "discount", value: this._discount },   // leaf inputs, pre-write
];
this._total = qty * price - this._discount;
const __lin_4: ProvLineage = {
  snapshotId: "13d60464",                          // content-addressed RHS
  target: { "type": "Order", "field": "total" },
  inputs: __prov_4,
  computedValue: this._total,                       // post-write value
};
this._total_provenance = __lin_4;   // current lineage, persisted on the row
this._provTraces.push(__lin_4);     // history buffer, drained at save
```
The buffer is emptied by `drainProv()`, called inside the operation's save transaction so the history commits atomically:
```ts
// http/order.routes.ts
await db.transaction(async (tx) => {
  const aggregate = await repoTx.getById(Ids.OrderId(id));
  aggregate.reprice(body.qty, body.price);
  await repoTx.save(aggregate);
  for (const t of aggregate.drainProv()) {
    await tx.insert(schema.provenanceRecords).values({
      traceId: randomUUID(),
      snapshotId: t.snapshotId,
      targetType: t.target.type,
      field: t.target.field,
      inputs: t.inputs,
      computedValue: t.computedValue,
      at: new Date(),
      correlationId: reqCtx?.correlationId ?? null,  // governance stamps —
      scopeId: reqCtx?.scopeId ?? null,              // join to audit_records
      actorId: reqCtx?.actorId ?? null,
      parentId: reqCtx?.parentId ?? null,
    });
  }
});
```
== dotnet
```csharp
// Domain/Orders/Order.cs — same shape in EF Core / CQRS terms
// • co-located `public ProvLineage? TotalProvenance { get; private set; }`
//   mapped to a `total_provenance` jsonb column via a value-converter
// • inline capture identical to the Hono withTrace logic (leaf inputs
//   before the write → ProvLineage → backing prop + _provTraces buffer)
// • repository SaveAsync drains DrainProv() into the ProvenanceRecord EF
//   entity BEFORE SaveChangesAsync, so history commits in the aggregate's
//   transaction; rows carry correlation/scope/parent/actor ids
// The provenance_records table + columns ship as one trailing EF migration.
```
== python
```python
# app/domain/order.py — same shape; @dataclass aggregate, jsonb column.
# Inline capture (leaf inputs pre-write → lineage dict → backing field +
# _prov_traces buffer); the repository drains into the provenance_records
# table inside the save transaction, rows stamped with the request-context ids.
```
== elixir
```elixir
# foundation: vanilla only — Phoenix + Ecto, no Ash.
# lib/<app>/<ctx>.ex — total := qty * price - discount, captured:
loom_prov_inputs_1 = [%{path: "qty", value: qty}, %{path: "price", value: price}, %{path: "discount", value: record.discount}]
record = %{record | total: qty * price - record.discount}
loom_lineage_1 = %{snapshot_id: "13d60464", target: %{type: "Order", field: "total"}, inputs: loom_prov_inputs_1, computed_value: record.total}
record = %{record | total_provenance: loom_lineage_1}
_ = MyApp.Provenance.record(loom_lineage_1)
# …then save + MyApp.Provenance.flush(MyApp.Repo) inside one Repo.transaction.
# foundation: ash → no-op at runtime (validator rejects the field on Ash).
```
::: end

Every history row also carries the ambient [request-context](../observability.md) ids — `correlation_id` (which request), `scope_id` (which frame), `parent_id` (the caller frame), `actor_id` (who computed) — the same tuple stamped on `audit_records`, so a forensic query joins the two. The `provenance_recorded` catalog event (debug level, fields `aggregate`/`field`/`snapshot_id`/`count`) marks each flush in the log stream.

## `ddd snapshot` — capturing rule snapshots

Snapshot capture is **explicit and separate from codegen** — like `ef migrations add`, you run it deliberately whenever your provenance rules change:

```bash
ddd snapshot examples/provenance.ddd -o out
# → out/.loom/snapshots/<ts>-<guid>.loomsnap.json
```

Each capture is one immutable, timestamped + GUID-suffixed file holding every `provenanced` write-site's snapshot, so multiple captures coexist; the runtime uses the latest. `--dry-run` lists what would be captured without writing.

A snapshot is content-addressed: identical RHS expressions at different sites collapse to one `snapshotId`. Each entry records the source text, the **lowered IR** (names already bound, member types annotated — not raw AST), and where the write lives.

```json
// .loom/snapshots/20260622T185132Z-767e3e8f-….loomsnap.json
{
  "captureId": "767e3e8f-4271-494c-a695-2d74cf600d7a",
  "system": "OrderingSystem",
  "commitHash": "5d62fe7b67c8fc558afcdea93f93a714faa7e92f",
  "capturedAt": "2026-06-22T18:51:32.823Z",
  "snapshots": {
    "13d60464": {
      "kind": "write-site",
      "target": { "type": "Order", "field": "total", "valueType": "int" },
      "expression": {
        "text": "qty * price - discount",
        "ast": {
          "kind": "binary", "op": "-",
          "left": {
            "kind": "binary", "op": "*",
            "left":  { "kind": "ref", "name": "qty",   "refKind": "param",     "type": { "kind": "primitive", "name": "int" } },
            "right": { "kind": "ref", "name": "price", "refKind": "param",     "type": { "kind": "primitive", "name": "int" } }
          },
          "right":   { "kind": "ref", "name": "discount", "refKind": "this-prop", "type": { "kind": "primitive", "name": "int" } }
        }
      },
      "source": { "path": "…/examples/provenance.ddd", "span": { "start": 1478, "end": 1509 } }
    }
    // …one entry per distinct write-site RHS. The crudish-synthesised
    // `update` op contributes its own write-site (3a1011f0).
  }
}
```

The `snapshotId` (`13d60464`) is exactly the value the runtime stamps on every trace row for that write — the join key between a persisted `provenance_records` row and the rule that produced it. The IR captured here is the *resolved* form: `qty`/`price` carry `refKind: "param"`, `discount` carries `refKind: "this-prop"`, every node carries its resolved `type`. Two writes with the same RHS in different operations share one entry; that content-addressing is why snapshots are a map, not a list.

See [`../provenance.md`](../provenance.md) for the full runtime walkthrough and [`../tools.md`](../tools.md) for the `ddd snapshot` CLI surface.
