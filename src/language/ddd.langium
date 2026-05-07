grammar Ddd

entry Model:
    members+=ModelMember*;

ModelMember:
    System | BoundedContext;

// ---------------------------------------------------------------------------
// System / Module / Deployable — the deployment shape.
//
// A `system` is the top-level grouping for a deployment plan.  Inside it,
// `module`s collect related bounded contexts; `deployable`s pick a
// platform and a subset of modules to ship as a runnable artefact.
// Bare `context` declarations at the top of the file are still valid
// (legacy single-deployable mode) and are treated as living in an
// implicit anonymous system.
// ---------------------------------------------------------------------------

System:
    'system' name=ID '{'
        members+=SystemMember*
    '}';

SystemMember:
    Module | Deployable | BoundedContext | TestE2E | UserBlock;

// System-level user shape — declares the strongly-typed claim record
// that backends decode JWT tokens into.  At most one per system
// (validator enforces).  Fields use the standard `name: TypeRef`
// vocabulary.  Backends with `auth: required` deployables emit a User
// type + verifier hook + middleware; the `currentUser` magic
// identifier in expression bodies is typed against this shape.
//
// We use `UserField` rather than `Property` so the canonical JWT
// claim name `id` (which is otherwise a reserved keyword for the
// implicit aggregate identity) is admissible here.
UserBlock:
    'user' '{'
        fields+=UserField*
    '}';

UserField:
    name=UserFieldName ':' type=TypeRef;

UserFieldName returns string:
    ID | 'id' | 'permissions';

// E2E test against a running deployable.  The body reuses the per-
// aggregate TestStatement vocabulary (let / expect / expectThrows /
// bare-call), but expressions can additionally reference the magic
// `api` identifier rooted at the named deployable's HTTP surface
// (e.g., `api.orders.create({...})`).  Renders to a vitest test file
// at the system output root.
TestE2E:
    'test' 'e2e' name=STRING 'against' deployable=[Deployable:ID] '{'
        body+=TestStatement*
    '}';

Module:
    'module' name=ID '{'
        (contexts+=BoundedContext | permissions+=PermissionsBlock)*
    '}';

// Per-module permission catalogue.  Each declaration becomes a typed
// identifier (`permissions.<name>`) usable in operation / workflow /
// view-bind expressions; lowering rewrites the reference to its
// runtime string `<lowercase-module>.<name>` so handlers can compare
// against `currentUser.permissions: string[]` claims without
// hand-spelling the strings.  Multiple `permissions { ... }` blocks
// in one module merge their declarations.
PermissionsBlock:
    'permissions' '{'
        (decls+=PermissionDecl (',' decls+=PermissionDecl)* ','?)?
    '}';

PermissionDecl:
    name=ID;

Deployable:
    'deployable' name=ID '{'
        ('platform' ':' platform=Platform ','?)
        ('modules' ':' modules+=[Module:ID] (',' modules+=[Module:ID])* ','?)?
        ('targets' ':' targets=[Deployable:ID] ','?)?
        ('port' ':' port=INT ','?)?
        ('auth' ':' auth=AuthMode ','?)?
    '}';

Platform returns string:
    'dotnet' | 'hono' | 'react';

// Per-deployable auth opt-in.  `required` enables JWT-decode middleware
// and the user-supplied verifier hook.  Absence keeps the deployable
// open (existing behaviour).  Future modes (`optional`, `forbidden`)
// can extend the union without touching consumers.
AuthMode returns string:
    'required';

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

BoundedContext:
    'context' name=ID '{'
        members+=ContextMember*
    '}';

ContextMember:
    EnumDecl | ValueObject | Aggregate | EventDecl | Repository | Workflow | View;

EnumDecl:
    'enum' name=ID '{'
        values+=EnumValue (',' values+=EnumValue)* ','?
    '}';

EnumValue:
    name=ID;

ValueObject:
    'valueobject' name=ID '{'
        members+=ValueObjectMember*
    '}';

ValueObjectMember:
    Property | DerivedProp | Invariant | FunctionDecl;

Aggregate:
    'aggregate' name=ID ('ids' idKind=IdKind)? '{'
        members+=AggregateMember*
    '}';

IdKind returns string:
    'guid' | 'int' | 'long' | 'string';

AggregateMember:
    Containment | DerivedProp | Invariant | FunctionDecl | Operation | EntityPart | TestBlock | Property;

TestBlock:
    'test' name=STRING '{'
        body+=TestStatement*
    '}';

TestStatement:
    ExpectThrowsStmt | ExpectStmt | PreconditionStmt | LetStmt | EmitStmt | AssignOrCallStmt;

ExpectStmt:
    'expect' expr=Expression;

ExpectThrowsStmt:
    'expectThrows' expr=Expression;

EntityPart:
    'entity' name=ID '{'
        members+=EntityPartMember*
    '}';

EntityPartMember:
    Containment | DerivedProp | Invariant | FunctionDecl | Property;

EventDecl:
    'event' name=ID '{'
        (fields+=Property (',' fields+=Property)* ','?)?
    '}';

Repository:
    'repository' name=ID 'for' aggregate=[Aggregate:ID] '{'
        finds+=FindDecl*
    '}';

FindDecl:
    'find' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' ':' returnType=TypeRef
        ('where' filter=Expression)?;

// Workflow — context-level orchestration of multiple aggregates.  The
// body reuses operation-body Statement rules (precondition, let, emit,
// call) but the validator restricts mutation forms (`:=`, `+=`, `-=`)
// to operation bodies only.  See docs/workflow.md for semantics.
Workflow:
    'workflow' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')'
        (transactional?='transactional' ('(' isolation=IsolationLevel ')')?)?
    '{'
        body+=Statement*
    '}';

// SQL-92 isolation levels.  Optional on `transactional`; default
// (when omitted) uses the database connection's configured level
// (Postgres = read committed; SQL Server = read committed).
IsolationLevel returns string:
    'readUncommitted' | 'readCommitted' | 'repeatableRead' | 'serializable';

// View — a saved, strongly-typed query over one source aggregate.
// Two forms share the same head:
//
//   Shorthand (slice 1):
//     view ActiveOrders = Order where status == Confirmed
//     Result shape = source aggregate's existing wire shape.
//
//   Full form (slice 2):
//     view OrderSummary {
//       orderId: Id<Order>
//       lineCount: int
//       from Order where status != Cancelled
//       bind orderId = id, lineCount = lines.count
//     }
//     Output shape declared as fields, each backed by a typed
//     bind expression evaluated against the source aggregate.
//
// See docs/views.md for the full surface.
View:
    'view' name=ID
    (
        '=' source=[Aggregate:ID] 'where' filter=Expression
      | '{'
            fields+=Property*
            'from' source=[Aggregate:ID]
            ('where' filter=Expression)?
            'bind' binds+=BindEntry (',' binds+=BindEntry)* ','?
        '}'
    );

BindEntry:
    name=ID '=' expr=Expression;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

Property:
    name=ID ':' type=TypeRef (display?='display')?;

Containment:
    'contains' name=ID ':' partType=[EntityPart:ID] (collection?='[]')?;

DerivedProp:
    'derived' name=ID ':' type=TypeRef '=' expr=Expression;

Invariant:
    'invariant' expr=Expression ('when' guard=Expression)?;

FunctionDecl:
    'function' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' ':' returnType=TypeRef '=' body=Expression;

Operation:
    (private?='private')? 'operation' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' (extern?='extern')? '{'
        body+=Statement*
    '}';

Parameter:
    name=ID ':' type=TypeRef;

// ---------------------------------------------------------------------------
// Type references
// ---------------------------------------------------------------------------

TypeRef:
    base=BaseType (array?='[]')? (optional?='?')?;

BaseType:
    PrimitiveType | IdType | NamedType;

PrimitiveType:
    name=('int' | 'long' | 'decimal' | 'string' | 'bool' | 'datetime' | 'guid');

IdType:
    'Id' '<' target=[NamedDecl:ID] '>';

NamedType:
    target=[NamedDecl:ID];

type NamedDecl = Aggregate | EntityPart | EnumDecl | ValueObject;

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

Statement:
    PreconditionStmt
  | RequiresStmt
  | LetStmt
  | EmitStmt
  | AssignOrCallStmt;

PreconditionStmt:
    'precondition' expr=Expression;

// Authorization gate.  Semantically `requires` reads as "this caller
// is allowed to invoke this op / workflow" — a declarative
// authorization check that maps to HTTP 403, distinct from
// `precondition` (a domain validity check that maps to 400).  The
// expression types to bool exactly like `precondition`; failure
// short-circuits the body and surfaces as ForbiddenException (.NET)
// / ForbiddenError (TS).  See docs/auth.md.
RequiresStmt:
    'requires' expr=Expression;

LetStmt:
    'let' name=ID '=' expr=Expression;

EmitStmt:
    'emit' event=[EventDecl:ID] '{'
        (fields+=EmitField (',' fields+=EmitField)* ','?)?
    '}';

EmitField:
    name=ID ':' value=Expression;

// Combined assignment / call statement.  We parse an LValue first, then
// optionally consume a mutation suffix.  Without a suffix the LValue
// must contain a call — i.e. it is a bare invocation as a statement.
AssignOrCallStmt:
    target=LValue (
        op=':=' value=Expression
      | op='+=' value=Expression
      | op='-=' value=Expression
    )?;

LValue:
    head=ID ('.' tail+=ID)*
      (call?='(' (args+=Expression (',' args+=Expression)*)? ')')?;

// ---------------------------------------------------------------------------
// Expressions (precedence climbing, lowest to highest)
// ---------------------------------------------------------------------------

Expression:
    TernaryExpr;

TernaryExpr infers Expression:
    OrExpr ({infer TernaryExpr.condition=current} '?' thenExpr=Expression ':' elseExpr=Expression)?;

OrExpr infers Expression:
    AndExpr ({infer BinaryExpr.left=current} op='||' right=AndExpr)*;

AndExpr infers Expression:
    EqualityExpr ({infer BinaryExpr.left=current} op='&&' right=EqualityExpr)*;

EqualityExpr infers Expression:
    ComparisonExpr ({infer BinaryExpr.left=current} op=('=='|'!=') right=ComparisonExpr)*;

ComparisonExpr infers Expression:
    AdditiveExpr ({infer BinaryExpr.left=current} op=('<='|'>='|'<'|'>') right=AdditiveExpr)*;

AdditiveExpr infers Expression:
    MultiplicativeExpr ({infer BinaryExpr.left=current} op=('+'|'-') right=MultiplicativeExpr)*;

MultiplicativeExpr infers Expression:
    UnaryExpr ({infer BinaryExpr.left=current} op=('*'|'/'|'%') right=UnaryExpr)*;

UnaryExpr infers Expression:
    {infer UnaryExpr} op=('!'|'-') operand=PostfixExpr
  | PostfixExpr;

PostfixExpr infers Expression:
    PrimaryExpr (
        {infer MemberAccess.receiver=current} '.' member=MemberName
          ( call?='(' (args+=Expression (',' args+=Expression)*)? ')' )?
      | {infer CallExpr.callee=current} '(' (args+=Expression (',' args+=Expression)*)? ')'
    )*;

// Accept reserved keywords (`id`, `permissions`, `contains`) as
// ordinary member names so `prod.id`, `currentUser.permissions`,
// `someArray.contains(x)` parse cleanly.  The magic-identifier
// resolution / collection-op dispatch lives in the lowering
// (lower-expr.ts + type-system.ts) rather than the grammar.
MemberName returns string:
    ID | 'id' | 'permissions' | 'contains';

Lambda:
    param=ID '=>' body=Expression;

PrimaryExpr infers Expression:
      Lambda
    | NewExpr
    | ObjectLit
    | ParenExpr
    | LiteralExpr
    | NowExpr
    | ThisRef
    | IdRef
    | NameRef;

NewExpr:
    'new' partType=[EntityPart:ID] '{'
        (fields+=ObjectFieldInit (',' fields+=ObjectFieldInit)* ','?)?
    '}';

// Bare object literal — used inside e2e test bodies to build request
// payloads (`api.orders.create({ customerId: "..." })`).  Distinct
// from `new PartName {…}`: no aggregate / part type binding, no
// invariant checks; it is a structural literal that the e2e renderer
// hands straight to JSON.stringify.
ObjectLit:
    '{' (fields+=ObjectFieldInit (',' fields+=ObjectFieldInit)* ','?)? '}';

ObjectFieldInit:
    name=ID ':' value=Expression;

ParenExpr:
    '(' inner=Expression ')';

LiteralExpr:
      {infer StringLit} value=STRING
    | {infer IntLit}    value=INT
    | {infer DecLit}    value=DECIMAL
    | {infer BoolLit}   value=('true'|'false')
    | {infer NullLit}   value='null';

NowExpr:
    {infer NowExpr} 'now' '(' ')';

ThisRef:
    {infer ThisRef} 'this';

IdRef:
    {infer IdRef} 'id';

// `name` accepts `permissions` as a soft keyword so an expression
// can use it as the receiver of a member access (`permissions.foo`).
// The `permissions { ... }` block keeps the keyword form because the
// surrounding `module { ... }` context disambiguates.
NameRef:
    name=NameRefIdent;

NameRefIdent returns string:
    ID | 'permissions';

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

hidden terminal WS: /\s+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;

terminal STRING: /"(\\.|[^"\\])*"/;
terminal DECIMAL: /[0-9]+\.[0-9]+/;
terminal INT returns number: /[0-9]+/;
terminal ID: /[_a-zA-Z][\w_]*/;
