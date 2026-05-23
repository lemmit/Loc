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
import { operationUsesCurrentUser } from "../../../ir/loom-ir.js";
import { stmtHasProv } from "../../../ir/prov-id.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
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
  emitProvenance = false,
  emitTrace = false,
): string {
  const valueObjectAliases = ctx.valueObjects.map((v) => v.name);
  const enumAliases = ctx.enums.map((e) => e.name);
  const hasProv =
    emitProvenance &&
    (agg.operations.some((op) => op.statements.some(stmtHasProv)) ||
      agg.fields.some((f) => f.provenanced) ||
      agg.parts.some((p) => p.fields.some((f) => f.provenanced)));
  // Domain-injected trace lines (`value_computed`, `precondition_evaluated`)
  // resolve the request-scoped logger via `requestLog()` from obs/als —
  // imported here only when --trace is on, so the default artefact keeps
  // the domain layer free of any infra import.
  const hasDomainTrace = emitTrace;
  const partsRendered = agg.parts.map((p) =>
    renderEntity(partShape(p, agg), emitProvenance, emitTrace),
  );
  const rootRendered = renderEntity(rootShape(agg), emitProvenance, emitTrace);
  // When any aggregate op references `currentUser` we pull the User
  // type from the auth/ package so the operation's `currentUser:
  // User` parameter typechecks.  Files emitted under deployables
  // without `auth: required` don't import this — and operations
  // can't reference currentUser there because the validator gates it.
  const usesUser = agg.operations.some(operationUsesCurrentUser);

  return (
    lines(
      "// Auto-generated.",
      'import * as Ids from "./ids";',
      valueObjectAliases.length > 0
        ? `import { ${valueObjectAliases.join(", ")} } from "./value-objects";`
        : null,
      enumAliases.length > 0
        ? `import { ${enumAliases.join(", ")} } from "./value-objects";`
        : null,
      'import type * as Events from "./events";',
      'import { DomainError, ForbiddenError } from "./errors";',
      hasProv ? 'import { type ProvLineage } from "./provenance";' : null,
      hasDomainTrace ? 'import { requestLog } from "../obs/als";' : null,
      usesUser ? 'import type { User } from "../auth/user-types";' : null,
      "",
      partsRendered.length > 0 ? partsRendered.map((p) => p + "\n").join("\n") : "",
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

function renderEntity(e: EntityShape, emitProvenance = false, emitTrace = false): string {
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
  // Provenanced fields carry a co-located `_<field>_provenance` backing
  // field (current lineage, persisted on the row) threaded through the
  // ctor state so repository hydration can restore it.  `__provTraces`
  // (the append-only history buffer drained by the route handler) is
  // emitted only where domain logic actually writes a provenanced field.
  const provFields = emitProvenance ? e.fields.filter((f) => f.provenanced) : [];
  const hasOwnProvWrite =
    emitProvenance && e.operations.some((op) => op.statements.some(stmtHasProv));

  const stateFields = [
    `id: Ids.${e.name}Id`,
    !e.isRoot ? `parentId: Ids.${e.rootName}Id` : null,
    ...e.fields.map((f) => `${f.name}: ${renderTsType(f.type)}`),
    ...provFields.map((f) => `${f.name}_provenance: ProvLineage | null`),
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
  for (const f of provFields) {
    fieldDecls.push(`  private _${f.name}_provenance: ProvLineage | null;`);
  }
  for (const c of e.contains) {
    fieldDecls.push(`  private _${c.name}: ${containsType(c)};`);
  }
  if (hasOwnProvWrite) {
    fieldDecls.push("  private __provTraces: ProvLineage[] = [];");
  }

  const ctorAssignments: string[] = [];
  ctorAssignments.push("    this._id = state.id;");
  if (!e.isRoot) {
    ctorAssignments.push("    this._parentId = state.parentId;");
  }
  for (const f of e.fields) {
    ctorAssignments.push(`    this._${f.name} = state.${f.name};`);
  }
  for (const f of provFields) {
    ctorAssignments.push(`    this._${f.name}_provenance = state.${f.name}_provenance;`);
  }
  for (const c of e.contains) {
    ctorAssignments.push(`    this._${c.name} = state.${c.name};`);
  }
  ctorAssignments.push("    this._assertInvariants();");

  const getters: string[] = [];
  getters.push(`  get id(): Ids.${e.name}Id { return this._id; }`);
  if (!e.isRoot) {
    getters.push(`  get parentId(): Ids.${e.rootName}Id { return this._parentId; }`);
  }
  for (const f of e.fields) {
    getters.push(`  get ${f.name}(): ${renderTsType(f.type)} { return this._${f.name}; }`);
  }
  for (const f of provFields) {
    getters.push(
      `  get ${f.name}_provenance(): ProvLineage | null { return this._${f.name}_provenance; }`,
    );
  }
  for (const c of e.contains) {
    getters.push(`  get ${c.name}(): ${containsGetterType(c)} { return this._${c.name}; }`);
  }
  for (const d of e.derived) {
    getters.push(`  get ${d.name}(): ${renderTsType(d.type)} { return ${renderTsExpr(d.expr)}; }`);
  }

  const fns = e.functions.map((fn) => {
    const params = fn.params.map((p) => `${p.name}: ${renderTsType(p.type)}`).join(", ");
    return `  private ${lowerFirst(fn.name)}(${params}): ${renderTsType(fn.returnType)} { return ${renderTsExpr(fn.body)}; }`;
  });

  // For extern: setters per declared property, plus `raiseEvent` on the
  // root.  Containment collections stay private (mutation goes through
  // the existing `add`/`remove` operation paths).
  const externMutators: string[] = [];
  if (hasExtern) {
    for (const f of e.fields) {
      externMutators.push(`  set ${f.name}(v: ${renderTsType(f.type)}) { this._${f.name} = v; }`);
    }
    if (e.isRoot) {
      externMutators.push("  raiseEvent(ev: Events.DomainEvent): void { this._events.push(ev); }");
      externMutators.push("  assertInvariants(): void { this._assertInvariants(); }");
    }
  }

  const ops: string[] = [];
  // True when ANY op references currentUser — drives whether the
  // file imports the User type from auth/.  Per-op signatures still
  // get the parameter conditionally so a non-auth op stays
  // un-burdened with a User param.
  const _anyOpUsesCurrentUser = e.operations.some(operationUsesCurrentUser);
  for (const op of e.operations) {
    const visibility = op.visibility === "public" ? "public" : "private";
    const usesUser = operationUsesCurrentUser(op);
    const baseParams = op.params.map((p) => `${p.name}: ${renderTsType(p.type)}`).join(", ");
    const userParam = usesUser ? "currentUser: User" : "";
    const params = [baseParams, userParam].filter(Boolean).join(", ");
    if (op.extern) {
      // Extern: emit `check<Pascal>(...)` running preconditions only.
      // The auto Hono route calls this, then dispatches to the
      // user-registered handler, then `assertInvariants()`.  No
      // user-named method exists on the aggregate; the user owns the
      // business decision.
      const checkName = `check${op.name[0]!.toUpperCase()}${op.name.slice(1)}`;
      ops.push(`  ${checkName}(${params}): void {`);
      const body = renderTsStatements(op.statements, emitProvenance, {
        emitTrace,
        aggregate: e.name,
        op: op.name,
      });
      if (body.length > 0) ops.push(body);
      ops.push("  }");
      ops.push("");
      continue;
    }
    ops.push(`  ${visibility} ${lowerFirst(op.name)}(${params}): void {`);
    const body = renderTsStatements(op.statements, emitProvenance, {
      emitTrace,
      aggregate: e.name,
      op: op.name,
    });
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
        ...e.fields.map((f) => `      ${f.name}: ${f.optional ? "null" : `input.${f.name}`},`),
        ...provFields.map((f) => `      ${f.name}_provenance: null,`),
        ...e.contains.map((c) => `      ${c.name}: ${c.collection ? "[]" : "null"},`),
        "    });",
        "  }",
      ]
    : [];

  // History drain — the route handler calls this inside the save
  // transaction and inserts one `provenance_records` row per lineage.
  const provDrain = hasOwnProvWrite
    ? [
        "  __drainProv(): ProvLineage[] {",
        "    const out = this.__provTraces;",
        "    this.__provTraces = [];",
        "    return out;",
        "  }",
        "",
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
    ...provDrain,
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
