grammar Ddd

entry Model:
    members+=ModelMember*;

ModelMember:
    System | BoundedContext | Requirement | Solution | TestCase;

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
    Module | Deployable | BoundedContext | TestE2E | UserBlock | ThemeBlock | Ui | Api | Storage;

// System-level visual identity — design tokens consumed by every
// React deployable in this system.  Tokens are intentionally
// framework-agnostic ("primary"/"neutral"/"radius"/"fontFamily")
// so the Mantine emitter today and a future shadcn/ui emitter
// translate the same source declaration.  The validator enforces
// known property names, valid hex colours, the radius enum, and
// no duplicates.  At most one `theme { ... }` per system.
ThemeBlock:
    'theme' '{'
        props+=ThemeProp*
    '}';

ThemeProp:
    name=LooseName ':' value=STRING;

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
    'test' 'e2e' name=STRING 'against' deployable=[Deployable:LooseName]
        ('verifies' verifies=[TestCase:TraceId])? '{'
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
    'deployable' name=LooseName '{'
        ('platform' ':' platform=Platform ','?)
        // Slice 11.27 — modules can carry per-module storage role
        // bindings.  Two surface forms:
        //   modules: Sales, Marketing                            // bare list (legacy)
        //   modules: Sales { primary: pg, cache: redis },        // per-module storage map
        //            Marketing { primary: pg }
        ('modules' ':' moduleBindings+=ModuleBinding (',' moduleBindings+=ModuleBinding)* ','?)?
        ('targets' ':' targets=[Deployable:LooseName] ','?)?
        // Slice 11.26 — explicit api composition.  Backend deployables
        // declare which contracts they serve via `serves:`.  Frontend
        // composition is per-ui-parameter via the `ui: WebApp { … }`
        // compose-block (see UiComposeBinding below): each UI api
        // parameter is bound by name to the backend deployable that
        // supplies it.
        ('serves' ':' serves+=[Api:ID] (',' serves+=[Api:ID])* ','?)?
        // UI binding — references a `ui { ... }` block at system scope.
        // Three surface forms:
        //   ui: WebApp                            // sugar — no params
        //   ui: WebApp { Sales: salesApi, ... }   // compose-block — per-param backend bindings
        //   ui WebApp { framework: react }        // legacy block form, framework override
        // Validator (Slice 3 + 11.26) ensures the referenced ui exists,
        // the deployable's platform supports a UI mount, the framework
        // value is one of the v0 allowed values, and every UI api
        // parameter has a binding when the UI declares any.
        (uiSugar=UiSugarBinding | uiCompose=UiComposeBinding | uiBlock=UiBlockBinding)?
        ('port' ':' port=INT ','?)?
        ('auth' ':' auth=AuthMode ','?)?
        ('design' ':' design=DesignPack ','?)?
    '}';

// Slice 11.26 — frontend composition.  `ui: WebApp { Sales: salesApi
// }` binds each UI api parameter (the `Sales` declared as `api Sales:
// SalesApi` in the ui block) to the backend deployable that supplies
// that contract.  Validator enforces that `salesApi.serves: SalesApi`.
UiComposeBinding:
    'ui' ':' ref=[Ui:ID] '{'
        (bindings+=UiParamBinding (',' bindings+=UiParamBinding)* ','?)?
    '}';

UiParamBinding:
    name=LooseName ':' source=[Deployable:LooseName];

// Slice 11.27 — `modules:` entry on a backend deployable.  Bare
// form (`Sales`) for backward compat; brace form (`Sales { primary:
// pg, cache: redis }`) binds storage instances to the module's
// roles.  Validator (Slice 11.27) enforces that role names are in
// the v0 enum and storage refs resolve.
ModuleBinding:
    name=[Module:ID] ('{' (storages+=ModuleStorageBinding (',' storages+=ModuleStorageBinding)* ','?)? '}')?;

ModuleStorageBinding:
    role=ModuleStorageRole ':' storage=[Storage:LooseName];

ModuleStorageRole returns string:
    'primary' | 'cache' | 'search' | 'events' | 'bi';

UiSugarBinding:
    'ui' ':' ref=[Ui:ID] ','?;

UiBlockBinding:
    'ui' ref=[Ui:ID] '{'
        ('framework' ':' framework=Framework ','?)?
    '}';

// Frameworks the `ui:` mount lowers against.  `react` renders TSX
// against a design pack (`mantine`/`shadcn`); `phoenixLiveView`
// renders HEEx against the `ashPhoenix` pack as part of a fullstack
// Elixir/Ash deployable.  Future values (`blazor-wasm`,
// `blazor-server`, …) extend this enum when their codegen backends
// land.
Framework returns string:
    'react' | 'phoenixLiveView';

// Backend platforms accept a quoted `family@version` pin
// (`platform: "hono@v4"`) via the STRING alternative — symmetric
// with `DesignPack` below.  Bareword keywords are unchanged so
// every existing source parses identically; the validator + lowering
// (`parseBuiltinPlatformRef`) are the resolution authority.
Platform returns string:
    'dotnet' | 'hono' | 'react' | 'static' | 'phoenixLiveView' | STRING;

// Design-system pack selector — picks the template pack the UI
// generator renders pages against.  `mantine` (default), `shadcn`,
// and `mui` are React/TSX packs; `ashPhoenix` is the HEEx pack for
// the Phoenix LiveView platform.  STRING points at a custom pack:
// a directory with `pack.json` resolved relative to the .ddd file.
// Only meaningful when the deployable mounts a UI; ignored
// otherwise.  Named `design` (not `ui`) to avoid colliding with
// the test-DSL's `ui.workflows.X(...)` accessor.
DesignPack returns string:
    'mantine' | 'shadcn' | 'mui' | 'chakra' | 'ashPhoenix' | STRING;
// Per-deployable auth opt-in.  `required` enables JWT-decode middleware
// and the user-supplied verifier hook.  Absence keeps the deployable
// open (existing behaviour).  Future modes (`optional`, `forbidden`)
// can extend the union without touching consumers.
AuthMode returns string:
    'required';

// ---------------------------------------------------------------------------
// Page metamodel (Slice 1)
//
// `ui` is a SystemMember peer to `module` / `deployable` / `theme` /
// `user`.  It owns pages, components, scaffold directives, and an
// optional sidebar menu.  See docs/page-metamodel.md for the full
// surface.  Six new declaration keywords are introduced:
//   ui, page, component, scaffold, state, menu
// Plus two expression-level reserved tokens (later in the grammar):
//   match, else
//
// `section` and `link` inside `menu`, and `framework` inside the
// deployable ui-block binding, are soft keywords scoped to their
// parent block — they remain free as ordinary identifiers elsewhere.
// ---------------------------------------------------------------------------

Ui:
    'ui' name=ID '{'
        members+=UiMember*
    '}';

UiMember:
    UiApiParam | UiHelperImport | Page | Component | Scaffold | MenuBlock;

// ---- helper import (UI-level) ----------------------------------
//
// Surfaces a user-authored TS helper into the walker stdlib so a
// page body can reference `<name>(args…)` and the emitted page
// TSX gets a matching `import { <name> } from "<path>";` at the
// top.  Paths are emitted verbatim and are resolved against the
// generated page's source location (typically `web/src/pages/`),
// so `"./helpers/x"` resolves to `web/src/pages/helpers/x.ts`.
//
//   import helper formatPrice from "./helpers/price"
//
// Validator rejects names that shadow walker stdlib primitives so
// helper authors never silently override `Stack` / `Form` / etc.
UiHelperImport:
    'import' 'helper' name=ID 'from' path=STRING;

// ---- api declaration (system-level) ----------------------------
//
// First-class API contract derived from a module's domain (its
// aggregates, repositories, workflows, views).  v0: full surface
// auto-derived from `from <Module>`; future: customization
// (hide, rename, expose subset, version).
//
//   api SalesApi from Sales
//
// Peer to module / ui / deployable.  Pure declarative — what's
// available; consumers (ui, deployable) reference it by name.
Api:
    'api' name=ID 'from' source=[Module:ID];

// ---- storage declaration (system-level) ------------------------
//
// First-class declaration of a storage instance — a typed slot
// the deployable composition picks up via `modules: <M> { primary:
// <Storage>, cache: <Storage>, ... }`.  Reusable across deployables
// (one Postgres serves the api server + worker service).
//
//   storage primarySql   { type: postgres }
//   storage hotCache     { type: redis }
//   storage warehouse    { type: clickhouse }
//
// v0 type enum: postgres | mysql | sqlite | inMemory (transactional
// stores); redis (cache); elastic | meilisearch (search); kafka
// (events); clickhouse | bigquery (analytics).  Only postgres /
// inMemory have generator-side support; the rest parse + validate
// but emit nothing yet.
Storage:
    'storage' name=LooseName '{'
        ('type' ':' type=StorageType ','?)
    '}';

StorageType returns string:
      'postgres' | 'mysql' | 'sqlite' | 'inMemory'
    | 'redis'
    | 'elastic' | 'meilisearch'
    | 'kafka'
    | 'clickhouse' | 'bigquery';

// ---- ui api parameter ------------------------------------------
//
// UI-scope api dependency declaration with a local handle.  The
// local name (e.g. `Sales`) is what page bodies use to reference
// operations: `Sales.Customer.all.data`, `Sales.Customer.create.mutate(...)`.
// The deployable composition supplies the binding (which backend
// deployable serves the api).
//
//   api Sales: SalesApi
UiApiParam:
    'api' name=ID ':' apiRef=[Api:ID];

// ---- page ---------------------------------------------------------------

Page:
    'page' name=ID ('(' (params+=Parameter (',' params+=Parameter)*)? ')')? '{'
        props+=PageProp*
    '}';

PageProp:
      RouteProp | TitleProp | RequiresProp | StateBlock | BodyProp | PageMenuMeta;

RouteProp:
    'route' ':' value=STRING;

TitleProp:
    'title' ':' value=Expression;

RequiresProp:
    'requires' expr=Expression;

BodyProp:
    'body' ':' expr=Expression;

// Per-page sidebar metadata.  Read by the menu emitter (Slice 6) when
// no explicit `ui`-level `menu { ... }` block is declared.  Recognised
// keys are `section` (string), `label` (string), `order` (int),
// `hidden` (bool).  We accept any `ID` here and let the validator
// (Slice 3) enforce the allowed names — same pattern `ThemeProp`
// uses (line 40).  Promoting these to grammar-level keywords would
// pollute the lexer and break user fields named `order` / `label` /
// `hidden` in domain aggregates (e.g. `event LineAdded { order: Id<Order> }`).
PageMenuMeta:
    'menu' '{'
        (entries+=MenuMetaEntry (',' entries+=MenuMetaEntry)* ','?)?
    '}';

MenuMetaEntry:
    name=LooseName ':' value=Expression;

// ---- component ----------------------------------------------------------

Component:
    'component' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' '{'
        decls+=ComponentDecl*
        'body' ':' body=Expression
    '}';

ComponentDecl:
    StateBlock;

// ---- state --------------------------------------------------------------

// Reactive local fields, inside a `page` or `component`.  Same
// shape as `theme { … }` and `user { … }`.  Multiple blocks merge
// at lowering time (matches `permissions`).  StateField extends
// the property pattern with an optional initializer expression
// (Loom's `Property` rule does not allow defaults; carrying the
// init inline avoids touching aggregate/entity/VO/event field
// parses).
StateBlock:
    'state' '{'
        fields+=StateField*
    '}';

StateField:
    name=ID ':' type=TypeRef ('=' init=Expression)?;

// ---- scaffold -----------------------------------------------------------

// Single fixed multi-page rewrite from a domain selector to pages.
// Not user-extensible.  See spec §10 for the granularity hierarchy
// (modules → contexts → aggregates ∪ workflows ∪ views).
Scaffold:
    'scaffold' selector=ScaffoldSelector ':' targets+=ID (',' targets+=ID)* ','?;

ScaffoldSelector returns string:
    'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views';

// ---- menu ---------------------------------------------------------------

// Optional `ui`-level sidebar block.  When present, it is the source
// of truth for sidebar structure; when absent, sidebar is derived
// from per-page `menu { … }` metadata (PageMenuMeta) grouped by
// `section`.  See spec §11 for the lowering.
MenuBlock:
    'menu' '{'
        sections+=MenuSection*
    '}';

MenuSection:
    'section' label=STRING '{'
        (links+=MenuLink (',' links+=MenuLink)* ','?)?
    '}';

// Page links use a real Langium cross-reference now that scaffold
// expansion runs at the AST level (Slice 10 — see
// `src/language/ddd-scaffold-ast-expander.ts`).  Synthesised pages
// are real `Page` AST nodes by the time the linker runs, so
// `[Page:ID]` resolves through Langium's standard machinery —
// IDE affordances (autocomplete, go-to-def, find-refs, rename)
// follow.
MenuLink:
      'link' page=[Page:LooseName] ('{' (props+=MenuLinkProp (',' props+=MenuLinkProp)* ','?)? '}')?
    | 'link' externalLabel=STRING '->' externalUrl=STRING;

// Same approach as MenuMetaEntry — `LooseName` + validator-side
// check of the allowed key names (`label`, `order`).
MenuLinkProp:
    name=LooseName ':' value=Expression;

// ---------------------------------------------------------------------------
// Traceability (Slice 12) — Requirement / Solution / TestCase.
//
// Three analytical artefacts that sit *above* the domain model and
// reference it one-directionally: the generated code stays clean (no
// `implements` back-links).  `Requirement` is one generalised box with
// a `type` discriminator (UserStory / UseCase / AcceptanceCriteria /
// BusinessReq) and an optional `parent` for hierarchy.  `Solution`
// records the design rationale ("talkback") for a requirement and
// `entitles` the concrete code symbols it legitimises.  `TestCase`
// `verifies` a requirement and `covers` the code symbols it exercises.
//
// Code references are qualified cross-references (`Identity.Auth.
// LoginSession.start`) resolved via the qualified-name index in
// ddd-scope.ts — full IDE navigation, no magic strings.  Executable
// tests (`test` / `test e2e`) back-link to a TestCase via `verifies`,
// completing the chain Requirement -> Solution -> TestCase -> test ->
// code.  See docs/traceability.md.
// ---------------------------------------------------------------------------

Requirement:
    'requirement' name=TraceId ('parent' parent=[Requirement:TraceId])? '{'
        props+=RequirementProp*
    '}';

// Permissive key/value prop-bag — the same pattern `ThemeProp` and
// `PageMenuMeta` use.  We deliberately do NOT promote the keys
// (`type`, `status`, `priority`) or the enum-like values (`UserStory`,
// `Draft`, …) to grammar keywords: doing so would steal extremely
// common domain identifiers (`status` alone appears in scores of
// example aggregates).  The validator (Slice 12) enforces the allowed
// key set { type, title, status, priority }, that `type` + `title` are
// present, and the RequirementType / RequirementStatus value enums.
RequirementProp:
    name=RequirementPropKey ':' value=Expression;

// `type` and `title` are already global keywords (Storage `type:`,
// page `title:`), so they are admitted explicitly; everything else
// (`status`, `priority`) flows through the ordinary ID alternative
// and never becomes a keyword.
RequirementPropKey returns string:
    ID | 'type' | 'title';

// Ticket-style identifier for traceability artefacts — `US-001`,
// `AC-001`, `SOL-001`, `TC-001`.  Backed by the `TRACE_ID` terminal
// (below) so the literal text — including leading zeros — is preserved
// (a parser-level `ID ('-' INT)*` rule would reassemble `US-001` as
// `US-1`, collapsing `US-001` and `US-01`).  A plain `ID` is also
// admitted for hyphen-free names.
TraceId returns string:
    TRACE_ID | ID;

Solution:
    'solution' name=TraceId 'for' requirement=[Requirement:TraceId] '{'
        ('title' ':' title=STRING)?
        ('entitles' '[' (entitles+=[Targetable:QualifiedName]
                         (',' entitles+=[Targetable:QualifiedName])* ','?)? ']')?
    '}';

TestCase:
    'testCase' name=TraceId 'verifies' requirement=[Requirement:TraceId] '{'
        ('title' ':' title=STRING)?
        ('covers' '[' (covers+=[Targetable:QualifiedName]
                       (',' covers+=[Targetable:QualifiedName])* ','?)? ']')?
    '}';

// Dotted-path datatype rule backing every code cross-reference.  The
// qualified-name provider in ddd-scope.ts exports each `Targetable`
// node under the same dotted form (Module.Context.Aggregate.operation).
// Segments use `LooseName` (not bare `ID`) so a symbol whose name is a
// reserved word — most commonly a `deployable api { ... }` — is still
// addressable from `entitles` / `covers`.
QualifiedName returns string:
    LooseName ('.' LooseName)*;

// The family of code symbols a Solution may `entitle` or a TestCase
// may `cover`.  Intentionally broad — anything from a whole module
// down to a single operation, plus deployables and api contracts.
type Targetable =
    Module | BoundedContext | Aggregate | ValueObject | EventDecl
  | Repository | Workflow | View | Operation | Deployable | Api;

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
    'test' name=STRING ('verifies' verifies=[TestCase:TraceId])? '{'
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
    name=ID ':' type=TypeRef (display?='display')? ('check' check=Expression)?;

Containment:
    'contains' name=ID ':' partType=[EntityPart:ID] (collection?='[]')?;

DerivedProp:
    'derived' name=ID ':' type=TypeRef '=' expr=Expression;

// Invariants default to "every layer the classifier can translate
// the predicate to" (frontend Zod, Hono routes, FluentValidation).
// `private invariant ...` opts out of the wire layers — the rule
// only runs in the domain `AssertInvariants()` floor.  Useful for
// rules the user doesn't want disclosed via OpenAPI (sensitive
// uniqueness checks, internal-only consistency rules).
Invariant:
    (serverOnly?='private')? 'invariant' expr=Expression ('when' guard=Expression)?;

FunctionDecl:
    'function' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' ':' returnType=TypeRef '=' body=Expression;

Operation:
    (private?='private')? 'operation' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' (extern?='extern')? '{'
        body+=Statement*
    '}';

Parameter:
    name=LooseName ':' type=TypeRef;

// LooseName — admissible identifiers in name positions that need to
// accept Loom keywords as ordinary names.  Used by `Parameter.name`
// (so `id` works as a route-param name on pages — `page Detail(id:
// Id<Order>)` — the IdRef magic-identifier doesn't shadow it),
// `MenuMetaEntry.name` (so `section: "Sales"` admits the same
// keyword `MenuSection` reserves), `MenuLinkProp.name` (likewise),
// and `CallArg.name` (so `Form(state: foo)` is legal even though
// `state` is reserved by `StateBlock`).  Adding a token here does
// NOT make it parseable as a NameRef in expression position — that
// remains `NameRefIdent`.  Validators (Slice 3) enforce semantic
// constraints (e.g. only specific names are valid for menu metadata).
LooseName returns string:
    ID
    | 'id' | 'permissions' | 'contains'
    | 'ui' | 'page' | 'component' | 'scaffold' | 'state' | 'menu'
    | 'section' | 'link' | 'route' | 'title' | 'body' | 'framework' | 'static'
    | 'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views'
    | 'design' | 'targets'
    | 'bind' | 'api'
    | 'primary' | 'cache' | 'search' | 'events' | 'bi';

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

// LValue accepts the same soft-keyword set as MemberName / NameRefIdent
// for both `head` and `tail` segments — so e2e test bodies like
// `ui.workflows.placeOrder({...})` and `ui.views.activeOrders()` parse
// cleanly when `ui` / `workflows` / `views` are reserved by the page-
// metamodel grammar.
LValue:
    head=LValueIdent ('.' tail+=LValueIdent)*
      (call?='(' (args+=Expression (',' args+=Expression)*)? ')')?;

LValueIdent returns string:
    ID | 'id' | 'permissions' | 'contains' | 'ui' | 'api'
       | 'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views';

// ---------------------------------------------------------------------------
// Expressions (precedence climbing, lowest to highest)
// ---------------------------------------------------------------------------

Expression:
    MatchExpr | TernaryExpr;

// Predicate-arms expression — first arm whose `cond` evaluates to
// `true` returns its value; optional `else` is the fallthrough.
// Lives in the expression engine so it can appear anywhere an
// expression is allowed (page bodies, derived properties, view
// `bind` exprs, filter lambdas, function bodies, etc.).
//
// `match` only enters this rule when followed by `{` — bare
// occurrences of `match` as an identifier remain free.  Validator
// may warn on non-exhaustive matches that lack `else`.
MatchExpr:
    'match' '{'
        (arms+=MatchArm (','? arms+=MatchArm)* ','?)?
        ('else' '=>' elseExpr=Expression ','?)?
    '}';

MatchArm:
    cond=Expression '=>' value=Expression;

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
          ( call?='(' (args+=CallArg (',' args+=CallArg)*)? ')' )?
      | {infer CallExpr.callee=current} '(' (args+=CallArg (',' args+=CallArg)*)? ')'
    )*;

// Call arguments admit an optional `name:` prefix (Slice 1.5).
// Positional usage (`Money(10.5, "USD")`) keeps working; named usage
// (`List(of: Order, scope: Orders.byCustomer(customerId))`) lets
// component invocations in the page metamodel surface the parameter
// names rather than relying on positional discipline.  Lowering
// threads the name into `CallExpr.argNames` / `MethodCall.argNames`
// parallel to `args`; renderers that don't care can ignore them.
//
// The name uses `LooseName` so common page-metamodel parameter
// keywords (`of`, `by`, `state`, `body`, …) are admissible — without
// this, e.g. `Form(state: order)` would fail because `state` is a
// hard keyword from `StateBlock`.
CallArg:
    (name=LooseName ':')? value=Expression;

// Accept reserved keywords as ordinary member names so `prod.id`,
// `currentUser.permissions`, `someArray.contains(x)`, and the e2e
// surface (`ui.products.create(...)`, `ui.workflows.<name>(...)`,
// `ui.views.<name>()`) all parse cleanly.  The magic-identifier
// resolution / collection-op dispatch lives in the lowering
// (lower-expr.ts + type-system.ts) rather than the grammar.
MemberName returns string:
    ID | 'id' | 'permissions' | 'contains' | 'ui' | 'api'
       | 'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views';

// Lambdas accept either a single expression body (the only form
// in v22) or a brace-wrapped block of statements.  Block bodies
// are required for multi-statement event handlers in pages — e.g.
// `c => { draft.customerId := c.customerId; step := 1 }`.  The
// block reuses the existing `Statement` rule so all of `let`,
// `:=`, `+=`, `-=`, calls, and `emit` are admissible inside.
Lambda:
    param=ID '=>' (
        body=Expression
      | '{' stmts+=Statement* '}'
    );

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
    // `ui` is admissible as a NameRef so e2e test bodies can reference
    // the magic `ui` identifier (`ui.products.create(...)`) rooted at
    // a react/static deployable's page-object surface.  The `ui { ... }`
    // SystemMember declaration keeps the keyword form because the
    // surrounding `system { ... }` context disambiguates.
    //
    // `permissions` is admissible for the analogous reason —
    // `currentUser.permissions.contains(x)` in expression bodies.
    //
    // `api` is admissible so e2e test bodies can use the existing
    // `api.<aggregate>.<verb>(...)` magic-identifier form even
    // though `api` is now a system-level keyword (Api declaration).
    ID | 'permissions' | 'ui' | 'api';

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

hidden terminal WS: /\s+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;

terminal STRING: /"(\\.|[^"\\])*"/;
terminal DECIMAL: /[0-9]+\.[0-9]+/;
terminal INT returns number: /[0-9]+/;
// Ticket-style trace identifier (`US-001`, `AC-001`, `SOL-001`).  Must
// end in `-<digits>` so ordinary hyphen-free identifiers fall through
// to ID and so expression subtraction that ends in an identifier
// (`price-discount`) is never captured.  The only residual collision
// is `name-<digits>` written with no surrounding spaces (e.g. `x-1`);
// Loom's house style — and every example — spaces binary operators,
// so this stays theoretical.  Declared before ID for longest-match
// priority on inputs like `US-001`.
terminal TRACE_ID: /[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*-[0-9]+/;
terminal ID: /[_a-zA-Z][\w_]*/;
