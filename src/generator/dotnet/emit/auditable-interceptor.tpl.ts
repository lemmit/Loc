import type { AggregateIR, ContextStampIR, ExprIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { renderCsExpr } from "../render-expr.js";

// EF Core SaveChangesInterceptor that stamps fields on lifecycle
// events.  Driven by a per-entity-type stamp registry generated
// from each aggregate's `contextStamps` IR.  No marker interface,
// no per-aggregate handler logic — adding a new stamping macro
// just adds a switch arm here.
//
// The generator emits one switch on entry.Entity, one arm per
// aggregate that has any stamping rules.  Inside each arm, the
// onCreate / onUpdate assignments are written through EF's metadata
// accessor via the COMPILE-CHECKED lambda overload
// (`ctx.Entry(e).Property(x => x.CreatedAt).CurrentValue = …`), not the
// CLR setter — so the entity's stamped columns stay `{ get; private set; }`
// (no `internal set` leak) while the write site stays bound to a real
// property at compile time (a renamed/removed column is a build error, not a
// runtime `Property("…")` throw).  The RHS uses the same expression machinery
// operation bodies use; `now()` resolves to `DateTime.UtcNow`.
//
// A `currentUser` stamp value (`createdBy := currentUser`) is the
// principal id — the .NET analogue of the Java backend's
// `currentUser.id()`.  The interceptor is not a per-request type, so
// it reads the request-scoped principal from the ambient
// `RequestContext.Current` (the AsyncLocal carrier UserMiddleware
// attaches the verified `User` to) and stamps its id property
// (`actorIdProp`).  Principal stamps without auth are rejected
// upstream (`loom.dotnet-stamp-unsupported`), so when any arm uses
// the principal `actorIdProp` is guaranteed present.

export function renderAuditableInterceptor(
  ns: string,
  aggregates: readonly AggregateIR[],
  /** The system user-block id property (PascalCased), e.g. `Id`.  Present
   *  whenever the deployable carries auth; required for any `currentUser`
   *  stamp value.  Undefined ⇒ no principal stamps reach this emitter. */
  actorIdProp?: string,
): string {
  // Each aggregate contributes zero or more stamping rules; group
  // by aggregate so we can emit one switch arm per type.  Skip
  // aggregates with no stamps so the switch stays tight.
  const stamping = aggregates
    .map((a) => ({ agg: a, rules: a.contextStamps ?? [] }))
    .filter((x) => x.rules.length > 0);

  // Build the switch body: for each aggregate, an arm that matches
  // entry.Entity to the concrete type and applies the relevant
  // assignments based on entry.State.
  const switchArms = stamping.map(({ agg, rules }) => renderArm(rules, agg, actorIdProp));

  // Per-aggregate using directives so the pattern in each arm can name
  // the type unqualified.
  const usings = stamping.map(({ agg }) => `using ${ns}.Domain.${plural(agg.name)};`);

  // Principal stamps reach into the ambient RequestContext for the verified
  // User; the namespaces (and the special rendering) only apply when the
  // principal id property is known — i.e. the deployable carries auth.  Without
  // it a principal stamp is rejected upstream (loom.dotnet-stamp-unsupported);
  // the legacy single-context generator path has no auth wiring, so it falls
  // back to the plain expr render (unchanged) rather than a dangling reference.
  const usesPrincipal = stamping.some(({ rules }) =>
    rules.some((r) => r.assignments.some((a) => referencesCurrentUser(a.value))),
  );
  const principalUsings = usesPrincipal ? [`using ${ns}.Domain.Common;`, `using ${ns}.Auth;`] : [];

  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Diagnostics;",
      "using Microsoft.EntityFrameworkCore.Infrastructure;",
      `using ${ns}.Domain.Ids;`,
      ...principalUsings,
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
      // Static: the body reads only the event data + ambient statics
      // (RequestContext.Current, DateTime.UtcNow), no instance state (CA1822).
      "    private static void Stamp(DbContextEventData eventData)",
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

/** True for a bare `currentUser` stamp value — the principal-id case
 * (`createdBy := currentUser`), rendered specially from the ambient
 * RequestContext rather than as an undefined local. */
function isCurrentUserRef(value: ExprIR): boolean {
  return value.kind === "ref" && value.refKind === "current-user";
}

/** Deep check: does the stamp value reference `currentUser` ANYWHERE — bare
 * (`createdBy := currentUser`) or through a member (`createdByRole :=
 * currentUser.role`)?  The interceptor is static, so any such reference needs
 * the ambient-principal wiring (usings + the arm-local `currentUser`). */
function referencesCurrentUser(e: ExprIR): boolean {
  if (isCurrentUserRef(e)) return true;
  switch (e.kind) {
    case "member":
      return referencesCurrentUser(e.receiver);
    case "method-call":
      return referencesCurrentUser(e.receiver) || e.args.some(referencesCurrentUser);
    case "call":
      return e.args.some(referencesCurrentUser);
    case "binary":
      return referencesCurrentUser(e.left) || referencesCurrentUser(e.right);
    case "unary":
      return referencesCurrentUser(e.operand);
    case "paren":
      return referencesCurrentUser(e.inner);
    case "ternary":
      return (
        referencesCurrentUser(e.cond) ||
        referencesCurrentUser(e.then) ||
        referencesCurrentUser(e.otherwise)
      );
    case "new":
    case "object":
      return e.fields.some((f) => referencesCurrentUser(f.value));
    default:
      return false;
  }
}

/** Switch arm for one aggregate's stamping rules.  Body assigns per-event
 * fields on the matched entity through EF's metadata accessor via the
 * compile-checked lambda overload (`ctx.Entry(e).Property(x => x.Field)
 * .CurrentValue = …`), so the stamped property can stay `private set` while
 * the write remains bound to a real property at compile time.  The value
 * expressions are rendered with `e` as the `this` binder; a bare `currentUser`
 * value renders to the ambient principal's id
 * (`RequestContext.Current!.CurrentUser!.<actorIdProp>`), mirroring the Java
 * backend's `currentUser.id()`. */
function renderArm(
  rules: readonly ContextStampIR[],
  agg: AggregateIR,
  actorIdProp?: string,
): string {
  const argName = "e"; // local for the matched entity inside the arm
  const onCreate = rules.find((r) => r.event === "create")?.assignments ?? [];
  const onUpdate = rules.find((r) => r.event === "update")?.assignments ?? [];

  const renderValue = (value: ExprIR): string =>
    isCurrentUserRef(value) && actorIdProp
      ? `RequestContext.Current!.CurrentUser!.${actorIdProp}`
      : renderCsExpr(value, { thisName: argName });
  // EF metadata write through the compile-checked lambda: keeps the stamped
  // property `private set` (the CLR setter is never invoked) yet binds the
  // write to a real property name at build time.
  const assign = (field: string, value: ExprIR): string =>
    `                        ctx.Entry(${argName}).Property(x => x.${upperFirst(field)}).CurrentValue = ${renderValue(value)};`;
  const createAssigns = onCreate.map((a) => assign(a.field, a.value));
  const updateAssigns = onUpdate.map((a) => assign(a.field, a.value));

  // A stamp value that reaches THROUGH the principal (`currentUser.role`)
  // renders as an ordinary member read on a `currentUser` local — which a
  // static interceptor doesn't have.  Materialise it from the ambient
  // RequestContext inside the arm (braced: switch-section locals share the
  // whole switch block's declaration space, so an unbraced `var currentUser`
  // in two arms is CS0128).  The bare-ref case keeps its direct
  // `RequestContext...<actorIdProp>` rendering and needs no local.
  const needsUserLocal = [...onCreate, ...onUpdate].some(
    (a) => referencesCurrentUser(a.value) && !(isCurrentUserRef(a.value) && actorIdProp),
  );

  const arm = [`                case ${agg.name} ${argName}:`];
  if (needsUserLocal) {
    arm.push("                {");
    arm.push("                    var currentUser = RequestContext.Current!.CurrentUser!;");
  }
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
  if (needsUserLocal) arm.push("                }");
  return arm.join("\n");
}
