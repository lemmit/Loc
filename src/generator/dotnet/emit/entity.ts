import type { AggregateIR, EntityPartIR } from "../../../ir/loom-ir.js";
import { operationUsesCurrentUser } from "../../../ir/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { csNewIdValue, renderCsExpr, renderCsType } from "../render-expr.js";
import { renderCsStatements } from "../render-stmt.js";

// ---------------------------------------------------------------------------
// Aggregate root + entity-part class emission for .NET.  The shape is a
// sealed class with private setters everywhere, an explicit
// parameterless ctor for EF Core, an explicit `_Create(State)` factory
// used by repository hydration, and (for the root) a public `Create`
// factory + `PullEvents()` drainage hook.
//
// Extern operations widen the surface: when an aggregate declares
// `operation X(...) extern { precondition ... }`, the generated request
// handler delegates the business decision to a user-supplied
// `IXFooHandler`.  That handler needs to mutate state and raise events,
// so for aggregates with at least one extern op we widen field setters
// from `private set` to `internal set` and expose
// `internal void RaiseEvent(IDomainEvent)` + `internal void AssertInvariants()`.
// Internal access keeps mutation co-located with the generated
// project's assembly (handlers ship in the same csproj).
// ---------------------------------------------------------------------------

/** Build the `: IAuditable, ISoftDeletable, ...` clause appended
 * after the class name for aggregates that opt into one or more
 * capability groups via `implements "<name>"`.  Backend convention:
 * `<name>` → `I<PascalCase>`.  No marker interface emitted for
 * capability names with no `implements` declarations; this clause
 * is empty for those aggregates.
 *
 * **Currently a no-op.**  Marker interfaces were the Phase 3
 * over-build that the refactor reverted; this stub stays in place
 * so a future "users opt into emitting marker interfaces for their
 * own type-checking" feature can re-enable emission per capability.
 * Until then, every aggregate gets an empty clause and the call
 * site below collapses to `public sealed class <Name>`. */
function capabilityInterfaceClause(_agg: AggregateIR): string {
  return "";
}

export function renderEntity(
  entity: AggregateIR | EntityPartIR,
  isRoot: boolean,
  ns: string,
  rootName: string,
  emitTrace = false,
): string {
  const isAgg = "operations" in entity;
  const idValueType = isAgg ? (entity as AggregateIR).idValueType : "guid";
  const operations = isAgg ? (entity as AggregateIR).operations : [];
  const requiredFields = entity.fields.filter((f) => !f.optional);
  const hasExtern = operations.some((o) => o.extern);
  const setterVisibility = hasExtern ? "internal" : "private";

  const propLines: string[] = [];
  propLines.push(`    public ${entity.name}Id Id { get; ${setterVisibility} set; }`);
  if (!isRoot) {
    propLines.push(`    public ${rootName}Id ParentId { get; ${setterVisibility} set; }`);
  }
  for (const f of entity.fields) {
    const def = f.optional ? " = default;" : " = default!;";
    propLines.push(
      `    public ${renderCsType(f.type)} ${upperFirst(f.name)} { get; ${setterVisibility} set; }${def}`,
    );
  }
  for (const c of entity.contains) {
    if (c.collection) {
      propLines.push(`    private readonly List<${c.partName}> _${c.name} = new();`);
      propLines.push(
        `    public IReadOnlyList<${c.partName}> ${upperFirst(c.name)} => _${c.name}.AsReadOnly();`,
      );
    } else {
      propLines.push(
        `    public ${c.partName} ${upperFirst(c.name)} { get; private set; } = default!;`,
      );
    }
  }

  const eventBlock = isRoot
    ? [
        "",
        `    private readonly List<IDomainEvent> _domainEvents = new();`,
        `    public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();`,
      ]
    : [];

  const ctorLines: string[] = [];
  ctorLines.push(`    private ${entity.name}()`);
  ctorLines.push("    {");
  ctorLines.push("        Id = default!;");
  if (!isRoot) ctorLines.push("        ParentId = default!;");
  for (const f of entity.fields) {
    ctorLines.push(`        ${upperFirst(f.name)} = default!;`);
  }
  ctorLines.push("    }");

  const derivedLines = entity.derived.map(
    (d) => `    public ${renderCsType(d.type)} ${upperFirst(d.name)} => ${renderCsExpr(d.expr)};`,
  );
  const fnLines = entity.functions.map((fn) => {
    const params = fn.params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", ");
    return `    private ${renderCsType(fn.returnType)} ${upperFirst(fn.name)}(${params}) => ${renderCsExpr(fn.body)};`;
  });

  const opLines: string[] = [];
  // Whether any operation references `currentUser`.  When true, we
  // pull in the Auth namespace alongside the existing usings so the
  // `User` type resolves; per-op signatures append a `User currentUser`
  // parameter (and the Mediator handler passes _currentUser.User).
  const anyOpUsesCurrentUser = operations.some(operationUsesCurrentUser);
  for (const op of operations) {
    const usesUser = operationUsesCurrentUser(op);
    const userParam = usesUser ? "User currentUser" : "";
    const baseParams = op.params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", ");
    const params = [baseParams, userParam].filter(Boolean).join(", ");
    if (op.extern) {
      // Extern op: emit a `Check<Pascal>` that runs preconditions only.
      // The auto-generated Mediator handler calls this, then dispatches
      // to the user-supplied handler, then runs AssertInvariants.  No
      // `<Pascal>` method exists on the aggregate; the user owns the
      // business decision.
      opLines.push(`    public void Check${upperFirst(op.name)}(${params})`);
      opLines.push("    {");
      const body = renderCsStatements(op.statements, {
        emitTrace,
        aggregate: entity.name,
        op: op.name,
      });
      if (body.length > 0) opLines.push(body);
      opLines.push("    }");
      opLines.push("");
      continue;
    }
    const visibility = op.visibility === "public" ? "public" : "private";
    opLines.push(`    ${visibility} void ${upperFirst(op.name)}(${params})`);
    opLines.push("    {");
    const body = renderCsStatements(op.statements, {
      emitTrace,
      aggregate: entity.name,
      op: op.name,
    });
    if (body.length > 0) opLines.push(body);
    opLines.push(
      emitTrace
        ? `        AssertInvariants("${op.name}");`
        : "        AssertInvariants();",
    );
    opLines.push("    }");
    opLines.push("");
  }

  // For aggregates with at least one extern op, expose RaiseEvent +
  // AssertInvariants as `internal` so the user's
  // `[ExternHandler]`-decorated class can mutate state, raise
  // events, and trigger invariant checks from the same assembly.
  const externHookLines: string[] = [];
  if (isRoot && hasExtern) {
    externHookLines.push(
      "    /// <summary>Raise a domain event from a [ExternHandler] class.</summary>",
      "    internal void RaiseEvent(IDomainEvent ev) => _domainEvents.Add(ev);",
      "",
    );
  }

  const pullEventsLines = isRoot
    ? [
        "    public IReadOnlyList<IDomainEvent> PullEvents()",
        "    {",
        "        var copy = _domainEvents.ToArray();",
        "        _domainEvents.Clear();",
        "        return copy;",
        "    }",
        "",
      ]
    : [];

  // Per-invariant body.  Trace-off: the one-liner if-throw.  Trace-on:
  // bind the boolean to `__inv_<i>_ok` so BOTH pass and fail outcomes
  // log (invariant_evaluated) before the conditional throw fires off
  // the same temp.  A GUARDED invariant logs ONLY when its guard
  // applies — the wrap sits inside `if (guard) { … }` so an
  // inapplicable invariant doesn't pollute the stream.  Op context
  // comes from the `__op` parameter on the trace-on AssertInvariants
  // signature.
  const invariantLines = entity.invariants.flatMap((inv, i) => {
    const thrown = `throw new DomainException(${JSON.stringify(`Invariant violated: ${inv.source}`)})`;
    if (!emitTrace) {
      const check = inv.guard
        ? `if ((${renderCsExpr(inv.guard)}) && !(${renderCsExpr(inv.expr)}))`
        : `if (!(${renderCsExpr(inv.expr)}))`;
      return [`        ${check} ${thrown};`];
    }
    const ok = `__inv_${i}_ok`;
    const traceCall = `DomainLog.LogTrace("{Event} aggregate={Aggregate} op={Op} expr={Expr} passed={Passed}", "invariant_evaluated", "${entity.name}", __op, ${JSON.stringify(inv.source)}, ${ok});`;
    if (inv.guard) {
      return [
        `        if (${renderCsExpr(inv.guard)})`,
        "        {",
        `            var ${ok} = (${renderCsExpr(inv.expr)});`,
        `            ${traceCall}`,
        `            if (!${ok}) ${thrown};`,
        "        }",
      ];
    }
    return [
      `        var ${ok} = (${renderCsExpr(inv.expr)});`,
      `        ${traceCall}`,
      `        if (!${ok}) ${thrown};`,
    ];
  });

  const stateLines: string[] = [];
  stateLines.push("    public sealed class State");
  stateLines.push("    {");
  stateLines.push(`        public ${entity.name}Id Id { get; init; } = default!;`);
  if (!isRoot) {
    stateLines.push(`        public ${rootName}Id ParentId { get; init; } = default!;`);
  }
  for (const f of entity.fields) {
    stateLines.push(
      `        public ${renderCsType(f.type)} ${upperFirst(f.name)} { get; init; } = default!;`,
    );
  }
  stateLines.push("    }");

  const createInternalLines: string[] = [];
  createInternalLines.push(`    public static ${entity.name} _Create(State s)`);
  createInternalLines.push("    {");
  createInternalLines.push(`        var e = new ${entity.name}();`);
  createInternalLines.push("        e.Id = s.Id;");
  if (!isRoot) createInternalLines.push("        e.ParentId = s.ParentId;");
  for (const f of entity.fields) {
    createInternalLines.push(`        e.${upperFirst(f.name)} = s.${upperFirst(f.name)};`);
  }
  // Hydration path — repository's _Create.  Under --trace, label as
  // `"<init>"` so the invariant_evaluated lines for ctor / hydration
  // runs are distinguishable from in-operation evaluations.
  createInternalLines.push(
    emitTrace ? `        e.AssertInvariants("<init>");` : "        e.AssertInvariants();",
  );
  createInternalLines.push("        return e;");
  createInternalLines.push("    }");

  const createPublicLines = isRoot
    ? [
        `    public static ${entity.name} Create(${requiredFields
          .map((f) => `${renderCsType(f.type)} ${f.name}`)
          .join(", ")})`,
        "    {",
        `        var e = new ${entity.name}();`,
        `        e.Id = new ${entity.name}Id(${csNewIdValue(idValueType)});`,
        ...requiredFields.map((f) => `        e.${upperFirst(f.name)} = ${f.name};`),
        // Public Create factory — same "<init>" label as the hydration path.
        emitTrace ? `        e.AssertInvariants("<init>");` : "        e.AssertInvariants();",
        "        return e;",
        "    }",
      ]
    : [];

  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Collections.Generic;",
      "using System.Linq;",
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.Events;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Domain.Common;`,
      anyOpUsesCurrentUser ? `using ${ns}.Auth;` : null,
      "",
      `namespace ${ns}.Domain.${plural(rootName)};`,
      "",
      `public sealed class ${entity.name}${isAgg ? capabilityInterfaceClause(entity as AggregateIR) : ""}`,
      "{",
      ...propLines,
      ...eventBlock,
      ...(isRoot ? [] : [""]),
      ...ctorLines,
      "",
      ...derivedLines,
      ...fnLines,
      ...opLines,
      ...externHookLines,
      "",
      ...pullEventsLines,
      `    ${hasExtern ? "internal" : "private"} void AssertInvariants(${emitTrace ? "string __op = \"<init>\"" : ""})`,
      "    {",
      ...invariantLines,
      "    }",
      "",
      ...stateLines,
      "",
      ...createInternalLines,
      ...createPublicLines,
      "}",
    ) + "\n"
  );
}
