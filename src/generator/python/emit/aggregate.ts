import { forCreateInput, hasCreate } from "../../../ir/enrich/wire-projection.js";
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
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";
import { emptyPyTypeImports, visitPyTypeImports } from "../py-type-imports.js";
import { collectPyExprImports, renderPyExpr, renderPyType } from "../render-expr.js";
import { renderPyStatements } from "../render-stmt.js";

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
  fields: FieldIR[];
  contains: ContainmentIR[];
  derived: DerivedIR[];
  invariants: InvariantIR[];
  functions: FunctionIR[];
  operations: OperationIR[];
}

export function renderPyAggregate(agg: AggregateIR, ctx: BoundedContextIR): string {
  const shapes = [...agg.parts.map((p) => partShape(p, agg)), rootShape(agg)];
  const rendered = shapes.map(renderEntity);
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
    for (const fn of s.functions) collectPyExprImports(fn.body, exprImports);
    for (const inv of s.invariants) {
      collectPyExprImports(inv.expr, exprImports);
      if (inv.guard) collectPyExprImports(inv.guard, exprImports);
    }
    for (const op of s.operations) {
      for (const st of op.statements) {
        collectStmtExprImports(st, exprImports);
      }
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
      shapes.flatMap((s) =>
        s.operations.flatMap((op) =>
          op.statements.filter((st) => st.kind === "emit").map((st) => st.eventName),
        ),
      ),
    ),
  ].sort();
  const eventImports = ["DomainEvent", ...emittedEvents];

  return lines(
    `"""${agg.name} aggregate.  Auto-generated."""`,
    "",
    exprImports.has("re") ? "import re" : null,
    usesDatetime ? "from datetime import UTC, datetime" : null,
    usesDecimal ? "from decimal import Decimal" : null,
    exprImports.has("re") || usesDatetime || usesDecimal ? "" : null,
    errorNames.length > 0 ? `from app.domain.errors import ${errorNames.join(", ")}` : null,
    `from app.domain.events import ${eventImports.join(", ")}`,
    `from app.domain.ids import ${idImports.join(", ")}`,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
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
  };
}

function partShape(p: EntityPartIR, root: AggregateIR): EntityShape {
  return {
    name: p.name,
    isRoot: false,
    hasCreate: false,
    rootName: root.name,
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

function renderEntity(e: EntityShape): string {
  const self = `"${e.name}"`;

  // Full-state keyword-only parameter list — shared by `__init__` and the
  // `_create` rehydration alias.
  const stateParams = [
    `id: ${e.name}Id`,
    !e.isRoot ? `parent_id: ${e.rootName}Id` : null,
    ...e.fields.map((f) => `${snake(f.name)}: ${renderPyType(f.type)}`),
    ...e.contains.map((c) => `${snake(c.name)}: ${containsType(c)}`),
  ].filter((s): s is string => s != null);
  const stateArgs = [
    "id=id",
    !e.isRoot ? "parent_id=parent_id" : null,
    ...e.fields.map((f) => `${snake(f.name)}=${snake(f.name)}`),
    ...e.contains.map((c) => `${snake(c.name)}=${snake(c.name)}`),
  ].filter((s): s is string => s != null);

  const ctor = [
    `    def __init__(self, *, ${stateParams.join(", ")}) -> None:`,
    `        self._id = id`,
    !e.isRoot ? `        self._parent_id = parent_id` : null,
    ...e.fields.map((f) => `        self._${snake(f.name)} = ${snake(f.name)}`),
    ...e.contains.map((c) => `        self._${snake(c.name)} = ${snake(c.name)}`),
    e.isRoot ? `        self._events: list[DomainEvent] = []` : null,
    `        self._assert_invariants()`,
  ].filter((s): s is string => s != null);

  const getters: string[] = [];
  const prop = (name: string, type: string, value: string): string[] => [
    "",
    "    @property",
    `    def ${name}(self) -> ${type}:`,
    `        return ${value}`,
  ];
  getters.push(...prop("id", `${e.name}Id`, "self._id"));
  if (!e.isRoot) {
    getters.push(...prop("parent_id", `${e.rootName}Id`, "self._parent_id"));
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
  if (e.derived.some((d) => d.name === "inspect")) {
    getters.push("", "    def __repr__(self) -> str:", "        return self.inspect");
  }

  const fns = e.functions.flatMap((fn) => {
    const params = ["self", ...fn.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`)];
    return [
      "",
      `    def _${snake(fn.name)}(${params.join(", ")}) -> ${renderPyType(fn.returnType)}:`,
      `        return ${renderPyExpr(fn.body)}`,
    ];
  });

  const ops = e.operations.flatMap((op) => {
    const prefix = op.visibility === "public" ? "" : "_";
    const params = ["self", ...op.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`)];
    const retType = op.returnType ? renderPyOperationReturnType(op.returnType) : "None";
    const body = renderPyStatements(op.statements);
    return [
      "",
      `    def ${prefix}${snake(op.name)}(${params.join(", ")}) -> ${retType}:`,
      ...(body.length > 0 ? [body] : []),
      // Void operations re-assert invariants on the way out; a returning
      // one ends in `return`, so the trailing assert would be unreachable.
      ...(op.returnType ? [] : ["        self._assert_invariants()"]),
    ];
  });

  const pullEvents = e.isRoot
    ? [
        "",
        "    def pull_events(self) -> list[DomainEvent]:",
        "        out = self._events",
        "        self._events = []",
        "        return out",
      ]
    : [];

  const invariantLines = e.invariants.flatMap((inv) => {
    const msg = JSON.stringify(`Invariant violated: ${inv.source}`);
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
    "    def _assert_invariants(self) -> None:",
    ...(invariantLines.length > 0 ? invariantLines : ["        pass"]),
  ];

  const createAlias = [
    "",
    "    @classmethod",
    `    def _create(cls, *, ${stateParams.join(", ")}) -> ${self}:`,
    `        return cls(${stateArgs.join(", ")})`,
  ];

  // Public `create(...)` factory — constructible roots only.  Inputs are
  // the wire create set (incl. optionals); server-owned fields seed.
  let createFactory: string[] = [];
  if (e.isRoot && e.hasCreate) {
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
    ...assertInvariants,
    ...createAlias,
    ...createFactory,
  );
}

/** Exception-less `or`-union returns get their proper variant classes in
 *  S12; the tagged dict the statement renderer emits types as
 *  `dict[str, object]` until then. */
function renderPyOperationReturnType(t: TypeIR): string {
  if (t.kind === "union") return "dict[str, object]";
  return renderPyType(t);
}
