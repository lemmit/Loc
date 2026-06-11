// -------------------------------------------------------------------------
// Domain-emit predicates + small helpers — pure classifiers (ref-collection,
// guarded-op, relationship-count derive), this/param/currentUser usage probes
// over the expr/stmt IR, the Ash built-in validation mapper, and naming.
// Leaf module: the resource renderers depend on these, never the reverse.
// -------------------------------------------------------------------------

import type {
  ContainmentIR,
  DerivedIR,
  ExprIR,
  OperationIR,
  StmtIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";

/** True for a field type that is a collection of references
 * (`Id<T>[]`) — persisted via a join table, not a column. */
export function isRefCollection(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "id";
}

// ---------------------------------------------------------------------------
// Ash domain emitter — per `AggregateIR` produce one `Ash.Resource` module.
//
// Output path:  lib/<app>/<ctx_snake>/<agg_snake>.ex
// Module name:  <AppModule>.<CtxModule>.<AggModule>
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Calculations (derived properties)
//
// Derives whose body is a bare `<relationship>.count` are lifted out of
// the `calculations` block into an Ash `aggregates` block — `Enum.count`
// isn't a primitive in Ash's expression DSL, but `count :<rel>` is.
// ---------------------------------------------------------------------------

export function isRelationshipCountDerive(d: DerivedIR, contains: ContainmentIR[]): string | null {
  const e = d.expr;
  if (e.kind !== "member" || e.member !== "count") return null;
  if (e.receiver.kind !== "ref") return null;
  if (e.receiver.refKind !== "this-prop") return null;
  const name = e.receiver.name;
  if (!contains.some((c) => c.name === name && c.collection)) return null;
  return name;
}

/** The `requires` guard expressions on an operation (authorization gates,
 *  distinct from `precondition` domain checks). */
export function operationGuards(op: OperationIR): ExprIR[] {
  return op.statements.filter((s) => s.kind === "requires").map((s) => s.expr);
}

/** True when the operation carries ≥1 `requires` authorization guard. */
export function isGuardedOperation(op: OperationIR): boolean {
  return op.statements.some((s) => s.kind === "requires");
}

/** Per-guarded-op SimpleCheck module name (e.g. `…Project.Checks.Rename`). */
export function policyCheckModule(resourceModule: string, op: OperationIR): string {
  return `${resourceModule}.Checks.${upperFirst(op.name)}`;
}

/** True when `e` references `this` (or the bare `id` keyword, which renders
 *  as `<thisName>.id`) or any `this-prop`-family field. */
export function exprUsesThis(e: ExprIR | undefined): boolean {
  if (!e) return false;
  if (e.kind === "this" || e.kind === "id") return true;
  if (
    e.kind === "ref" &&
    (e.refKind === "this-prop" || e.refKind === "this-vo-prop" || e.refKind === "this-derived")
  ) {
    return true;
  }
  if (e.kind === "call" && (e.callKind === "function" || e.callKind === "private-operation")) {
    // Receiver-prefixed function call passes `this` as first arg.
    return true;
  }
  return walkExpr(e, exprUsesThis);
}

/** True when the expr references a `this`-scoped field that is NOT a scalar
 *  attribute — a containment relationship (`pipelines`) or a derived
 *  calculation (`this-derived`).  Neither is materialised on a CREATE
 *  changeset's *applied attributes* (relationships are `%Ash.NotLoaded{}`,
 *  calcs aren't run), so an invariant touching one must read `changeset.data`
 *  rather than `Ash.Changeset.apply_attributes/2` — otherwise e.g.
 *  `Enum.count(record.pipelines)` raises on the NotLoaded relationship.
 *  `attrNames` is the resource's scalar-attribute set. */
export function exprRefsNonAttribute(
  e: ExprIR | undefined,
  attrNames: ReadonlySet<string>,
): boolean {
  if (!e) return false;
  if (e.kind === "ref" && e.refKind === "this-derived") return true;
  if (
    e.kind === "ref" &&
    (e.refKind === "this-prop" || e.refKind === "this-vo-prop") &&
    !attrNames.has(e.name)
  ) {
    return true;
  }
  return walkExpr(e, (c) => exprRefsNonAttribute(c, attrNames));
}

export function stmtUsesThis(s: StmtIR): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return exprUsesThis(s.expr);
    case "assign":
    case "add":
    case "remove":
    case "return":
      return exprUsesThis(s.value);
    case "emit":
      return s.fields.some((f) => exprUsesThis(f.value));
    case "call":
      // Receiver-prefixed call passes `this` as first arg.
      return true;
  }
}

export function stmtUsesCurrentUser(s: StmtIR): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return exprUsesCurrentUser(s.expr);
    case "assign":
    case "add":
    case "remove":
    case "return":
      return exprUsesCurrentUser(s.value);
    case "emit":
      return s.fields.some((f) => exprUsesCurrentUser(f.value));
    case "call":
      return s.args.some(exprUsesCurrentUser);
  }
}

function exprUsesParam(e: ExprIR | undefined, name: string): boolean {
  if (!e) return false;
  if (e.kind === "ref" && e.refKind === "param" && e.name === name) return true;
  return walkExpr(e, (sub) => exprUsesParam(sub, name));
}

export function stmtUsesParam(s: StmtIR, name: string): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return exprUsesParam(s.expr, name);
    case "assign":
    case "add":
    case "remove":
    case "return":
      return exprUsesParam(s.value, name);
    case "emit":
      return s.fields.some((f) => exprUsesParam(f.value, name));
    case "call":
      return s.args.some((a) => exprUsesParam(a, name));
  }
}

/** Walk one level into `e` and return true if `pred` matches any child. */
function walkExpr(e: ExprIR, pred: (sub: ExprIR | undefined) => boolean): boolean {
  switch (e.kind) {
    case "method-call":
      return pred(e.receiver) || e.args.some((a) => pred(a));
    case "member":
      return pred(e.receiver);
    case "binary":
      return pred(e.left) || pred(e.right);
    case "ternary":
      return pred(e.cond) || pred(e.then) || pred(e.otherwise);
    case "unary":
      return pred(e.operand);
    case "paren":
      return pred(e.inner);
    case "call":
      return e.args.some((a) => pred(a));
    case "lambda":
      return pred(e.body);
    case "new":
    case "object":
      return e.fields.some((f) => pred(f.value));
  }
  return false;
}

/** Map a recognised single-field pattern to an idiomatic Ash built-in
 *  validate call string (without trailing message), or null when no
 *  built-in covers the shape. */
export function ashBuiltinValidate(
  field: string,
  pattern: import("../../../ir/validate/invariant-classify.js").SingleFieldPattern,
): string | null {
  const attr = `:${snake(field)}`;
  switch (pattern.kind) {
    case "min":
      return `validate compare(${attr}, greater_than_or_equal_to: ${pattern.n})`;
    case "max":
      return `validate compare(${attr}, less_than_or_equal_to: ${pattern.n})`;
    case "between":
      return `validate compare(${attr}, greater_than_or_equal_to: ${pattern.lo}, less_than_or_equal_to: ${pattern.hi})`;
    case "len-min":
      return `validate string_length(${attr}, min: ${pattern.n})`;
    case "len-max":
      return `validate string_length(${attr}, max: ${pattern.n})`;
    case "len-eq":
      return `validate string_length(${attr}, min: ${pattern.n}, max: ${pattern.n})`;
    case "len-range":
      return `validate string_length(${attr}, min: ${pattern.lo}, max: ${pattern.hi})`;
    case "regex":
      return `validate match(${attr}, ~r/${pattern.pattern}/)`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function plural(name: string): string {
  if (name.endsWith("y") && !/[aeiou]y$/i.test(name)) {
    return name.slice(0, -1) + "ies";
  }
  if (/(s|x|z|ch|sh)$/i.test(name)) return name + "es";
  return name + "s";
}
