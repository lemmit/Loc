# 20. Observability & provenance

Two cross-cutting runtime concerns the compiler wires in for you — no DSL keyword for the first, one stored-field modifier for the second. **Observability**: every backend emits the same machine-parseable JSON log envelope, drawn from one platform-neutral event catalog, so a `jq` query written once works against any deployable. **Provenance**: mark a stored field `provenanced` and every assignment to it becomes an immutable rule snapshot, with a per-write runtime trace the backend persists so a computed value can be explained long after the fact. Reach for this chapter when you need a uniform log stream across a polyglot stack, or value-lineage you can audit.

> **Grammar:** `provenanced` property modifier (observability is emitter-level, no surface syntax) · **Validators:** `loom.provenanced-never-written` (warning), `loom.provenanced-backend-unsupported`; `provenanced` on a `derived` property is a **parse** error (the `DerivedProp` rule has no modifier slot) · **Source:** [`src/generator/_obs/log-events.ts`](../../src/generator/_obs/log-events.ts) (catalog), `src/generator/_obs/render-{hono,dotnet,phoenix,java}.ts` + `src/generator/python/emit/obs.ts` (renderers), `src/system/loomsnap.ts` (snapshot capture) · **Docs:** [`../observability.md`](../observability.md), [`../provenance.md`](../provenance.md)

## The catalog envelope

Every log line is a single JSON object. The catalog (`src/generator/_obs/log-events.ts`) is the one source of truth — each entry pins an `event` name, a `level`, and the structured fields it carries beyond the envelope. The envelope keys (`ts`, `level`, `event`, `request_id`, and — inside a request frame — `scope_id` / `actor_id`, plus `trace_id` / `span_id` when tracing is on) are auto-supplied; the catalog fields ride alongside as their own top-level keys, never nested under a `data` blob.

There is no `.ddd` for this — it is on by every backend that boots a server. The proof that it's *one* shape is that the same catalog event renders to the same envelope on every backend. Here is `request_end` (catalog: `level: "info"`, fields `method`/`path`/`status`/`duration_ms`) as emitted by each of the five backends from one `generate system` run over a five-deployable system:

::: tabs backend
== node
```ts
// obs/request-id.ts — pino, JSON native; ts/level/event/request_id auto-bound
const durationMs = Date.now() - startedAt;
log.info({
  event: "request_end",
  method: c.req.method,
  path: url.pathname,
  status: c.res.status,
  duration_ms: durationMs,
});
```
== dotnet
```csharp
// Middleware/RequestLoggingMiddleware.cs — ILogger, AddJsonConsole
_log.LogInformation("{Event} method={Method} path={Path} status={Status} duration_ms={DurationMs}", "request_end", ctx.Request.Method, ctx.Request.Path.Value ?? "/", ctx.Response.StatusCode, sw.ElapsedMilliseconds);
```
== java
```java
// config/RequestCatalogFilter.java — slf4j + JSON layout
CatalogLog.event(
    "request_end",
    "info",
    "method", request.getMethod(), /* … path, status, duration_ms */);
```
== python
```python
# app/obs/middleware.py — stdlib logging + JSON formatter
log(
    "info",
    "request_end",
    method=method,
    path=path,
    status=status,
    duration_ms=duration_ms,
)
```
== elixir
```elixir
# lib/<app>/telemetry.ex — :telemetry handler + the custom LogFormatter
Logger.info("request_end", event: "request_end", method: conn.method, path: conn.request_path, status: conn.status, duration_ms: duration_ms)
```
::: end

Five different loggers (pino, `ILogger`, slf4j, stdlib `logging`, Elixir `Logger`), one line on stdout:

```json
{"ts":"2026-06-22T18:51:32.823Z","level":"info","event":"request_end","request_id":"01J6…","method":"POST","path":"/orders/…/reprice","status":204,"duration_ms":7}
```

so `jq 'select(.event == "request_end") | {path, duration_ms, status}'` works unchanged on any deployable. On Elixir the field in the JSON payload is always `"warn"`, even though the `Logger` method is named `warning(...)`.

The catalog spans the full lifecycle: lifecycle bracket (`server_starting` → `server_listening` → `server_shutdown` → `server_drained`), request bracket (`request_start`/`request_end`), domain narrative at `info` (`aggregate_created`, `operation_invoked`, `event_dispatched`, `workflow_started`/`workflow_completed`, `seed_applied`, `timer_fired`, `channel_published`/`channel_consumed`), domain faults at `warn` (`domain_error`, `forbidden`, `disallowed`, `conflict`, `not_found`, `client_error`, `event_unrouted`), system faults at `error` (`internal_error`, `extern_handler_threw`, `migration_failed`, `db_error`, `timer_emit_failed`), mechanism detail at `debug` (`db_connecting`, `aggregate_loaded`, `repository_save`, `find_executed`, `audit_recorded`, `provenance_recorded`, `health_ok`), and trace-level detail (`tx_begin`/`tx_commit`/`tx_rollback`, `wire_in`/`wire_out`, `invariant_evaluated`, `precondition_evaluated`, `value_computed`) that only appears when codegen runs with `--trace`. Levels are *concepts*, not verbosity tiers — `warn` means "client/domain fault, recoverable", so filtering to `warn` shows faults regardless of how chatty the run is. The stability promise is additive-only: new events and new optional fields are safe; renaming or removing one is a downstream-consumer break. Full catalog + per-backend logger wiring, plus the Prometheus `/metrics` scrape and OpenTelemetry tracing every backend also ships: [`../observability.md`](../observability.md).

## `provenanced` fields

`provenanced` is a stored-field modifier that captures the **lineage** of every value the field holds. For each distinct assignment site (`:=` / `+=` / `-=`), the compiler content-addresses the right-hand-side expression into a **rule snapshot**, and the backend records a runtime trace on every write — enough to later answer "why is `order.total` 128?".

```ddd
aggregate Order with crudish {
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
  operation applyDiscount(amount: int) {
    discount := amount
    total := quantity * unitPrice - amount   // a second write-site → 1cfe25c0
  }
  derived display: string = reference
}
```

The grammar admits `provenanced` on any stored property, in any order relative to `sensitive(...)` and the access modifier (`total: int sensitive(pii) provenanced` and `total: int provenanced sensitive(pii)` both parse); it must precede `= default` / `check`. It is not admitted on a `derived` property (a parse error — its value is recomputed, not assigned). A provenanced field no operation ever writes is `loom.provenanced-never-written` (warning — no trace would ever be produced). Provenance has a runtime on **all five backends** — node, dotnet, java, python, and elixir; the frontends consume the lineage the backend recorded (see the wire carrier below) but run no capture. `loom.provenanced-backend-unsupported` names the host when a provenanced context lands on a deployable without the runtime.

### Per-backend trace emission

Each provenanced write site is wrapped: the generator snapshots the RHS leaf inputs *before* the write (so a self-referential `x := x + n` records the pre-write value), performs the write, builds a lineage value (`snapshotId` + inputs + post-write `computedValue`), and routes it to both a co-located backing field and a per-aggregate trace buffer. There is no standalone `recordTrace(...)` function — the capture is inlined statement-by-statement. Every tab below is from one five-deployable generation of the corpus fixture `test/fixtures/corpus/provenance.ddd` (the same domain as `examples/provenance.ddd`).

::: tabs backend
== node
```ts
// domain/order.ts — operation reprice, the inlined trace capture
this._quantity = qty;
this._unitPrice = price;
const __prov_4 = [{ path: "qty", value: qty }, { path: "price", value: price }, { path: "discount", value: this._discount }];
this._total = qty * price - this._discount;
const __lin_4: ProvLineage = { snapshotId: "13d60464", target: {"type":"Order","field":"total"}, inputs: __prov_4, computedValue: this._total };
this._total_provenance = __lin_4;   // current lineage, persisted on the row
this._provTraces.push(__lin_4);     // history buffer, drained at save
```
The buffer is emptied by `drainProv()`, called inside the operation's save transaction so the history commits atomically:
```ts
// http/order.routes.ts
await db.transaction(async (tx) => {
  const repoTx = new OrderRepository(tx, events);
  const aggregate = await repoTx.getById(Ids.OrderId(id));
  aggregate.reprice(body.qty, body.price);
  await repoTx.save(aggregate);
  const __prov = aggregate.drainProv();
  for (const t of __prov) {
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
  // …
});
```
== dotnet
```csharp
// Domain/Orders/Order.cs — operation Reprice
Quantity = qty;
UnitPrice = price;
var __prov_4 = new List<ProvInput> { new ProvInput("qty", qty), new ProvInput("price", price), new ProvInput("discount", this.Discount) };
Total = qty * price - this.Discount;
var __lin_4 = new ProvLineage("13d60464", new ProvTarget("Order", "total"), __prov_4, Total);
this.TotalProvenance = __lin_4;
this._provTraces.Add(__lin_4);
```
```csharp
// Infrastructure/Repositories/OrderRepository.cs — SaveAsync drains BEFORE SaveChangesAsync
var __prov = aggregate.DrainProv();
foreach (var __lin in __prov)
{
    _db.ProvenanceRecords.Add(new ProvenanceRecord
    {
        TraceId = Guid.NewGuid().ToString(),
        SnapshotId = __lin.SnapshotId,
        TargetType = __lin.Target.Type,
        Field = __lin.Target.Field,
        Inputs = System.Text.Json.JsonSerializer.Serialize(__lin.Inputs, ProvJson.Options),
        ComputedValue = System.Text.Json.JsonSerializer.Serialize(__lin.ComputedValue, ProvJson.Options),
        At = DateTime.UtcNow,
        CorrelationId = RequestContext.Current?.CorrelationId,
        ScopeId = RequestContext.Current?.ScopeId,
        ActorId = RequestContext.Current?.ActorId,
        ParentId = RequestContext.Current?.ParentId,
    });
}
```
== java
```java
// features/orders/Order.java — reprice(...)
this.quantity = qty;
this.unitPrice = price;
var __prov_4 = java.util.List.<ProvInput>of(new ProvInput("qty", qty), new ProvInput("price", price), new ProvInput("discount", this.discount));
this.total = qty * price - this.discount;
var __lin_4 = new ProvLineage("13d60464", new ProvTarget("Order", "total"), __prov_4, this.total);
this.totalProvenance = __lin_4;
this._provTraces.add(__lin_4);
```
```java
// features/orders/OrderRepositoryImpl.java — save(...) drains into ProvenanceRecordRepository
var __prov = aggregate.drainProv();
for (var __lin : __prov) {
    provenanceRecords.save(new ProvenanceRecord(
        java.util.UUID.randomUUID().toString(),
        __lin.snapshotId(),
        __lin.target().type(),
        __lin.target().field(),
        __lin.inputs(),
        __lin.computedValue(), /* …at, correlation/scope/actor/parent ids */));
}
```
== python
```python
# app/domain/order.py — reprice(...)
self._quantity = qty
self._unit_price = price
__prov_0 = [ProvInput(path="qty", value=qty), ProvInput(path="price", value=price), ProvInput(path="discount", value=self._discount)]
self._total = qty * price - self._discount
__lin_0 = ProvLineage(snapshot_id="13d60464", target=ProvTarget(type="Order", field="total"), inputs=__prov_0, computed_value=self._total)
self._total_provenance = __lin_0
record(__lin_0)          # app/domain/provenance.py — the per-request trace buffer
self._assert_invariants()
```
The repository's `save` drains the buffer into `provenance_records` inside the session transaction (`log("debug", "provenance_recorded", aggregate="Order", count=…)` marks the flush).
== elixir
```elixir
# lib/<app>/ordering.ex — the context's reprice_order/2, plain Ecto
record = %{record | quantity: qty}
record = %{record | unit_price: price}
loom_prov_inputs_2 = [%{path: "qty", value: qty}, %{path: "price", value: price}, %{path: "discount", value: record.discount}]
record = %{record | total: qty * price - record.discount}
loom_lineage_2 = %{snapshotId: "13d60464", target: %{type: "Order", field: "total"}, inputs: loom_prov_inputs_2, computedValue: record.total}
record = %{record | total_provenance: loom_lineage_2}
_ = DElixir.Provenance.record(loom_lineage_2)
# …then the changeset is persisted and DElixir.Provenance.flush(DElixir.Repo) runs inside one Repo.transaction.
```
::: end

Every history row also carries the ambient [request-context](../observability.md) ids — `correlation_id` (which request), `scope_id` (which frame), `parent_id` (the caller frame), `actor_id` (who computed) — the same tuple stamped on `audit_records`, so a forensic query joins the two. The `provenance_recorded` catalog event (debug level, fields `aggregate`/`field`/`snapshot_id`/`count`) marks each flush in the log stream.

### The wire shape — `Provenanced<T>`

A provenanced field's value and its lineage travel together as **one** wire object on all five backends and all six frontends — `{ "value": 120, "lineage": { "snapshotId", "target", "inputs", "computedValue" } | null }` (`lineage` is null until the first write). The shape is declared once (`GENERIC_SHAPES.provenanced`), stamped into `wireShape` once, and read by every DTO emitter through `src/generator/_payload/provenanced-wire.ts`; storage is unchanged (a typed value column plus a `<field>_provenance` jsonb column), and the request side carries the bare value. A scaffolded detail page renders a "?" disclosure over the lineage on React/Vue/Svelte/Angular/Feliz and the HEEx server render. See [`../provenance.md`](../provenance.md) § "The wire shape".

## `ddd snapshot` — capturing rule snapshots

Snapshot capture is **explicit and separate from codegen** — like `ef migrations add`, you run it deliberately whenever your provenance rules change:

```bash
ddd snapshot examples/provenance.ddd -o out
# → out/.loom/snapshots/<ts>-<guid>.loomsnap.json
```

Each capture is one immutable, timestamped + GUID-suffixed file holding every `provenanced` write-site's snapshot, so multiple captures coexist; the runtime uses the latest. `--dry-run` lists what would be captured without writing.

A snapshot is content-addressed: identical RHS expressions at different sites collapse to one `snapshotId`. Each entry records the source text, the **lowered IR** (names already bound, member types annotated, every node carrying its `origin` source span — not raw AST), and where the write lives.

```json
// .loom/snapshots/20260903T084824Z-4ec487e7-….loomsnap.json (origin spans elided)
{
  "captureId": "4ec487e7-6d16-4f04-b7f8-5cd7b9ac1cc5",
  "system": "OrderingSystem",
  "commitHash": "651388da9cde542e51f945e811a2ab0f1582d738",
  "capturedAt": "2026-09-03T08:48:24.960Z",
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
            "right": { "kind": "ref", "name": "price", "refKind": "param",     "type": { "kind": "primitive", "name": "int" } },
            "resultType": { "kind": "primitive", "name": "int" }
          },
          "right":   { "kind": "ref", "name": "discount", "refKind": "this-prop", "type": { "kind": "primitive", "name": "int" } },
          "resultType": { "kind": "primitive", "name": "int" }
        }
      },
      "source": { "path": "…/examples/provenance.ddd", "span": { "start": 1522, "end": 1544 } }
    },
    "1cfe25c0": { /* applyDiscount's `quantity * unitPrice - amount` */ },
    "3a1011f0": { /* the crudish-synthesised `update` op's `total := total` */ }
  }
}
```

The `snapshotId` (`13d60464`) is exactly the value the runtime stamps on every trace row for that write — the join key between a persisted `provenance_records` row and the rule that produced it. The IR captured here is the *resolved* form: `qty`/`price` carry `refKind: "param"`, `discount` carries `refKind: "this-prop"`, every node carries its resolved `type`. Two writes with the same RHS in different operations share one entry; that content-addressing is why snapshots are a map, not a list.

See [`../provenance.md`](../provenance.md) for the full runtime walkthrough and [`../tools.md`](../tools.md) for the `ddd snapshot` CLI surface.
