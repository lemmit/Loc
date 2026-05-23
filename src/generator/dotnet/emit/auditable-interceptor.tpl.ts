import type { AggregateIR, ContextStampIR } from "../../../ir/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { renderCsExpr } from "../render-expr.js";

// EF Core SaveChangesInterceptor that stamps fields on lifecycle
// events.  Driven by a per-entity-type stamp registry generated
// from each aggregate's `contextStamps` IR.  No marker interface,
// no per-aggregate handler logic — adding a new stamping macro
// just adds a switch arm here.
//
// The generator emits one switch on entry.Entity.GetType(), one
// arm per aggregate that has any stamping rules.  Inside each arm,
// the onCreate / onUpdate assignments are rendered using the same
// expression machinery operation bodies use; `currentUser`,
// `now()`, and other magic identifiers resolve through their
// normal IR lowering, so the interceptor body reads like any other
// generated C# expression.

export function renderAuditableInterceptor(ns: string, aggregates: readonly AggregateIR[]): string {
  // Each aggregate contributes zero or more stamping rules; group
  // by aggregate so we can emit one switch arm per type.  Skip
  // aggregates with no stamps so the switch stays tight.
  const stamping = aggregates
    .map((a) => ({ agg: a, rules: a.contextStamps ?? [] }))
    .filter((x) => x.rules.length > 0);

  // Build the switch body: for each aggregate, an arm that casts
  // entry.Entity to the concrete type and applies the relevant
  // assignments based on entry.State.
  const switchArms = stamping.map(({ agg, rules }) => renderArm(ns, agg, rules));

  // Per-aggregate using directives so the cast in each arm can name
  // the type unqualified.
  const usings = stamping.map(({ agg }) => `using ${ns}.Domain.${plural(agg.name)};`);

  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Diagnostics;",
      "using Microsoft.EntityFrameworkCore.Infrastructure;",
      `using ${ns}.Domain.Ids;`,
      ...usings,
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "public sealed class AuditableInterceptor : SaveChangesInterceptor",
      "{",
      "    public override InterceptionResult<int> SavingChanges(",
      "        DbContextEventData eventData,",
      "        InterceptionResult<int> result)",
      "    {",
      "        Stamp(eventData);",
      "        return base.SavingChanges(eventData, result);",
      "    }",
      "",
      "    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(",
      "        DbContextEventData eventData,",
      "        InterceptionResult<int> result,",
      "        CancellationToken cancellationToken = default)",
      "    {",
      "        Stamp(eventData);",
      "        return base.SavingChangesAsync(eventData, result, cancellationToken);",
      "    }",
      "",
      "    private void Stamp(DbContextEventData eventData)",
      "    {",
      "        var ctx = eventData.Context;",
      "        if (ctx is null) return;",
      "        foreach (var entry in ctx.ChangeTracker.Entries())",
      "        {",
      "            if (entry.State != EntityState.Added && entry.State != EntityState.Modified) continue;",
      "            switch (entry.Entity)",
      "            {",
      ...switchArms,
      "                default: break;",
      "            }",
      "        }",
      "    }",
      "}",
    ) + "\n"
  );
}

/** Switch arm for one aggregate's stamping rules.  Body assigns
 * per-event fields on the casted entity using the macro-supplied
 * value expressions, rendered with `entity` as the `this` binder. */
function renderArm(ns: string, agg: AggregateIR, rules: readonly ContextStampIR[]): string {
  const argName = "e"; // local for the casted entity inside the arm
  const onCreate = rules.find((r) => r.event === "create")?.assignments ?? [];
  const onUpdate = rules.find((r) => r.event === "update")?.assignments ?? [];

  const createAssigns = onCreate.map(
    (a) =>
      `                        ${argName}.${upperFirst(a.field)} = ${renderCsExpr(a.value, { thisName: argName })};`,
  );
  const updateAssigns = onUpdate.map(
    (a) =>
      `                        ${argName}.${upperFirst(a.field)} = ${renderCsExpr(a.value, { thisName: argName })};`,
  );

  const arm = [`                case ${agg.name} ${argName}:`];
  if (createAssigns.length) {
    arm.push("                    if (entry.State == EntityState.Added)");
    arm.push("                    {");
    arm.push(...createAssigns);
    arm.push("                    }");
  }
  if (updateAssigns.length) {
    arm.push(
      "                    if (entry.State == EntityState.Added || entry.State == EntityState.Modified)",
    );
    arm.push("                    {");
    arm.push(...updateAssigns);
    arm.push("                    }");
  }
  arm.push("                    break;");
  void ns;
  return arm.join("\n");
}
