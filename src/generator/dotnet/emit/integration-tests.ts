// Context-scoped INTEGRATION test emission (test-placement.md, Phase 3b) — the
// .NET/EF backend.  The .NET twin of the node renderer
// (`typescript/emit/integration-tests.ts`): a `test … for <Context>` (or a
// `context`-nested `test`) runs cross-aggregate behaviour IN-PROCESS against
// live EF repositories, no HTTP — a create persists via `repo.SaveAsync(...)`,
// an operation mutates-then-saves, a repository find reads back.  The emitted
// class is provisioning-agnostic — it reads `LOOM_PG_URL` (a Loom app already
// ships a compose Postgres), applies the EF migrations via
// `db.Database.MigrateAsync()`, wires the context's repositories, and runs the
// body.
//
// v1 constraints: a repository find must be LET-BOUND
// (`loom.integration-find-must-bind`, shared with node), and the dispatcher is
// the no-op — synchronous workflow cascade for the non-node backends is the
// tracked 3b follow-up (the app's in-process cascade is DI-resolved, so it needs
// a service provider the plain test harness doesn't build).

import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  FindIR,
  TestIR,
  TestStmtIR,
} from "../../../ir/types/loom-ir.js";
import { lowerFirst, plural, upperFirst } from "../../../util/naming.js";
import { renderCsExpr } from "../render-expr.js";
import { renderCreateCall, renderExplicitMatcherToAwesome, renderTestExpr } from "./tests.js";

/** A repository find on `agg` named `name`, or undefined. */
function findRepoQuery(name: string, aggName: string, ctx: BoundedContextIR): FindIR | undefined {
  for (const r of ctx.repositories) {
    if (r.aggregateName !== aggName) continue;
    const f = r.finds.find((q) => q.name === name);
    if (f) return f;
  }
  return undefined;
}

/** A `<Agg>.create(...)` / named create-action call → the owning aggregate;
 *  undefined when the call is not a create. */
function createAggOf(e: ExprIR, ctx: BoundedContextIR): AggregateIR | undefined {
  if (e.kind !== "method-call" || e.receiver.kind !== "ref") return undefined;
  const agg = ctx.aggregates.find((a) => a.name === (e.receiver as { name: string }).name);
  if (!agg) return undefined;
  if (e.member === "create" || (agg.creates ?? []).some((c) => c.name === e.member)) return agg;
  return undefined;
}

// Built-in repository reads every aggregate's repo emits.
const BUILTIN_READS = new Set(["findById", "getById", "findAll"]);

/** A `<Agg>.<find>(...)` repository read → the aggregate + emitted call + whether
 *  it is nullable; undefined otherwise.  `.NET`'s `GetByIdAsync` returns
 *  `<Agg>?` (there is no throwing variant), so both `findById` and `getById` map
 *  to it and get a `!` non-null assertion.  `findAll` folds its `Paged<T>` down
 *  to `.Items` (node's `<Agg>[]`); a custom find keeps its return arity. */
function findCallOf(
  e: ExprIR,
  ctx: BoundedContextIR,
): { call: string; nullable: boolean } | undefined {
  if (e.kind !== "method-call" || e.receiver.kind !== "ref") return undefined;
  const aggName = (e.receiver as { name: string }).name;
  if (!ctx.repositories.some((r) => r.aggregateName === aggName)) return undefined;
  const custom = findRepoQuery(e.member, aggName, ctx);
  if (!BUILTIN_READS.has(e.member) && !custom) return undefined;
  const repo = repoVar(aggName);
  const args = e.args.map((a) => renderCsExpr(a)).join(", ");
  if (e.member === "findById" || e.member === "getById") {
    return { call: `await ${repo}.GetByIdAsync(${args})`, nullable: true };
  }
  if (e.member === "findAll") {
    return { call: `(await ${repo}.All(1, 1000, "id", "asc")).Items`, nullable: false };
  }
  const nullable = custom?.returnType.kind === "optional" || custom?.returnType.kind === "union";
  return { call: `await ${repo}.${upperFirst(e.member)}(${args})`, nullable };
}

const repoVar = (aggName: string): string => `${lowerFirst(aggName)}Repo`;
const aggNamespace = (aggName: string, ns: string): string =>
  `${ns}.Domain.${upperFirst(plural(aggName))}`;

/** Render one integration-test statement (8-space body indent).  Creates and
 *  mutating ops persist via the repository; let-bound finds await a repository
 *  read (nullable → `!`); everything else defers to the shared expression /
 *  matcher renderers. */
function renderStmt(s: TestStmtIR, ctx: BoundedContextIR): string[] {
  const I = "        ";
  switch (s.kind) {
    case "let": {
      const agg = createAggOf(s.expr, ctx);
      if (agg && s.expr.kind === "method-call" && s.expr.args[0]?.kind === "object") {
        const create = renderCreateCall(s.expr, ctx) ?? renderTestExpr(s.expr, ctx);
        return [
          `${I}var ${s.name} = ${create};`,
          `${I}await ${repoVar(agg.name)}.SaveAsync(${s.name});`,
        ];
      }
      const find = findCallOf(s.expr, ctx);
      if (find) {
        return [`${I}var ${s.name} = ${find.nullable ? `(${find.call})!` : find.call};`];
      }
      return [`${I}var ${s.name} = ${renderTestExpr(s.expr, ctx)};`];
    }
    case "expression": {
      // A mutating operation on a let-bound aggregate instance → mutate in place,
      // then persist (mirrors the route handler's load → mutate → save).
      if (
        s.expr.kind === "method-call" &&
        s.expr.receiverType.kind === "entity" &&
        !s.expr.isCollectionOp
      ) {
        const aggName = s.expr.receiverType.name;
        const recv = renderCsExpr(s.expr.receiver);
        return [
          `${I}${renderTestExpr(s.expr, ctx)};`,
          `${I}await ${repoVar(aggName)}.SaveAsync(${recv});`,
        ];
      }
      return [`${I}${renderTestExpr(s.expr, ctx)};`];
    }
    case "expect": {
      const explicit = renderExplicitMatcherToAwesome(s.expr);
      if (explicit) return [`${I}${explicit}`];
      throw new Error("expect requires a matcher (e.g. expect(x).toBe(y)).");
    }
    case "expect-throws": {
      const inner = renderTestExpr(s.expr, ctx);
      const isInvocation = s.expr.kind === "method-call" || s.expr.kind === "call";
      const body = isInvocation ? `${inner};` : `var __ = ${inner};`;
      return [
        `${I}await Assert.ThrowsAsync<DomainException>(async () => { ${body} await Task.CompletedTask; });`,
      ];
    }
    default:
      throw new Error(`unsupported integration-test statement '${s.kind}'`);
  }
}

function renderTest(t: TestIR, ctx: BoundedContextIR, usedAggs: readonly AggregateIR[]): string[] {
  const methodName = upperFirst(t.name.replace(/[^A-Za-z0-9]+/g, "_")) || "Test";
  const out: string[] = [];
  out.push(`    [Fact(DisplayName = ${JSON.stringify(t.name)})]`);
  out.push(`    public async Task ${methodName}()`);
  out.push("    {");
  out.push(
    "        var opts = new DbContextOptionsBuilder<AppDbContext>().UseNpgsql(ConnString()).Options;",
  );
  out.push("        await using var db = new AppDbContext(opts);");
  out.push("        await db.Database.MigrateAsync();");
  out.push("        var events = new NoopDomainEventDispatcher();");
  for (const a of usedAggs) {
    out.push(
      `        var ${repoVar(a.name)} = new ${a.name}Repository(db, events, NullLogger<${a.name}Repository>.Instance);`,
    );
  }
  for (const s of t.statements) out.push(...renderStmt(s, ctx));
  out.push("    }");
  return out;
}

/** Emit `Tests/<ns>.Tests/<Ctx>IntegrationTests.cs` for a context that declares
 *  integration tests, or null when it declares none. */
export function renderContextIntegrationTest(ctx: BoundedContextIR, ns: string): string | null {
  if (ctx.tests.length === 0) return null;

  // Which aggregates (with a repo) the bodies reference → wire + import.  Detect
  // from the rendered statement bodies (before the per-test wiring is prepended).
  const bodyOnly = ctx.tests
    .flatMap((t) => t.statements)
    .flatMap((s) => renderStmt(s, ctx))
    .join("\n");
  const usedAggs = ctx.aggregates.filter(
    (a) =>
      ctx.repositories.some((r) => r.aggregateName === a.name) &&
      new RegExp(`\\b${a.name}\\b`).test(bodyOnly),
  );
  const methodBlocks = ctx.tests.map((t) => renderTest(t, ctx, usedAggs));

  const className = `${upperFirst(ctx.name)}IntegrationTests`;
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push("using System;");
  lines.push("using System.Threading.Tasks;");
  lines.push("using Microsoft.EntityFrameworkCore;");
  lines.push("using Microsoft.Extensions.Logging.Abstractions;");
  lines.push("using Xunit;");
  lines.push("using AwesomeAssertions;");
  lines.push(`using ${ns}.Domain.Common;`);
  if (ctx.aggregates.length > 0) lines.push(`using ${ns}.Domain.Ids;`);
  for (const nsp of [...new Set(usedAggs.map((a) => aggNamespace(a.name, ns)))].sort()) {
    lines.push(`using ${nsp};`);
  }
  lines.push(`using ${ns}.Infrastructure.Persistence;`);
  lines.push(`using ${ns}.Infrastructure.Repositories;`);
  lines.push(`using ${ns}.Infrastructure.Events;`);
  lines.push("");
  lines.push(`namespace ${ns}.Tests;`);
  lines.push("");
  lines.push(`public sealed class ${className}`);
  lines.push("{");
  // Provisioning-agnostic connection: LOOM_PG_URL (a libpq URL, the same knob
  // the other backends read) → an Npgsql keyword connection string.
  lines.push("    private static string ConnString()");
  lines.push("    {");
  lines.push('        var url = Environment.GetEnvironmentVariable("LOOM_PG_URL");');
  lines.push("        if (string.IsNullOrEmpty(url))");
  lines.push(
    '            return "Host=localhost;Port=5432;Username=postgres;Password=postgres;Database=postgres";',
  );
  lines.push('        if (!url.StartsWith("postgres", StringComparison.Ordinal)) return url;');
  lines.push("        var uri = new Uri(url);");
  lines.push("        var userInfo = uri.UserInfo.Split(':');");
  lines.push("        var db = uri.AbsolutePath.TrimStart('/');");
  lines.push(
    '        return $"Host={uri.Host};Port={(uri.Port > 0 ? uri.Port : 5432)};Username={userInfo[0]};Password={(userInfo.Length > 1 ? userInfo[1] : "")};Database={db}";',
  );
  lines.push("    }");
  lines.push("");
  for (const block of methodBlocks) {
    lines.push(...block);
    lines.push("");
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}
