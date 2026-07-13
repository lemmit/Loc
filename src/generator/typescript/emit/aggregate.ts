import { unionMembers } from "../../../generator/_payload/union-wire.js";
import type { SourceMapSubRegion } from "../../../generator/_trace/sourcemap.js";
import { forCreateInput, hasCreate } from "../../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  ApplyIR,
  BoundedContextIR,
  ContainmentIR,
  DerivedIR,
  EntityPartIR,
  FieldIR,
  FunctionIR,
  InvariantIR,
  OperationIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { aggregateUsesMoney, operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { directParentName } from "../../../ir/util/containment-parent.js";
import { stmtHasProv } from "../../../ir/util/prov-id.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import { renderTsExpr, renderTsType } from "../render-expr.js";
import {
  renderTsStatementChunks,
  renderTsStatements,
  statementExprMarks,
  statementSubRegions,
} from "../render-stmt.js";

/** One operation body's exact emitted text plus its per-statement
 *  sub-regions — surfaced by `renderAggregate` (when `opFragments` is
 *  passed) to the caller that owns the recorder and the final file content
 *  (`src/platform/hono/v4/emit.ts`), which anchors it via
 *  `SourceMapRecorder.fragment`.  Covers only the REGULAR (non-extern,
 *  non-lifecycle) operation-body path — see the call site in `renderEntity`
 *  below. */
export interface OpFragment {
  fragmentText: string;
  subRegions: SourceMapSubRegion[];
}

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
  /** Whether the root aggregate is constructible (see `isConstructible`).
   *  Gates the public `create(...)` factory; always false for entity parts
   *  (they have no factory). */
  hasCreate: boolean;
  rootName?: string;
  /** The entity that DIRECTLY contains this part — the aggregate root for a
   *  root-level part, a sibling part for a nested one.  Drives the `parentId`
   *  id-type branding (`ShipmentId`, not `OrderId`, for a Label nested under
   *  Shipment); equals `rootName` for root-level parts (byte-identical). */
  parentName?: string;
  fields: FieldIR[];
  contains: ContainmentIR[];
  derived: DerivedIR[];
  invariants: InvariantIR[];
  functions: FunctionIR[];
  operations: OperationIR[];
  /** Event-fold appliers — root-only, present iff the aggregate is
   *  event-sourced.  Drive the `_apply` fold dispatch + `_fromEvents`
   *  rehydrator (appliers A2). */
  appliers?: ApplyIR[];
  /** True when the aggregate is `persistedAs(eventLog)` — gates the
   *  fold/rehydrate emission and flips `emit` to push-and-apply. */
  eventSourced?: boolean;
  /** Explicit `create` lifecycle actions (root only).  On an event-sourced
   *  aggregate the (single) create's emit-only body drives an event-sourced
   *  `create(...)` factory — construct an empty shell, run the body so it
   *  emits-and-folds the creation event (appliers A2.2). */
  creates?: OperationIR[];
}

export function renderAggregate(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  emitProvenance = false,
  emitTrace = false,
  opFragments?: OpFragment[],
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
  // Entity parts never carry operations (see `partShape`), so they never
  // contribute op fragments — only the root render call gets `opFragments`.
  const partsRendered = agg.parts.map((p) =>
    renderEntity(partShape(p, agg), ctx, emitProvenance, emitTrace),
  );
  const rootRendered = renderEntity(rootShape(agg), ctx, emitProvenance, emitTrace, opFragments);
  // When any aggregate op references `currentUser` we pull the User
  // type from the auth/ package so the operation's `currentUser:
  // User` parameter typechecks.  Files emitted under deployables
  // without `auth: required` don't import this — and operations
  // can't reference currentUser there because the validator gates it.
  // Lifecycle stamps no longer thread the principal into the domain (it's
  // stamped persist-time in the drizzle save()), so only operation bodies
  // pull in the User type now.
  const usesUser = agg.operations.some(operationUsesCurrentUser);
  const usesMoney = aggregateUsesMoney(agg);
  // The errors-module imports are conditional on what the body emits
  // (see render-stmt.ts and the invariant renderer below):
  //   DomainError    — invariants (root + parts) and `precondition` statements
  //   ForbiddenError — `requires` statements (RBAC preconditions)
  // Keeps the import line free of dead names per Loom's "ok generated code" gate.
  const usesDomain =
    agg.invariants.length > 0 ||
    agg.parts.some((p) => p.invariants.length > 0) ||
    agg.operations.some((op) => op.statements.some((s) => s.kind === "precondition"));
  const usesForbidden = agg.operations.some((op) =>
    op.statements.some((s) => s.kind === "requires"),
  );
  const errorsImportList = [usesDomain && "DomainError", usesForbidden && "ForbiddenError"]
    .filter(Boolean)
    .join(", ");

  // Render the body up front so the value-object import can be narrowed
  // to `import type` when no operation constructs a VO (`new Money(...)`),
  // and dropped entirely when no VO appears in any type position either.
  const rawBody =
    (partsRendered.length > 0 ? partsRendered.map((p) => p + "\n").join("\n") : "") + rootRendered;
  // Strip string-literal contents so a symbol name that only appears
  // inside a quoted string (e.g. an error message) doesn't count as a
  // reference.
  const body = rawBody
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  // Per-symbol narrowing: a VO / enum needs a runtime value when the body
  // uses `new <Vo>(` (value-object construction) or `<Name>.<member>` (enum
  // value access). Type-only positions (annotation, `as <Name>`) qualify
  // for `type <Name>` inline. Symbols never referenced are dropped.
  const isValueUsed = (n: string): boolean => new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(body);
  const usedVoOrEnum = [...valueObjectAliases, ...enumAliases].filter((n) =>
    new RegExp(`\\b${n}\\b`).test(body),
  );
  const anyValueUsed = usedVoOrEnum.some(isValueUsed);
  let voEnumImport: string | null = null;
  if (usedVoOrEnum.length > 0) {
    if (!anyValueUsed) {
      voEnumImport = `import type { ${usedVoOrEnum.join(", ")} } from "./value-objects";`;
    } else {
      const symbols = usedVoOrEnum.map((n) => (isValueUsed(n) ? n : `type ${n}`));
      voEnumImport = `import { ${symbols.join(", ")} } from "./value-objects";`;
    }
  }
  return (
    lines(
      "// Auto-generated.",
      usesMoney ? 'import Decimal from "decimal.js";' : null,
      'import * as Ids from "./ids";',
      voEnumImport,
      'import type * as Events from "./events";',
      errorsImportList ? `import { ${errorsImportList} } from "./errors";` : null,
      hasProv ? 'import { type ProvLineage } from "./provenance";' : null,
      hasDomainTrace ? 'import { requestLog } from "../obs/als";' : null,
      usesUser ? 'import type { User } from "../auth/user-types";' : null,
      "",
      rawBody,
    ) + "\n\n"
  );
}

function rootShape(a: AggregateIR): EntityShape {
  return {
    name: a.name,
    isRoot: true,
    hasCreate: hasCreate(a),
    fields: a.fields,
    contains: a.contains,
    derived: a.derived,
    invariants: a.invariants,
    functions: a.functions,
    operations: a.operations,
    appliers: a.appliers,
    eventSourced: a.persistedAs === "eventLog",
    creates: a.creates,
  };
}

function partShape(p: EntityPartIR, root: AggregateIR): EntityShape {
  return {
    name: p.name,
    isRoot: false,
    hasCreate: false,
    rootName: root.name,
    parentName: directParentName(root, p.name, root.name),
    fields: p.fields,
    contains: p.contains,
    derived: p.derived,
    invariants: p.invariants,
    functions: p.functions,
    operations: [],
  };
}

/** The TS type of an exception-less operation's `or`-union return, rendered
 *  inline from the resolved wire members so the domain method signature carries
 *  no external payload-type reference (payloads aren't emitted as domain
 *  interfaces).  Mirrors the route's `z.discriminatedUnion` field-for-field
 *  (both derive from `unionMembers`): a record variant flattens its wire fields
 *  beside `type`, a scalar wraps a `value`, `none` is the bare unit. */
/** Type-correct seed value for a non-optional, non-input field the create
 *  factory must name in its all-fields state literal but the server owns
 *  (`managed`/`token`/`internal`).  A `datetime managed` placement stamp
 *  seeds to `new Date()`; numeric counters to `0`, etc.  Falls back to
 *  `null` for shapes with no obvious zero (value objects, enums) — those
 *  don't occur as server-managed non-optional fields today, and `null`
 *  preserves the prior behaviour rather than fabricating a bogus instance. */
function serverInitSeed(t: TypeIR): string {
  if (t.kind === "primitive") {
    switch (t.name) {
      case "datetime":
        return "new Date()";
      case "int":
      case "long":
      case "decimal":
        return "0";
      // `money` renders as `Decimal` (decimal.js) and `json`/value-object /
      // enum shapes have no obvious bare zero — those fall through to the
      // `null` default below (none occur as server-managed non-optional
      // fields today; the seed only has to cover the cases that do).
      case "bool":
        return "false";
      case "string":
      case "guid":
        return '""';
    }
  }
  return "null";
}

export function renderOperationReturnType(returnType: TypeIR, ctx: BoundedContextIR): string {
  if (returnType.kind !== "union") return renderTsType(returnType);
  const members = unionMembers(returnType.variants, ctx).map((m) => {
    if (m.shape === "none") return `{ type: "none" }`;
    if (m.shape === "scalar") return `{ type: "${m.tag}"; value: ${renderTsType(m.type)} }`;
    const body = m.fields
      .map((f) => `${f.name}: ${f.isId ? "string" : renderTsType(f.type)}`)
      .join("; ");
    return `{ type: "${m.tag}"${body ? `; ${body}` : ""} }`;
  });
  return `(${members.join(" | ")})`;
}

function renderEntity(
  e: EntityShape,
  ctx: BoundedContextIR,
  emitProvenance = false,
  emitTrace = false,
  opFragments?: OpFragment[],
): string {
  const containsType = (c: ContainmentIR): string =>
    `${c.partName}${c.collection ? "[]" : " | null"}`;
  const containsGetterType = (c: ContainmentIR): string =>
    c.collection ? `readonly ${c.partName}[]` : `${c.partName} | null`;
  // Extern operations (extern-domain-extension-point.md §3a, decision (b)
  // Phase 2) re-home to a DOMAIN extension point that is a MEMBER of the
  // aggregate — a `protected abstract <op>Extern(...)` hook the operation
  // method calls, implemented by a co-located scaffold-once subclass the user
  // owns (`domain/<agg>.ts`, extending this generated base `domain/<agg>.base.ts`).
  // Because the hook is a subclass member it reaches the aggregate's own state
  // directly — no injected handler registry, no app-wide setter leak (S10).
  // For extern roots the class is emitted as `<Agg>Base` (abstract, regenerated);
  // the concrete `<Agg>` subclass is the user-owned file everyone imports.
  const hasExtern = e.operations.some((o) => o.extern);
  const isExternRoot = hasExtern && e.isRoot;
  // The emitted class name — the abstract base for extern roots, the concrete
  // class otherwise.  Consumers still import the concrete `<Agg>` (the
  // scaffold-once subclass, exported from `domain/<agg>.ts`), so nothing
  // downstream changes.
  const className = isExternRoot ? `${e.name}Base` : e.name;
  // Extern roots relax backing fields from `private` to `protected` (the
  // subclass hook mutates them directly) and open the constructor to `public`
  // (the inherited generic factories construct the concrete subclass via
  // `new this(...)`).  `protected` is NOT a public setter — no code outside the
  // aggregate's own class hierarchy can write, so the S10 app-wide leak is gone
  // by construction.  Non-extern aggregates keep `private` (byte-identical).
  const fieldVis = isExternRoot ? "protected" : "private";
  const ctorVis = isExternRoot ? "public" : "private";

  // Constructor parameter list — `id`, then optional `parentId`, then
  // every field, then every containment.  Used in three places: the
  // private ctor signature, the static `_create` signature, and (for
  // the root) the static `create` factory body.
  // Provenanced fields carry a co-located `_<field>_provenance` backing
  // field (current lineage, persisted on the row) threaded through the
  // ctor state so repository hydration can restore it.  `_provTraces`
  // (the append-only history buffer drained by the route handler) is
  // emitted only where domain logic actually writes a provenanced field.
  const provFields = emitProvenance ? e.fields.filter((f) => f.provenanced) : [];
  const hasOwnProvWrite =
    emitProvenance && e.operations.some((op) => op.statements.some(stmtHasProv));

  // A NESTED part (contained by a sibling, not the root) has no parent id at
  // construction — its FK is stamped from tree position on save — so `parentId`
  // is optional in construction and defaulted in the ctor.  Root-level parts are
  // byte-identical (parentName === rootName).
  const isNested = !e.isRoot && e.parentName != null && e.parentName !== e.rootName;
  const parentIdField = (optional: boolean): string | null =>
    e.isRoot ? null : `parentId${optional ? "?" : ""}: Ids.${e.parentName ?? e.rootName}Id`;

  const stateFields = [
    `id: Ids.${e.name}Id`,
    parentIdField(isNested),
    ...e.fields.map((f) => `${f.name}: ${renderTsType(f.type)}`),
    ...provFields.map((f) => `${f.name}_provenance: ProvLineage | null`),
    ...e.contains.map((c) => `${c.name}: ${containsType(c)}`),
  ].filter((s): s is string => s != null);
  const stateLiteral = `{ ${stateFields.join("; ")} }`;

  // The op-body `new <Part>` factory (`_create`) defaults a part's OWN nested
  // containments — a freshly-constructed part starts with none, and callers
  // (`renderNew`) only pass declared fields (and, for a nested part, no
  // parentId).  Byte-identical for a non-nested part with no containments;
  // `_rehydrate` keeps the full required state contract.
  const hasContains = e.contains.length > 0;
  const createStateLiteral =
    hasContains || isNested
      ? `{ ${[
          `id: Ids.${e.name}Id`,
          parentIdField(isNested),
          ...e.fields.map((f) => `${f.name}: ${renderTsType(f.type)}`),
          ...provFields.map((f) => `${f.name}_provenance: ProvLineage | null`),
          ...e.contains.map((c) => `${c.name}?: ${containsType(c)}`),
        ]
          .filter((s): s is string => s != null)
          .join("; ")} }`
      : stateLiteral;
  // Callee is `new this` for an extern-root base class (the static factory is
  // polymorphic so `<Agg>Base._create` constructs the concrete subclass and
  // never forward-references it), else the plain `new <Agg>` form.
  const createCallee = isExternRoot ? "this" : e.name;
  const createBody = hasContains
    ? `new ${createCallee}({ ...state, ${e.contains
        .map((c) => `${c.name}: state.${c.name} ?? ${c.collection ? "[]" : "null"}`)
        .join(", ")} })`
    : `new ${createCallee}(state)`;

  const fieldDecls: string[] = [];
  fieldDecls.push(`  ${fieldVis} _id: Ids.${e.name}Id;`);
  if (!e.isRoot) {
    fieldDecls.push(`  ${fieldVis} _parentId: Ids.${e.parentName ?? e.rootName}Id;`);
  }
  if (e.isRoot) {
    fieldDecls.push(`  ${fieldVis} _events: Events.DomainEvent[] = [];`);
  }
  for (const f of e.fields) {
    fieldDecls.push(`  ${fieldVis} _${f.name}: ${renderTsType(f.type)};`);
  }
  for (const f of provFields) {
    fieldDecls.push(`  ${fieldVis} _${f.name}_provenance: ProvLineage | null;`);
  }
  for (const c of e.contains) {
    fieldDecls.push(`  ${fieldVis} _${c.name}: ${containsType(c)};`);
  }
  if (hasOwnProvWrite) {
    fieldDecls.push(`  ${fieldVis} _provTraces: ProvLineage[] = [];`);
  }

  const ctorAssignments: string[] = [];
  ctorAssignments.push("    this._id = state.id;");
  if (!e.isRoot) {
    // A nested part built via `new` carries no parentId — mint a placeholder so
    // `_parentId` is always a valid id; the real FK is stamped from tree
    // position on save and the real parentId is set from the DB row on hydrate.
    ctorAssignments.push(
      isNested
        ? `    this._parentId = state.parentId ?? Ids.new${e.parentName}Id();`
        : "    this._parentId = state.parentId;",
    );
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
  // Constructor runs invariants on domain construction (`create`, in-op
  // part builds via `_create`); repository rehydration opts out through
  // `_rehydrate` (S6: invariants guard TRANSITIONS — reconstituted state
  // was valid when stored, and re-asserting on load makes every
  // pre-existing row unreadable the moment an invariant tightens,
  // including the fix-it update path).  The op context isn't meaningful
  // here, so trace-on passes the sentinel "<init>" so the
  // invariant_evaluated lines for ctor runs are distinguishable from
  // in-operation evaluations.
  ctorAssignments.push(
    "    if (!trustStore) {",
    emitTrace ? `      this._assertInvariants("<init>");` : "      this._assertInvariants();",
    "    }",
  );

  const getters: string[] = [];
  getters.push(`  get id(): Ids.${e.name}Id { return this._id; }`);
  if (!e.isRoot) {
    getters.push(
      `  get parentId(): Ids.${e.parentName ?? e.rootName}Id { return this._parentId; }`,
    );
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
  // Host-language debug-string hooks delegate to the `inspect` getter
  // emitted by the loop above.  Two slots: `toString()` for
  // `String(x)` / `${x}` interpolation, and `util.inspect.custom` for
  // `console.log` + Node debugger inspection.  Both return the same
  // structural form so library consumers see a consistent debug
  // representation regardless of the call shape.
  if (e.derived.some((d) => d.name === "inspect")) {
    getters.push(`  toString(): string { return this.inspect; }`);
    getters.push(`  [Symbol.for("nodejs.util.inspect.custom")](): string { return this.inspect; }`);
  }

  const fns = e.functions.flatMap((fn) => {
    const params = fn.params.map((p) => `${p.name}: ${renderTsType(p.type)}`).join(", ");
    const head = `  private ${lowerFirst(fn.name)}(${params}): ${renderTsType(fn.returnType)}`;
    // Expression form stays the single-line `{ return expr; }` (byte-identical);
    // block form (domain-services.md rev. 4) emits its lowered statements.
    if ("expr" in fn.body) {
      return [`${head} { return ${renderTsExpr(fn.body.expr)}; }`];
    }
    return [`${head} {`, renderTsStatements(fn.body.stmts), `  }`];
  });

  // Extern extension points (extern-domain-extension-point.md §3a, decision (b)
  // Phase 2).  The hook is a MEMBER of the aggregate (`protected abstract
  // <op>Extern(...)`, emitted per op in the ops loop below); the operation
  // method calls it between preconditions and invariants.  The co-located
  // scaffold-once subclass implements each hook, reaching the (now `protected`)
  // fields directly — so there is NO injected handler registry and NO editor.
  // `_raiseEvent` lets a hook emit a domain event through the same buffer the
  // framework drains (`pullEvents`).
  const externHookLines: string[] = [];
  if (isExternRoot) {
    externHookLines.push(
      "  /** Raise a domain event from within an `extern` operation hook.  Buffered",
      "   *  like any other emitted event; drained by `pullEvents()`. */",
      "  protected _raiseEvent(ev: Events.DomainEvent): void { this._events.push(ev); }",
    );
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
      // Extern operation (case-1 domain logic): the route/workflow calls
      // `aggregate.<op>(...)`, which runs preconditions → the aggregate-owned
      // hook → invariants (the framework flow, unchanged).  The hook is a
      // `protected abstract <op>Extern(...)` the scaffold-once subclass fills.
      const checkName = `check${op.name[0]!.toUpperCase()}${op.name.slice(1)}`;
      const hookName = `${lowerFirst(op.name)}Extern`;
      const callArgs = [op.params.map((p) => p.name).join(", "), usesUser ? "currentUser" : ""]
        .filter(Boolean)
        .join(", ");
      const retType = op.returnType ? renderOperationReturnType(op.returnType, ctx) : "void";
      // Preconditions kept as their own method (parity with the prior shape).
      ops.push(`  ${checkName}(${params}): void {`);
      const checkBody = renderTsStatements(op.statements, emitProvenance, {
        emitTrace,
        aggregate: e.name,
        op: op.name,
        eventSourced: e.eventSourced,
      });
      if (checkBody.length > 0) ops.push(checkBody);
      ops.push("  }");
      ops.push("");
      // The operation method — preconditions → hook → invariants.
      ops.push(`  public ${lowerFirst(op.name)}(${params}): ${retType} {`);
      ops.push(`    this.${checkName}(${callArgs});`);
      if (op.returnType) {
        ops.push(`    return this.${hookName}(${callArgs});`);
      } else {
        ops.push(`    this.${hookName}(${callArgs});`);
        ops.push(
          emitTrace ? `    this._assertInvariants("${op.name}");` : "    this._assertInvariants();",
        );
      }
      ops.push("  }");
      ops.push("");
      // The extension point — a member of the aggregate, implemented by the
      // co-located scaffold-once `${e.name}` subclass.
      ops.push(
        `  /** Extension point for \`extern\` operation \`${op.name}\` — hand-written`,
        `   *  domain logic.  Implement in the co-located \`${e.name}\` subclass`,
        `   *  (\`domain/${lowerFirst(e.name)}.ts\`): mutate this aggregate's fields and`,
        `   *  \`_raiseEvent(...)\` as needed; the framework re-asserts invariants after. */`,
        `  protected abstract ${hookName}(${params}): ${retType};`,
        "",
      );
      continue;
    }
    // An exception-less operation (`operation foo(): X or NotFound`) returns its
    // declared `or`-union; lowering tags each `return` with the matching variant
    // so the method body emits the tagged-wire shape.  A void operation keeps the
    // `void` signature and asserts invariants on the way out; a returning one
    // ends in `return`, so the trailing assert would be unreachable — skip it.
    const retType = op.returnType ? renderOperationReturnType(op.returnType, ctx) : "void";
    ops.push(`  ${visibility} ${lowerFirst(op.name)}(${params}): ${retType} {`);
    // Chunked (one string per statement) rather than the pre-joined
    // `renderTsStatements` here — `renderTsStatements` IS `chunks.join("\n")`
    // by construction, so `body` below is byte-identical either way, but the
    // per-chunk list lets us surface per-statement sub-regions to the caller
    // that owns the recorder + this file's final content (source-map
    // Milestone 3, Hono-only for now — see `OpFragment`).
    const chunks = renderTsStatementChunks(op.statements, emitProvenance, {
      emitTrace,
      aggregate: e.name,
      op: op.name,
      eventSourced: e.eventSourced,
    });
    const body = chunks.join("\n");
    if (opFragments && chunks.length > 0) {
      // Expression-level marks (span-tracking-emission.md, M15 phase 7
      // slice 2) — only computed on this recording path (`opFragments`
      // present); the flag-off run above never re-renders the RHS
      // expressions through the marks-carrying entry.
      const exprMarks = op.statements.map((s, i) => statementExprMarks(s, chunks[i]!));
      opFragments.push({
        fragmentText: body,
        subRegions: statementSubRegions(
          op.statements,
          chunks,
          `${ctx.name}.${e.name}.${op.name}`,
          exprMarks,
        ),
      });
    }
    if (body.length > 0) ops.push(body);
    if (!op.returnType) {
      ops.push(
        emitTrace ? `    this._assertInvariants("${op.name}");` : "    this._assertInvariants();",
      );
    }
    ops.push("  }");
    ops.push("");
  }

  // When `--trace` is on, each invariant binds its boolean to a temp so
  // both pass and fail outcomes log before the conditional throw fires
  // off the same temp.  A guarded invariant logs only when its guard
  // applies (so an inapplicable invariant doesn't pollute the stream).
  // Op context comes from the implicit `__op` parameter on the trace-on
  // signature of `_assertInvariants`.
  const invariants = e.invariants.map((inv, i) => {
    const exprSrc = JSON.stringify(`Invariant violated: ${inv.source}`);
    if (!emitTrace) {
      const check = inv.guard
        ? `if ((${renderTsExpr(inv.guard)}) && !(${renderTsExpr(inv.expr)}))`
        : `if (!(${renderTsExpr(inv.expr)}))`;
      return `    ${check} throw new DomainError(${exprSrc});`;
    }
    const ok = `__inv_${i}_ok`;
    const traceLine = `requestLog().trace({ event: "invariant_evaluated", aggregate: "${e.name}", op: __op, expr: ${JSON.stringify(inv.source)}, passed: ${ok} });`;
    if (inv.guard) {
      return [
        `    if (${renderTsExpr(inv.guard)}) {`,
        `      const ${ok} = (${renderTsExpr(inv.expr)});`,
        `      ${traceLine}`,
        `      if (!${ok}) throw new DomainError(${exprSrc});`,
        `    }`,
      ].join("\n");
    }
    return [
      `    const ${ok} = (${renderTsExpr(inv.expr)});`,
      `    ${traceLine}`,
      `    if (!${ok}) throw new DomainError(${exprSrc});`,
    ].join("\n");
  });

  // Create-factory input — the create-input set (`forCreateInput`, incl.
  // optionals) matching the wire DTO.  Every constructible aggregate's
  // create is parameterized by this set; there is no parameterless form.
  const createInputs = forCreateInput(e.fields);
  const createInputNames = new Set(createInputs.map((f) => f.name));
  const fieldInit = (f: FieldIR): string => {
    if (createInputNames.has(f.name)) {
      return f.optional ? `input.${f.name} ?? null` : `input.${f.name}`;
    }
    // Outside the create input (managed/token/internal): server-initialised.
    // An optional field may simply be null; a non-optional one is server-
    // stamped (e.g. a `datetime managed` placement timestamp) and needs a
    // type-correct seed so the all-fields ctor state literal type-checks —
    // `null` against a non-nullable `Date`/`number` is the bug.  The .NET
    // backend sidesteps this by leaving such fields at their property
    // default; Hono's state object has to name every field, so it seeds one.
    if (f.optional) return "null";
    return serverInitSeed(f.type);
  };
  // Factory shape helpers.  An extern root is an ABSTRACT base whose concrete
  // subclass (`${e.name}`, scaffold-once) is what callers reference, so its
  // static factories are `this`-polymorphic (`new this(...)`) — typed so the
  // `this` receiver must be a CONCRETE constructor (calling a factory on the
  // abstract base is a tsc error, calling it on `${e.name}` yields `${e.name}`).
  // Non-extern aggregates keep the plain `new ${e.name}(...)` form
  // (byte-identical).
  const newSelf = (args: string): string =>
    isExternRoot ? `new this(${args})` : `new ${e.name}(${args})`;
  // Bare constructor callee (`new this` / `new ${e.name}`) for the multi-line
  // object-literal create factory, whose `({` / `});` framing is emitted around it.
  const newSelfCallee = isExternRoot ? "new this" : `new ${e.name}`;
  const factoryHead = (name: string, param: string, ret: string): string =>
    isExternRoot
      ? `  static ${name}<T extends ${className}>(this: new (state: ${stateLiteral}, trustStore?: boolean) => T, ${param}): T {`
      : `  static ${name}(${param}): ${ret} {`;
  // Event-sourced create factory (appliers A2.2): an event-sourced
  // aggregate is constructed from its creation event, not by writing state.
  // The single `create` lifecycle action's emit-only body runs against a
  // fresh empty shell (`_init`), where each `emit` records-and-folds — so
  // after `create(...)` the instance holds the folded state AND carries the
  // creation event for the repository to append.  Input is the create
  // action's params (the command shape), not the field set.
  const esCreate = e.creates?.[0];
  const esCreateFactory =
    e.isRoot && e.eventSourced && esCreate
      ? [
          factoryHead(
            "create",
            `input: { ${esCreate.params
              .map((p) => `${p.name}: ${renderTsType(p.type)}`)
              .join("; ")} }`,
            e.name,
          ),
          `    const inst = ${newSelf(`{ id: Ids.new${e.name}Id() } as unknown as ${stateLiteral}`)};`,
          `    inst._init(${esCreate.params.map((p) => `input.${p.name}`).join(", ")});`,
          `    return inst;`,
          `  }`,
          "",
          `  private _init(${esCreate.params
            .map((p) => `${p.name}: ${renderTsType(p.type)}`)
            .join(", ")}): void {`,
          renderTsStatements(esCreate.statements, emitProvenance, {
            emitTrace,
            aggregate: e.name,
            op: esCreate.name,
            eventSourced: true,
          }),
          `  }`,
        ]
      : [];

  // Public `create(...)` factory gated on constructibility — a
  // non-constructible aggregate exposes no factory; it is reconstructed
  // only via `_create` (repository hydration).  Suppressed for event-sourced
  // aggregates, which use the event-sourced factory above.
  const createFactory =
    e.isRoot && e.hasCreate && !e.eventSourced
      ? [
          factoryHead(
            "create",
            `input: { ${createInputs
              .map((f) => `${f.name}${f.optional ? "?" : ""}: ${renderTsType(f.type)}`)
              .join("; ")} }`,
            e.name,
          ),
          `    return ${newSelfCallee}({`,
          `      id: Ids.new${e.name}Id(),`,
          ...e.fields.map((f) => `      ${f.name}: ${fieldInit(f)},`),
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
        "  drainProv(): ProvLineage[] {",
        "    const out = this._provTraces;",
        "    this._provTraces = [];",
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

  // Lifecycle stamps (audit / softDelete capability stamps) are NO LONGER
  // emitted on the domain entity.  Persist-time auditing
  // (node-persist-time-auditing) relocated stamping into the drizzle `save()`
  // (db/audit-stamp.ts), reading the principal from the ambient request
  // context — so the aggregate stays pure (no `_stampOnCreate`/`_stampOnUpdate`)
  // and the route handler never stamps.  The audit FIELDS + getters
  // (createdAt/createdBy/updatedAt/updatedBy) remain, as before.

  // Event-sourcing fold (appliers A2): one `_apply<Event>` method per
  // applier (body rendered at the natural method-body depth), a `_apply`
  // dispatcher that switches on `ev.type`, and a `_fromEvents` rehydrator
  // that folds a stream from an empty shell.  Emitted root-only and only
  // for `persistedAs(eventLog)` aggregates; the repository calls
  // `_fromEvents` on load, and the push-and-apply `emit` calls `_apply`.
  const appliersBlock =
    e.isRoot && e.eventSourced && (e.appliers?.length ?? 0) > 0
      ? [
          ...(e.appliers ?? []).flatMap((ap) => {
            const body = renderTsStatements(ap.statements, emitProvenance, {
              emitTrace,
              aggregate: e.name,
              op: `apply(${ap.event})`,
              eventSourced: true,
            });
            return [
              `  private _apply${ap.event}(${ap.param}: Events.${ap.event}): void {`,
              ...(body.length > 0 ? [body] : []),
              "  }",
              "",
            ];
          }),
          "  private _apply(ev: Events.DomainEvent): void {",
          "    switch (ev.type) {",
          ...(e.appliers ?? []).flatMap((ap) => [
            `      case ${JSON.stringify(ap.event)}:`,
            `        this._apply${ap.event}(ev as Events.${ap.event});`,
            "        break;",
          ]),
          "    }",
          "  }",
          "",
          isExternRoot
            ? `  static _fromEvents<T extends ${className}>(this: new (state: ${stateLiteral}, trustStore?: boolean) => T, id: Ids.${e.name}Id, events: Events.DomainEvent[]): T {`
            : `  static _fromEvents(id: Ids.${e.name}Id, events: Events.DomainEvent[]): ${e.name} {`,
          isExternRoot
            ? `    const inst = new this({ id } as unknown as ${stateLiteral}, true);`
            : `    const inst = ${e.name}._rehydrate({ id } as unknown as ${stateLiteral});`,
          "    for (const ev of events) inst._apply(ev);",
          "    return inst;",
          "  }",
          "",
        ]
      : [];

  return lines(
    `export ${isExternRoot ? "abstract " : ""}class ${className} {`,
    ...fieldDecls,
    `  ${ctorVis} constructor(state: ${stateLiteral}, trustStore = false) {`,
    ...ctorAssignments,
    "  }",
    "",
    ...getters,
    ...externHookLines,
    ...fns,
    ...ops,
    ...provDrain,
    ...pullEvents,
    ...appliersBlock,
    // Under --trace, the helper takes an `__op` string param threaded by
    // each call site (ctor → "<init>", per-op → op name, extern public
    // wrapper → "extern") so the invariant_evaluated trace line carries
    // op context.  Trace off: byte-identical no-arg signature.
    emitTrace
      ? "  private _assertInvariants(__op: string): void {"
      : "  private _assertInvariants(): void {",
    ...invariants,
    "  }",
    "",
    factoryHead("_create", `state: ${createStateLiteral}`, e.name),
    `    return ${createBody};`,
    "  }",
    "",
    "  /** Reconstitution from the store — trusts persisted state, so no",
    "   *  invariant run: invariants guard transitions (create + operations),",
    "   *  not loads.  Repository hydration only; domain code constructs via",
    "   *  `create`/`_create`, which assert. */",
    factoryHead("_rehydrate", `state: ${stateLiteral}`, e.name),
    `    return ${newSelf("state, true")};`,
    "  }",
    ...createFactory,
    ...esCreateFactory,
    "}",
  );
}
