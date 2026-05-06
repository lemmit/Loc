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
    Module | Deployable | BoundedContext | TestE2E;

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
        contexts+=BoundedContext*
    '}';

Deployable:
    'deployable' name=ID '{'
        ('platform' ':' platform=Platform ','?)
        ('modules' ':' modules+=[Module:ID] (',' modules+=[Module:ID])* ','?)?
        ('targets' ':' targets=[Deployable:ID] ','?)?
        ('port' ':' port=INT ','?)?
    '}';

Platform returns string:
    'dotnet' | 'hono' | 'react';

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

BoundedContext:
    'context' name=ID '{'
        members+=ContextMember*
    '}';

ContextMember:
    EnumDecl | ValueObject | Aggregate | EventDecl | Repository | Workflow;

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
        (transactional?='transactional')?
    '{'
        body+=Statement*
    '}';

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
  | LetStmt
  | EmitStmt
  | AssignOrCallStmt;

PreconditionStmt:
    'precondition' expr=Expression;

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

// Accept `id` and `this` (otherwise reserved as primary-expression
// keywords) as ordinary member names — `prod.id`, `agg.this` (rare but
// allowed) parse without surprises.
MemberName returns string:
    ID | 'id';

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

NameRef:
    name=ID;

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
