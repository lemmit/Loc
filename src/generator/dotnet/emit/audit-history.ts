// ---------------------------------------------------------------------------
// Entity history — the READ side of the `audited` command trail, .NET /
// ASP.NET + Mediator.  (docs/audit.md; the entry shape, the diff boundary and
// the masking rule live at IR level in `src/ir/util/audit-history.ts`, shared
// with the other four backends, so the wire bytes match
// `test/behavioral/wire-golden/audit-history.json` by construction rather than
// by re-derivation here.)
//
// Four emitted pieces, mirroring the Hono / FastAPI ports one-for-one:
//
//   1. `Application/Common/AuditHistory.cs` — the `AuditEntry` /
//      `AuditFieldChange` response records and the pure snapshot helpers.
//      Shape-only, so one copy serves every audited aggregate.
//   2. `Application/Common/IAuditHistoryReader.cs` — the read port over
//      `audit_records`.  A PORT rather than a direct `AppDbContext` touch
//      because the .NET backend has TWO persistence adapters: EF Core reads it
//      through a `DbSet`, Dapper through raw Npgsql.  Same seam shape as the
//      write side's `IAuditWriter`.
//   3. `Infrastructure/Persistence/AuditHistoryReader.cs` — the EF / Dapper
//      implementation, filtered on the `(target_type, target_id)` pair the
//      write side indexes, oldest first (a timeline reads forwards).
//   4. A per-aggregate `Get<Agg>HistoryQuery` + handler (assembled by
//      `cqrs/queries.ts`) whose mapper body is built here — this is where the
//      `mask unless` pass composes in.
//
// ── Reading the snapshots ──────────────────────────────────────────────────
// `before` / `after` are `jsonb` (one shared `auditTableShape`) bound as
// `JsonNode?` — the same OBJECT binding every other backend uses (docs/audit.md
// §2), so the mapper indexes them directly and nothing parses.  Carrying the
// diffed values back out as `JsonNode` also means they re-serialize VERBATIM: a
// round-trip through `object` / `decimal` would reformat numbers (`5` → `5.0`)
// and diverge from the cross-backend wire golden.
//
// The KEYS inside a snapshot are PascalCase.  The blob is
// `JsonSerializer.SerializeToNode(new <Agg>Response(…))` with no options, so it
// uses `JsonSerializerDefaults.General` — NOT the app's `JsonNamingPolicy
// .CamelCase`, which is configured on MVC's serializer and not on the static
// one.  The snapshot therefore holds `"Reference"` where the wire holds
// `"reference"`.  `snapshotKey` below is that mapping, kept in one place and
// pinned against the write site by
// `test/generator/dotnet/audit-history-dotnet.test.ts`.  The emitted `field` on
// the wire stays the IR (camelCase) name, so the entry shape is identical
// across backends.
//
// ── Why the mapper is per-aggregate and per-caller ─────────────────────────
// An audit row's snapshots are written server-side INSIDE the command's
// transaction, where there is no caller to mask against.  The mapper is the
// only place a caller enters the picture, so it is where masking has to happen.
// A masked field's change entry is DROPPED, never emitted-and-redacted: a
// redacted-but-present entry still discloses THAT the field changed, when, and
// by whom.  Fail-closed on a null principal, exactly like `maskWrap`.
// ---------------------------------------------------------------------------

import type { EnrichedAggregateIR, WireField } from "../../../ir/types/loom-ir.js";
import { maskedHistoryFields, unmaskedHistoryFields } from "../../../ir/util/audit-history.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
import { renderCsExpr } from "../render-expr.js";

/** The JSON key a wire field occupies inside a STORED .NET snapshot.
 *
 *  The snapshot is `JsonSerializer.Serialize(new <Agg>Response(...))` with the
 *  default (non-camelCase) naming policy, and `<Agg>Response`'s positional
 *  parameters are named `upperFirst(wireField.name)` (see `projectEntityArgs` /
 *  `responseRecordParams` in `dto-mapping.ts`) — so the stored key is the
 *  PascalCase property name, not the camelCase wire name. */
export function snapshotKey(f: WireField): string {
  return upperFirst(f.name);
}

/** `Get<Agg>HistoryQuery` — the CQRS query for the derived history read. */
export function historyQueryName(agg: EnrichedAggregateIR): string {
  return `Get${agg.name}HistoryQuery`;
}

/** `Get<Agg>HistoryHandler`. */
export function historyHandlerName(agg: EnrichedAggregateIR): string {
  return `Get${agg.name}HistoryHandler`;
}

/** The query's (and the controller action's) C# return type. */
export const HISTORY_RETURN_TYPE = "IReadOnlyList<AuditEntry>";

/** `Application/Common/AuditHistory.cs` — the shared response records + the
 *  pure snapshot helpers.  No aggregate knowledge, so one copy serves every
 *  audited aggregate in the deployable. */
export function renderAuditHistoryTypes(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      "//",
      "// Entity history — the read side of the `audited` command trail.  One entry",
      "// per SUCCESSFUL command (a failed command's transaction rolls back, taking",
      '// its audit row with it), so this answers "what changed", not "who tried".',
      "using System;",
      "using System.Collections.Generic;",
      "using System.Text.Json.Nodes;",
      "",
      `namespace ${ns}.Application.Common;`,
      "",
      "/// <summary>One field-level change, derived from an entry's two snapshots at",
      "/// READ time.  <c>Before</c>/<c>After</c> are opaque JSON — whatever the",
      '/// aggregate\'s wire DTO held for that key — carried as <see cref="JsonNode"/>',
      "/// so they re-serialize VERBATIM (a round-trip through <c>object</c> would",
      "/// reformat numbers and diverge from the cross-backend wire contract).  Both",
      "/// sides are nullable and both are meaningful: a <c>create</c> has no before,",
      "/// a <c>destroy</c> no after.</summary>",
      "public sealed record AuditFieldChange(string Field, JsonNode? Before, JsonNode? After);",
      "",
      "/// <summary>One entry in an entity's history.  Deliberately NOT carrying the",
      "/// raw before/after snapshots: they are stored unmasked, so publishing them",
      "/// whole would need a recursive redaction pass over arbitrary JSON with no",
      "/// schema to guarantee it reached every masked key.  The derived",
      "/// <c>Changes</c> list is a typed, field-keyed projection where the masking",
      "/// rule is exact and checkable.</summary>",
      "public sealed record AuditEntry(",
      "    string AuditId,",
      "    string At,",
      "    string Action,",
      "    string OperationId,",
      "    JsonNode? Actor,",
      "    string? CorrelationId,",
      "    IReadOnlyList<AuditFieldChange> Changes);",
      "",
      "/// <summary>Snapshot reading + comparison.  The stored snapshots bind as",
      '/// <see cref="JsonNode"/> (jsonb, the same object binding every other backend',
      "/// uses), so these index straight into them — nothing parses.</summary>",
      "public static class AuditSnapshot",
      "{",
      "    /// <summary>Read one key out of a snapshot.  A missing key, an explicit",
      "    /// JSON null and an absent snapshot are all the same thing here — a",
      "    /// <c>create</c> row has no before object at all, and its fields must read",
      "    /// null rather than throw on a history GET.</summary>",
      "    public static JsonNode? Value(JsonNode? snapshot, string key)",
      "        => snapshot is JsonObject obj && obj.TryGetPropertyValue(key, out var found)",
      "            ? found",
      "            : null;",
      "",
      "    /// <summary>Did this key actually move between the two snapshots?",
      "    /// Structural comparison via the serialized form, which is key-order",
      "    /// sensitive — safe here because both snapshots come from the SAME",
      "    /// <c>&lt;Agg&gt;Response</c> projection AND are read back through the same",
      "    /// jsonb normalization.  Comparing serialized form also means a value",
      "    /// object or containment array compares by CONTENT rather than by",
      '    /// reference, which is what a reader expects of "changed".</summary>',
      "    public static bool Changed(JsonNode? before, JsonNode? after)",
      "        => Text(before) != Text(after);",
      "",
      "    /// <summary>The recorded principal as a JSON object.  <c>actor</c> is the",
      "    /// one audit column still bound as text (RequestContext's",
      "    /// <c>PrincipalJson()</c> produces a string), so it is the only value this",
      "    /// module converts — the entry has to publish an OBJECT, matching every",
      "    /// other backend's <c>actor</c>.</summary>",
      "    public static JsonNode? Actor(string? json)",
      "        => string.IsNullOrWhiteSpace(json) ? null : JsonNode.Parse(json);",
      "",
      '    private static string Text(JsonNode? value) => value?.ToJsonString() ?? "null";',
      "}",
    ) + "\n"
  );
}

/** `Application/Common/IAuditHistoryReader.cs` — the read port over
 *  `audit_records`.
 *
 *  A port rather than a direct `AppDbContext` dependency for the same reason
 *  `IAuditWriter` is one: the .NET backend ships two persistence adapters, and
 *  under `persistence: dapper` there is no `DbContext` to inject.  The port also
 *  keeps `AuditRecord` (Infrastructure) off the DOMAIN-facing
 *  `I<Agg>Repository`, which is exactly where the Python port deliberately
 *  refuses to put its own `history` read. */
export function renderAuditHistoryReaderInterface(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      "using System.Collections.Generic;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      `using ${ns}.Infrastructure.Persistence;`,
      "",
      `namespace ${ns}.Application.Common;`,
      "",
      "/// <summary>Reads one entity's audit_records trail, oldest first — keyed on",
      "/// the (target_type, target_id) pair the write side indexes.",
      "/// Persistence-neutral, so the EF and Dapper adapters both serve the same",
      "/// history query.</summary>",
      "public interface IAuditHistoryReader",
      "{",
      "    Task<IReadOnlyList<AuditRecord>> ReadAsync(string targetType, string targetId, CancellationToken cancellationToken = default);",
      "}",
    ) + "\n"
  );
}

/** The EF Core `IAuditHistoryReader` — a no-tracking read off the shared
 *  `AppDbContext.AuditRecords` set. */
export function renderEfAuditHistoryReader(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      "using System.Collections.Generic;",
      "using System.Linq;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      "using Microsoft.EntityFrameworkCore;",
      `using ${ns}.Application.Common;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "public sealed class AuditHistoryReader : IAuditHistoryReader",
      "{",
      "    private readonly AppDbContext _db;",
      "",
      "    public AuditHistoryReader(AppDbContext db)",
      "    {",
      "        _db = db;",
      "    }",
      "",
      "    // Ordered oldest-first: a timeline reads forwards, and `at` plus the",
      "    // (target_type, target_id) index make it the natural scan order.",
      "    public async Task<IReadOnlyList<AuditRecord>> ReadAsync(string targetType, string targetId, CancellationToken cancellationToken = default)",
      "        => await _db.AuditRecords",
      "            .AsNoTracking()",
      "            .Where(r => r.TargetType == targetType && r.TargetId == targetId)",
      "            .OrderBy(r => r.At)",
      "            .ToListAsync(cancellationToken);",
      "}",
    ) + "\n"
  );
}

/** The Dapper `IAuditHistoryReader` — the raw-Npgsql sibling.  Same rows, same
 *  order; `DbSchema` owns the table's DDL on this adapter.  The two JSONB
 *  columns are read `::text` so the reader hands the query handler the SAME
 *  serialized snapshot string the EF path does. */
export function renderDapperAuditHistoryReader(ns: string): string {
  const sql =
    "SELECT audit_id, operation_id, action, target_type, target_id, actor::text, " +
    "before::text, after::text, at, status, correlation_id, scope_id, parent_id " +
    "FROM audit_records WHERE target_type = @t AND target_id = @i ORDER BY at";
  return (
    lines(
      "// Auto-generated.  Dapper audit-history read (persistence: dapper).",
      "using System.Collections.Generic;",
      "using System.Text.Json.Nodes;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      "using Npgsql;",
      `using ${ns}.Application.Common;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "public sealed class AuditHistoryReader : IAuditHistoryReader",
      "{",
      "    private readonly NpgsqlDataSource _db;",
      "",
      "    public AuditHistoryReader(NpgsqlDataSource db)",
      "    {",
      "        _db = db;",
      "    }",
      "",
      "    // Ordered oldest-first: a timeline reads forwards, and `at` plus the",
      "    // (target_type, target_id) index make it the natural scan order.",
      "    public async Task<IReadOnlyList<AuditRecord>> ReadAsync(string targetType, string targetId, CancellationToken cancellationToken = default)",
      "    {",
      "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `        await using var cmd = new NpgsqlCommand(${JSON.stringify(sql)}, conn);`,
      '        cmd.Parameters.AddWithValue("t", targetType);',
      '        cmd.Parameters.AddWithValue("i", targetId);',
      "        var rows = new List<AuditRecord>();",
      "        await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);",
      "        while (await reader.ReadAsync(cancellationToken))",
      "        {",
      "            rows.Add(new AuditRecord",
      "            {",
      "                AuditId = reader.GetString(0),",
      "                OperationId = reader.GetString(1),",
      "                Action = reader.GetString(2),",
      "                TargetType = reader.GetString(3),",
      "                TargetId = reader.GetString(4),",
      "                Actor = reader.IsDBNull(5) ? null : reader.GetString(5),",
      // The two jsonb snapshots come back through the `::text` projection and
      // are re-hydrated to `JsonNode` here — the read-side mirror of the write
      // side's `ToJsonString()` on this same raw-Npgsql seam.  (The EF adapter
      // needs neither: the provider maps the column to `JsonNode` directly.)
      "                Before = reader.IsDBNull(6) ? null : JsonNode.Parse(reader.GetString(6)),",
      "                After = reader.IsDBNull(7) ? null : JsonNode.Parse(reader.GetString(7)),",
      "                At = reader.GetDateTime(8),",
      "                Status = reader.GetString(9),",
      "                CorrelationId = reader.IsDBNull(10) ? null : reader.GetString(10),",
      "                ScopeId = reader.IsDBNull(11) ? null : reader.GetString(11),",
      "                ParentId = reader.IsDBNull(12) ? null : reader.GetString(12),",
      "            });",
      "        }",
      "        return rows;",
      "    }",
      "}",
    ) + "\n"
  );
}

/** The row → `AuditEntry` mapper lines, spliced into the history query
 *  handler's body (they run inside a `foreach (var row in __rows)`).
 *
 *  Unmasked diff fields run through one loop over `(wire name, snapshot key)`
 *  pairs; each masked field gets its own predicate-guarded block, so a caller
 *  who fails the predicate sees NO entry for it at all. */
export function renderHistoryEntryMapperLines(agg: EnrichedAggregateIR, pad: string): string[] {
  const unmasked = unmaskedHistoryFields(agg);
  const masked = maskedHistoryFields(agg);
  const out: string[] = [
    // No parse step: `row.Before` / `row.After` are already `JsonNode?` (the
    // jsonb object binding every backend shares — docs/audit.md §2).
    `${pad}var __changes = new List<AuditFieldChange>();`,
  ];
  if (unmasked.length > 0) {
    // `(wire key, snapshot key)` — camelCase on the wire, PascalCase in the
    // stored blob (see `snapshotKey`).  The pair is emitted rather than derived
    // at runtime so neither convention is ever guessed at.
    const pairs = unmasked
      .map((f) => `(${JSON.stringify(f.name)}, ${JSON.stringify(snapshotKey(f))})`)
      .join(", ");
    out.push(
      `${pad}foreach (var (__field, __key) in new[] { ${pairs} })`,
      `${pad}{`,
      `${pad}    var __b = AuditSnapshot.Value(row.Before, __key);`,
      `${pad}    var __a = AuditSnapshot.Value(row.After, __key);`,
      `${pad}    if (AuditSnapshot.Changed(__b, __a))`,
      `${pad}    {`,
      `${pad}        __changes.Add(new AuditFieldChange(__field, __b, __a));`,
      `${pad}    }`,
      `${pad}}`,
    );
  }
  masked.forEach((f, i) => {
    // The SAME `mask unless` predicate the entity read applies via `maskWrap`,
    // resolved through the SAME fail-closed ambient accessor: no principal →
    // `RequestContext.Current?.CurrentUser` is null → the pattern match fails →
    // the whole block is skipped and every entry for the field drops.
    const user = `__maskUser${i}`;
    const pred = renderCsExpr(f.maskUnless!, { thisName: "this", currentUserExpr: user });
    const key = JSON.stringify(snapshotKey(f));
    out.push(
      `${pad}// \`${f.name}\`: \`mask unless\` — the change entry is DROPPED, not redacted.`,
      `${pad}// A redacted-but-present entry would still disclose that it changed, when,`,
      `${pad}// and by whom, which is the disclosure the mask exists to prevent.`,
      `${pad}if (RequestContext.Current?.CurrentUser is { } ${user} && (${pred}))`,
      `${pad}{`,
      `${pad}    var __b${i} = AuditSnapshot.Value(row.Before, ${key});`,
      `${pad}    var __a${i} = AuditSnapshot.Value(row.After, ${key});`,
      `${pad}    if (AuditSnapshot.Changed(__b${i}, __a${i}))`,
      `${pad}    {`,
      `${pad}        __changes.Add(new AuditFieldChange(${JSON.stringify(f.name)}, __b${i}, __a${i}));`,
      `${pad}    }`,
      `${pad}}`,
    );
  });
  out.push(
    `${pad}__entries.Add(new AuditEntry(`,
    `${pad}    row.AuditId,`,
    // The canonical ISO-8601 UTC instant every backend's wire carries (RS-4) —
    // the same trim `projectToResponse` applies to a business `datetime` field.
    `${pad}    ${csAtWire("row.At")},`,
    `${pad}    row.Action,`,
    `${pad}    row.OperationId,`,
    `${pad}    AuditSnapshot.Actor(row.Actor),`,
    `${pad}    row.CorrelationId,`,
    `${pad}    __changes));`,
  );
  return out;
}

/** Canonical ISO-8601 UTC wire string for the entry's `at` — byte-identical to
 *  the `csCanonicalInstantWire` projection business `datetime` fields use, so a
 *  history timestamp and an aggregate timestamp read the same on the wire. */
function csAtWire(expr: string): string {
  return `System.Text.RegularExpressions.Regex.Replace(${expr}.ToUniversalTime().ToString("o"), @"\\.?0+Z$", "Z")`;
}
