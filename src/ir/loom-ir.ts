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
//                  Handlebars templates  ──▶  source files
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
}

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
}

export interface EventIR {
  name: string;
  fields: FieldIR[];
}

export interface FindIR {
  name: string;
  params: ParamIR[];
  returnType: TypeIR;
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
}

export interface LoomModel {
  contexts: BoundedContextIR[];
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
    };

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
  | { kind: "paren"; inner: ExprIR }
  | { kind: "unary"; op: "-" | "!"; operand: ExprIR }
  | { kind: "binary"; op: BinOp; left: ExprIR; right: ExprIR }
  | { kind: "ternary"; cond: ExprIR; then: ExprIR; otherwise: ExprIR };

// Convenience constructors used by the lowering layer.
export const lit = (
  kind: LiteralKind,
  value: string,
): ExprIR => ({ kind: "literal", lit: kind, value });
