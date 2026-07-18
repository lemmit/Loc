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

import { pagedReturn } from "../../../ir/stdlib/generics.js";
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
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { sortableFields } from "../../../ir/util/sortable-fields.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { unionFindAsOptionalTwin } from "../find-emit.js";
import { csValueTypeForId, renderCsExpr, renderCsType } from "../render-expr.js";
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
  // Reference-collection fields (`X id[]`) live in their join tables, not as
  // root columns — see the association load/save blocks in the repository.
  const assocFields = new Set((agg.associations ?? []).map((a) => a.fieldName));
  return [idColumn(agg), ...agg.fields.filter((f) => !assocFields.has(f.name)).map(fieldColumn)];
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

function renderParams(params: ParamIR[], extra: readonly string[] = []): string {
  const ps = params.map((p) => `${renderCsType(p.type)} ${p.name}`);
  return [...ps, ...extra, "CancellationToken cancellationToken = default"].join(", ");
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
  // Lifecycle stamps (`stamp onCreate/onUpdate { field: expr }` →
  // `contextStamps`).  EF applies these via SaveChangesInterceptor; the
  // Dapper upsert can't see Added-vs-Modified, so:
  //   - onUpdate assignments MUTATE the in-memory aggregate before the
  //     upsert (EF parity — EF applies onUpdate at Added too), so both the
  //     row and the projected response carry the stamp;
  //   - onCreate assignments are INSERT-only: computed into locals, bound
  //     as that column's parameter, and EXCLUDED from the ON CONFLICT
  //     UPDATE SET — an existing row keeps its original value.  (The
  //     in-memory aggregate is not mutated for onCreate; existence is
  //     unknowable without an extra round-trip.)
  const stampRules = agg.contextStamps ?? [];
  const onCreateStamps = stampRules
    .filter((r) => r.event === "create")
    .flatMap((r) => r.assignments);
  const onUpdateStamps = stampRules
    .filter((r) => r.event === "update")
    .flatMap((r) => r.assignments);
  const onCreateCols = new Set(onCreateStamps.map((a) => snake(a.field)));
  const upsertSet = cols
    .filter((c) => c.col !== "id" && !onCreateCols.has(c.col))
    .map((c) => `${c.col} = excluded.${c.col}`)
    .join(", ");
  const createLocal = (col: string): string => `__create_${col}`;
  const saveParams = cols
    .map((c) => `${c.col} = ${onCreateCols.has(c.col) ? createLocal(c.col) : c.save}`)
    .join(", ");
  const stampLines: string[] = [
    ...onUpdateStamps.map(
      (a) =>
        `        aggregate.${upperFirst(a.field)} = ${renderCsExpr(a.value, { thisName: "aggregate" })};`,
    ),
    ...onCreateStamps.map(
      (a) =>
        `        var ${createLocal(snake(a.field))} = ${renderCsExpr(a.value, { thisName: "aggregate" })};`,
    ),
  ];

  // Optimistic concurrency (`versioned`, default-on): the guarded upsert seeds
  // `version = 1` on INSERT and, on ON CONFLICT, bumps `version = version + 1`
  // ONLY when the row's current version matches the expected version (the
  // client's `If-Match`, or the loaded aggregate's own version) — a CAS in the
  // conflict branch's `WHERE`.  A stale row / stale precondition makes the
  // UPDATE match zero rows, so `ExecuteAsync` returns 0 and we throw
  // `ConcurrencyConflictException` (→ 409 via DomainExceptionFilter's Dapper
  // arm) — the persistence-neutral mirror of EF's `IsConcurrencyToken()` +
  // `DbUpdateConcurrencyException`.  The expected version is read from the
  // ambient RequestContext (populated from `If-Match` by
  // RequestContextMiddleware — persistence-independent), EXACTLY as the EF
  // repository threads it, so the port signature `SaveAsync(agg, ct)` is
  // unchanged.  A non-versioned aggregate keeps the blind upsert below
  // (byte-identical).
  const versioned = aggregateIsVersioned(agg);
  const versionCol = "version";
  const upsertSetNoVersion = cols
    .filter((c) => c.col !== "id" && c.col !== versionCol && !onCreateCols.has(c.col))
    .map((c) => `${c.col} = excluded.${c.col}`)
    .join(", ");
  const versionedInsertVals = cols
    .map((c) => (c.col === versionCol ? "1" : `@${c.col}${c.cast}`))
    .join(", ");
  const versionedSetClause = upsertSetNoVersion
    ? `${upsertSetNoVersion}, ${versionCol} = ${table}.${versionCol} + 1`
    : `${versionCol} = ${table}.${versionCol} + 1`;
  const saveUpsertLines = versioned
    ? [
        "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
        "        var __expected = RequestContext.Current?.ExpectedVersion ?? aggregate.Version;",
        `        var __affected = await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${table} (${colList}) VALUES (${versionedInsertVals}) ON CONFLICT (id) DO UPDATE SET ${versionedSetClause} WHERE ${table}.${versionCol} = @ExpectedVersion", new { ${saveParams}, ExpectedVersion = __expected }, cancellationToken: cancellationToken));`,
        `        if (__affected == 0) throw new ConcurrencyConflictException("The resource was modified by another request; reload and retry.");`,
      ]
    : [
        "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
        `        await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${table} (${colList}) VALUES (${insertVals}) ON CONFLICT (id) DO UPDATE SET ${upsertSet}", new { ${saveParams} }, cancellationToken: cancellationToken));`,
      ];

  // Non-principal capability filters (`filter !this.isDeleted`) AND into
  // every read (GetById / FindManyByIds / finds / retrievals) — Dapper has
  // no EF HasQueryFilter, so the predicate is spliced into each SELECT's
  // WHERE.  Principal-referencing filters are validator-rejected on Dapper
  // (`loom.dapper-unsupported`).  A predicate outside the Dapper SQL subset
  // throws here (loud) rather than silently dropping the filter — half-
  // applying a soft-delete filter would be a correctness hole.
  const capabilityFilters = (agg.contextFilters ?? []).filter((p) => !exprUsesCurrentUser(p));
  const filterSql: string | null =
    capabilityFilters.length > 0
      ? capabilityFilters
          .map((p) => {
            try {
              return whereToSql(p);
            } catch {
              throw new Error(
                `dapper: capability filter on '${agg.name}' is outside the Dapper SQL subset; ` +
                  `use 'persistence: efcore' or simplify the predicate.`,
              );
            }
          })
          .join(" AND ")
      : null;
  const andFilter = (existingWhere: boolean): string =>
    filterSql ? `${existingWhere ? " AND " : " WHERE "}${filterSql}` : "";

  const mapBody = cols.map((c) => `            ${c.stateProp} = ${c.hydrate},`);

  // Reference collections (`X id[]` → AssociationIR, one join table each).
  // `X id[]` is contractually a set (membership only, no order), so the join
  // row is just its composite (owner, target) PK — no payload column.
  // Loads: a private LoadRefsAsync bulk-fills every root's list (ordered by
  // the target FK id for deterministic read-back); GetById funnels its single
  // root through it too.  Saves: full-list replace — DELETE owner rows +
  // re-INSERT (delete+insert is semantically identical for a full-list
  // replace and keeps the SQL trivial).  Deletes: join rows go first (the
  // Dapper schema emits no FK cascade).
  const associations = agg.associations ?? [];
  const hasAssoc = associations.length > 0;
  const loadRefsMethod = hasAssoc
    ? lines(
        `    private static async Task LoadRefsAsync(NpgsqlConnection conn, List<${agg.name}> roots, CancellationToken cancellationToken)`,
        "    {",
        "        if (roots.Count == 0) return;",
        "        var __ids = roots.Select(x => x.Id.Value).ToArray();",
        ...associations.flatMap((a) => {
          const ownerCs = idTypes(agg.idValueType).cs;
          const targetCs = idTypes(a.valueType).cs;
          const prop = upperFirst(a.fieldName);
          return [
            `        var __${a.fieldName}Rows = (await conn.QueryAsync<(${ownerCs} owner, ${targetCs} target)>(new CommandDefinition("SELECT ${a.ownerFk}, ${a.targetFk} FROM ${a.joinTable} WHERE ${a.ownerFk} = ANY(@ids) ORDER BY ${a.ownerFk}, ${a.targetFk}", new { ids = __ids }, cancellationToken: cancellationToken))).ToList();`,
            `        var __${a.fieldName}ByOwner = __${a.fieldName}Rows.GroupBy(t => t.owner).ToDictionary(g => g.Key, g => g.Select(t => new ${a.targetAgg}Id(t.target)).ToList());`,
            `        foreach (var __root in roots)`,
            `        {`,
            `            __root.${prop} = __${a.fieldName}ByOwner.TryGetValue(__root.Id.Value, out var __${a.fieldName}List) ? __${a.fieldName}List : new List<${a.targetAgg}Id>();`,
            `        }`,
          ];
        }),
        "    }",
      )
    : "";
  const assocSaveLines = associations.flatMap((a) => {
    const prop = upperFirst(a.fieldName);
    return [
      `        await conn.ExecuteAsync(new CommandDefinition("DELETE FROM ${a.joinTable} WHERE ${a.ownerFk} = @id", new { id = aggregate.Id.Value }, cancellationToken: cancellationToken));`,
      `        foreach (var __t in aggregate.${prop})`,
      "        {",
      `            await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${a.joinTable} (${a.ownerFk}, ${a.targetFk}) VALUES (@o, @t)", new { o = aggregate.Id.Value, t = __t.Value }, cancellationToken: cancellationToken));`,
      "        }",
    ];
  });
  const assocDeleteLines = associations.map(
    (a) =>
      `        await conn.ExecuteAsync(new CommandDefinition("DELETE FROM ${a.joinTable} WHERE ${a.ownerFk} = @id", new { id = aggregate.Id.Value }, cancellationToken: cancellationToken));`,
  );

  const findMethods = (repo?.finds ?? []).map((raw) => {
    const f = unionFindAsOptionalTwin(raw, agg.name);
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
    const sql = `SELECT ${colList} FROM ${table}${where}${andFilter(where !== "")}`;
    // Paged-by-default findAll (M-T2.6): a COUNT + a whitelisted ORDER BY / LIMIT
    // / OFFSET page query returning the domain `Paged<Agg>` envelope (1-based).
    // The sort column is resolved from a fixed whitelist server-side (an unknown
    // key falls to `id`) so the interpolated column can't inject SQL; `dir` maps
    // to a literal ASC/DESC.
    if (pagedReturn(f.returnType)) {
      const fromClause = `FROM ${table}${where}${andFilter(where !== "")}`;
      const sortArms = sortableFields(agg)
        .filter((wf) => wf !== "id")
        .map((wf) => `"${wf}" => "${snake(wf)}"`)
        .join(", ");
      return lines(
        `    public async Task<${ret}> ${name}(${renderParams(f.params, ["int page", "int pageSize", "string sort", "string dir"])})`,
        `    {`,
        `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
        `        var offset = (page - 1) * pageSize;`,
        `        var sortColumn = sort switch { ${sortArms}${sortArms ? ", " : ""}_ => "id" };`,
        `        var sortDir = dir == "desc" ? "DESC" : "ASC";`,
        `        var total = await conn.ExecuteScalarAsync<int>(new CommandDefinition("SELECT COUNT(*) ${fromClause}"${paramObj}, cancellationToken: cancellationToken));`,
        `        var totalPages = pageSize > 0 ? (int)System.Math.Ceiling((double)total / pageSize) : 0;`,
        `        var rows = await conn.QueryAsync<Row>(new CommandDefinition($"SELECT ${colList} ${fromClause} ORDER BY {sortColumn} {sortDir} LIMIT @__take OFFSET @__offset", new { __take = pageSize, __offset = offset }, cancellationToken: cancellationToken));`,
        `        var items = rows.Select(Map).ToList();`,
        ...(hasAssoc ? [`        await LoadRefsAsync(conn, items, cancellationToken);`] : []),
        `        return new Paged<${agg.name}>(items, page, pageSize, total, totalPages);`,
        `    }`,
      );
    }
    if (isList) {
      return lines(
        `    public async Task<${ret}> ${name}(${renderParams(f.params)})`,
        `    {`,
        `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
        `        var rows = await conn.QueryAsync<Row>(new CommandDefinition("${sql}"${paramObj}, cancellationToken: cancellationToken));`,
        ...(hasAssoc
          ? [
              `        var __roots = rows.Select(Map).ToList();`,
              `        await LoadRefsAsync(conn, __roots, cancellationToken);`,
              `        return __roots;`,
            ]
          : [`        return rows.Select(Map).ToList();`]),
        `    }`,
      );
    }
    return lines(
      `    public async Task<${ret}> ${name}(${renderParams(f.params)})`,
      `    {`,
      `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
      `        var r = await conn.QuerySingleOrDefaultAsync<Row>(new CommandDefinition("${sql}"${paramObj}, cancellationToken: cancellationToken));`,
      ...(hasAssoc
        ? [
            `        if (r is null) return null;`,
            `        var __one = new List<${agg.name}> { Map(r) };`,
            `        await LoadRefsAsync(conn, __one, cancellationToken);`,
            `        return __one[0];`,
          ]
        : [`        return r is null ? null : Map(r);`]),
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
    const baseSql = `SELECT ${colList} FROM ${table} WHERE ${whereSql}${filterSql ? ` AND ${filterSql}` : ""}${orderSql}`;
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
        ...assocDeleteLines,
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
      `        var r = await conn.QuerySingleOrDefaultAsync<Row>(new CommandDefinition("SELECT ${colList} FROM ${table} WHERE id = @id${andFilter(true)}", new { id = id.Value }, cancellationToken: cancellationToken));`,
      ...(hasAssoc
        ? [
            "        if (r is null) return null;",
            "        var __one = new List<" + agg.name + "> { Map(r) };",
            "        await LoadRefsAsync(conn, __one, cancellationToken);",
            "        return __one[0];",
          ]
        : ["        return r is null ? null : Map(r);"]),
      "    }",
      "",
      `    public async Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${agg.name}Id> ids, CancellationToken cancellationToken = default)`,
      "    {",
      "        if (ids.Count == 0) return Array.Empty<" + agg.name + ">();",
      `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
      `        var rows = await conn.QueryAsync<Row>(new CommandDefinition("SELECT ${colList} FROM ${table} WHERE id = ANY(@ids)${andFilter(true)}", new { ids = ids.Select(x => x.Value).ToArray() }, cancellationToken: cancellationToken));`,
      ...(hasAssoc
        ? [
            "        var __roots = rows.Select(Map).ToList();",
            "        await LoadRefsAsync(conn, __roots, cancellationToken);",
            "        return __roots;",
          ]
        : ["        return rows.Select(Map).ToList();"]),
      "    }",
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
      "    {",
      ...stampLines,
      ...saveUpsertLines,
      ...assocSaveLines,
      "        foreach (var ev in aggregate.PullEvents())",
      "        {",
      "            await _events.DispatchAsync(ev, cancellationToken);",
      "        }",
      "    }",
      deleteMethod ? "" : null,
      deleteMethod || null,
      loadRefsMethod ? "" : null,
      loadRefsMethod || null,
      ...findMethods.flatMap((m) => ["", m]),
      ...retrievalMethods.flatMap((m) => ["", m]),
      "}",
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Event-sourced (`persistedAs(eventLog)`) Dapper repository (appliers, Dapper
// edition).  The .NET domain layer's fold (`_Apply` / `_FromEvents`) and the
// CQRS create chain are persistence-agnostic and reused as-is; this is the raw
// Npgsql/Dapper version of the event store — read the `<agg>_events` stream
// ordered by version and fold via `_FromEvents`; append `PullEvents()` with
// gap-free versions; finds load every stream + fold in-memory.  Event payloads
// round-trip through System.Text.Json (`RowToEvent` type-switch deserialiser).
// ---------------------------------------------------------------------------
export function renderDapperEventSourcedRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  findBodies: Array<{ name: string; filterClause: string; projectionClause: string }>,
  /** The owning bounded context's name — the per-context event log lives in
   *  `<ctx>_events` (event-log-architecture.md), shared by every stream in the
   *  context and discriminated by `stream_type`. */
  ctxName: string,
): string {
  // The single per-context event log (event-log-architecture.md): every load /
  // append / fold scopes to `stream_type = @st` (this aggregate's name) so a
  // sibling stream sharing the `<ctx>_events` table is never folded in.
  const table = `${snake(ctxName)}_events`;
  const streamType = agg.name;
  const eventNames = [...new Set((agg.appliers ?? []).map((a) => a.event))];
  const idValue = csValueTypeForId(agg.idValueType);
  const parseId =
    idValue === "Guid"
      ? "System.Guid.Parse(__g.Key)"
      : idValue === "int"
        ? "int.Parse(__g.Key)"
        : idValue === "long"
          ? "long.Parse(__g.Key)"
          : "__g.Key";
  const rowToEventArms = eventNames.map(
    (e) =>
      `            "${e}" => System.Text.Json.JsonSerializer.Deserialize<${e}>(__r.data, __json)!,`,
  );
  const findMethods = (repo?.finds ?? []).flatMap((raw) => {
    const f = unionFindAsOptionalTwin(raw, agg.name);
    const body = findBodies.find((b) => b.name === f.name);
    const filter = body?.filterClause ?? "";
    // ES finds load every stream in-memory, so strip the async EF terminal
    // (the projection clause is built with `cancellationToken`).
    const projection = (body?.projectionClause ?? ".ToListAsync(cancellationToken)")
      .replace(".ToListAsync(cancellationToken)", ".ToList()")
      .replace(".FirstOrDefaultAsync(cancellationToken)", ".FirstOrDefault()")
      .replace(".FirstAsync(cancellationToken)", ".First()");
    return [
      `    public async Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParams(f.params)})`,
      "    {",
      "        var __all = await _LoadAllAsync(cancellationToken);",
      `        return __all${filter}${projection};`,
      "    }",
    ];
  });
  return (
    lines(
      "// Auto-generated.  Dapper event-store (persistence: dapper, persistedAs(eventLog)).",
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
      `using ${ns}.Domain.Events;`,
      "",
      `namespace ${ns}.Infrastructure.Repositories;`,
      "",
      `public sealed class ${agg.name}Repository : I${agg.name}Repository`,
      "{",
      "    private readonly NpgsqlDataSource _db;",
      "    private readonly IDomainEventDispatcher _events;",
      "    private static readonly System.Text.Json.JsonSerializerOptions __json =",
      "        new(System.Text.Json.JsonSerializerDefaults.Web);",
      "",
      `    public ${agg.name}Repository(NpgsqlDataSource db, IDomainEventDispatcher events)`,
      "    {",
      "        _db = db;",
      "        _events = events;",
      "    }",
      "",
      "    private sealed class EvRow",
      "    {",
      "        public string stream_id { get; set; } = default!;",
      "        public string type { get; set; } = default!;",
      "        public string data { get; set; } = default!;",
      "    }",
      "",
      `    public async Task<${agg.name}?> GetByIdAsync(${agg.name}Id id, CancellationToken cancellationToken = default)`,
      "    {",
      "        var __sid = id.Value.ToString();",
      "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `        var __rows = (await conn.QueryAsync<EvRow>(new CommandDefinition("SELECT stream_id, type, data FROM ${table} WHERE stream_type = @st AND stream_id = @sid ORDER BY version", new { st = "${streamType}", sid = __sid }, cancellationToken: cancellationToken))).ToList();`,
      "        if (__rows.Count == 0) return null;",
      `        return ${agg.name}._FromEvents(id, __rows.Select(RowToEvent).ToList());`,
      "    }",
      "",
      `    public async Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${agg.name}Id> ids, CancellationToken cancellationToken = default)`,
      "    {",
      `        if (ids.Count == 0) return Array.Empty<${agg.name}>();`,
      `        var __out = new List<${agg.name}>();`,
      "        foreach (var __id in ids)",
      "        {",
      "            var __a = await GetByIdAsync(__id, cancellationToken);",
      "            if (__a != null) __out.Add(__a);",
      "        }",
      "        return __out;",
      "    }",
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
      "    {",
      "        var __pending = aggregate.PullEvents();",
      "        if (__pending.Count > 0)",
      "        {",
      "            var __sid = aggregate.Id.Value.ToString();",
      "            await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `            var __version = await conn.ExecuteScalarAsync<int?>(new CommandDefinition("SELECT MAX(version) FROM ${table} WHERE stream_type = @st AND stream_id = @sid", new { st = "${streamType}", sid = __sid }, cancellationToken: cancellationToken)) ?? 0;`,
      "            foreach (var __ev in __pending)",
      "            {",
      "                __version++;",
      "                var __data = System.Text.Json.JsonSerializer.Serialize((object)__ev, __json);",
      `                await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${table} (stream_type, stream_id, version, type, data, occurred_at) VALUES (@st, @sid, @version, @type, CAST(@data AS jsonb), now())", new { st = "${streamType}", sid = __sid, version = __version, type = __ev.GetType().Name, data = __data }, cancellationToken: cancellationToken));`,
      "            }",
      "        }",
      "        foreach (var ev in __pending) await _events.DispatchAsync(ev, cancellationToken);",
      "    }",
      "",
      `    private async Task<List<${agg.name}>> _LoadAllAsync(CancellationToken cancellationToken)`,
      "    {",
      "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `        var __rows = (await conn.QueryAsync<EvRow>(new CommandDefinition("SELECT stream_id, type, data FROM ${table} WHERE stream_type = @st ORDER BY stream_id, version", new { st = "${streamType}" }, cancellationToken: cancellationToken))).ToList();`,
      `        return __rows`,
      "            .GroupBy(__r => __r.stream_id)",
      `            .Select(__g => ${agg.name}._FromEvents(new ${agg.name}Id(${parseId}), __g.Select(RowToEvent).ToList()))`,
      "            .ToList();",
      "    }",
      "",
      "    private static IDomainEvent RowToEvent(EvRow __r)",
      "    {",
      "        return __r.type switch",
      "        {",
      ...rowToEventArms,
      '            _ => throw new InvalidOperationException($"Unknown event type: {__r.type}"),',
      "        };",
      "    }",
      ...findMethods.flatMap((m) => ["", m]),
      "}",
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// schema.sql bootstrap — a self-applied `CREATE TABLE IF NOT EXISTS` per
// aggregate, embedded in a C# helper run once at startup.
// ---------------------------------------------------------------------------

export function renderDapperSchema(
  aggs: readonly EnrichedAggregateIR[],
  ns: string,
  /** Snake-case names of the bounded contexts that own any event-sourced
   *  stream — one shared `<ctx>_events` log per context (event-log-architecture.md),
   *  holding every `persistedAs(eventLog)` aggregate stream discriminated by
   *  `stream_type`.  Empty ⇒ no event log. */
  eventLogContexts: readonly string[] = [],
): string {
  // Event-sourced aggregates own no per-aggregate table — their stream lives in
  // the shared per-context `<ctx>_events` log emitted after this map.
  const stateTables = aggs
    .filter((agg) => agg.persistedAs !== "eventLog")
    .map((agg) => {
      const cols = columnsOf(agg).map((c, i) => {
        const pk = i === 0 ? " primary key" : "";
        const nn = c.nullable || i === 0 ? "" : " not null";
        return `    ${c.col} ${c.sql}${pk}${nn}`;
      });
      const root = `CREATE TABLE IF NOT EXISTS ${tableOf(agg.name)} (\n${cols.join(",\n")}\n);`;
      // One join table per reference collection (`X id[]`).  `X id[]` is a set
      // (membership only, no order): the composite (owner, target) PK is the
      // whole row — no payload column.  Reads ORDER BY the target FK id.
      const joins = (agg.associations ?? []).map((a) =>
        [
          `CREATE TABLE IF NOT EXISTS ${a.joinTable} (`,
          `    ${a.ownerFk} ${idTypes(agg.idValueType).sql} not null,`,
          `    ${a.targetFk} ${idTypes(a.valueType).sql} not null,`,
          `    primary key (${a.ownerFk}, ${a.targetFk})`,
          ");",
        ].join("\n"),
      );
      return [root, ...joins].join("\n\n");
    });
  // The single per-context event log `<ctx>_events` (event-log-architecture.md):
  // seq cursor + stream_type discriminator + PK (stream_type, stream_id,
  // version) + unique seq index — mirrors the canonical migration.
  const eventLogTables = eventLogContexts.map((ctxSnake) => {
    const t = `${ctxSnake}_events`;
    return [
      `CREATE TABLE IF NOT EXISTS ${t} (`,
      "    seq bigserial not null,",
      "    stream_type text not null,",
      "    stream_id text not null,",
      "    version int not null,",
      "    type text not null,",
      "    data jsonb not null,",
      "    occurred_at timestamptz not null default now(),",
      "    primary key (stream_type, stream_id, version)",
      ");",
      `CREATE UNIQUE INDEX IF NOT EXISTS ${t}_seq_key ON ${t} (seq);`,
    ].join("\n");
  });
  const ddl = [...stateTables, ...eventLogTables].join("\n\n");
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
  `    <PackageReference Include="Dapper" Version="2.1.79" />`,
  `    <PackageReference Include="Npgsql" Version="10.0.3" />`,
];

/** Program.cs persistence wiring for Dapper — registers the NpgsqlDataSource
 *  (replaces the `AddDbContext` block). */
export function renderDapperConnectionSetup(): readonly string[] {
  return [
    `builder.Services.AddSingleton(Npgsql.NpgsqlDataSource.Create(`,
    `    builder.Configuration.GetConnectionString("Default")!));`,
  ];
}
