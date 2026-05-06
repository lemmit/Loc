import type {
  AggregateIR,
  BoundedContextIR,
  ContainmentIR,
  DerivedIR,
  EntityPartIR,
  FieldIR,
  FunctionIR,
  InvariantIR,
  OperationIR,
} from "../../../ir/loom-ir.js";
import { camel } from "../../../util/naming.js";
import { lines } from "../../../util/code-builder.js";
import { renderTsExpr, renderTsType } from "../render-expr.js";
import { renderTsStatements } from "../render-stmt.js";

// ---------------------------------------------------------------------------
// Aggregate emission.  One file per aggregate root, containing the root
// class plus a class for each entity-part declared inside it.  Every part
// carries a `parentId` field; only the root carries `_events` and
// `pullEvents()`.  Both shapes share the private constructor + static
// `_create` factory (used by repository hydration); only the root gets
// the public `create` factory.
// ---------------------------------------------------------------------------

interface EntityShape {
  name: string;
  isRoot: boolean;
  rootName?: string;
  fields: FieldIR[];
  contains: ContainmentIR[];
  derived: DerivedIR[];
  invariants: InvariantIR[];
  functions: FunctionIR[];
  operations: OperationIR[];
}

export function renderAggregate(
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const valueObjectAliases = ctx.valueObjects.map((v) => v.name);
  const enumAliases = ctx.enums.map((e) => e.name);
  const partsRendered = agg.parts.map((p) => renderEntity(partShape(p, agg)));
  const rootRendered = renderEntity(rootShape(agg));

  return (
    lines(
      "// Auto-generated.",
      'import * as Ids from "./ids.js";',
      valueObjectAliases.length > 0
        ? `import { ${valueObjectAliases.join(", ")} } from "./value-objects.js";`
        : null,
      enumAliases.length > 0
        ? `import { ${enumAliases.join(", ")} } from "./value-objects.js";`
        : null,
      'import type * as Events from "./events.js";',
      'import { DomainError } from "./errors.js";',
      "",
      partsRendered.length > 0
        ? partsRendered.map((p) => p + "\n").join("\n")
        : "",
      rootRendered,
    ) + "\n\n"
  );
}

function rootShape(a: AggregateIR): EntityShape {
  return {
    name: a.name,
    isRoot: true,
    fields: a.fields,
    contains: a.contains,
    derived: a.derived,
    invariants: a.invariants,
    functions: a.functions,
    operations: a.operations,
  };
}

function partShape(p: EntityPartIR, root: AggregateIR): EntityShape {
  return {
    name: p.name,
    isRoot: false,
    rootName: root.name,
    fields: p.fields,
    contains: p.contains,
    derived: p.derived,
    invariants: p.invariants,
    functions: p.functions,
    operations: [],
  };
}

function renderEntity(e: EntityShape): string {
  const containsType = (c: ContainmentIR): string =>
    `${c.partName}${c.collection ? "[]" : " | null"}`;
  const containsGetterType = (c: ContainmentIR): string =>
    c.collection ? `readonly ${c.partName}[]` : `${c.partName} | null`;
  // When at least one operation is `extern`, the user's registered
  // handler needs to mutate properties and raise events.  For TS we
  // expose public setters per property + `raiseEvent` + a public
  // `assertInvariants()` (the auto route handler runs it after the
  // user's handler returns).
  const hasExtern = e.operations.some((o) => o.extern);

  // Constructor parameter list — `id`, then optional `parentId`, then
  // every field, then every containment.  Used in three places: the
  // private ctor signature, the static `_create` signature, and (for
  // the root) the static `create` factory body.
  const stateFields = [
    `id: Ids.${e.name}Id`,
    !e.isRoot ? `parentId: Ids.${e.rootName}Id` : null,
    ...e.fields.map((f) => `${f.name}: ${renderTsType(f.type)}`),
    ...e.contains.map((c) => `${c.name}: ${containsType(c)}`),
  ].filter((s): s is string => s != null);
  const stateLiteral = `{ ${stateFields.join("; ")} }`;

  const fieldDecls: string[] = [];
  fieldDecls.push(`  private _id: Ids.${e.name}Id;`);
  if (!e.isRoot) {
    fieldDecls.push(`  private _parentId: Ids.${e.rootName}Id;`);
  }
  if (e.isRoot) {
    fieldDecls.push("  private _events: Events.DomainEvent[] = [];");
  }
  for (const f of e.fields) {
    fieldDecls.push(`  private _${f.name}: ${renderTsType(f.type)};`);
  }
  for (const c of e.contains) {
    fieldDecls.push(`  private _${c.name}: ${containsType(c)};`);
  }

  const ctorAssignments: string[] = [];
  ctorAssignments.push("    this._id = state.id;");
  if (!e.isRoot) {
    ctorAssignments.push("    this._parentId = state.parentId;");
  }
  for (const f of e.fields) {
    ctorAssignments.push(`    this._${f.name} = state.${f.name};`);
  }
  for (const c of e.contains) {
    ctorAssignments.push(`    this._${c.name} = state.${c.name};`);
  }
  ctorAssignments.push("    this._assertInvariants();");

  const getters: string[] = [];
  getters.push(`  get id(): Ids.${e.name}Id { return this._id; }`);
  if (!e.isRoot) {
    getters.push(
      `  get parentId(): Ids.${e.rootName}Id { return this._parentId; }`,
    );
  }
  for (const f of e.fields) {
    getters.push(
      `  get ${f.name}(): ${renderTsType(f.type)} { return this._${f.name}; }`,
    );
  }
  for (const c of e.contains) {
    getters.push(
      `  get ${c.name}(): ${containsGetterType(c)} { return this._${c.name}; }`,
    );
  }
  for (const d of e.derived) {
    getters.push(
      `  get ${d.name}(): ${renderTsType(d.type)} { return ${renderTsExpr(d.expr)}; }`,
    );
  }

  const fns = e.functions.map((fn) => {
    const params = fn.params
      .map((p) => `${p.name}: ${renderTsType(p.type)}`)
      .join(", ");
    return `  private ${camel(fn.name)}(${params}): ${renderTsType(fn.returnType)} { return ${renderTsExpr(fn.body)}; }`;
  });

  // For extern: setters per declared property, plus `raiseEvent` on the
  // root.  Containment collections stay private (mutation goes through
  // the existing `add`/`remove` operation paths).
  const externMutators: string[] = [];
  if (hasExtern) {
    for (const f of e.fields) {
      externMutators.push(
        `  set ${f.name}(v: ${renderTsType(f.type)}) { this._${f.name} = v; }`,
      );
    }
    if (e.isRoot) {
      externMutators.push(
        "  raiseEvent(ev: Events.DomainEvent): void { this._events.push(ev); }",
      );
      externMutators.push(
        "  assertInvariants(): void { this._assertInvariants(); }",
      );
    }
  }

  const ops: string[] = [];
  for (const op of e.operations) {
    const visibility = op.visibility === "public" ? "public" : "private";
    const params = op.params
      .map((p) => `${p.name}: ${renderTsType(p.type)}`)
      .join(", ");
    if (op.extern) {
      // Extern: emit `check<Pascal>(...)` running preconditions only.
      // The auto Hono route calls this, then dispatches to the
      // user-registered handler, then `assertInvariants()`.  No
      // user-named method exists on the aggregate; the user owns the
      // business decision.
      const checkName = `check${op.name[0]!.toUpperCase()}${op.name.slice(1)}`;
      ops.push(`  ${checkName}(${params}): void {`);
      const body = renderTsStatements(op.statements);
      if (body.length > 0) ops.push(body);
      ops.push("  }");
      ops.push("");
      continue;
    }
    ops.push(`  ${visibility} ${camel(op.name)}(${params}): void {`);
    const body = renderTsStatements(op.statements);
    if (body.length > 0) ops.push(body);
    ops.push("    this._assertInvariants();");
    ops.push("  }");
    ops.push("");
  }

  const invariants = e.invariants.map((inv) => {
    const check = inv.guard
      ? `if ((${renderTsExpr(inv.guard)}) && !(${renderTsExpr(inv.expr)}))`
      : `if (!(${renderTsExpr(inv.expr)}))`;
    return `    ${check} throw new DomainError(${JSON.stringify(`Invariant violated: ${inv.source}`)});`;
  });

  const requiredFields = e.fields.filter((f) => !f.optional);
  const createFactory = e.isRoot
    ? [
        `  static create(input: { ${requiredFields
          .map((f) => `${f.name}: ${renderTsType(f.type)}`)
          .join("; ")} }): ${e.name} {`,
        `    return new ${e.name}({`,
        `      id: Ids.new${e.name}Id(),`,
        ...e.fields.map(
          (f) => `      ${f.name}: ${f.optional ? "null" : `input.${f.name}`},`,
        ),
        ...e.contains.map(
          (c) => `      ${c.name}: ${c.collection ? "[]" : "null"},`,
        ),
        "    });",
        "  }",
      ]
    : [];

  const pullEvents = e.isRoot
    ? [
        "  pullEvents(): Events.DomainEvent[] {",
        "    const out = this._events;",
        "    this._events = [];",
        "    return out;",
        "  }",
        "",
      ]
    : [];

  return lines(
    `export class ${e.name} {`,
    ...fieldDecls,
    `  private constructor(state: ${stateLiteral}) {`,
    ...ctorAssignments,
    "  }",
    "",
    ...getters,
    ...externMutators,
    ...fns,
    ...ops,
    ...pullEvents,
    "  private _assertInvariants(): void {",
    ...invariants,
    "  }",
    "",
    `  static _create(state: ${stateLiteral}): ${e.name} {`,
    `    return new ${e.name}(state);`,
    "  }",
    ...createFactory,
    "}",
  );
}
