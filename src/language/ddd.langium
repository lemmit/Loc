grammar Ddd

entry Model:
    contexts+=BoundedContext*;

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

BoundedContext:
    'context' name=ID '{'
        members+=ContextMember*
    '}';

ContextMember:
    EnumDecl | ValueObject | Aggregate | EventDecl | Repository;

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

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

Property:
    name=ID ':' type=TypeRef;

Containment:
    'contains' name=ID ':' partType=[EntityPart:ID] (collection?='[]')?;

DerivedProp:
    'derived' name=ID ':' type=TypeRef '=' expr=Expression;

Invariant:
    'invariant' expr=Expression ('when' guard=Expression)?;

FunctionDecl:
    'function' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' ':' returnType=TypeRef '=' body=Expression;

Operation:
    (private?='private')? 'operation' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' '{'
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
        {infer MemberAccess.receiver=current} '.' member=ID
          ( call?='(' (args+=Expression (',' args+=Expression)*)? ')' )?
      | {infer CallExpr.callee=current} '(' (args+=Expression (',' args+=Expression)*)? ')'
    )*;

Lambda:
    param=ID '=>' body=Expression;

PrimaryExpr infers Expression:
      Lambda
    | NewExpr
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
