// ---------------------------------------------------------------------------
// dapper — minimal-real persistence emitters for the .NET backend
// (D-REALIZATION-AXES Phase 5c).  An ALTERNATE persistence implementation
// selected by `persistence: dapper`: the generated Domain layer (entities, ids,
// value objects, enums, events, commands/handlers/controllers) is
// persistence-agnostic and reused as-is; Dapper only replaces the Infrastructure
// (per-aggregate repository + Npgsql connection + a self-applied `schema.sql`),
// the Program.cs persistence wiring, and the project deps.
//
// SCOPE (v1, validator-gated in `ir/validate/validate.ts`): relational shape,
// flat aggregates whose fields are scalar / enum / value-object / single id-ref.
// Everything else (document/embedded shape, associations, nested parts,
// inheritance, event-sourcing, audit/provenance/managed fields) is rejected at
// validate time, so this emitter only ever sees the supported subset.
//
// Hydration seam: the entity exposes `<Agg>._Create(new <Agg>.State { … })`, so a
// queried row maps cleanly into the domain object without EF.  Value objects are
// stored as a single `jsonb` column (System.Text.Json round-trip); enums as
// `text` (`.ToString()` / `Enum.Parse`).
// ---------------------------------------------------------------------------

import type {
  EnrichedAggregateIR,
  ExprIR,
  FieldIR,
  IdValueType,
  ParamIR,
  RepositoryIR,
  RetrievalIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { renderCsType } from "../render-expr.js";
import { renderRetrievalParamsWithCt } from "./repository.js";

/** Postgres table for an aggregate — lowercase plural (e.g. `orders`). */
const tableOf = (aggName: string): string => plural(snake(aggName));

/** SQL + C# row type for an id value type. */
function idTypes(vt: IdValueType): { sql: string; cs: string } {
  switch (vt) {
    case "int":
      return { sql: "integer", cs: "int" };
    case "long":
      return { sql: "bigint", cs: "long" };
    case "string":
      return { sql: "text", cs: "string" };
    default:
      return { sql: "uuid", cs: "Guid" };
  }
}

/** SQL + C# row type for a primitive. */
function primTypes(name: string): { sql: string; cs: string } {
  switch (name) {
    case "int":
      return { sql: "integer", cs: "int" };
    case "long":
      return { sql: "bigint", cs: "long" };
    case "decimal":
    case "money":
      return { sql: "numeric", cs: "decimal" };
    case "bool":
      return { sql: "boolean", cs: "bool" };
    case "datetime":
      return { sql: "timestamptz", cs: "DateTime" };
    case "guid":
      return { sql: "uuid", cs: "Guid" };
    case "json":
      return { sql: "jsonb", cs: "string" };
    default:
      return { sql: "text", cs: "string" };
  }
}

/** A persisted column + the C# expressions that read it off the aggregate
 *  (save) and reconstruct it into the `State` (hydrate). */
interface DapperColumn {
  col: string; // snake_case column name (== Dapper param + Row prop)
  sql: string; // Postgres column type
  nullable: boolean;
  rowCs: string; // C# type on the row DTO
  /** placeholder cast in the INSERT VALUES list (`""` or `"::jsonb"`). */
  cast: string;
  /** C# expression reading the save value off `aggregate`. */
  save: string;
  /** State init property (PascalCase). */
  stateProp: string;
  /** C# expression building the State value from `r.<col>`. */
  hydrate: string;
}

function unwrapOptional(t: TypeIR): { type: TypeIR; nullable: boolean } {
  return t.kind === "optional" ? { type: t.inner, nullable: true } : { type: t, nullable: false };
}

/** The id column — every aggregate has one. */
function idColumn(agg: EnrichedAggregateIR): DapperColumn {
  const { sql, cs } = idTypes(agg.idValueType);
  return {
    col: "id",
    sql,
    nullable: false,
    rowCs: cs,
    cast: "",
    save: "aggregate.Id.Value",
    stateProp: "Id",
    hydrate: `new ${agg.name}Id(r.id)`,
  };
}

/** Map a supported field to its column.  Throws on an unsupported field kind —
 *  the validator gates these out, so reaching the throw means a gating gap. */
function fieldColumn(f: FieldIR): DapperColumn {
  const { type, nullable } = unwrapOptional(f.type);
  const col = snake(f.name);
  const prop = upperFirst(f.name);
  const acc = `aggregate.${prop}`;
  switch (type.kind) {
    case "primitive": {
      const { sql, cs } = primTypes(type.name);
      return {
        col,
        sql,
        nullable,
        rowCs: `${cs}${nullable ? "?" : ""}`,
        cast: "",
        save: acc,
        stateProp: prop,
        hydrate: `r.${col}`,
      };
    }
    case "enum":
      return {
        col,
        sql: "text",
        nullable,
        rowCs: nullable ? "string?" : "string",
        cast: "",
        save: nullable ? `${acc}?.ToString()` : `${acc}.ToString()`,
        stateProp: prop,
        hydrate: nullable
          ? `r.${col} is null ? (${type.name}?)null : Enum.Parse<${type.name}>(r.${col})`
          : `Enum.Parse<${type.name}>(r.${col})`,
      };
    case "valueobject":
      return {
        col,
        sql: "jsonb",
        nullable,
        rowCs: nullable ? "string?" : "string",
        cast: "::jsonb",
        save: nullable
          ? `${acc} is null ? null : System.Text.Json.JsonSerializer.Serialize(${acc})`
          : `System.Text.Json.JsonSerializer.Serialize(${acc})`,
        stateProp: prop,
        hydrate: nullable
          ? `r.${col} is null ? (${type.name}?)null : System.Text.Json.JsonSerializer.Deserialize<${type.name}>(r.${col})!`
          : `System.Text.Json.JsonSerializer.Deserialize<${type.name}>(r.${col})!`,
      };
    case "id": {
      const { sql, cs } = idTypes(type.valueType);
      return {
        col,
        sql,
        nullable,
        rowCs: `${cs}${nullable ? "?" : ""}`,
        cast: "",
        save: nullable ? `${acc}?.Value` : `${acc}.Value`,
        stateProp: prop,
        hydrate: nullable
          ? `r.${col} is null ? (${type.targetName}Id?)null : new ${type.targetName}Id(r.${col}${cs === "Guid" ? ".Value" : ""})`
          : `new ${type.targetName}Id(r.${col})`,
      };
    }
    default:
      throw new Error(
        `dapper: unsupported field kind '${type.kind}' on '${f.name}' (validator gap)`,
      );
  }
}

function columnsOf(agg: EnrichedAggregateIR): DapperColumn[] {
  return [idColumn(agg), ...agg.fields.map(fieldColumn)];
}

// ---------------------------------------------------------------------------
// find `where` → SQL.  Minimal subset; throws on anything unsupported so the
// caller can emit a compile-safe `NotImplementedException` body.
// ---------------------------------------------------------------------------

const SQL_BINOP: Record<string, string> = {
  "==": "=",
  "!=": "<>",
  "<": "<",
  ">": ">",
  "<=": "<=",
  ">=": ">=",
  "&&": "AND",
  "||": "OR",
};

function whereToSql(e: ExprIR): string {
  switch (e.kind) {
    case "paren":
      return `(${whereToSql(e.inner)})`;
    case "unary":
      if (e.op === "!") return `(NOT ${whereToSql(e.operand)})`;
      throw new Error("dapper: unsupported unary in find");
    case "binary": {
      const op = SQL_BINOP[e.op];
      if (!op) throw new Error(`dapper: unsupported operator '${e.op}' in find`);
      return `(${whereToSql(e.left)} ${op} ${whereToSql(e.right)})`;
    }
    case "member":
      // `this.<field>` → column.
      if (e.receiver.kind === "this") return snake(e.member);
      throw new Error("dapper: unsupported member access in find");
    case "ref":
      // A find/retrieval parameter → Dapper named parameter.
      if (e.refKind === "param") return `@${e.name}`;
      // A candidate field (criterion / retrieval `where`) → its column.
      if (e.refKind === "this-prop") return snake(e.name);
      // An enum value (`Status.Confirmed`) → its text representation, matching
      // the `text` column the enum is stored as.
      if (e.refKind === "enum-value") return `'${e.name.replace(/'/g, "''")}'`;
      throw new Error(`dapper: unsupported ref '${e.refKind}' in find`);
    case "literal":
      switch (e.lit) {
        case "string":
          return `'${e.value.replace(/'/g, "''")}'`;
        case "bool":
          return e.value === "true" ? "TRUE" : "FALSE";
        case "null":
          return "NULL";
        case "int":
        case "long":
        case "decimal":
        case "money":
          return e.value;
        default:
          throw new Error("dapper: unsupported literal in find");
      }
    default:
      throw new Error(`dapper: unsupported expression '${e.kind}' in find`);
  }
}

function renderParams(params: ParamIR[]): string {
  const ps = params.map((p) => `${renderCsType(p.type)} ${p.name}`);
  return [...ps, "CancellationToken cancellationToken = default"].join(", ");
}

// ---------------------------------------------------------------------------
// Per-aggregate Dapper repository.
// ---------------------------------------------------------------------------

export function renderDapperRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  retrievals: RetrievalIR[] = [],
): string {
  const table = tableOf(agg.name);
  const cols = columnsOf(agg);
  const colList = cols.map((c) => c.col).join(", ");
  const insertVals = cols.map((c) => `@${c.col}${c.cast}`).join(", ");
  const upsertSet = cols
    .filter((c) => c.col !== "id")
    .map((c) => `${c.col} = excluded.${c.col}`)
    .join(", ");
  const saveParams = cols.map((c) => `${c.col} = ${c.save}`).join(", ");

  const mapBody = cols.map((c) => `            ${c.stateProp} = ${c.hydrate},`);

  const findMethods = (repo?.finds ?? []).map((f) => {
    const name = upperFirst(f.name);
    const ret = renderCsType(f.returnType);
    const isList = f.returnType.kind === "array";
    // Id-typed params bind their wrapped `.Value` (Dapper has no handler for
    // the strongly-typed id struct); scalars bind directly.
    const paramFields = f.params.map((p) => {
      const pt = p.type.kind === "optional" ? p.type.inner : p.type;
      return pt.kind === "id" ? `${p.name} = ${p.name}.Value` : p.name;
    });
    const paramObj = paramFields.length > 0 ? `, new { ${paramFields.join(", ")} }` : "";
    let where = "";
    try {
      where = f.filter ? ` WHERE ${whereToSql(f.filter)}` : "";
    } catch {
      // Unsupported predicate — emit a compile-safe stub.
      return lines(
        `    public Task<${ret}> ${name}(${renderParams(f.params)})`,
        `        => throw new NotImplementedException("Dapper v1 does not support this find's predicate.");`,
      );
    }
    const sql = `SELECT ${colList} FROM ${table}${where}`;
    if (isList) {
      return lines(
        `    public async Task<${ret}> ${name}(${renderParams(f.params)})`,
        `    {`,
        `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
        `        var rows = await conn.QueryAsync<Row>(new CommandDefinition("${sql}"${paramObj}, cancellationToken: cancellationToken));`,
        `        return rows.Select(Map).ToList();`,
        `    }`,
      );
    }
    return lines(
      `    public async Task<${ret}> ${name}(${renderParams(f.params)})`,
      `    {`,
      `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
      `        var r = await conn.QuerySingleOrDefaultAsync<Row>(new CommandDefinition("${sql}"${paramObj}, cancellationToken: cancellationToken));`,
      `        return r is null ? null : Map(r);`,
      `    }`,
    );
  });

  // Retrieval bundles → `Run<Name>Async`, parameterised SQL (where + sort +
  // call-site offset/limit paging).  The `where` is the inlined predicate
  // (criterion bodies included) rendered by `whereToSql`; anything outside the
  // Dapper subset stubs with NotImplementedException, like the find path.
  const retrievalMethods = retrievals.map((r) => {
    const name = upperFirst(r.name);
    let whereSql: string;
    try {
      whereSql = whereToSql(r.where);
    } catch {
      return lines(
        `    public Task<IReadOnlyList<${agg.name}>> Run${name}Async(${renderRetrievalParamsWithCt(r.params)})`,
        `        => throw new NotImplementedException("Dapper v1 does not support this retrieval's predicate.");`,
      );
    }
    const orderSql =
      r.sort.length > 0
        ? ` ORDER BY ${r.sort
            .map((s) => `${snake(s.path[0]!.name)} ${s.direction === "desc" ? "DESC" : "ASC"}`)
            .join(", ")}`
        : "";
    const baseSql = `SELECT ${colList} FROM ${table} WHERE ${whereSql}${orderSql}`;
    const paramAdds = r.params.map((p) => {
      const pt = p.type.kind === "optional" ? p.type.inner : p.type;
      const val = pt.kind === "id" ? `${p.name}.Value` : p.name;
      return `        p.Add("${p.name}", ${val});`;
    });
    return lines(
      `    public async Task<IReadOnlyList<${agg.name}>> Run${name}Async(${renderRetrievalParamsWithCt(r.params)})`,
      `    {`,
      `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
      `        var sql = "${baseSql}";`,
      `        var p = new DynamicParameters();`,
      ...paramAdds,
      `        if (page is { } pg)`,
      `        {`,
      `            if (pg.limit is { } lim) { sql += " LIMIT @__lim"; p.Add("__lim", lim); }`,
      `            if (pg.offset is { } off) { sql += " OFFSET @__off"; p.Add("__off", off); }`,
      `        }`,
      `        var rows = await conn.QueryAsync<Row>(new CommandDefinition(sql, p, cancellationToken: cancellationToken));`,
      `        return rows.Select(Map).ToList();`,
      `    }`,
    );
  });

  const deleteMethod = agg.canonicalDestroy
    ? lines(
        `    public async Task DeleteAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
        `    {`,
        `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
        `        await conn.ExecuteAsync(new CommandDefinition("DELETE FROM ${table} WHERE id = @id", new { id = aggregate.Id.Value }, cancellationToken: cancellationToken));`,
        `    }`,
      )
    : "";

  return (
    lines(
      "// Auto-generated.  Dapper persistence (persistence: dapper).",
      "using System;",
      "using System.Collections.Generic;",
      "using System.Linq;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      "using Dapper;",
      "using Npgsql;",
      `using ${ns}.Domain.${plural(agg.name)};`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Common;`,
      "",
      `namespace ${ns}.Infrastructure.Repositories;`,
      "",
      `public sealed class ${agg.name}Repository : I${agg.name}Repository`,
      "{",
      "    private readonly NpgsqlDataSource _db;",
      "    private readonly IDomainEventDispatcher _events;",
      "",
      `    public ${agg.name}Repository(NpgsqlDataSource db, IDomainEventDispatcher events)`,
      "    {",
      "        _db = db;",
      "        _events = events;",
      "    }",
      "",
      "    private sealed class Row",
      "    {",
      // Only a non-nullable reference type (string) needs the `= default!`
      // initializer to suppress CS8618; value types + nullable types default
      // on their own.  An auto-property block takes a trailing `;` ONLY when an
      // initializer follows (`{ get; set; } = default!;`) — a bare `{ get; set; };`
      // is a CS1597 error, so the no-initializer arm ends at `}`.
      ...cols.map(
        (c) =>
          `        public ${c.rowCs} ${c.col} { get; set; }${c.rowCs === "string" ? " = default!;" : ""}`,
      ),
      "    }",
      "",
      `    private static ${agg.name} Map(Row r) =>`,
      `        ${agg.name}._Create(new ${agg.name}.State`,
      "        {",
      ...mapBody,
      "        });",
      "",
      `    public async Task<${agg.name}?> GetByIdAsync(${agg.name}Id id, CancellationToken cancellationToken = default)`,
      "    {",
      "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `        var r = await conn.QuerySingleOrDefaultAsync<Row>(new CommandDefinition("SELECT ${colList} FROM ${table} WHERE id = @id", new { id = id.Value }, cancellationToken: cancellationToken));`,
      "        return r is null ? null : Map(r);",
      "    }",
      "",
      `    public async Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${agg.name}Id> ids, CancellationToken cancellationToken = default)`,
      "    {",
      "        if (ids.Count == 0) return Array.Empty<" + agg.name + ">();",
      `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
      `        var rows = await conn.QueryAsync<Row>(new CommandDefinition("SELECT ${colList} FROM ${table} WHERE id = ANY(@ids)", new { ids = ids.Select(x => x.Value).ToArray() }, cancellationToken: cancellationToken));`,
      "        return rows.Select(Map).ToList();",
      "    }",
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
      "    {",
      "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `        await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${table} (${colList}) VALUES (${insertVals}) ON CONFLICT (id) DO UPDATE SET ${upsertSet}", new { ${saveParams} }, cancellationToken: cancellationToken));`,
      "        foreach (var ev in aggregate.PullEvents())",
      "        {",
      "            await _events.DispatchAsync(ev, cancellationToken);",
      "        }",
      "    }",
      deleteMethod ? "" : null,
      deleteMethod || null,
      ...findMethods.flatMap((m) => ["", m]),
      ...retrievalMethods.flatMap((m) => ["", m]),
      "}",
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// schema.sql bootstrap — a self-applied `CREATE TABLE IF NOT EXISTS` per
// aggregate, embedded in a C# helper run once at startup.
// ---------------------------------------------------------------------------

export function renderDapperSchema(aggs: readonly EnrichedAggregateIR[], ns: string): string {
  const tables = aggs.map((agg) => {
    const cols = columnsOf(agg).map((c, i) => {
      const pk = i === 0 ? " primary key" : "";
      const nn = c.nullable || i === 0 ? "" : " not null";
      return `    ${c.col} ${c.sql}${pk}${nn}`;
    });
    return `CREATE TABLE IF NOT EXISTS ${tableOf(agg.name)} (\n${cols.join(",\n")}\n);`;
  });
  const ddl = tables.join("\n\n");
  return (
    lines(
      "// Auto-generated.  Dapper schema bootstrap (persistence: dapper).",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      "using Dapper;",
      "using Npgsql;",
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "public static class DbSchema",
      "{",
      '    public const string Sql = @"',
      ddl.replace(/"/g, '""'),
      '";',
      "",
      "    public static async Task EnsureAsync(NpgsqlDataSource db, CancellationToken cancellationToken = default)",
      "    {",
      "        await using var conn = await db.OpenConnectionAsync(cancellationToken);",
      "        await conn.ExecuteAsync(new CommandDefinition(Sql, cancellationToken: cancellationToken));",
      "    }",
      "}",
    ) + "\n"
  );
}

/** Dapper `<PackageReference>` rows for the deployable's csproj (replaces the
 *  EF Core package set). */
export const DAPPER_PROJECT_DEPS: readonly string[] = [
  `    <PackageReference Include="Dapper" Version="2.1.35" />`,
  `    <PackageReference Include="Npgsql" Version="8.0.5" />`,
];

/** Program.cs persistence wiring for Dapper — registers the NpgsqlDataSource
 *  (replaces the `AddDbContext` block). */
export function renderDapperConnectionSetup(): readonly string[] {
  return [
    `builder.Services.AddSingleton(Npgsql.NpgsqlDataSource.Create(`,
    `    builder.Configuration.GetConnectionString("Default")!));`,
  ];
}
