// First-boot database seeding for the .NET/EF Core backend
// (database-seeding.md, Phase 3a).  Emits `Infrastructure/Persistence/Seed.cs`
// from the context's `SeedIR` list.
//
// Per D-SEED-PATH the default path is **through the domain `Create`**: each
// row becomes `await <agg>Repo.SaveAsync(<Agg>.Create(…), cancellationToken)`, so the
// aggregate's invariants run.  Unlike the Hono `create({ … })` named object,
// the C# `Create(…)` factory is **positional** in the aggregate's
// required-field order, so a row's fields are ordered to match before being
// rendered by the shared `renderCsExpr` (value objects → `new Money(…)`,
// enums → `Tier.Free`, money → `1.0m`).  The repository is DI-resolved (its
// ctor needs an ILogger), so it is fetched via `sp.GetRequiredService`.
//
// Per D-SEED-IDEMPOTENCY v1 is **ship-once per dataset**: a `__loom_seed`
// marker table holds one row per applied dataset; a dataset whose marker is
// present is skipped.  `default` always runs; others opt in via `LOOM_SEED`.
//
// The `raw` table-insert path is wired too: `raw` rows bypass the domain
// `Create` and emit direct SQL via the shared `renderSeedRowInsert`.
// Cross-row references use explicit ids per D-SEED-XREF (an `@handle`
// indirection was considered and not adopted).

import { createInputFields, createOmissionValue } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  SeedRowIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, upperFirst } from "../../../util/naming.js";
import { renderSeedRowInsert } from "../../sql-pg.js";
import { renderCsExpr } from "../render-expr.js";

interface Entry {
  row: SeedRowIR;
  raw: boolean;
}

interface Dataset {
  name: string;
  entries: Entry[];
}

export function emitDotnetSeeds(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  const datasets = groupByDataset(ctx);
  if (datasets.length === 0) return;

  const aggByName = new Map<string, EnrichedAggregateIR>(
    ctx.aggregates.filter((a) => !a.isAbstract).map((a) => [a.name, a]),
  );

  const fnBlocks: string[] = [];
  const callLines: string[] = [];
  const usedAggs = new Set<string>();
  for (const ds of datasets) {
    const entries = ds.entries.filter((e) => aggByName.has(e.row.aggregate));
    if (entries.length === 0) continue;
    fnBlocks.push(renderDatasetFn(ds.name, entries, aggByName));
    callLines.push(
      `        await Seed${upperFirst(ds.name)}(db, sp, requested, cancellationToken);`,
    );
    // raw rows emit SQL only — they import no aggregate class/repository.
    for (const e of entries) if (!e.raw) usedAggs.add(e.row.aggregate);
  }
  if (callLines.length === 0) return;

  out.set(
    "Infrastructure/Persistence/Seed.cs",
    renderSeedFile(ns, fnBlocks, callLines, [...usedAggs].sort(), ctx),
  );
}

function groupByDataset(ctx: EnrichedBoundedContextIR): Dataset[] {
  const byName = new Map<string, Dataset>();
  const order: string[] = [];
  for (const seed of ctx.seeds) {
    let ds = byName.get(seed.dataset);
    if (!ds) {
      ds = { name: seed.dataset, entries: [] };
      byName.set(seed.dataset, ds);
      order.push(seed.dataset);
    }
    for (const row of seed.rows) ds.entries.push({ row, raw: seed.path === "raw" });
  }
  return order.map((n) => byName.get(n)!);
}

function renderDatasetFn(
  dataset: string,
  entries: Entry[],
  aggByName: Map<string, EnrichedAggregateIR>,
): string {
  const domainAggs = [...new Set(entries.filter((e) => !e.raw).map((e) => e.row.aggregate))];
  const repoDecls = domainAggs.map(
    (a) => `        var ${repoVar(a)} = sp.GetRequiredService<I${a}Repository>();`,
  );
  const saveLines = entries.map((e) => {
    if (e.raw) {
      // raw path (D-SEED-XREF): direct INSERT with explicit id + FK columns.
      return `        await db.Database.ExecuteSqlRawAsync(${csVerbatim(renderSeedRowInsert(e.row.aggregate, e.row.fields))}, cancellationToken);`;
    }
    const agg = aggByName.get(e.row.aggregate)!;
    return `        await ${repoVar(e.row.aggregate)}.SaveAsync(${e.row.aggregate}.Create(${renderArgs(e.row, agg)}), cancellationToken);`;
  });
  return lines(
    `    private static async Task Seed${upperFirst(dataset)}(`,
    "        AppDbContext db,",
    "        IServiceProvider sp,",
    "        HashSet<string> requested,",
    "        CancellationToken cancellationToken)",
    "    {",
    `        if (!DatasetEnabled(${csStr(dataset)}, requested)) return;`,
    `        if (await AlreadySeeded(db, ${csStr(dataset)}, cancellationToken)) return;`,
    ...repoDecls,
    ...saveLines,
    `        await MarkSeeded(db, ${csStr(dataset)}, cancellationToken);`,
    "    }",
    "",
  );
}

/** Positional `Create(…)` args in the factory's parameter order.  The .NET
 *  `Create(...)` factory declares EVERY create-input field (`createInputFields`
 *  — optionals included) as a required positional parameter, so a seed row
 *  that names only a subset must still supply every position: provided values
 *  render in place, omitted ones take their omission value (optional → null,
 *  bare bool → false, `= default` → the default literal) — mirroring the
 *  workflow `factoryLet` emission.  Filtering to the row's own non-optional
 *  fields (the old shape) drops required positions → CS7036. */
function renderArgs(row: SeedRowIR, agg: EnrichedAggregateIR): string {
  const byName = new Map(row.fields.map((f) => [f.name, f.value]));
  return createInputFields(agg)
    .map((f) => {
      const provided = byName.get(f.name);
      if (provided !== undefined) return renderSeedValue(provided, f.type);
      const v = createOmissionValue(f);
      return v.kind === "default" ? renderCsExpr(v.expr) : v.kind === "false" ? "false" : "null";
    })
    .join(", ");
}

/** A provided seed value, coerced to the factory's parameter type where the
 *  DSL literal and the CLR type diverge: a STRING literal for a `datetime`
 *  field parses to a UTC `DateTime` (the factory takes `DateTime`, not the
 *  wire string — same coercion as `wireToCommandArgument`). */
function renderSeedValue(value: ExprIR, fieldType: TypeIR): string {
  let t = fieldType;
  while (t.kind === "optional") t = t.inner;
  if (t.kind === "primitive" && t.name === "datetime" && value.kind === "literal") {
    return `DateTime.Parse(${renderCsExpr(value)}, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal)`;
  }
  return renderCsExpr(value);
}

function repoVar(agg: string): string {
  return `${lowerFirst(agg)}Repo`;
}

function csStr(s: string): string {
  return JSON.stringify(s);
}

/** A C# verbatim string literal (`@"…"`, doubling `"`) — keeps the SQL's own
 *  double-quoted identifiers + single-quoted values readable. */
function csVerbatim(s: string): string {
  return `@"${s.replace(/"/g, '""')}"`;
}

function renderSeedFile(
  ns: string,
  fnBlocks: string[],
  callLines: string[],
  aggs: string[],
  ctx: EnrichedBoundedContextIR,
): string {
  const body = lines(...fnBlocks);
  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const usesVo = ctx.valueObjects.some((v) => new RegExp(`\\b${v.name}\\b`).test(scan));
  const usesEnum = ctx.enums.some((e) => new RegExp(`\\b${e.name}\\b`).test(scan));

  const usings = lines(
    "using System;",
    "using System.Collections.Generic;",
    // The datetime seed-literal coercion (renderSeedValue) reaches into
    // CultureInfo/DateTimeStyles — outside the emitted file's other usings.
    body.includes("CultureInfo.") && "using System.Globalization;",
    "using System.Linq;",
    "using System.Threading;",
    "using System.Threading.Tasks;",
    "using Microsoft.EntityFrameworkCore;",
    "using Microsoft.Extensions.DependencyInjection;",
    usesVo && `using ${ns}.Domain.ValueObjects;`,
    usesEnum && `using ${ns}.Domain.Enums;`,
    // Each seeded aggregate's class + I<Agg>Repository share this namespace.
    ...aggs.map((a) => `using ${ns}.Domain.${plural(a)};`),
  );

  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      usings,
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "/// <summary>First-boot seed data (database-seeding.md).  Ship-once per",
      "/// dataset via the __loom_seed marker (D-SEED-IDEMPOTENCY); re-runs are",
      "/// no-ops.</summary>",
      "public static class Seed",
      "{",
      "    public static async Task RunSeeds(AppDbContext db, IServiceProvider sp, CancellationToken cancellationToken = default)",
      "    {",
      "        await db.Database.ExecuteSqlRawAsync(",
      '            "CREATE TABLE IF NOT EXISTS \\"__loom_seed\\" (\\"dataset\\" text PRIMARY KEY, \\"applied_at\\" timestamptz NOT NULL DEFAULT now())",',
      "            cancellationToken);",
      '        var requested = (Environment.GetEnvironmentVariable("LOOM_SEED") ?? "")',
      "            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)",
      "            .ToHashSet();",
      ...callLines,
      "    }",
      "",
      "    // `default` always runs; other datasets opt in via LOOM_SEED.",
      "    private static bool DatasetEnabled(string dataset, HashSet<string> requested) =>",
      '        dataset == "default" || requested.Contains(dataset);',
      "",
      "    private static async Task<bool> AlreadySeeded(AppDbContext db, string dataset, CancellationToken cancellationToken)",
      "    {",
      "        var conn = db.Database.GetDbConnection();",
      "        var opened = conn.State != System.Data.ConnectionState.Open;",
      "        if (opened) await conn.OpenAsync(cancellationToken);",
      "        try",
      "        {",
      "            await using var cmd = conn.CreateCommand();",
      '            cmd.CommandText = "SELECT 1 FROM \\"__loom_seed\\" WHERE \\"dataset\\" = @dataset";',
      "            var p = cmd.CreateParameter();",
      '            p.ParameterName = "@dataset";',
      "            p.Value = dataset;",
      "            cmd.Parameters.Add(p);",
      "            return await cmd.ExecuteScalarAsync(cancellationToken) is not null;",
      "        }",
      "        finally",
      "        {",
      "            if (opened) await conn.CloseAsync();",
      "        }",
      "    }",
      "",
      "    private static async Task MarkSeeded(AppDbContext db, string dataset, CancellationToken cancellationToken) =>",
      "        await db.Database.ExecuteSqlRawAsync(",
      '            "INSERT INTO \\"__loom_seed\\" (\\"dataset\\") VALUES ({0})",',
      "            new object[] { dataset }, cancellationToken);",
      "",
      body,
      "}",
    ) + "\n"
  );
}
