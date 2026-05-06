// ---------------------------------------------------------------------------
// Loom IR — semantic, platform-neutral representation of the DSL.
//
// The pipeline is:
//
//   .ddd source  ──parse──▶  Langium AST
//                                │
//                                ▼
//                            lowering
//                                │
//                                ▼
//                            Loom IR  (this file)
//                                │
//                                ▼
//                  per-platform shaping  (typescript-ir, dotnet-ir)
//                                │
//                                ▼
//                  procedural builders  ──▶  source files
//
// All implicit DDD plumbing — entity ids, parent FKs, name resolution of
// expression references, enum-value qualification, value-object constructor
// recognition, lambda parameter scoping — is fully resolved here so the
// per-platform layers only need to deal with naming conventions and the
// platform-specific shape of the surrounding code.
// ---------------------------------------------------------------------------

export type IdValueType = "guid" | "int" | "long" | "string";

export type PrimitiveName =
  | "int"
  | "long"
  | "decimal"
  | "string"
  | "bool"
  | "datetime"
  | "guid";

export type TypeIR =
  | { kind: "primitive"; name: PrimitiveName }
  | { kind: "id"; targetName: string; valueType: IdValueType }
  | { kind: "enum"; name: string }
  | { kind: "valueobject"; name: string }
  | { kind: "entity"; name: string }
  | { kind: "array"; element: TypeIR }
  | { kind: "optional"; inner: TypeIR };

export interface ParamIR {
  name: string;
  type: TypeIR;
}

export interface FieldIR {
  name: string;
  type: TypeIR;
  optional: boolean;
  /** True iff the source declared this property with the `display`
   * modifier.  At most one such field per aggregate (enforced by the
   * validator).  Used by the React generator to pick the option label
   * for `Id<X>` Selects pointing at this aggregate. */
  display?: boolean;
}

export interface ContainmentIR {
  name: string;
  partName: string;
  collection: boolean;
}

export interface DerivedIR {
  name: string;
  type: TypeIR;
  expr: ExprIR;
}

export interface InvariantIR {
  expr: ExprIR;
  guard?: ExprIR;
  source: string;
}

export interface FunctionIR {
  name: string;
  params: ParamIR[];
  returnType: TypeIR;
  body: ExprIR;
}

export interface OperationIR {
  name: string;
  visibility: "public" | "private";
  params: ParamIR[];
  statements: StmtIR[];
  /** When true, the body contains preconditions only — the
   * generator emits a wrapper that loads the aggregate, runs the
   * preconditions, dispatches to a user-supplied handler
   * (registered via DI on .NET, via a typed registry on TS),
   * persists, and drains pending events.  The aggregate class
   * itself does NOT get a method body for an extern operation;
   * the user owns the business decision. */
  extern: boolean;
}

export interface EntityPartIR {
  name: string;
  parentName: string;
  parentIdValueType: IdValueType;
  fields: FieldIR[];
  contains: ContainmentIR[];
  derived: DerivedIR[];
  invariants: InvariantIR[];
  functions: FunctionIR[];
  /** Canonical JSON-on-the-wire field list.  Populated by
   * `enrichLoomModel` after lowering; lowering itself leaves it
   * undefined so an unenriched IR is a type error to consume.
   * See `src/ir/enrichments.ts`. */
  wireShape?: WireField[];
}

/** One field in an aggregate / part / value object's canonical
 * wire shape.  See `src/ir/enrichments.ts`. */
export type WireFieldSource = "id" | "property" | "containment" | "derived";

export interface WireField {
  /** JSON key on the wire.  Stays as the user wrote it in the
   * `.ddd` source — backends that prefer PascalCase / camelCase
   * decide their own casing rule. */
  name: string;
  /** Domain-typed value the wire field carries.  For containment
   * collections, this is `array { element: entity { name } }`; for
   * single containments it's `entity { name }`. */
  type: TypeIR;
  /** True iff the source field was declared `T?`. */
  optional: boolean;
  /** Where the wire field came from in the IR. */
  source: WireFieldSource;
}

export interface AggregateIR {
  name: string;
  idValueType: IdValueType;
  fields: FieldIR[];
  contains: ContainmentIR[];
  derived: DerivedIR[];
  invariants: InvariantIR[];
  functions: FunctionIR[];
  operations: OperationIR[];
  parts: EntityPartIR[];
  tests: TestIR[];
  /** Canonical JSON-on-the-wire field list.  Populated by
   * `enrichLoomModel`. */
  wireShape?: WireField[];
}

export interface TestIR {
  name: string;
  statements: TestStmtIR[];
}

export type TestStmtIR =
  | StmtIR
  | { kind: "expect"; expr: ExprIR; source: string }
  | { kind: "expect-throws"; expr: ExprIR; source: string };

export interface EnumIR {
  name: string;
  values: string[];
}

export interface ValueObjectIR {
  name: string;
  fields: FieldIR[];
  derived: DerivedIR[];
  invariants: InvariantIR[];
  functions: FunctionIR[];
  /** Canonical wire-shape — no id, no containment, just declared
   * fields + derived. */
  wireShape?: WireField[];
}

export interface EventIR {
  name: string;
  fields: FieldIR[];
}

export interface FindIR {
  name: string;
  params: ParamIR[];
  returnType: TypeIR;
  /** Optional `where ...` filter expression in IR form. */
  filter?: ExprIR;
}

export interface RepositoryIR {
  name: string;
  aggregateName: string;
  finds: FindIR[];
}

export interface BoundedContextIR {
  name: string;
  enums: EnumIR[];
  valueObjects: ValueObjectIR[];
  events: EventIR[];
  aggregates: AggregateIR[];
  repositories: RepositoryIR[];
  workflows: WorkflowIR[];
  views: ViewIR[];
}

/** A saved, strongly-typed query over one source aggregate.  Slice
 *  1: parameterless, filter-only; result is the source aggregate's
 *  enriched wire shape (an array thereof).  Future slices add
 *  declared output shapes and joined sources.  Compiles to a
 *  per-view method on the source aggregate's repository plus a
 *  `GET /views/<snake_name>` route on each backend. */
export interface ViewIR {
  name: string;
  /** Source aggregate.  Must live in the same context as the
   *  view declaration. */
  aggregateName: string;
  /** Queryable predicate.  Always populated — the grammar
   *  requires `where`.  Subject to the same restrictions as
   *  repository find filters. */
  filter: ExprIR;
}

/** SQL-92 isolation levels — optional on `transactional` workflows.
 *  When omitted, the connection's default level applies (Postgres
 *  defaults to `readCommitted`). */
export type IsolationLevel =
  | "readUncommitted"
  | "readCommitted"
  | "repeatableRead"
  | "serializable";

/** Context-level orchestration that loads + creates aggregates,
 *  invokes their public operations, and emits orchestration-level
 *  events.  Default save semantics: each aggregate's save commits
 *  independently.  `transactional: true` wraps everything in one DB
 *  transaction. */
export interface WorkflowIR {
  name: string;
  params: ParamIR[];
  transactional: boolean;
  /** Set only when the source declared `transactional(<level>)`.
   *  Bare `transactional` leaves this undefined and the backend
   *  emits a transaction without an explicit level (connection
   *  default applies). */
  isolation?: IsolationLevel;
  statements: WorkflowStmtIR[];
  /** Computed at lowering: which let-bindings need a save call at
   *  workflow exit, in declaration order.  `Agg.create(...)` always
   *  saves; `Repo.getById(...)`/find saves only if a later op-call
   *  targets the binding. */
  savesAtExit: { name: string; aggName: string; repoName: string }[];
}

export type WorkflowStmtIR =
  | { kind: "precondition"; expr: ExprIR; source: string }
  | {
      kind: "emit";
      eventName: string;
      fields: { name: string; value: ExprIR }[];
    }
  | {
      kind: "factory-let";
      name: string;
      aggName: string;
      fields: { name: string; value: ExprIR }[];
    }
  | {
      kind: "repo-let";
      name: string;
      repoName: string;
      aggName: string;
      method: string;
      args: ExprIR[];
      returnType: TypeIR;
    }
  | {
      kind: "expr-let";
      name: string;
      type: TypeIR;
      expr: ExprIR;
    }
  | {
      kind: "op-call";
      target: string;
      aggName: string;
      op: string;
      args: ExprIR[];
    };

export interface LoomModel {
  /**
   * Explicit `system` declarations.  Each one is a complete deployment
   * plan with modules + deployables.
   */
  systems: SystemIR[];
  /**
   * Bounded contexts declared at the top level of the source file
   * (legacy single-deployable mode).  Empty when the source uses the
   * `system` vocabulary.  When non-empty, the CLI treats these as an
   * implicit anonymous system with one deployable of the platform
   * picked by the user.
   */
  contexts: BoundedContextIR[];
}

/** A deployment plan: modules grouping bounded contexts, plus the
 * deployable artefacts that ship subsets of those modules. */
export interface SystemIR {
  name: string;
  modules: ModuleIR[];
  deployables: DeployableIR[];
  e2eTests: TestE2EIR[];
}

/** End-to-end test that targets a running deployable. */
export interface TestE2EIR {
  name: string;
  /** "api" — typed-fetch HTTP test (default).  "ui" — Playwright
   * test driven through the auto-generated page objects in the
   * target react deployable's `e2e/pages/`. */
  kind: "api" | "ui";
  deployableName: string;
  statements: TestStmtIR[];
}

export interface ModuleIR {
  name: string;
  contexts: BoundedContextIR[];
}

export type Platform = "dotnet" | "hono" | "react";

export interface DeployableIR {
  name: string;
  platform: Platform;
  /** Names of modules included in this deployable.  For react frontends,
   * inherited from the targeted backend deployable. */
  moduleNames: string[];
  /** HTTP port the deployable's web server listens on. */
  port: number;
  /** Backend deployable this frontend talks to.  Set only when
   * platform === "react"; the frontend's API base URL is derived from
   * the target's port. */
  targetName?: string;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type StmtIR =
  | { kind: "precondition"; expr: ExprIR; source: string }
  | { kind: "let"; name: string; expr: ExprIR; type: TypeIR }
  | { kind: "assign"; target: PathIR; value: ExprIR; targetType: TypeIR }
  | { kind: "add"; target: PathIR; value: ExprIR; elementType: TypeIR }
  | { kind: "remove"; target: PathIR; value: ExprIR; elementType: TypeIR }
  | {
      kind: "emit";
      eventName: string;
      fields: { name: string; value: ExprIR }[];
    }
  | {
      kind: "call";
      target: "function" | "private-operation";
      name: string;
      args: ExprIR[];
    }
  /**
   * Bare expression-statement.  Used when a chained call like
   * `a.b.c(args)` appears as an operation- or test-body statement.
   * Renderers emit `<expr>;` (TS / e2e) or `<expr>;` (C#).
   */
  | { kind: "expression"; expr: ExprIR };

/**
 * A path used as the LHS of an assignment / collection mutation.  All
 * paths are rooted in `this` (the enclosing aggregate).  The first
 * segment is the property/containment name on the root; subsequent
 * segments walk into nested structure.  Paths never reference parameters
 * or let-bindings (those are not assignable in Loom).
 */
export interface PathIR {
  segments: string[];
}

// ---------------------------------------------------------------------------
// Expressions — fully resolved, every name has a kind tag.
// ---------------------------------------------------------------------------

export type LiteralKind = "string" | "int" | "decimal" | "bool" | "null" | "now";

export type RefKind =
  | "param"
  | "let"
  | "lambda"
  | "this-prop"           // entity field (private _name with public getter)
  | "this-vo-prop"        // value-object public readonly field
  | "this-derived"
  | "helper-fn"
  | "enum-value"
  | "unknown";

export type CallKind =
  | "function"            // calls a `function` declared in scope
  | "value-object-ctor"   // calls a value-object constructor
  | "private-operation"   // calls a private operation
  | "free";               // unresolved free call

export type BinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "&&"
  | "||";

export type ExprIR =
  | { kind: "literal"; lit: LiteralKind; value: string }
  | { kind: "this" }
  | { kind: "id" }
  | {
      kind: "ref";
      name: string;
      refKind: RefKind;
      enumName?: string;
      type?: TypeIR;
    }
  | {
      kind: "member";
      receiver: ExprIR;
      member: string;
      receiverType: TypeIR;
      memberType: TypeIR;
    }
  | {
      kind: "method-call";
      receiver: ExprIR;
      member: string;
      args: ExprIR[];
      receiverType: TypeIR;
      isCollectionOp: boolean;
    }
  | {
      kind: "call";
      callKind: CallKind;
      name: string;
      args: ExprIR[];
    }
  | { kind: "lambda"; param: string; body: ExprIR }
  | {
      kind: "new";
      partName: string;
      fields: { name: string; value: ExprIR }[];
    }
  | {
      kind: "object";
      fields: { name: string; value: ExprIR }[];
    }
  | { kind: "paren"; inner: ExprIR }
  | { kind: "unary"; op: "-" | "!"; operand: ExprIR }
  | { kind: "binary"; op: BinOp; left: ExprIR; right: ExprIR }
  | { kind: "ternary"; cond: ExprIR; then: ExprIR; otherwise: ExprIR };

// Convenience constructors used by the lowering layer.
export const lit = (
  kind: LiteralKind,
  value: string,
): ExprIR => ({ kind: "literal", lit: kind, value });

// ---------------------------------------------------------------------------
// Workspace traversal helpers — dedupe the systems-vs-contexts dual
// iteration that every consumer (validator, system orchestrator,
// wire-spec emitter) had to spell out.  A `LoomModel` carries
// bounded contexts in two places: under each system's modules, and
// at the top level (legacy single-deployable mode).  These helpers
// flatten both into a single iterator.
// ---------------------------------------------------------------------------

/** Every bounded context in the model — system-bundled + top-level. */
export function allContexts(loom: LoomModel): BoundedContextIR[] {
  const out: BoundedContextIR[] = [];
  for (const sys of loom.systems) {
    for (const m of sys.modules) out.push(...m.contexts);
  }
  out.push(...loom.contexts);
  return out;
}

/** Every aggregate in the model, regardless of which context owns it. */
export function allAggregates(loom: LoomModel): AggregateIR[] {
  return allContexts(loom).flatMap((c) => c.aggregates);
}
