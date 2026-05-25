// AST node factories for macro authors.
//
// Every factory:
//   - Constructs a well-formed AST node matching the Langium
//     production for that kind.
//   - Wires `$container`/`$containerProperty`/`$containerIndex` on
//     child nodes (the expander will set the outer node's container
//     when it splices the result into the host).
//   - Tags the produced node with an `$origin` token derived from
//     the active macro call site, so validator diagnostics on the
//     synthesised node can be rendered against the user's source.
//
// Authors never construct AST nodes by hand.  If a node shape isn't
// here, add a factory — the surface is intentionally narrow.

import type {
  Aggregate,
  AggregateMember,
  AssignOrCallStmt,
  Expression,
  IdType,
  LValue,
  MemberAccess,
  NamedDecl,
  NamedType,
  NameRef,
  Operation,
  Parameter,
  PrimitiveType,
  Property,
  Statement,
  TypeRef,
  UnaryExpr,
} from "../language/generated/ast.js";
import { isProperty } from "../language/generated/ast.js";
import {
  _currentOrigin,
  _setContainer,
  _tag,
  _withOrigin as _withOriginInternal,
  ORIGIN_PROP as ORIGIN_PROP_INTERNAL,
  originOf as originOfInternal,
} from "./factories-internals.js";

// ---------------------------------------------------------------------------
// Origin tagging — implementation lives in `factories-internals.ts`
// so the active-origin slot is a single shared cell across both this
// file and `ui-factories.ts`.  These re-exports keep the old import
// paths working (`originOf`, `ORIGIN_PROP`, `_withOrigin` are all
// already-public surface).
// ---------------------------------------------------------------------------

export const ORIGIN_PROP = ORIGIN_PROP_INTERNAL;
export const originOf = originOfInternal;
export const _withOrigin = _withOriginInternal;

const currentOrigin = _currentOrigin;
const tag = _tag;
const setContainer = _setContainer;

// ---------------------------------------------------------------------------
// Type-reference factories
// ---------------------------------------------------------------------------

/** A primitive type reference: `string`, `int`, `datetime`, etc.
 * Wraps the primitive in a `TypeRef` envelope as the parser does. */
export function primType(
  name: "bool" | "datetime" | "decimal" | "guid" | "int" | "long" | "money" | "string",
  opts: { array?: boolean; optional?: boolean } = {},
): TypeRef {
  const origin = currentOrigin();
  const prim: PrimitiveType = tag(
    { $type: "PrimitiveType", name } as unknown as PrimitiveType,
    origin,
  );
  const ref: TypeRef = tag(
    {
      $type: "TypeRef",
      base: prim,
      array: opts.array ?? false,
      optional: opts.optional ?? false,
    } as unknown as TypeRef,
    origin,
  );
  setContainer(prim, ref, "base");
  return ref;
}

/** An `Id<Target>` type reference.  `targetName` resolves through
 * Langium's standard cross-reference machinery once linked. */
export function idRef(
  targetName: string,
  opts: { array?: boolean; optional?: boolean } = {},
): TypeRef {
  const origin = currentOrigin();
  const idType: IdType = tag(
    {
      $type: "IdType",
      target: makeRef<NamedDecl>(targetName),
    } as unknown as IdType,
    origin,
  );
  const ref: TypeRef = tag(
    {
      $type: "TypeRef",
      base: idType,
      array: opts.array ?? false,
      optional: opts.optional ?? false,
    } as unknown as TypeRef,
    origin,
  );
  setContainer(idType, ref, "base");
  return ref;
}

/** A bare named-type reference: `Money`, `OrderStatus`. */
export function namedType(
  targetName: string,
  opts: { array?: boolean; optional?: boolean } = {},
): TypeRef {
  const origin = currentOrigin();
  const nt: NamedType = tag(
    { $type: "NamedType", target: makeRef<NamedDecl>(targetName) } as unknown as NamedType,
    origin,
  );
  const ref: TypeRef = tag(
    {
      $type: "TypeRef",
      base: nt,
      array: opts.array ?? false,
      optional: opts.optional ?? false,
    } as unknown as TypeRef,
    origin,
  );
  setContainer(nt, ref, "base");
  return ref;
}

// ---------------------------------------------------------------------------
// Aggregate-member factories
// ---------------------------------------------------------------------------

/** A property declaration on an aggregate, entity part, value
 * object, etc.  Lives inside the aggregate body once the expander
 * splices it in. */
export function field(name: string, type: TypeRef, opts: { provenanced?: boolean } = {}): Property {
  const origin = currentOrigin();
  const prop: Property = tag(
    {
      $type: "Property",
      name,
      type,
      provenanced: opts.provenanced ?? false,
    } as unknown as Property,
    origin,
  );
  setContainer(type, prop, "type");
  return prop;
}

/** A parameter on an operation. */
export function param(name: string, type: TypeRef): Parameter {
  const origin = currentOrigin();
  const p: Parameter = tag({ $type: "Parameter", name, type } as unknown as Parameter, origin);
  setContainer(type, p, "type");
  return p;
}

/** An operation declaration.  `body` is a (possibly empty) array
 * of statements.  Statement factories will be added when crudish
 * lands; for now, `operation(...)` with `body: []` is enough for
 * trait macros that only need to declare operations. */
export function operation(
  name: string,
  params: Parameter[],
  body: Statement[],
  opts: { private?: boolean; extern?: boolean; audited?: boolean } = {},
): Operation {
  const origin = currentOrigin();
  const op: Operation = tag(
    {
      $type: "Operation",
      name,
      params,
      body,
      private: opts.private ?? false,
      extern: opts.extern ?? false,
      audited: opts.audited ?? false,
    } as unknown as Operation,
    origin,
  );
  params.forEach((p, i) => setContainer(p, op, "params", i));
  body.forEach((s, i) => setContainer(s, op, "body", i));
  return op;
}

// ---------------------------------------------------------------------------
// Expression + statement factories
// ---------------------------------------------------------------------------
//
// Macro authors construct operation bodies as arrays of Statement
// AST nodes.  The factory set is intentionally narrow: only the
// shapes the stdlib macros (crudish first) actually need.  When a
// new macro needs a new statement/expression kind, add a focused
// factory here rather than letting authors construct nodes by hand
// — that's the only way origin metadata stays consistent across
// the synthesised subtree.

/** A bare `name` reference in an expression position.  Lowering
 * resolves it against the host's scope (params, fields, etc.)
 * just like a user-typed identifier. */
export function nameRef(name: string): NameRef {
  const origin = currentOrigin();
  return tag({ $type: "NameRef", name } as unknown as NameRef, origin);
}

/** A dotted member-access expression: `receiver.member`.  Used by
 * crudish to build `input.subject` from `input` + "subject".  `args`
 * is the empty array (no call) for property access; pass `call: true`
 * + args to construct a method invocation. */
export function memberAccess(
  receiver: Expression,
  member: string,
  opts: { call?: boolean; args?: Expression[] } = {},
): MemberAccess {
  const origin = currentOrigin();
  const args = opts.args ?? [];
  // CallArg wraps each call argument with an optional name; for a
  // simple positional call this is just an envelope.
  const callArgs = args.map((a) => {
    const node = { $type: "CallArg", value: a } as unknown as { $type: string; value: Expression };
    setContainer(a, node, "value");
    return node;
  });
  const ma: MemberAccess = tag(
    {
      $type: "MemberAccess",
      receiver,
      member,
      call: opts.call ?? false,
      args: callArgs,
    } as unknown as MemberAccess,
    origin,
  );
  setContainer(receiver, ma, "receiver");
  callArgs.forEach((c, i) => setContainer(c, ma, "args", i));
  return ma;
}

/** An assignment statement: `target := value`.  `target` is a flat
 * dotted lvalue head (e.g. `subject` or `this.subject`); pass tail
 * segments via `parts` when the assignment is to a nested member.
 * `value` may be any Expression. */
export function assignStmt(targetName: string, value: Expression): AssignOrCallStmt {
  return assignStmtPath([targetName], value);
}

/** An assignment to a dotted path: `head.tail1.tail2 := value`. */
export function assignStmtPath(path: string[], value: Expression): AssignOrCallStmt {
  if (path.length === 0) throw new Error("assignStmtPath requires at least one segment");
  const origin = currentOrigin();
  const lv: LValue = tag(
    {
      $type: "LValue",
      head: path[0]!,
      tail: path.slice(1),
      call: false,
      args: [],
    } as unknown as LValue,
    origin,
  );
  const stmt: AssignOrCallStmt = tag(
    {
      $type: "AssignOrCallStmt",
      target: lv,
      op: ":=",
      value,
    } as unknown as AssignOrCallStmt,
    origin,
  );
  setContainer(lv, stmt, "target");
  setContainer(value, stmt, "value");
  return stmt;
}

// ---------------------------------------------------------------------------
// Host introspection helpers
// ---------------------------------------------------------------------------
//
// Macros that need to inspect the host's existing members (crudish
// reads `target.fields` to know what to assign) go through these
// helpers rather than reaching into the raw AST.  Keeps the API
// surface focused and lets us evolve the host representation
// without breaking macro authors.

/** Plain Property declarations on the aggregate (excludes
 * containments, derived props, operations, entity parts, tests).
 * Lists user-declared fields plus any fields contributed by other
 * macros that ran before this one — call order is the `with`
 * clause's left-to-right order. */
export function targetFields(target: Aggregate): readonly Property[] {
  return (target.members ?? []).filter(isProperty);
}

/** Subset of `targetFields` excluding fields contributed by other
 * macros.  Useful for crudish-style macros that want to expose only
 * the user's own writable surface, ignoring macro-added bookkeeping
 * fields like createdAt/updatedAt/isDeleted.  Detection is by
 * presence of the macro-origin tag — fields without one are
 * user-written. */
export function writableUserFields(target: Aggregate): readonly Property[] {
  return targetFields(target).filter((f) => (f as any)[ORIGIN_PROP] === undefined);
}

// ---------------------------------------------------------------------------
// Cross-decl accessors — typed views over Module / BoundedContext
// members, computed on the fly.  Used by ui-targeted macros like
// `scaffold` to walk `mod.aggregates`, `ctx.workflows`, etc.  The
// raw AST has heterogeneous `members` arrays; these helpers do the
// per-type filtering once so macro authors don't reach into
// `$type` discriminators.
// ---------------------------------------------------------------------------

/** Aggregates declared inside a Module (across all its
 * BoundedContexts) or directly inside a BoundedContext. */
export function aggregatesIn(
  parent:
    | import("../language/generated/ast.js").Module
    | import("../language/generated/ast.js").BoundedContext,
): readonly Aggregate[] {
  if ((parent as any).$type === "Module") {
    const m = parent as import("../language/generated/ast.js").Module;
    return (m.contexts ?? []).flatMap(
      (c) => (c.members ?? []).filter((cm) => cm.$type === "Aggregate") as Aggregate[],
    );
  }
  const ctx = parent as import("../language/generated/ast.js").BoundedContext;
  return (ctx.members ?? []).filter((m) => m.$type === "Aggregate") as Aggregate[];
}

/** Workflows declared inside a Module / BoundedContext. */
export function workflowsIn(
  parent:
    | import("../language/generated/ast.js").Module
    | import("../language/generated/ast.js").BoundedContext,
): readonly import("../language/generated/ast.js").Workflow[] {
  type W = import("../language/generated/ast.js").Workflow;
  if ((parent as any).$type === "Module") {
    const m = parent as import("../language/generated/ast.js").Module;
    return (m.contexts ?? []).flatMap(
      (c) => (c.members ?? []).filter((cm) => cm.$type === "Workflow") as W[],
    );
  }
  const ctx = parent as import("../language/generated/ast.js").BoundedContext;
  return (ctx.members ?? []).filter((m) => m.$type === "Workflow") as W[];
}

/** Views declared inside a Module / BoundedContext. */
export function viewsIn(
  parent:
    | import("../language/generated/ast.js").Module
    | import("../language/generated/ast.js").BoundedContext,
): readonly import("../language/generated/ast.js").View[] {
  type V = import("../language/generated/ast.js").View;
  if ((parent as any).$type === "Module") {
    const m = parent as import("../language/generated/ast.js").Module;
    return (m.contexts ?? []).flatMap(
      (c) => (c.members ?? []).filter((cm) => cm.$type === "View") as V[],
    );
  }
  const ctx = parent as import("../language/generated/ast.js").BoundedContext;
  return (ctx.members ?? []).filter((m) => m.$type === "View") as V[];
}

// ---------------------------------------------------------------------------
// Small expression-tree helpers used by capability predicates.
// ---------------------------------------------------------------------------
//
// Capability factories (`contextFilter`, `contextStamp`) embed
// Loom AST expressions.  Authors build those via the existing
// factories (`memberAccess`, `nameRef`, `callExpr` from
// ui-factories) plus the helpers here.  All produce real Langium
// AST nodes (`UnaryExpr`, `NameRef`, etc.) that the IR layer
// lowers through `lowerExpr` after the linker runs.

/** Boolean negation: `!operand`.  Builds a `UnaryExpr` matching
 * the grammar's `(op='!' | op='-') operand=Expression` shape. */
export function not(operand: Expression): UnaryExpr {
  const origin = currentOrigin();
  const u: UnaryExpr = tag(
    { $type: "UnaryExpr", op: "!", operand } as unknown as UnaryExpr,
    origin,
  );
  setContainer(operand, u, "operand");
  return u;
}

/** Bare `this` reference.  Returns a real `ThisRef` AST node (not a
 * `NameRef("this")`) so it lowers to `{ kind: "this" }` via the
 * `isThisRef(expr)` branch in `lower-expr.ts:377`. */
export function thisRef(): import("../language/generated/ast.js").ThisRef {
  const origin = currentOrigin();
  return tag(
    { $type: "ThisRef" } as unknown as import("../language/generated/ast.js").ThisRef,
    origin,
  );
}

/** `null` literal.  Loom's grammar models this as a `NullLit` with
 * `value: 'null'` (`src/language/ddd.langium:897`); the lowerer
 * recognises it and emits `{ kind: "literal", lit: "null", value: "null" }`. */
export function nullLit(): import("../language/generated/ast.js").NullLit {
  const origin = currentOrigin();
  return tag(
    {
      $type: "NullLit",
      value: "null",
    } as unknown as import("../language/generated/ast.js").NullLit,
    origin,
  );
}

// String / boolean literals live in `ui-factories.ts` (they were
// added there first, for page menu metadata).  Re-export from
// `index.ts` keeps the public surface single-file.  Aggregate-side
// authors that need them just import from the macro-api index.

// ---------------------------------------------------------------------------
// Capability factories — produce real `FilterDecl` / `StampDecl` /
// `ImplementsDecl` AST nodes that the expander splices into the
// host's `members` array, exactly like Property / Operation.  No
// side table, no special bag mechanism — capabilities are first-
// class source members.  These factories are sugar over the same
// AST a user could hand-write inside an aggregate or context block.
// ---------------------------------------------------------------------------

type FilterDeclAst = import("../language/generated/ast.js").FilterDecl;
type StampDeclAst = import("../language/generated/ast.js").StampDecl;
type ImplementsDeclAst = import("../language/generated/ast.js").ImplementsDecl;

/** Construct a `filter <expr>` aggregate / context member.
 * Equivalent to writing `filter <expr>` directly in source.  Pass
 * `{ capability: "<name>" }` to emit the capability-scoped variant
 * (`filter for "<name>" <expr>`) — only applies to aggregates whose
 * `implements "<name>"` matches. */
export function contextFilter(
  predicate: Expression,
  opts: { capability?: string } = {},
): FilterDeclAst & AggregateMember {
  const origin = currentOrigin();
  const node: FilterDeclAst = tag(
    {
      $type: "FilterDecl",
      expr: predicate,
      ...(opts.capability !== undefined ? { capability: opts.capability } : {}),
    } as unknown as FilterDeclAst,
    origin,
  );
  setContainer(predicate, node, "expr");
  return node as unknown as FilterDeclAst & AggregateMember;
}

/** One field/value pair inside a `stamp onCreate { ... }` /
 * `stamp onUpdate { ... }` body. */
export interface ContextStampAssignment {
  readonly field: string;
  readonly value: Expression;
}

/** Construct one or two `stamp <event> { ... }` aggregate / context
 * members from the spec.  Each event with at least one assignment
 * yields a StampDecl AST node; the expander splices each separately.
 * Pass `{ capability: "<name>" }` to emit the capability-scoped
 * variant (`stamp for "<name>" <event>` — applies only to opt-ins). */
export function contextStamp(spec: {
  onCreate?: ContextStampAssignment[];
  onUpdate?: ContextStampAssignment[];
  capability?: string;
}): Array<StampDeclAst & AggregateMember> {
  const out: Array<StampDeclAst & AggregateMember> = [];
  if (spec.onCreate?.length) {
    out.push(buildStamp("onCreate", spec.onCreate, spec.capability));
  }
  if (spec.onUpdate?.length) {
    out.push(buildStamp("onUpdate", spec.onUpdate, spec.capability));
  }
  return out;
}

function buildStamp(
  event: "onCreate" | "onUpdate",
  assignments: ContextStampAssignment[],
  capability?: string,
): StampDeclAst & AggregateMember {
  const origin = currentOrigin();
  const stmts = assignments.map((a) => assignStmt(a.field, a.value));
  const node: StampDeclAst = tag(
    {
      $type: "StampDecl",
      event,
      assignments: stmts,
      ...(capability !== undefined ? { capability } : {}),
    } as unknown as StampDeclAst,
    origin,
  );
  stmts.forEach((s, i) => setContainer(s, node, "assignments", i));
  return node as unknown as StampDeclAst & AggregateMember;
}

/** Construct an `implements "<name>"` aggregate / context member —
 * opts the host into a capability group with the given name.
 * Generators translate the name by convention (.NET adds an
 * `I` prefix → `IAuditable`) and emit one shared infrastructure
 * block per name (e.g. one HasQueryFilter loop in OnModelCreating). */
export function implementsCapability(name: string): ImplementsDeclAst & AggregateMember {
  const origin = currentOrigin();
  const node: ImplementsDeclAst = tag(
    { $type: "ImplementsDecl", name } as unknown as ImplementsDeclAst,
    origin,
  );
  return node as unknown as ImplementsDeclAst & AggregateMember;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a Langium-style unresolved cross-reference.  Langium's
 * Linker phase resolves these against scope; until then, `ref` is
 * undefined and `$refText` carries the textual name. */
function makeRef<T>(name: string): { $refText: string; ref?: T } {
  return { $refText: name };
}
