import type { SourceMapSubRegion } from "../../../generator/_trace/sourcemap.js";
import { forCreateInput, hasCreate } from "../../../ir/enrich/wire-projection.js";
import {
  type AggregateIR,
  type BoundedContextIR,
  type ContainmentIR,
  type ContextStampAssignmentIR,
  type DerivedIR,
  type EntityPartIR,
  type ExprIR,
  exprUsesCurrentUser,
  type FieldIR,
  type FunctionIR,
  type InvariantIR,
  type OperationIR,
  operationUsesCurrentUser,
  type TypeIR,
} from "../../../ir/types/loom-ir.js";
import { directParentName, partsChildrenFirst } from "../../../ir/util/containment-parent.js";
import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";
import { provColumn, provenancedFieldsOf } from "../emit/provenance.js";
import { externHookCall, externHookModuleName } from "../extern-builder.js";
import { emptyPyTypeImports, visitPyTypeImports } from "../py-type-imports.js";
import { collectPyExprImports, renderPyExpr, renderPyType } from "../render-expr.js";
import {
  renderPyStatementChunks,
  renderPyStatements,
  statementSubRegions,
} from "../render-stmt.js";
import { domainServiceImportLines } from "./domain-service.js";

/** One operation body's exact emitted text plus its per-statement
 *  sub-regions — surfaced by `renderPyAggregate` (when `opFragments` is
 *  passed) to the caller that owns the recorder and the final file content
 *  (`src/generator/python/index.ts`), which anchors it via
 *  `SourceMapRecorder.fragment`.  Covers only the REGULAR (non-extern)
 *  named-operation body path — see the call site in `renderEntity` below;
 *  extern check bodies / event-sourced init / appliers are out of scope for
 *  this milestone. */
export interface OpFragment {
  fragmentText: string;
  subRegions: SourceMapSubRegion[];
}

// ---------------------------------------------------------------------------
// Aggregate emission — `app/domain/<snake(agg)>.py`.  One module per
// aggregate root: part classes first (so the root's containment
// annotations resolve without forward refs), then the root class.
//
// Shape per class (mirrors the TS emitter):
//   - `__init__(self, *, id, [parent_id], fields…, contains…)` assigns
//     the private backing fields and asserts invariants — the full-state
//     constructor repository hydration uses (via the `_create` alias).
//   - `@property` per field / containment / derived.
//   - `__repr__` delegates to the `inspect` derived when present.
//   - `_<snake>` private method per `function`; `<snake>` public /
//     `_<snake>` private method per operation, ending in
//     `_assert_invariants()` when void.
//   - Root-only: `_events` + `pull_events()`, the public `create`
//     classmethod (constructible aggregates only).
//
// Deferred to later slices: provenance backing fields, --trace
// instrumentation, extern mutators (S16), event-sourced create/appliers
// (S14 — the IR validator gates `persistedAs(eventLog)` off python
// until then).
// ---------------------------------------------------------------------------

interface EntityShape {
  name: string;
  isRoot: boolean;
  hasCreate: boolean;
  rootName?: string;
  /** The entity that DIRECTLY contains this part — the aggregate root for a
   *  root-level part, or a sibling part for a nested one.  Drives the
   *  `parent_id` id-type branding (`ShipmentId`, not `OrderId`, for a Label
   *  nested under Shipment).  Equals `rootName` for root-level parts, so
   *  single-level output is byte-identical. */
  parentName?: string;
  fields: FieldIR[];
  contains: ContainmentIR[];
  derived: DerivedIR[];
  invariants: InvariantIR[];
  functions: FunctionIR[];
  operations: OperationIR[];
  /** Root-only, `persistedAs(eventLog)`: fold appliers + the single
   *  create lifecycle action whose emit-only body drives the
   *  event-sourced factory (appliers A2). */
  eventSourced?: boolean;
  appliers?: import("../../../ir/types/loom-ir.js").ApplyIR[];
  esCreate?: OperationIR;
  /** Root-only lifecycle stamps (audit / softDelete capability stamps, or
   *  hand-written `stamp onCreate`/`onUpdate`) — `_stamp_on_create` /
   *  `_stamp_on_update` methods the route calls before persist. */
  contextStamps?: import("../../../ir/types/loom-ir.js").ContextStampIR[];
}

export function renderPyAggregate(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  emitTrace = false,
  /** The principal's id attribute (`actorIdAttr(sys.user)`) — a bare
   *  `currentUser` stamp value resolves to `current_user.<attr>`.  Only
   *  threaded for auth deployables; principal stamps without auth are
   *  gated upstream (loom.python-stamp-unsupported). */
  principalIdAttr?: string | null,
  /** Collector for source-map Milestone 3 statement sub-regions — only
   *  allocated by the caller when a recorder is present (zero cost
   *  otherwise).  Only the root shape carries operations, so only its
   *  `renderEntity` call contributes fragments. */
  opFragments?: OpFragment[],
): string {
  // Provenance (provenance.md): the runtime is emitted only when the
  // aggregate hosts a `provenanced` field (root fields only — captured at
  // named-operation write sites, which target root columns).
  const emitProvenance = provenancedFieldsOf(agg).length > 0;
  // Children-first so a part-in-part class (`Shipment` → `list[Label]`) is
  // defined after the sibling it references — no forward-ref NameError.
  const shapes = [...partsChildrenFirst(agg.parts).map((p) => partShape(p, agg)), rootShape(agg)];
  // Entity parts never carry operations (see `partShape`), so they never
  // contribute op fragments — only the root shape's render call does.
  const rendered = shapes.map((s) =>
    renderEntity(
      s,
      emitTrace,
      principalIdAttr,
      emitProvenance,
      ctx.name,
      s.isRoot ? opFragments : undefined,
    ),
  );
  const body = rendered.join("\n\n\n");

  // --- import resolution -------------------------------------------------
  // Type-graph walk for Decimal / datetime / id-type needs…
  const types = emptyPyTypeImports();
  for (const s of shapes) {
    for (const f of s.fields) visitPyTypeImports(f.type, types);
    for (const d of s.derived) visitPyTypeImports(d.type, types);
    for (const fn of s.functions) {
      visitPyTypeImports(fn.returnType, types);
      for (const p of fn.params) visitPyTypeImports(p.type, types);
    }
    for (const op of s.operations) {
      for (const p of op.params) visitPyTypeImports(p.type, types);
      if (op.returnType) visitPyTypeImports(op.returnType, types);
    }
  }
  // …plus the expression-triggered ones (re / Decimal / datetime).
  const exprImports = new Set<string>();
  for (const s of shapes) {
    for (const d of s.derived) collectPyExprImports(d.expr, exprImports);
    for (const fn of s.functions) {
      if ("expr" in fn.body) collectPyExprImports(fn.body.expr, exprImports);
      else for (const st of fn.body.stmts) collectStmtExprImports(st, exprImports);
    }
    for (const inv of s.invariants) {
      collectPyExprImports(inv.expr, exprImports);
      if (inv.guard) collectPyExprImports(inv.guard, exprImports);
    }
    for (const op of s.operations) {
      for (const st of op.statements) {
        collectStmtExprImports(st, exprImports);
      }
    }
    for (const ap of s.appliers ?? []) {
      for (const st of ap.statements) collectStmtExprImports(st, exprImports);
    }
    for (const st of s.esCreate?.statements ?? []) collectStmtExprImports(st, exprImports);
    // Lifecycle-stamp values (e.g. `now()`) need their own import triggers.
    for (const rule of s.contextStamps ?? []) {
      for (const a of rule.assignments) collectPyExprImports(a.value, exprImports);
    }
  }
  // Server-init seeds in the create factory can stamp `datetime.now(UTC)`.
  const root = rootShape(agg);
  const createSeedsDatetime =
    root.hasCreate &&
    root.fields.some(
      (f) =>
        !forCreateInput(root.fields).includes(f) &&
        !f.optional &&
        f.type.kind === "primitive" &&
        f.type.name === "datetime",
    );
  const usesDatetime =
    types.usesDatetime || exprImports.has("datetime") || createSeedsDatetime === true;
  const usesDecimal = types.usesDecimal || exprImports.has("decimal");

  // Symbol-reference scan over the rendered body (string literals
  // stripped, the TS emitter's trick) for VO / enum / id-factory needs.
  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (name: string): boolean => new RegExp(`\\b${name}\\b`).test(scan);
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();
  const ownIdNames = [agg.name, ...agg.parts.map((p) => p.name)];
  const idTypeNames = [...new Set([...ownIdNames, ...types.idNames])].sort();
  const idFactoryNames = ownIdNames
    .map((n) => `new_${snake(n)}_id`)
    .filter(refersTo)
    .sort();
  const idImports = [...idTypeNames.map((n) => `${n}Id`), ...idFactoryNames];

  const usesDomainError =
    shapes.some((s) => s.invariants.length > 0) ||
    shapes.some((s) =>
      s.operations.some((op) => op.statements.some((st) => st.kind === "precondition")),
    );
  const usesForbidden = shapes.some((s) =>
    s.operations.some((op) => op.statements.some((st) => st.kind === "requires")),
  );
  const errorNames = [
    usesDomainError ? "DomainError" : null,
    usesForbidden ? "ForbiddenError" : null,
  ].filter((n): n is string => n != null);

  const emittedEvents = [
    ...new Set(
      shapes.flatMap((s) => [
        ...s.operations.flatMap((op) =>
          op.statements.filter((st) => st.kind === "emit").map((st) => st.eventName),
        ),
        ...(s.appliers ?? []).map((ap) => ap.event),
        ...(s.esCreate?.statements ?? [])
          .filter((st) => st.kind === "emit")
          .map((st) => (st as { eventName: string }).eventName),
      ]),
    ),
  ].sort();
  const eventImports = ["DomainEvent", ...emittedEvents];

  const usesCurrentUser =
    shapes.some((s) => s.operations.some(operationUsesCurrentUser)) ||
    shapes.some((s) =>
      (s.contextStamps ?? []).some((r) => r.assignments.some((a) => exprUsesCurrentUser(a.value))),
    );
  const bodyUsesCast = /\bcast\(/.test(body);
  // Domain-service calls render as bare functions (`quote(...)`), so the
  // aggregate module imports them by name from app.domain.services.* —
  // collected from every operation / applier / es-create body.
  const serviceImports = domainServiceImportLines([
    ...shapes.flatMap((s) => s.operations.flatMap((op) => op.statements)),
    ...shapes.flatMap((s) => (s.appliers ?? []).flatMap((ap) => ap.statements)),
    ...shapes.flatMap((s) => s.esCreate?.statements ?? []),
  ]);
  return lines(
    `"""${agg.name} aggregate.  Auto-generated."""`,
    "",
    exprImports.has("math") ? "import math" : null,
    exprImports.has("re") ? "import re" : null,
    bodyUsesCast ? "from typing import cast" : null,
    usesDatetime || exprImports.has("timedelta")
      ? `from datetime import ${[
          ...(usesDatetime ? ["UTC", "datetime"] : []),
          ...(exprImports.has("timedelta") ? ["timedelta"] : []),
        ].join(", ")}`
      : null,
    usesDecimal ? "from decimal import Decimal" : null,
    exprImports.has("math") ||
      exprImports.has("re") ||
      exprImports.has("timedelta") ||
      usesDatetime ||
      usesDecimal
      ? ""
      : null,
    usesCurrentUser ? "from app.auth.user import User" : null,
    errorNames.length > 0 ? `from app.domain.errors import ${errorNames.join(", ")}` : null,
    `from app.domain.events import ${eventImports.join(", ")}`,
    `from app.domain.ids import ${idImports.join(", ")}`,
    emitProvenance
      ? "from app.domain.provenance import ProvInput, ProvLineage, ProvTarget, record"
      : null,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    // The user-owned extern hook module (docs/extern.md) — the op bodies call
    // `<agg>_extern.<op>(self, …)`.  Its own aggregate import is TYPE_CHECKING-
    // only, so this module-level import never cycles.
    agg.operations.some((op) => op.extern && op.visibility === "public")
      ? `from app.domain.extern import ${externHookModuleName(agg.name)}`
      : null,
    ...serviceImports,
    emitTrace && /\blog\("trace"/.test(body) ? "from app.obs.log import log" : null,
    "",
    "",
    body,
    "",
  );
}

/** Recursive import collection over a statement's expressions. */
function collectStmtExprImports(st: OperationIR["statements"][number], into: Set<string>): void {
  switch (st.kind) {
    case "precondition":
    case "requires":
      collectPyExprImports(st.expr, into);
      return;
    case "let":
      collectPyExprImports(st.expr, into);
      return;
    case "assign":
    case "add":
    case "remove":
      collectPyExprImports(st.value, into);
      return;
    case "emit":
      for (const f of st.fields) collectPyExprImports(f.value, into);
      return;
    case "call":
      for (const a of st.args) collectPyExprImports(a, into);
      return;
    case "expression":
      collectPyExprImports(st.expr, into);
      return;
    case "return":
      collectPyExprImports(st.value, into);
      return;
  }
}

/** The provenanced fields on an entity shape (root only — provenance targets
 *  root columns at named-operation write sites). */
function provFieldsOf(e: EntityShape): FieldIR[] {
  return e.fields.filter((f) => f.provenanced);
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
    eventSourced: a.persistedAs === "eventLog",
    appliers: a.appliers,
    esCreate: a.creates?.[0],
    contextStamps: a.contextStamps,
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

/** Type-correct seed for a non-optional server-owned field the create
 *  factory must still populate (managed / token / internal). */
function serverInitSeed(t: TypeIR): string {
  if (t.kind === "primitive") {
    switch (t.name) {
      case "datetime":
        return "datetime.now(UTC)";
      case "int":
      case "long":
        return "0";
      case "decimal":
        return "0.0";
      case "bool":
        return "False";
      case "string":
      case "guid":
        return '""';
      default:
        return "None";
    }
  }
  if (t.kind === "array") return "[]";
  return "None";
}

function containsType(c: ContainmentIR): string {
  return c.collection ? `list[${c.partName}]` : `${c.partName} | None`;
}

function renderEntity(
  e: EntityShape,
  emitTrace = false,
  principalIdAttr?: string | null,
  emitProvenance = false,
  /** Bounded-context name — only needed to build the `ctx.agg.op` construct
   *  id for `opFragments`; unused when `opFragments` is undefined. */
  ctxName?: string,
  opFragments?: OpFragment[],
): string {
  // Provenanced fields (root-only) carry a co-located `_<field>_provenance`
  // backing field holding the current lineage — initialised to None in the
  // ctor and restored on hydrate from the row's jsonb column.  The save
  // persists it; `to_wire` surfaces it on the wire DTO.
  const provFields = emitProvenance && e.isRoot ? provFieldsOf(e) : [];
  const self = `"${e.name}"`;
  // Under --trace, `_assert_invariants` takes an `__op` label threaded by
  // each caller (the ctor passes "<init>", the extern wrapper "extern") so
  // the `invariant_evaluated` line carries the originating operation.
  const assertCall = (op: string): string =>
    emitTrace
      ? `        self._assert_invariants(${JSON.stringify(op)})`
      : "        self._assert_invariants()";

  // A NESTED part (contained by a sibling, not the root) has no parent id at
  // construction — its FK is stamped from tree position on save — so `parent_id`
  // is optional (keyword-only, so a default before required fields is legal) and
  // defaulted in `__init__`.  Root-level parts are byte-identical.
  const isNested = !e.isRoot && e.parentName != null && e.parentName !== e.rootName;
  const parentIdParam = (optional: boolean): string | null =>
    e.isRoot
      ? null
      : `parent_id: ${e.parentName ?? e.rootName}Id${optional ? " | None = None" : ""}`;

  // Full-state keyword-only parameter list — shared by `__init__` and the
  // `_create` rehydration alias.
  const stateParams = [
    `id: ${e.name}Id`,
    parentIdParam(isNested),
    ...e.fields.map((f) => `${snake(f.name)}: ${renderPyType(f.type)}`),
    ...e.contains.map((c) => `${snake(c.name)}: ${containsType(c)}`),
  ].filter((s): s is string => s != null);
  const stateArgs = [
    "id=id",
    !e.isRoot ? "parent_id=parent_id" : null,
    ...e.fields.map((f) => `${snake(f.name)}=${snake(f.name)}`),
    ...e.contains.map((c) => `${snake(c.name)}=${snake(c.name)}`),
  ].filter((s): s is string => s != null);

  // `_trust_store` opts repository rehydration out of the invariant run
  // (S6: invariants guard TRANSITIONS — reconstituted state was valid when
  // stored, and re-asserting on load makes every pre-existing row
  // unreadable the moment an invariant tightens, including the fix-it
  // update path).  Domain construction (`create`, in-op part builds via
  // `_create`) keeps the default and asserts.
  const ctor = [
    `    def __init__(self, *, ${stateParams.join(", ")}, _trust_store: bool = False) -> None:`,
    `        self._id = id`,
    e.isRoot
      ? null
      : isNested
        ? `        self._parent_id = parent_id if parent_id is not None else new_${snake(e.parentName ?? e.name)}_id()`
        : `        self._parent_id = parent_id`,
    ...e.fields.map((f) => `        self._${snake(f.name)} = ${snake(f.name)}`),
    ...e.contains.map((c) => `        self._${snake(c.name)} = ${snake(c.name)}`),
    e.isRoot ? `        self._events: list[DomainEvent] = []` : null,
    // Co-located provenance lineage, set on each provenanced write and
    // restored on hydrate; None until first written.
    ...provFields.map((f) => `        self._${provColumn(f.name)}: ProvLineage | None = None`),
    "        if not _trust_store:",
    `    ${assertCall("<init>")}`,
  ].filter((s): s is string => s != null);

  // Extern ops (docs/extern.md, extern (b) Phase 2): the op body delegates its
  // mutation to a USER-OWNED hook function that receives the aggregate and
  // reaches its own private state directly — so the aggregate needs no per-field
  // setters (fields stay `private` behind read-only getters).  It keeps only
  // `raise_event`, the event API the hook calls.
  const hasExtern = e.operations.some((op) => op.extern);
  const getters: string[] = [];
  const prop = (name: string, type: string, value: string): string[] => [
    "",
    "    @property",
    `    def ${name}(self) -> ${type}:`,
    `        return ${value}`,
  ];
  getters.push(...prop("id", `${e.name}Id`, "self._id"));
  if (!e.isRoot) {
    getters.push(...prop("parent_id", `${e.parentName ?? e.rootName}Id`, "self._parent_id"));
  }
  for (const f of e.fields) {
    getters.push(...prop(snake(f.name), renderPyType(f.type), `self._${snake(f.name)}`));
  }
  for (const c of e.contains) {
    getters.push(...prop(snake(c.name), containsType(c), `self._${snake(c.name)}`));
  }
  for (const d of e.derived) {
    getters.push(...prop(snake(d.name), renderPyType(d.type), renderPyExpr(d.expr)));
  }
  for (const f of provFields) {
    getters.push(...prop(provColumn(f.name), "ProvLineage | None", `self._${provColumn(f.name)}`));
  }
  if (e.derived.some((d) => d.name === "inspect")) {
    getters.push("", "    def __repr__(self) -> str:", "        return self.inspect");
  }

  const fns = e.functions.flatMap((fn) => {
    const params = ["self", ...fn.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`)];
    const head = `    def _${snake(fn.name)}(${params.join(", ")}) -> ${renderPyType(fn.returnType)}:`;
    // Expression form keeps the single `return expr` line (byte-identical);
    // block form (domain-services.md rev. 4) emits its lowered statements.
    const body =
      "expr" in fn.body
        ? `        return ${renderPyExpr(fn.body.expr)}`
        : renderPyStatements(fn.body.stmts);
    return ["", head, body];
  });

  const ops = e.operations.flatMap((op) => {
    const params = ["self", ...op.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`)];
    // currentUser-gated ops pick up a trailing actor parameter — the
    // route threads `request.state.current_user` into it.
    if (operationUsesCurrentUser(op)) params.push("current_user: User");
    const trace = emitTrace ? { aggregate: e.name, op: op.name } : undefined;
    // An extern op (extern (b) Phase 2, docs/extern.md) is a REAL method whose
    // DSL body carries only its preconditions: run them, delegate the mutation
    // to the user-owned hook (`<agg>_extern.<op>(self, …)`, which reaches the
    // aggregate's private state and may `raise_event`), then re-assert
    // invariants — the framework flow the proposal keeps (preconditions → hook
    // → invariants).  A missing hook impl raises `NotImplementedError` (500).
    if (op.extern) {
      const preconditions = renderPyStatements(op.statements, undefined, {
        eventSourced: e.eventSourced,
        trace,
        emitProvenance,
      });
      const retType = op.returnType ? renderPyOperationReturnType(op.returnType) : "None";
      const hook = `        ${op.returnType ? "return " : ""}${externHookCall(e.name, op)}`;
      return [
        "",
        `    def ${snake(op.name)}(${params.join(", ")}) -> ${retType}:`,
        ...(preconditions.length > 0 ? [preconditions] : []),
        hook,
        // A void extern op re-asserts invariants after the hook; a returning
        // one ends in `return`, so the trailing assert would be unreachable.
        ...(op.returnType ? [] : [assertCall(op.name)]),
      ];
    }
    const prefix = op.visibility === "public" ? "" : "_";
    const retType = op.returnType ? renderPyOperationReturnType(op.returnType) : "None";
    // Chunked (one string per statement) rather than the pre-joined
    // `renderPyStatements` here — `renderPyStatements` IS `chunks.join("\n")`
    // by construction, so `body` below is byte-identical either way, but the
    // per-chunk list lets us surface per-statement sub-regions to the caller
    // that owns the recorder + this file's final content (source-map
    // Milestone 3, regular named-operation bodies only — see `OpFragment`).
    const chunks = renderPyStatementChunks(op.statements, undefined, {
      eventSourced: e.eventSourced,
      trace,
      emitProvenance,
    });
    const body = chunks.join("\n");
    if (opFragments && chunks.length > 0) {
      opFragments.push({
        fragmentText: body,
        subRegions: statementSubRegions(op.statements, chunks, `${ctxName}.${e.name}.${op.name}`),
      });
    }
    return [
      "",
      `    def ${prefix}${snake(op.name)}(${params.join(", ")}) -> ${retType}:`,
      ...(body.length > 0 ? [body] : []),
      // Void operations re-assert invariants on the way out; a returning
      // one ends in `return`, so the trailing assert would be unreachable.
      ...(op.returnType ? [] : [assertCall(op.name)]),
    ];
  });

  const pullEvents = e.isRoot
    ? [
        "",
        "    def pull_events(self) -> list[DomainEvent]:",
        "        out = self._events",
        "        self._events = []",
        "        return out",
        // Extern hooks (docs/extern.md) mutate the aggregate directly and raise
        // events through this event API; invariants are re-asserted by the op
        // method itself (`self._assert_invariants()`), so no public assert seam
        // is exposed.
        ...(hasExtern
          ? [
              "",
              "    def raise_event(self, ev: DomainEvent) -> None:",
              "        self._events.append(ev)",
            ]
          : []),
      ]
    : [];

  // Lifecycle stamps (audit / softDelete capability stamps, or hand-written
  // `stamp onCreate`/`onUpdate`): `_stamp_on_create` / `_stamp_on_update`
  // methods the route calls right before persist.  A non-principal value
  // (e.g. `now()`) renders directly; a bare `currentUser` value resolves to
  // the principal id (`current_user.<idAttr>`, threaded from
  // `request.state.current_user`).  Root-only; event-sourced aggregates and
  // principal stamps without auth are gated upstream.
  const stampRules = (event: "create" | "update"): ContextStampAssignmentIR[] =>
    e.isRoot
      ? (e.contextStamps ?? []).filter((r) => r.event === event).flatMap((r) => r.assignments)
      : [];
  const renderStampValue = (value: ExprIR): string =>
    value.kind === "ref" && value.refKind === "current-user"
      ? `current_user.${principalIdAttr ?? "id"}`
      : renderPyExpr(value);
  const stampMethod = (event: "create" | "update"): string[] => {
    const rules = stampRules(event);
    if (rules.length === 0) return [];
    const usesUser = rules.some((a) => exprUsesCurrentUser(a.value));
    return [
      "",
      `    def _stamp_on_${event}(self${usesUser ? ", current_user: User" : ""}) -> None:`,
      ...rules.map((a) => `        self._${snake(a.field)} = ${renderStampValue(a.value)}`),
    ];
  };
  const stampMethods = [...stampMethod("create"), ...stampMethod("update")];

  const invariantLines = e.invariants.flatMap((inv, idx) => {
    const msg = JSON.stringify(
      inv.message ? inv.message.text : `Invariant violated: ${inv.source}`,
    );
    // Under --trace, evaluate into a temp, emit `invariant_evaluated`
    // (op label = the threaded `__op`), then check — matching Hono/.NET.
    if (emitTrace) {
      const ok = `__inv_${idx}_ok`;
      const traceArgs = `aggregate=${JSON.stringify(e.name)}, op=__op, expr=${JSON.stringify(inv.source)}, passed=${ok}`;
      const evalCheck = (pad: string): string[] => [
        `${pad}${ok} = (${renderPyExpr(inv.expr)})`,
        `${pad}log("trace", "invariant_evaluated", ${traceArgs})`,
        `${pad}if not ${ok}:`,
        `${pad}    raise DomainError(${msg})`,
      ];
      if (inv.guard) {
        return [`        if ${renderPyExpr(inv.guard)}:`, ...evalCheck("            ")];
      }
      return evalCheck("        ");
    }
    if (inv.guard) {
      return [
        `        if (${renderPyExpr(inv.guard)}) and not (${renderPyExpr(inv.expr)}):`,
        `            raise DomainError(${msg})`,
      ];
    }
    return [`        if not (${renderPyExpr(inv.expr)}):`, `            raise DomainError(${msg})`];
  });
  const assertInvariants = [
    "",
    emitTrace
      ? "    def _assert_invariants(self, __op: str) -> None:"
      : "    def _assert_invariants(self) -> None:",
    ...(invariantLines.length > 0 ? invariantLines : ["        pass"]),
  ];

  // `_create` (the op-body `new <Part>` factory) defaults a part's OWN nested
  // containments — a freshly-constructed part starts with none, and callers
  // (`renderNew`) only pass declared fields.  Collections default via a safe
  // in-body `None`-coercion (never a shared mutable `[]` default); a single
  // containment's type is already `| None`.  Byte-identical for a part with no
  // containments (`createParams`/`createArgs` fall back to the shared state
  // lists); `__init__`/`_rehydrate` keep the full required state contract.
  const hasContains = e.contains.length > 0;
  const createParams = hasContains
    ? [
        `id: ${e.name}Id`,
        parentIdParam(isNested),
        ...e.fields.map((f) => `${snake(f.name)}: ${renderPyType(f.type)}`),
        ...e.contains.map((c) =>
          c.collection
            ? `${snake(c.name)}: ${containsType(c)} | None = None`
            : `${snake(c.name)}: ${containsType(c)} = None`,
        ),
      ].filter((s): s is string => s != null)
    : stateParams;
  const createArgs = hasContains
    ? [
        "id=id",
        !e.isRoot ? "parent_id=parent_id" : null,
        ...e.fields.map((f) => `${snake(f.name)}=${snake(f.name)}`),
        ...e.contains.map((c) =>
          c.collection
            ? `${snake(c.name)}=${snake(c.name)} if ${snake(c.name)} is not None else []`
            : `${snake(c.name)}=${snake(c.name)}`,
        ),
      ].filter((s): s is string => s != null)
    : stateArgs;

  const createAlias = [
    "",
    "    @classmethod",
    `    def _create(cls, *, ${createParams.join(", ")}) -> ${self}:`,
    `        return cls(${createArgs.join(", ")})`,
    "",
    "    # Reconstitution from the store — trusts persisted state, so no",
    "    # invariant run: invariants guard transitions (create + operations),",
    "    # not loads.  Repository hydration only; domain code constructs via",
    "    # `create`/`_create`, which assert.",
    "    @classmethod",
    `    def _rehydrate(cls, *, ${stateParams.join(", ")}) -> ${self}:`,
    `        return cls(${stateArgs.join(", ")}, _trust_store=True)`,
  ];

  // Event-sourcing (appliers A2): per-event fold methods, the
  // isinstance `_apply` dispatch, the `_from_events` rehydrator
  // (fold-from-zero over a __new__ shell), and the event-sourced
  // `create` factory running the create action's emit-only body.
  const esBlocks: string[] = [];
  if (e.isRoot && e.eventSourced) {
    const shellSeeds = [
      `        inst = cls.__new__(cls)`,
      ...e.fields.map((f) => `        inst._${snake(f.name)} = ${shellSeed(f)}`),
      "        inst._events = []",
    ];
    for (const ap of e.appliers ?? []) {
      esBlocks.push(
        "",
        `    def _apply_${snake(ap.event)}(self, ${snake(ap.param)}: ${ap.event}) -> None:`,
        renderPyStatements(ap.statements) || "        pass",
      );
    }
    esBlocks.push(
      "",
      "    def _apply(self, ev: DomainEvent) -> None:",
      ...(e.appliers ?? []).flatMap((ap, i) => [
        `        ${i === 0 ? "if" : "elif"} isinstance(ev, ${ap.event}):`,
        `            self._apply_${snake(ap.event)}(ev)`,
      ]),
      "",
      "    @classmethod",
      `    def _from_events(cls, id: ${e.name}Id, events: list[DomainEvent]) -> ${self}:`,
      `        inst = cls.__new__(cls)`,
      `        inst._id = id`,
      ...e.fields.map((f) => `        inst._${snake(f.name)} = ${shellSeed(f)}`),
      "        inst._events = []",
      "        for ev in events:",
      "            inst._apply(ev)",
      "        return inst",
    );
    if (e.esCreate) {
      const params = e.esCreate.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`);
      esBlocks.push(
        "",
        "    @classmethod",
        `    def create(cls${params.length > 0 ? `, *, ${params.join(", ")}` : ""}) -> ${self}:`,
        `        inst = cls.__new__(cls)`,
        `        inst._id = new_${snake(e.name)}_id()`,
        ...e.fields.map((f) => `        inst._${snake(f.name)} = ${shellSeed(f)}`),
        "        inst._events = []",
        `        inst._init(${e.esCreate.params.map((p) => snake(p.name)).join(", ")})`,
        "        return inst",
        "",
        `    def _init(self${params.length > 0 ? `, ${params.join(", ")}` : ""}) -> None:`,
        renderPyStatements(e.esCreate.statements, undefined, { eventSourced: true }) ||
          "        pass",
      );
    }
    void shellSeeds;
  }

  // Public `create(...)` factory — constructible roots only.  Inputs are
  // the wire create set (incl. optionals); server-owned fields seed.
  let createFactory: string[] = [];
  if (e.isRoot && e.hasCreate && !e.eventSourced) {
    const inputs = forCreateInput(e.fields);
    const inputNames = new Set(inputs.map((f) => f.name));
    const factoryParams = inputs.map((f) =>
      f.optional
        ? `${snake(f.name)}: ${renderPyType(f.type)} = None`
        : `${snake(f.name)}: ${renderPyType(f.type)}`,
    );
    const fieldInit = (f: FieldIR): string => {
      if (inputNames.has(f.name)) return snake(f.name);
      if (f.optional) return "None";
      return serverInitSeed(f.type);
    };
    createFactory = [
      "",
      "    @classmethod",
      `    def create(cls${factoryParams.length > 0 ? `, *, ${factoryParams.join(", ")}` : ""}) -> ${self}:`,
      "        return cls(",
      `            id=new_${snake(e.name)}_id(),`,
      ...e.fields.map((f) => `            ${snake(f.name)}=${fieldInit(f)},`),
      ...e.contains.map((c) => `            ${snake(c.name)}=${c.collection ? "[]" : "None"},`),
      "        )",
    ];
  }

  return lines(
    `class ${e.name}:`,
    ...ctor,
    ...getters,
    ...fns,
    ...ops,
    ...pullEvents,
    ...stampMethods,
    ...esBlocks,
    ...assertInvariants,
    ...createAlias,
    ...createFactory,
  );
}

/** Type-correct fold-from-zero shell seed — like `serverInitSeed`, but
 *  enum / VO shapes cast a None through so mypy accepts the shell (the
 *  appliers populate them before any read). */
function shellSeed(f: FieldIR): string {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  if (f.optional || f.type.kind === "optional") return "None";
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
        return "0";
      case "decimal":
        return "0.0";
      case "money":
        return 'Decimal("0")';
      case "bool":
        return "False";
      case "string":
      case "guid":
        return '""';
      case "datetime":
        return "datetime.now(UTC)";
      default:
        return "None";
    }
  }
  if (t.kind === "array") return "[]";
  return `cast(${renderPyType(f.type)}, None)`;
}

/** Exception-less `or`-union returns get their proper variant classes in
 *  S12; the tagged dict the statement renderer emits types as
 *  `dict[str, object]` until then. */
function renderPyOperationReturnType(t: TypeIR): string {
  if (t.kind === "union") return "dict[str, object]";
  return renderPyType(t);
}
