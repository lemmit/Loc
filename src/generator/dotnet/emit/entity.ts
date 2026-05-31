import { forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedEntityPartIR,
  EntityPartIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { csNewIdValue, renderCsExpr, renderCsType } from "../render-expr.js";
import { renderCsStatements } from "../render-stmt.js";

/** True for a field type that is a collection of references
 * (`Id<T>[]`) — persisted via a join table, not a column. */
function isRefCollection(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "id";
}

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

export function renderEntity(
  entity: EnrichedAggregateIR | EnrichedEntityPartIR,
  isRoot: boolean,
  ns: string,
  rootName: string,
  emitTrace = false,
  /** When true, the entity is part of a document-shaped
   *  (`shape(document)`) aggregate: emit the `ToSnapshot()` /
   *  `FromSnapshot(...)` mapping methods the JSONB repository serialises
   *  through.  Additive — byte-identical output when false. */
  document = false,
): string {
  // `operations` is the discriminator between EnrichedAggregateIR and
  // EnrichedEntityPartIR — wrapped in a type predicate so the union
  // narrows in every downstream consumer without per-site casts.
  const isAgg = (e: typeof entity): e is EnrichedAggregateIR => "operations" in e;
  const idValueType = isAgg(entity) ? entity.idValueType : "guid";
  const operations = isAgg(entity) ? entity.operations : [];
  // Public `Create(...)` factory params — the canonical create-input set
  // (`forCreateInput`, INCLUDING optionals).  Matches the CreateCommand /
  // handler call order + the wire DTO, so `Agg.Create(cmd.Field, ...)`
  // binds positionally.  Optionals arrive as nullable params and are
  // assigned through; server-owned fields stay at their `= default;`
  // property initialiser.
  const createInputFieldList = isAgg(entity) ? forCreateInput(entity.fields) : [];
  const hasExtern = operations.some((o) => o.extern);
  const setterVisibility = hasExtern ? "internal" : "private";
  // Threaded through every render call below.  Renderers add the
  // non-implicit namespaces they reach into (`System.Text.RegularExpressions`
  // when an invariant uses `email.matches(...)`); on file assembly the
  // accumulated set becomes one `using <ns>;` per entry, so the file
  // imports only what its own expressions actually use.
  const usings = new Set<string>();
  const renderCtx = {
    thisName: "this",
    usings,
    // Threaded through so render-stmt's collection-mutation path can
    // distinguish ref-collection fields (writable public `Party`)
    // from containment fields (private `_lines` backing).  Entity
    // parts don't have associations, but typing as the union keeps
    // the ctx shape stable across the two callers.
    agg: isAgg(entity) ? entity : undefined,
  };

  const propLines: string[] = [];
  propLines.push(`    public ${entity.name}Id Id { get; ${setterVisibility} set; }`);
  if (!isRoot) {
    propLines.push(`    public ${rootName}Id ParentId { get; ${setterVisibility} set; }`);
  }
  for (const f of entity.fields) {
    const def = f.optional ? " = default;" : " = default!;";
    // Reference-collection (`Id<T>[]`) fields are persisted via a
    // separate join table; the repository (in the Infrastructure
    // assembly) needs to write the `List<TargetId>` after loading
    // join rows post-`FirstOrDefaultAsync`.  Widening the setter from
    // `private` to `internal` keeps the field unwritable from
    // user/application code but lets the same-assembly hydration
    // succeed without reflection.
    const fieldSetter = isRefCollection(f.type) ? "internal" : setterVisibility;
    propLines.push(
      `    public ${renderCsType(f.type)} ${upperFirst(f.name)} { get; ${fieldSetter} set; }${def}`,
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
    (d) =>
      `    public ${renderCsType(d.type)} ${upperFirst(d.name)} => ${renderCsExpr(d.expr, renderCtx)};`,
  );
  // Override `ToString()` on aggregate roots to delegate to the
  // `Inspect` derived — gives a useful debug form in exceptions,
  // debugger watches, Serilog destructuring, etc.
  if (isRoot && entity.derived.some((d) => d.name === "inspect")) {
    derivedLines.push("    public override string ToString() => Inspect;");
  }
  const fnLines = entity.functions.map((fn) => {
    const params = fn.params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", ");
    return `    private ${renderCsType(fn.returnType)} ${upperFirst(fn.name)}(${params}) => ${renderCsExpr(fn.body, renderCtx)};`;
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
      const body = renderCsStatements(op.statements, renderCtx, {
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
    const body = renderCsStatements(op.statements, renderCtx, {
      emitTrace,
      aggregate: entity.name,
      op: op.name,
    });
    if (body.length > 0) opLines.push(body);
    opLines.push(
      emitTrace ? `        AssertInvariants("${op.name}");` : "        AssertInvariants();",
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
        ? `if ((${renderCsExpr(inv.guard, renderCtx)}) && !(${renderCsExpr(inv.expr, renderCtx)}))`
        : `if (!(${renderCsExpr(inv.expr, renderCtx)}))`;
      return [`        ${check} ${thrown};`];
    }
    const ok = `__inv_${i}_ok`;
    const traceCall = `DomainLog.LogTrace("{Event} aggregate={Aggregate} op={Op} expr={Expr} passed={Passed}", "invariant_evaluated", "${entity.name}", __op, ${JSON.stringify(inv.source)}, ${ok});`;
    if (inv.guard) {
      return [
        `        if (${renderCsExpr(inv.guard, renderCtx)})`,
        "        {",
        `            var ${ok} = (${renderCsExpr(inv.expr, renderCtx)});`,
        `            ${traceCall}`,
        `            if (!${ok}) ${thrown};`,
        "        }",
      ];
    }
    return [
      `        var ${ok} = (${renderCsExpr(inv.expr, renderCtx)});`,
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
        `    public static ${entity.name} Create(${createInputFieldList
          .map((f) => `${renderCsType(f.type)} ${f.name}`)
          .join(", ")})`,
        "    {",
        `        var e = new ${entity.name}();`,
        `        e.Id = new ${entity.name}Id(${csNewIdValue(idValueType)});`,
        ...createInputFieldList.map((f) => `        e.${upperFirst(f.name)} = ${f.name};`),
        // Public Create factory — same "<init>" label as the hydration path.
        emitTrace ? `        e.AssertInvariants("<init>");` : "        e.AssertInvariants();",
        "        return e;",
        "    }",
      ]
    : [];

  // Document-shape (shape(document)) round-trip mapping.  Emitted
  // ONLY for entities inside a document aggregate.  Both methods live
  // on the entity class so they can reach private setters + the
  // `_<containment>` backing lists; the repository calls them across
  // the same assembly via `internal`.  `ToSnapshot` copies state out;
  // `FromSnapshot` rebuilds it (running AssertInvariants once, AFTER
  // the contained parts are rehydrated, so part-dependent invariants
  // see the full tree — unlike `_Create`, which only knows fields).
  const snapshotLines: string[] = [];
  if (document) {
    const toInit: string[] = [];
    toInit.push("            Id = Id,");
    if (!isRoot) toInit.push("            ParentId = ParentId,");
    for (const f of entity.fields) {
      toInit.push(`            ${upperFirst(f.name)} = ${upperFirst(f.name)},`);
    }
    for (const c of entity.contains) {
      toInit.push(
        c.collection
          ? `            ${upperFirst(c.name)} = _${c.name}.Select(__x => __x.ToSnapshot()).ToList(),`
          : `            ${upperFirst(c.name)} = ${upperFirst(c.name)}.ToSnapshot(),`,
      );
    }
    snapshotLines.push(
      `    internal ${entity.name}Snapshot ToSnapshot()`,
      "    {",
      `        return new ${entity.name}Snapshot`,
      "        {",
      ...toInit,
      "        };",
      "    }",
      "",
      `    internal static ${entity.name} FromSnapshot(${entity.name}Snapshot s)`,
      "    {",
      `        var e = new ${entity.name}();`,
      "        e.Id = s.Id;",
    );
    if (!isRoot) snapshotLines.push("        e.ParentId = s.ParentId;");
    for (const f of entity.fields) {
      snapshotLines.push(`        e.${upperFirst(f.name)} = s.${upperFirst(f.name)};`);
    }
    for (const c of entity.contains) {
      if (c.collection) {
        snapshotLines.push(
          `        foreach (var __it in s.${upperFirst(c.name)}) e._${c.name}.Add(${c.partName}.FromSnapshot(__it));`,
        );
      } else {
        snapshotLines.push(
          `        e.${upperFirst(c.name)} = ${c.partName}.FromSnapshot(s.${upperFirst(c.name)});`,
        );
      }
    }
    snapshotLines.push(
      emitTrace ? `        e.AssertInvariants("<init>");` : "        e.AssertInvariants();",
      "        return e;",
      "    }",
    );
  }

  const extraUsings = [...usings].sort().map((n) => `using ${n};`);
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Collections.Generic;",
      "using System.Linq;",
      ...extraUsings,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.Events;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Domain.Common;`,
      anyOpUsesCurrentUser ? `using ${ns}.Auth;` : null,
      "",
      `namespace ${ns}.Domain.${plural(rootName)};`,
      "",
      `public sealed class ${entity.name}`,
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
      `    ${hasExtern ? "internal" : "private"} void AssertInvariants(${emitTrace ? 'string __op = "<init>"' : ""})`,
      "    {",
      ...invariantLines,
      "    }",
      "",
      ...stateLines,
      "",
      ...createInternalLines,
      ...createPublicLines,
      ...(snapshotLines.length > 0 ? ["", ...snapshotLines] : []),
      "}",
    ) + "\n"
  );
}
