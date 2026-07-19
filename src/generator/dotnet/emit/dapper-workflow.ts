// ---------------------------------------------------------------------------
// Dapper (raw Npgsql) workflow / saga / outbox / event-store adapters
// (M-T6.9 — draining the last `persistence: dapper` gate).
//
// The default EF path weaves the concrete `AppDbContext` through the workflow
// surface: the saga handlers inject EF-tracked `ISagaStateStore<>` /
// `IWorkflowEventStore<>` / `IReadModelStore<>` (PersistencePorts.cs, EF), the
// outbox relay is an EF-querying BackgroundService, and the saga / event /
// outbox tables are EF-migration-owned.  A Dapper deployable emits none of
// that.  This module supplies the raw-Npgsql equivalents behind the dapper
// branch, so the SAME persistence-neutral orchestration handlers (which depend
// only on the `Domain.Common` port interfaces) run unchanged:
//
//   - closed-generic Dapper `ISagaStateStore<<Wf>State>` / `IReadModelStore<
//     <Proj>Row>` implementations (load-all + in-memory predicate + upsert),
//   - a per-context `IWorkflowEventStore<<Ctx>EventRecord>` over `<ctx>_events`,
//   - a `DapperUnitOfWork` (real Npgsql transaction),
//   - an Npgsql-querying outbox dispatcher + relay BackgroundService,
//   - the saga / projection / outbox table DDL (rendered into `DbSchema.cs`),
//
// while keeping the EF output byte-identical when `persistence: efcore`
// (everything here is gated on the dapper branch in index.ts / program.ts).
// ---------------------------------------------------------------------------

import {
  isMaterializedProjection,
  isSingletonProjection,
  type ProjectionIR,
  type WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";
import {
  projectionRowClass,
  projectionRowTable,
  renderProjectionRowEntity,
} from "../projection-state-emit.js";
import {
  correlationWorkflows,
  renderWorkflowStateEntity,
  workflowStateClass,
  workflowStateTable,
} from "../workflow-state-emit.js";
import { type DapperColumn, fieldColumn } from "./dapper.js";
import { eventRecordClass, renderEventRecordPoco } from "./event-store.js";

/** A projection that persists a KEYED read-model row (the IReadModelStore /
 *  DbSchema-table users) — materialized + keyed.  Query-time / singleton
 *  projections carry no stored row table in v1. */
function projectionNeedsRowStore(proj: ProjectionIR): boolean {
  return isMaterializedProjection(proj) && !isSingletonProjection(proj);
}

/** The Dapper saga-state store class name for a workflow. */
function sagaStoreClass(wf: WorkflowIR): string {
  return `Dapper${workflowStateClass(wf)}Store`;
}

/** The Dapper read-model store class name for a projection. */
function readModelStoreClass(proj: ProjectionIR): string {
  return `Dapper${projectionRowClass(proj)}Store`;
}

/** The Dapper per-context event-store class name. */
function eventStoreClass(ctxName: string): string {
  return `Dapper${eventRecordClass(ctxName)}Store`;
}

/** The saga-state columns for a workflow, in declaration order (correlation
 *  field first as the PK), plus the durable idempotent-consumer marker.  The
 *  column shape mirrors `fieldColumn` (the aggregate repositories' mapper) so
 *  the DDL types + JSON casts match the rest of the Dapper output exactly. */
export function dapperWorkflowStateColumns(wf: WorkflowIR, durable: boolean): DapperColumn[] {
  return stateColumns(wf, durable);
}

function stateColumns(wf: WorkflowIR, durable: boolean, accBase = "s"): DapperColumn[] {
  const cols = (wf.stateFields ?? []).map((f) => fieldColumn(f, accBase));
  if (durable) {
    cols.push({
      col: "last_event_id",
      sql: "text",
      nullable: true,
      rowCs: "string?",
      cast: "",
      save: `${accBase}.LastEventId`,
      stateProp: "LastEventId",
      hydrate: "r.last_event_id",
    });
  }
  return cols;
}

/** The read-model columns for a projection (public alias for view-handler
 *  reuse).  Non-key columns are NULLABLE (a fold upserts only the fields an
 *  event carries — projectionTableShape). */
export function dapperProjectionColumns(proj: ProjectionIR): DapperColumn[] {
  return projectionColumns(proj);
}

/** The read-model columns for a projection.  Non-key columns are NULLABLE (a
 *  fold upserts only the fields an event carries — projectionTableShape). */
function projectionColumns(proj: ProjectionIR, accBase = "s"): DapperColumn[] {
  const corr = proj.correlationField;
  return proj.stateFields.map((f) => {
    const c = fieldColumn(f, accBase);
    return f.name === corr ? c : { ...c, nullable: true };
  });
}

/** `CREATE TABLE IF NOT EXISTS` for a keyed saga / projection row: `pkCol` is
 *  the primary key column, the rest carry ` not null` unless nullable. */
function keyedTableDdl(table: string, pkCol: string, cols: DapperColumn[]): string {
  const body = cols.map((c) => {
    if (c.col === pkCol) return `    ${c.col} ${c.sql} primary key`;
    return `    ${c.col} ${c.sql}${c.nullable ? "" : " not null"}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${table} (\n${body.join(",\n")}\n);`;
}

/** The transactional-outbox table DDL (dispatch-delivery-semantics.md), the
 *  raw-Npgsql mirror of `outboxTableShape`. */
export function dapperOutboxTableDdl(): string {
  return [
    "CREATE TABLE IF NOT EXISTS __loom_outbox (",
    "    id uuid primary key default gen_random_uuid(),",
    "    occurred_at timestamptz not null default now(),",
    "    type text not null,",
    "    payload jsonb not null,",
    "    dispatched_at timestamptz,",
    "    attempts int not null default 0",
    ");",
  ].join("\n");
}

/** Every extra `CREATE TABLE` the Dapper workflow surface needs, spliced into
 *  `DbSchema.cs` alongside the aggregate / event-log / provenance tables.  The
 *  `<ctx>_events` log itself is already emitted by `renderDapperSchema` (its
 *  `eventLogContexts` cover event-sourced workflows). */
export function dapperWorkflowTables(
  workflows: readonly WorkflowIR[],
  projections: readonly ProjectionIR[],
  durable: boolean,
  hasOutbox: boolean,
): string[] {
  const out: string[] = [];
  for (const wf of correlationWorkflows(workflows)) {
    out.push(
      keyedTableDdl(
        workflowStateTable(wf),
        snake(wf.correlationField as string),
        stateColumns(wf, durable),
      ),
    );
  }
  for (const proj of projections) {
    if (!projectionNeedsRowStore(proj)) continue;
    out.push(
      keyedTableDdl(
        projectionRowTable(proj),
        snake(proj.correlationField as string),
        projectionColumns(proj),
      ),
    );
  }
  if (hasOutbox) out.push(dapperOutboxTableDdl());
  return out;
}

/** A private `Row` DTO + a `Map` builder producing the closed row/POCO type
 *  from a Dapper-read row.  Shared by the store's `FindAsync` and the
 *  instances controller's Dapper read. */
function rowClassAndMap(pocoClass: string, cols: DapperColumn[]): string[] {
  const rowProps = cols.map(
    (c) => `        public ${c.rowCs} ${c.col} { get; set; }${c.nullable ? "" : " = default!;"}`,
  );
  const inits = cols.map((c) => `            ${c.stateProp} = ${c.hydrate},`);
  return [
    "    private sealed class Row",
    "    {",
    ...rowProps,
    "    }",
    "",
    `    private static ${pocoClass} Map(Row r) => new()`,
    "    {",
    ...inits,
    "    };",
  ];
}

/** The SELECT column list + INSERT-upsert SQL fragments shared by the store. */
function selectList(cols: DapperColumn[]): string {
  return cols.map((c) => c.col).join(", ");
}

/** A closed-generic Dapper store implementing `ISagaStateStore<TRow>` /
 *  `IReadModelStore<TRow>` — load-all + in-memory predicate + buffered upsert.
 *  `FindAsync` materialises every row and applies the compiled predicate
 *  (correctness over scale — v1, the raw-SQL mirror of the document-shape
 *  in-memory find); `Add` / a found row are both buffered and upserted on
 *  `SaveChangesAsync`. */
function renderRowStore(
  storeClass: string,
  iface: string,
  pocoClass: string,
  table: string,
  pkCol: string,
  cols: DapperColumn[],
): string[] {
  const nonPk = cols.filter((c) => c.col !== pkCol);
  const insertCols = cols.map((c) => c.col).join(", ");
  const insertVals = cols.map((c) => `@${c.col}${c.cast}`).join(", ");
  const setClause = nonPk.map((c) => `${c.col} = excluded.${c.col}`).join(", ");
  const bind = cols.map((c) => `${c.col} = ${c.save}`).join(", ");
  const upsert =
    setClause.length > 0
      ? `INSERT INTO ${table} (${insertCols}) VALUES (${insertVals}) ON CONFLICT (${pkCol}) DO UPDATE SET ${setClause}`
      : `INSERT INTO ${table} (${insertCols}) VALUES (${insertVals}) ON CONFLICT (${pkCol}) DO NOTHING`;
  return [
    `public sealed class ${storeClass} : ${iface}<${pocoClass}>`,
    "{",
    "    private readonly NpgsqlDataSource _db;",
    `    private readonly List<${pocoClass}> _pending = new();`,
    `    public ${storeClass}(NpgsqlDataSource db) => _db = db;`,
    "",
    `    public async Task<${pocoClass}?> FindAsync(Expression<Func<${pocoClass}, bool>> predicate, CancellationToken cancellationToken = default)`,
    "    {",
    "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
    `        var rows = await conn.QueryAsync<Row>(new CommandDefinition("SELECT ${selectList(cols)} FROM ${table}", cancellationToken: cancellationToken));`,
    "        var match = rows.Select(Map).AsQueryable().FirstOrDefault(predicate);",
    "        if (match is not null) _pending.Add(match);",
    "        return match;",
    "    }",
    "",
    `    public void Add(${pocoClass} row) => _pending.Add(row);`,
    "",
    "    public async Task SaveChangesAsync(CancellationToken cancellationToken = default)",
    "    {",
    "        if (_pending.Count == 0) return;",
    "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
    "        foreach (var s in _pending)",
    `            await conn.ExecuteAsync(new CommandDefinition("${upsert}", new { ${bind} }, cancellationToken: cancellationToken));`,
    "        _pending.Clear();",
    "    }",
    "",
    ...rowClassAndMap(pocoClass, cols),
    "}",
  ];
}

/** A per-context Dapper `IWorkflowEventStore<<Ctx>EventRecord>` over the shared
 *  `<ctx>_events` log — the raw-Npgsql mirror of `EfWorkflowEventStore`. */
function renderEventStore(ns: string, ctxName: string): string[] {
  const cls = eventStoreClass(ctxName);
  const rec = `global::${ns}.Infrastructure.Persistence.Events.${eventRecordClass(ctxName)}`;
  const table = `${snake(ctxName)}_events`;
  return [
    `public sealed class ${cls} : IWorkflowEventStore<${rec}>`,
    "{",
    "    private readonly NpgsqlDataSource _db;",
    `    private readonly List<${rec}> _pending = new();`,
    `    public ${cls}(NpgsqlDataSource db) => _db = db;`,
    "",
    `    public async Task<List<${rec}>> LoadStreamAsync(string streamType, string streamId, CancellationToken cancellationToken = default)`,
    "    {",
    "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
    `        var rows = await conn.QueryAsync<${rec}>(new CommandDefinition(`,
    `            "SELECT seq AS Seq, stream_type AS StreamType, stream_id AS StreamId, version AS Version, type AS Type, data AS Data, occurred_at AS OccurredAt FROM ${table} WHERE stream_type = @streamType AND stream_id = @streamId ORDER BY version",`,
    "            new { streamType, streamId }, cancellationToken: cancellationToken));",
    "        return rows.ToList();",
    "    }",
    "",
    "    public async Task<int> MaxVersionAsync(string streamType, string streamId, CancellationToken cancellationToken = default)",
    "    {",
    "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
    "        return await conn.ExecuteScalarAsync<int?>(new CommandDefinition(",
    `            "SELECT MAX(version) FROM ${table} WHERE stream_type = @streamType AND stream_id = @streamId",`,
    "            new { streamType, streamId }, cancellationToken: cancellationToken)) ?? 0;",
    "    }",
    "",
    `    public void Append(${rec} row) => _pending.Add(row);`,
    "",
    "    public async Task SaveChangesAsync(CancellationToken cancellationToken = default)",
    "    {",
    "        if (_pending.Count == 0) return;",
    "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
    "        foreach (var r in _pending)",
    "            await conn.ExecuteAsync(new CommandDefinition(",
    `                "INSERT INTO ${table} (stream_type, stream_id, version, type, data, occurred_at) VALUES (@StreamType, @StreamId, @Version, @Type, @Data::jsonb, @OccurredAt)",`,
    "                r, cancellationToken: cancellationToken));",
    "        _pending.Clear();",
    "    }",
    "}",
  ];
}

/** The single `Infrastructure/Persistence/DapperPersistencePorts.cs` carrying
 *  every Dapper port adapter for the deployable's workflow / projection surface. */
export function renderDapperPersistencePorts(
  ns: string,
  workflows: readonly WorkflowIR[],
  projections: readonly ProjectionIR[],
  durable: boolean,
  eventLogContextNames: readonly string[],
): string {
  const blocks: string[] = [];
  // Unit of work — a real Npgsql transaction (the Dapper repositories open
  // their own per-call connections, so this covers only work done on the
  // returned transaction's connection; v1 correctness for the single-writer
  // command handlers, byte-neutral otherwise).
  blocks.push(
    [
      "public sealed class DapperUnitOfWork : IUnitOfWork",
      "{",
      "    private readonly NpgsqlDataSource _db;",
      "    public DapperUnitOfWork(NpgsqlDataSource db) => _db = db;",
      "",
      "    public async Task<IDomainTransaction> BeginTransactionAsync(CancellationToken cancellationToken = default)",
      "    {",
      "        var conn = await _db.OpenConnectionAsync(cancellationToken);",
      "        var tx = await conn.BeginTransactionAsync(cancellationToken);",
      "        return new DapperDomainTransaction(conn, tx);",
      "    }",
      "",
      "    public async Task<IDomainTransaction> BeginTransactionAsync(System.Data.IsolationLevel isolationLevel, CancellationToken cancellationToken = default)",
      "    {",
      "        var conn = await _db.OpenConnectionAsync(cancellationToken);",
      "        var tx = await conn.BeginTransactionAsync(isolationLevel, cancellationToken);",
      "        return new DapperDomainTransaction(conn, tx);",
      "    }",
      "}",
      "",
      "public sealed class DapperDomainTransaction : IDomainTransaction",
      "{",
      "    private readonly NpgsqlConnection _conn;",
      "    private readonly System.Data.Common.DbTransaction _tx;",
      "    public DapperDomainTransaction(NpgsqlConnection conn, System.Data.Common.DbTransaction tx) { _conn = conn; _tx = tx; }",
      "    public Task CommitAsync(CancellationToken cancellationToken = default) => _tx.CommitAsync(cancellationToken);",
      "    public Task RollbackAsync(CancellationToken cancellationToken = default) => _tx.RollbackAsync(cancellationToken);",
      "    public async ValueTask DisposeAsync() { await _tx.DisposeAsync(); await _conn.DisposeAsync(); }",
      "}",
    ].join("\n"),
  );
  for (const wf of correlationWorkflows(workflows)) {
    const cls = sagaStoreClass(wf);
    const poco = workflowStateClass(wf);
    blocks.push(
      renderRowStore(
        cls,
        "ISagaStateStore",
        `global::${ns}.Infrastructure.Persistence.Workflows.${poco}`,
        workflowStateTable(wf),
        snake(wf.correlationField as string),
        stateColumns(wf, durable),
      ).join("\n"),
    );
  }
  for (const proj of projections) {
    if (!projectionNeedsRowStore(proj)) continue;
    const cls = readModelStoreClass(proj);
    const poco = projectionRowClass(proj);
    blocks.push(
      renderRowStore(
        cls,
        "IReadModelStore",
        `global::${ns}.Infrastructure.Persistence.Projections.${poco}`,
        projectionRowTable(proj),
        snake(proj.correlationField as string),
        projectionColumns(proj),
      ).join("\n"),
    );
  }
  for (const ctxName of eventLogContextNames) {
    blocks.push(renderEventStore(ns, ctxName).join("\n"));
  }
  return (
    lines(
      "// Auto-generated.  Dapper (raw Npgsql) adapters for the domain persistence",
      "// ports (M-T6.9 — the raw-SQL siblings of PersistencePorts.cs's EF adapters).",
      "using System;",
      "using System.Collections.Generic;",
      "using System.Linq;",
      "using System.Linq.Expressions;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      "using Dapper;",
      "using Npgsql;",
      `using ${ns}.Domain.Common;`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      blocks.join("\n\n"),
    ) + "\n"
  );
}

/** Emit every Dapper workflow / projection / event-log INFRASTRUCTURE file on
 *  the dapper branch: the persistence-neutral row POCOs (workflow-state,
 *  projection-row, per-context event-record — reused verbatim from the EF
 *  emitters, minus their `IEntityTypeConfiguration`) plus the Dapper port
 *  adapters.  The EF-only configs / AppDbContext are NOT emitted. */
export function emitDapperWorkflowInfra(
  ns: string,
  workflows: readonly WorkflowIR[],
  projections: readonly ProjectionIR[],
  eventLogContextNames: readonly string[],
  durable: boolean,
  out: Map<string, string>,
): void {
  for (const ctxName of eventLogContextNames) {
    out.set(
      `Infrastructure/Persistence/Events/${eventRecordClass(ctxName)}.cs`,
      renderEventRecordPoco(ns, ctxName),
    );
  }
  for (const wf of correlationWorkflows(workflows)) {
    out.set(
      `Infrastructure/Persistence/Workflows/${workflowStateClass(wf)}.cs`,
      renderWorkflowStateEntity(wf, ns, durable),
    );
  }
  for (const proj of projections) {
    if (!projectionNeedsRowStore(proj)) continue;
    out.set(
      `Infrastructure/Persistence/Projections/${projectionRowClass(proj)}.cs`,
      renderProjectionRowEntity(proj, ns),
    );
  }
  if (workflows.length > 0 || projections.length > 0) {
    out.set(
      "Infrastructure/Persistence/DapperPersistencePorts.cs",
      renderDapperPersistencePorts(ns, workflows, projections, durable, eventLogContextNames),
    );
  }
}

/** The DI registration lines binding the Dapper port adapters — closed
 *  bindings (one per workflow / projection / event-log context), unlike the EF
 *  path's open generics. */
export function dapperPortRegistrations(
  ns: string,
  workflows: readonly WorkflowIR[],
  projections: readonly ProjectionIR[],
  eventLogContextNames: readonly string[],
): string[] {
  const regs: string[] = [
    `builder.Services.AddScoped<${ns}.Domain.Common.IUnitOfWork, ${ns}.Infrastructure.Persistence.DapperUnitOfWork>();`,
  ];
  for (const wf of correlationWorkflows(workflows)) {
    const poco = `${ns}.Infrastructure.Persistence.Workflows.${workflowStateClass(wf)}`;
    regs.push(
      `builder.Services.AddScoped<${ns}.Domain.Common.ISagaStateStore<${poco}>, ${ns}.Infrastructure.Persistence.${sagaStoreClass(wf)}>();`,
    );
  }
  for (const proj of projections) {
    if (!projectionNeedsRowStore(proj)) continue;
    const poco = `${ns}.Infrastructure.Persistence.Projections.${projectionRowClass(proj)}`;
    regs.push(
      `builder.Services.AddScoped<${ns}.Domain.Common.IReadModelStore<${poco}>, ${ns}.Infrastructure.Persistence.${readModelStoreClass(proj)}>();`,
    );
  }
  for (const ctxName of eventLogContextNames) {
    const rec = `${ns}.Infrastructure.Persistence.Events.${eventRecordClass(ctxName)}`;
    regs.push(
      `builder.Services.AddScoped<${ns}.Domain.Common.IWorkflowEventStore<${rec}>, ${ns}.Infrastructure.Persistence.${eventStoreClass(ctxName)}>();`,
    );
  }
  return regs;
}

// ---------------------------------------------------------------------------
// Outbox — the Dapper dispatcher + relay (the raw-Npgsql siblings of
// emit/outbox.ts's `renderOutboxDispatcher` / `renderOutboxRelay`).
// `OutboxDelivery` (the AsyncLocal id carrier) is persistence-neutral and
// reused from emit/outbox.ts unchanged; the `OutboxMessage` EF POCO is NOT
// emitted (the Dapper path reads/writes __loom_outbox with raw SQL).
// ---------------------------------------------------------------------------

/** The outbox-recording dispatcher (Dapper): durable events INSERT into
 *  __loom_outbox (the relay delivers); everything else delegates to the
 *  in-process Mediator dispatcher. */
export function renderDapperOutboxDispatcher(ns: string, durableTypes: readonly string[]): string {
  const set = durableTypes.map((t) => `"${t}"`).join(", ");
  return `// Auto-generated.
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Dapper;
using Npgsql;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;

namespace ${ns}.Infrastructure.Events;

/// <summary>Records durable events (channels with retention: log | work) in
/// the __loom_outbox table instead of dispatching inline; the
/// OutboxRelayService delivers them at-least-once.  Ephemeral events
/// delegate to the in-process dispatcher unchanged.  Raw-Npgsql sibling of the
/// EF OutboxDomainEventDispatcher (persistence: dapper).</summary>
public sealed class OutboxDomainEventDispatcher : IDomainEventDispatcher
{
    private static readonly HashSet<string> DurableEventTypes = new() { ${set} };
    private readonly NpgsqlDataSource _db;
    private readonly InProcessDomainEventDispatcher _inner;

    public OutboxDomainEventDispatcher(NpgsqlDataSource db, InProcessDomainEventDispatcher inner)
    {
        _db = db;
        _inner = inner;
    }

    public async Task DispatchAsync(IDomainEvent ev, CancellationToken cancellationToken = default)
    {
        var type = ev.GetType().Name;
        if (DurableEventTypes.Contains(type))
        {
            await using var conn = await _db.OpenConnectionAsync(cancellationToken);
            await conn.ExecuteAsync(new CommandDefinition(
                "INSERT INTO __loom_outbox (type, payload) VALUES (@type, @payload::jsonb)",
                new { type, payload = JsonSerializer.Serialize((object)ev) }, cancellationToken: cancellationToken));
            return; // the relay delivers
        }
        await _inner.DispatchAsync(ev, cancellationToken);
    }
}
`;
}

/** The polling relay (Dapper): a BackgroundService draining undispatched
 *  outbox rows (ordered by occurred_at) through the in-process dispatcher;
 *  failures bump `attempts` and dead-letter (log only) after MaxAttempts. */
export function renderDapperOutboxRelay(ns: string, durableTypes: readonly string[]): string {
  const arms = durableTypes
    .map((t) => `            "${t}" => JsonSerializer.Deserialize<${t}>(payload),`)
    .join("\n");
  return `// Auto-generated.
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Dapper;
using Npgsql;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ${ns}.Domain.Common;
using ${ns}.Domain.Events;

namespace ${ns}.Infrastructure.Events;

/// <summary>Drains __loom_outbox through the in-process dispatcher
/// (at-least-once — consumers must tolerate redelivery).  Rows that exhaust
/// MaxAttempts stay in the table and log event_dead_lettered once.  Raw-Npgsql
/// sibling of the EF OutboxRelayService (persistence: dapper).</summary>
public sealed class OutboxRelayService : BackgroundService
{
    private const int MaxAttempts = 5;
    private const int BatchSize = 50;
    private static readonly TimeSpan Interval = TimeSpan.FromMilliseconds(500);

    private readonly IServiceScopeFactory _scopes;
    private readonly NpgsqlDataSource _db;
    private readonly ILogger<OutboxRelayService> _log;

    public OutboxRelayService(IServiceScopeFactory scopes, NpgsqlDataSource db, ILogger<OutboxRelayService> log)
    {
        _scopes = scopes;
        _db = db;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await DrainAsync(stoppingToken);
                await Task.Delay(Interval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private sealed class OutboxRow
    {
        public Guid id { get; set; }
        public string type { get; set; } = "";
        public string payload { get; set; } = "";
        public int attempts { get; set; }
    }

    private async Task DrainAsync(CancellationToken cancellationToken)
    {
        List<OutboxRow> rows;
        await using (var conn = await _db.OpenConnectionAsync(cancellationToken))
        {
            rows = (await conn.QueryAsync<OutboxRow>(new CommandDefinition(
                "SELECT id, type, payload, attempts FROM __loom_outbox WHERE dispatched_at IS NULL AND attempts < @max ORDER BY occurred_at LIMIT @take",
                new { max = MaxAttempts, take = BatchSize }, cancellationToken: cancellationToken))).ToList();
        }
        foreach (var row in rows)
        {
            await using var scope = _scopes.CreateAsyncScope();
            var inner = scope.ServiceProvider.GetRequiredService<InProcessDomainEventDispatcher>();
            try
            {
                var ev = Deserialize(row.type, row.payload);
                // The row id rides on an AsyncLocal so saga handlers'
                // idempotent-consumer markers can no-op on redelivery
                // (dispatch-delivery-semantics.md §3).
                OutboxDelivery.CurrentEventId = row.id.ToString();
                try
                {
                    if (ev is not null) await inner.DispatchAsync(ev, cancellationToken);
                }
                finally
                {
                    OutboxDelivery.CurrentEventId = null;
                }
                await using var mark = await _db.OpenConnectionAsync(cancellationToken);
                await mark.ExecuteAsync(new CommandDefinition(
                    "UPDATE __loom_outbox SET dispatched_at = now() WHERE id = @id",
                    new { id = row.id }, cancellationToken: cancellationToken));
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                var attempts = row.attempts + 1;
                await using var bump = await _db.OpenConnectionAsync(cancellationToken);
                await bump.ExecuteAsync(new CommandDefinition(
                    "UPDATE __loom_outbox SET attempts = @attempts WHERE id = @id",
                    new { attempts, id = row.id }, cancellationToken: cancellationToken));
                if (attempts >= MaxAttempts)
                {
                    _log.LogWarning("{Event} type={Type} attempts={Attempts} error={Error}", "event_dead_lettered", row.type, attempts, ex.Message);
                }
            }
        }
    }

    private static IDomainEvent? Deserialize(string type, string payload) =>
        type switch
        {
${arms}
            _ => null,
        };
}
`;
}
