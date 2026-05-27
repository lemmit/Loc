grammar Ddd

entry Model:
    imports+=ImportStmt*
    members+=ModelMember*;

// Multi-file source — import another .ddd file relative to the file
// containing this statement.  The CLI's project loader walks the
// import graph transitively from the entry file (main.ddd) and
// registers every reachable document with Langium's workspace; the
// rest of the pipeline sees the merged model.  Imports are about
// file loading, not visibility: every reachable document's symbols
// share the same global scope.  See docs/multi-file-source.md.
ImportStmt:
    'import' path=STRING ';'?;

ModelMember:
    System | BoundedContext | ValueObject | EnumDecl | Requirement | Solution | TestCase | Component;

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
    Module | Deployable | BoundedContext | TestE2E | UserBlock | ThemeBlock | Ui | Api | Storage | Layout;

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
        (decls+=PermissionDecl (','? decls+=PermissionDecl)* ','?)?
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
        // Optional favicon path — relative to the .ddd source file.
        // The React generator copies the referenced file into
        // `public/favicon.<ext>` and the index.html shell emits a
        // `<link rel="icon" href="/favicon.<ext>">`.
        ('favicon' ':' favicon=STRING ','?)?
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
    'ui' name=ID withClause=WithClause? '{'
        members+=UiMember*
    '}';

UiMember:
    UiApiParam | UiHelperImport | Page | Component | MenuBlock;

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
      RouteProp | TitleProp | RequiresProp | StateBlock | BodyProp | PageMenuMeta | LayoutProp
    | DescriptionProp | OgImageProp | CanonicalProp;

RouteProp:
    'route' ':' value=STRING;

TitleProp:
    'title' ':' value=Expression;

RequiresProp:
    'requires' expr=Expression;

BodyProp:
    'body' ':' expr=Expression;

// Page metadata props — projected into the generated `index.html`
// shell as standard SEO / social-graph meta tags.  All three are
// plain string literals (not Expression) — static metadata, no
// state interpolation.  Validator enforces uniqueness; lowering
// stores them under `PageIR.metadata`.
DescriptionProp:
    'description' ':' value=STRING;

OgImageProp:
    'ogImage' ':' value=STRING;

CanonicalProp:
    'canonical' ':' value=STRING;

// Per-page layout selector.  Bare `ID` admits two preset values
// (`default`, `none`) plus the name of any `layout <Name> { … }`
// SystemMember declared in the same system.  The validator + lowerer
// distinguish presets from named refs by the literal value; cross-ref
// scoping is per-system because layouts are SystemMembers.
LayoutProp:
    'layout' ':' value=ID;

// Named layout declaration (Phase 8).  A page or ui can opt into a
// named layout (`layout: AdminFrame`) which lowers to a wrapping
// React Router layout-route around the page body, similar to v1's
// `default` AppShell but built from user-defined slots.  Reserved
// names `default` and `none` cannot be redeclared (validator).
//
// Each slot's body is a single Expression evaluated in the same
// scope as a page body — so it can reference walker-stdlib primitives
// (Sticky, Container, Group, …), user-declared components, and
// helper imports.  `main` is a special slot with no body — it marks
// where React Router's `<Outlet />` lands; every layout must declare
// exactly one `main`.  Validator enforces.
Layout:
    'layout' name=ID '{'
        slots+=LayoutSlot+
    '}';

LayoutSlot:
    LayoutNamedSlot | LayoutMainSlot;

LayoutNamedSlot:
    name=LayoutSlotName '{' body=Expression '}';

LayoutMainSlot:
    {infer LayoutMainSlot} 'main';

LayoutSlotName returns string:
    'header' | 'sidebar' | 'footer';

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
        (entries+=MenuMetaEntry (','? entries+=MenuMetaEntry)* ','?)?
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
    name=StateFieldName ':' type=TypeRef ('=' init=Expression)?;

// State-field names accept the soft keywords introduced by the
// capability source surface (`filter`, `stamp`, `implements`) so
// existing pages with state fields named `filter`/`stamp`/etc.
// still parse.  The keywords only have structural meaning inside
// aggregate / context member positions; everywhere else they remain
// admissible identifiers.
StateFieldName returns string:
    ID | 'filter' | 'stamp' | 'implements';

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
        (links+=MenuLink (','? links+=MenuLink)* ','?)?
    '}';

// Page links use a real Langium cross-reference now that scaffold
// expansion runs at the AST level (Slice 10 — see
// `src/language/ddd-scaffold-ast-expander.ts`).  Synthesised pages
// are real `Page` AST nodes by the time the linker runs, so
// `[Page:ID]` resolves through Langium's standard machinery —
// IDE affordances (autocomplete, go-to-def, find-refs, rename)
// follow.
MenuLink:
      'link' page=[Page:LooseName] ('{' (props+=MenuLinkProp (','? props+=MenuLinkProp)* ','?)? '}')?
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
    'context' name=ID withClause=WithClause? '{'
        members+=ContextMember*
    '}';

ContextMember:
    EnumDecl | ValueObject | Aggregate | EventDecl | Repository | Workflow | View
    | FilterDecl | StampDecl | ImplementsDecl;

EnumDecl:
    'enum' name=ID '{'
        values+=EnumValue (','? values+=EnumValue)* ','?
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
    'aggregate' name=ID ('ids' idKind=IdKind)? withClause=WithClause? '{'
        members+=AggregateMember*
    '}';

IdKind returns string:
    'guid' | 'int' | 'long' | 'string';

// ---- macro `with` clause ----------------------------------------
//
// Attaches one or more macro invocations to an aggregate (later: ui,
// property).  Macro names resolve against a TS-side registry loaded
// from the toolchain stdlib and from project-local `.loom/macros/*.ts`
// modules.  Expansion runs at the AST level (see
// `ddd-macro-expander.ts`) before linking, so synthesised members
// participate in scope resolution and validation as if user-written.
WithClause:
    'with' calls+=MacroCall (',' calls+=MacroCall)*;

MacroCall:
    name=ID ('(' (args+=MacroArg (',' args+=MacroArg)*)? ')')?;

// Arg names accept the same soft-keyword set as LooseName so
// macros may use `modules:`, `aggregates:`, etc. as parameter
// names — same identifier surface the legacy `scaffold` directive
// uses, which scaffold-replacement macros need to mirror.
MacroArg:
    name=LooseName ':' value=MacroArgValue;

// Macro arg ref-list elements are bare IDs, not Langium cross-
// references.  We don't use the [Target:ID] form because:
//   - Macros accept refs to declaration kinds outside the global
//     scope (Workflow, View, Module), which the default scope
//     provider doesn't expose;
//   - The macro expander does its own name lookup against a
//     per-document inventory, with diagnostics that point at the
//     macro call rather than the linker's generic "could not
//     resolve" message.
// IDE go-to-definition on macro args is a Phase 5 concern; will
// be implemented via a custom DefinitionProvider rather than by
// routing through Langium's linker.
MacroArgValue:
    {infer MacroArgString} string=STRING
    | {infer MacroArgBool} bool=('true' | 'false')
    | {infer MacroArgInt} int=INT
    | {infer MacroArgRef} ref=ID
    | {infer MacroArgRefList} '[' (refs+=ID (',' refs+=ID)*)? ']';

AggregateMember:
    Containment | DerivedProp | Invariant | FunctionDecl | Operation | EntityPart | TestBlock | Property
    | FilterDecl | StampDecl | ImplementsDecl;

// ---- capability source surface ----------------------------------
//
// Capabilities (`filter`, `stamp`, `implements`) are first-class
// aggregate/context members.  They produce the same IR shape macros
// did (`AggregateIR.contextFilters` / `.contextStamps` /
// `.implementsCapabilities`); the macro factories are sugar that
// emit these node types into the host's members[] array.  Anything
// a macro can contribute, a user can hand-write.
//
// At ContextMember position these propagate to every aggregate
// inside the context at lowering time (see `lowerContext`).

// `filter <expr>` declares a query-filter predicate.  At aggregate
// scope it applies to that aggregate only.  At context scope it
// applies to every aggregate inside (propagated at lowering time).
//
// `filter for "<name>" <expr>` is a capability-scoped variant: it
// only applies to aggregates whose `implements "<name>"` matches.
// Aggregates without the matching opt-in ignore the declaration.
// Useful for "context Sales { filter for 'softDeletable' !this.isDeleted }"
// where some aggregates participate and some don't.
FilterDecl:
    'filter' ('for' capability=STRING)? expr=Expression;

// `stamp <event> { ... }` declares lifecycle-stamping assignments.
// Same scoping rules as FilterDecl: at aggregate scope applies to
// that aggregate; at context scope propagates to every aggregate;
// `for "<name>"` qualifier restricts propagation to opt-ins.
StampDecl:
    'stamp' ('for' capability=STRING)? event=StampEvent '{'
        assignments+=AssignOrCallStmt*
    '}';

StampEvent returns string:
    'onCreate' | 'onUpdate';

// `implements "name"` opts the host into a capability group with the
// given name.  Backends translate the name by convention (.NET adds
// an `I` prefix → `IAuditable`; TS may emit a type alias; etc.) and
// emit one shared infrastructure block per name (e.g. one
// HasQueryFilter loop per capability in OnModelCreating).
ImplementsDecl:
    'implements' name=STRING;

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
        (fields+=Property (','? fields+=Property)* ','?)?
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

// Field access modifier — single optional keyword controlling the
// field's role in input DTOs, update wire shape, and view/API read
// exposure.  See `src/ir/enrichments.ts` for resolution rules and
// `FieldIR.access` in `src/ir/loom-ir.ts` for downstream semantics.
//
//   editable (default) — client read+write
//   immutable          — client write on create only
//   managed            — server-managed; client read-only
//   token              — server-managed; echoed by client on update (id, version)
//   internal           — views may read; not exposed via API; no client input
//   secret             — client write-only; never disclosed in any read
//
// All five names are also admitted as identifiers in property/parameter
// /name-ref positions via `Property.name`, `LooseName`, `NameRefIdent`
// (same soft-keyword treatment as `money`) so this addition does not
// break user code that already uses `secret` etc. as a field name.
FieldAccess returns string:
    'immutable' | 'managed' | 'token' | 'internal' | 'secret';

// `money` and the five field-access keywords are admitted as property
// names so pre-existing files that named a field `money` / `secret` /
// etc. keep parsing.  Hard-keyword positions for `money` remain
// `PrimitiveType` and `MoneyLit`; for the access modifiers they remain
// the `FieldAccess` slot below.  See `LooseName` and `NameRefIdent`
// for the same admission in parameter / expression positions.
Property:
    name=(ID | 'money' | 'immutable' | 'managed' | 'token' | 'internal' | 'secret'
        // Phase 2 page-metadata + favicon keywords — soft in property position.
        | 'description' | 'ogImage' | 'canonical' | 'favicon')
    ':' type=TypeRef
    (provenanced?='provenanced')?
    sensitivity=SensitivityClause?
    (access=FieldAccess)?
    ('check' check=Expression)?;

// Information-flow sensitivity tag(s) on a property.  Tags are bare
// identifiers, opaque to the compiler — `pii`, `phi`, `cred` are
// conventional choices but any identifier is accepted.  Multiple tags
// (`sensitive(pii, audited)`) declare the value carries every listed
// classification simultaneously.  See `docs/proposals/sensitivity-and-compliance.md`.
SensitivityClause:
    'sensitive' '(' tags+=ID (',' tags+=ID)* ')';

Containment:
    'contains' name=ID ':' partType=[EntityPart:ID] (collection?='[]')? (optional?='?')?;

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
    (private?='private')? 'operation' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' (extern?='extern')? (audited?='audited')? '{'
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
    | 'ui' | 'page' | 'component' | 'state' | 'menu'
    | 'section' | 'link' | 'route' | 'title' | 'body' | 'framework' | 'static'
    | 'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views'
    | 'design' | 'targets'
    | 'bind' | 'api'
    | 'primary' | 'cache' | 'search' | 'events' | 'bi'
    // `money` is a soft keyword — the only places it acts as a
    // hard keyword are `PrimitiveType` (`amount: money`) and
    // `MoneyLit` (`money("10.50")`).  Admitting it here lets
    // pre-existing .ddd files keep using `money` as an ordinary
    // identifier in field / parameter / property positions; without
    // this, adding `money` to the grammar (#498) silently broke any
    // file that named a field `money` (e.g. `pokemon-world.ddd`).
    | 'money'
    // Field-access modifier keywords (`FieldAccess` rule) are likewise
    // soft.  They only act as hard keywords in the optional `access`
    // slot of `Property`; everywhere else (parameter names, field
    // names, property bindings) they're admitted as identifiers so
    // adding them in this PR does not break any user code.
    | 'immutable' | 'managed' | 'token' | 'internal' | 'secret'
    // Phase 2 page-metadata + favicon keywords.  Admitted as soft so
    // user code can still name fields `description`, `ogImage`,
    // `canonical`, `favicon`.
    | 'description' | 'ogImage' | 'canonical' | 'favicon';

// ---------------------------------------------------------------------------
// Type references
// ---------------------------------------------------------------------------

TypeRef:
    base=BaseType (array?='[]')? (optional?='?')?;

BaseType:
    PrimitiveType | SlotType | IdType | NamedType;

PrimitiveType:
    name=('int' | 'long' | 'decimal' | 'money' | 'string' | 'bool' | 'datetime' | 'guid');

// Element-shaped param type for component slot injection — see
// `docs/page-metamodel.md`.  Valid only on a `component`'s parameter
// list; values flow as JSX (`React.ReactNode`-ish in TS land) from
// the caller's expression scope into the component's body, where
// a bare ref `paramName` renders the caller's expr at that
// position.  The validator pins the position restriction.
SlotType:
    name='slot';

IdType:
    target=[NamedDecl:ID] 'id';

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
    OrExpr ({infer TernaryExpr.cond=current} '?' thenExpr=Expression ':' elseExpr=Expression)?;

OrExpr infers Expression:
    AndExpr ({infer BinaryChain.head=current} (ops+='||' rest+=AndExpr)+)?;

AndExpr infers Expression:
    EqualityExpr ({infer BinaryChain.head=current} (ops+='&&' rest+=EqualityExpr)+)?;

EqualityExpr infers Expression:
    ComparisonExpr ({infer BinaryChain.head=current} (ops+=('=='|'!=') rest+=ComparisonExpr)+)?;

ComparisonExpr infers Expression:
    AdditiveExpr ({infer BinaryChain.head=current} (ops+=('<='|'>='|'<'|'>') rest+=AdditiveExpr)+)?;

AdditiveExpr infers Expression:
    MultiplicativeExpr ({infer BinaryChain.head=current} (ops+=('+'|'-') rest+=MultiplicativeExpr)+)?;

MultiplicativeExpr infers Expression:
    UnaryExpr ({infer BinaryChain.head=current} (ops+=('*'|'/'|'%') rest+=UnaryExpr)+)?;

UnaryExpr infers Expression:
    {infer UnaryExpr} op=('!'|'-') operand=PostfixExpr
  | PostfixExpr;

PostfixExpr infers Expression:
    PrimaryExpr ({infer PostfixChain.head=current} suffixes+=PostfixSuffix+)?;

PostfixSuffix:
      {infer MemberSuffix} '.' member=MemberName
        ( call?='(' (args+=CallArg (',' args+=CallArg)*)? ')' )?
    | {infer CallSuffix}   '(' (args+=CallArg (',' args+=CallArg)*)? ')';

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
       | 'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views'
       | 'filter' | 'stamp' | 'implements'
       // `where` is a hard keyword in `FindDecl` (`find foo(): T where ...`)
       // and `View` (`view X = Y where ...` and the full form's `from Y where`),
       // but it's also the collection-op name in `arr.where(λ)` — see
       // `src/util/collection-ops.ts` and the `case "where":` arms in the TS /
       // Phoenix renderers.  Admit it here so expression-position uses parse.
       | 'where';

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
    | BuilderCall
    | ObjectLit
    | ParenExpr
    | ListLit
    | LiteralExpr
    | MoneyLit
    | PrimitiveConversion
    | NowExpr
    | ThisRef
    | IdRef
    | NameRef;

// Bracketed list literal — `[3, 2, 1]`.  Used as the value of named
// args that admit a list shape (e.g. `Grid { cols: [3, 2, 1] }` for
// responsive breakpoints).  Heterogeneous expression elements are
// admitted at the grammar level; the type system / each consumer
// validates element shape per use site.
ListLit:
    {infer ListLit} '[' (elements+=Expression (',' elements+=Expression)* ','?)? ']';

// Universal construction form (Loom v2).  Replaces `new Part { ... }`
// and the walker-call form (`Form(state: ..., body: ...)`).  The type
// name resolves at lowering time:
//   - ValueObject / EntityPart  → value construction, runs invariants
//   - EventDecl                 → event construction (only as `emit` operand)
//   - Component (stdlib walker primitive or user component) → UI element
// Entries are `(name ':')? expr` so named slots and bare positional
// children (Stack { Heading{...}, Button{...} }) coexist.  Explicit
// alternation (not optional `(name ':')?`) is required for stable
// LL(*) selection on bare-positional entries whose token is a soft
// keyword (e.g. `Card { title, Slot {} }`).
BuilderCall:
    type=ID '{'
        (entries+=BuilderEntry (',' entries+=BuilderEntry)* ','?)?
    '}';

BuilderEntry:
      name=LooseName ':' value=Expression
    | value=Expression;

// Bare object literal — used inside e2e test bodies to build request
// payloads (`api.orders.create({ customerId: "..." })`).  Distinct
// from a typed `BuilderCall`: no type binding, no invariant checks; it
// is a structural literal that the e2e renderer hands straight to
// JSON.stringify.
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

// `money("10.50")` constructor — the source-level form for a money
// literal.  The string argument carries the precise decimal value;
// every backend's host-language precise-decimal type (decimal.js,
// System.Decimal, Elixir Decimal, rust_decimal) parses from this
// string without loss.
MoneyLit:
    {infer MoneyLit} 'money' '(' value=STRING ')';

// Loom-style explicit conversion vocabulary — `<target>(value)` where
// `target` is a primitive type and `value` is the expression to
// convert.  Used for things the strict binary validator now requires
// to be explicit: `"Hello " + string(age)` instead of bare
// `"Hello " + age`, `money(decimalField)` to bridge a typed decimal
// into money, `decimal(moneyValue)` for the lossy projection.
//
// Targets in this PR (infallible only):
//   string  ← {int, long, decimal, money, bool}
//   long    ← int
//   decimal ← {int, long, money}
//   money   ← {int, long, decimal}
//
// Notably missing — fallible parses (`int("42")`, `decimal("3.14")`,
// `datetime("...")`, …) need a `T?`-or-throw decision before the
// vocabulary settles; deferred.
//
// MoneyLit comes first in PrimaryExpr's alternative list so
// `money("10.50")` (string-arg literal) wins the parse; PrimitiveConversion
// catches the expression-arg form `money(someDecimal)`.
PrimitiveConversion:
    {infer PrimitiveConversion} target=('string' | 'long' | 'decimal' | 'money') '(' value=Expression ')';

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
    // `money` admitted so pre-existing field names like `money:
    // int` (pokemon-world.ddd) can still be referenced in expression
    // position without colliding with the `MoneyLit` `money("...")`
    // form.  MoneyLit comes before NameRef in PrimaryExpr, so the
    // parser picks the literal form whenever `(` follows and falls
    // back to NameRef otherwise.
    // v2 expanded set: every soft keyword that LooseName admits is also
    // admissible as a bare NameRef in expression position.  This lets a
    // BuilderCall's bare-positional entry (`Card { title, Slot {} }`) parse
    // when the entry happens to be a NameRef whose token is a soft keyword
    // — without this, the parser commits to the named-slot alternative
    // (`name=LooseName ':'`) and fails on the missing `:`.
    //
    // Field-access modifier keywords (`FieldAccess` rule) are admitted
    // here so `let s = secret`, `currentUser.token`, etc. keep working
    // even though `secret`/`token`/etc. are reserved in the access slot
    // of a `Property` declaration.  Same soft-keyword treatment `money`
    // gets above.
    //
    // `id` is intentionally excluded: it's the magic identifier handled by
    // IdRef and would create an ambiguity with IdRef inside PrimaryExpr.
    ID | 'permissions' | 'ui' | 'api' | 'money'
       | 'contains' | 'page' | 'component' | 'state' | 'menu'
       | 'section' | 'link' | 'route' | 'title' | 'body' | 'framework' | 'static'
       | 'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views'
       | 'design' | 'targets' | 'bind'
       | 'primary' | 'cache' | 'search' | 'events' | 'bi'
       | 'filter' | 'stamp' | 'implements'
       | 'immutable' | 'managed' | 'token' | 'internal' | 'secret'
       // Phase 2 page-metadata + favicon keywords admitted as NameRef
       // so expressions can read a field named `description`,
       // `ogImage`, etc. (e.g. `description != null` in a derived
       // property — see showcase.ddd).
       | 'description' | 'ogImage' | 'canonical' | 'favicon';

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
