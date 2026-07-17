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
// share the same global scope.
ImportStmt:
    'import' path=STRING ';'?;

ModelMember:
    System | Subdomain | BoundedContext | ValueObject | EnumDecl | PayloadDecl | Requirement | Solution | TestCase | Component
    // Top-level (ambient) helper `function`: a pure, expression-form function
    // visible workspace-wide, like a root `valueobject` / `enum`.  It inlines
    // at every call site during lowering (no emitted function), so it needs no
    // owning aggregate.
    | FunctionDecl
    // The deployment-shape members are also admissible at file top level and
    // compose into the project's single `system`, so deployment can live in
    // its own file.
    | Deployable | Storage | Resource | ChannelSource | Ui | ThemeBlock | UserBlock | AuthBlock | Api | Layout | TestE2E
    // A `capability` pure-mixin is top-level declarable (and a `SystemMember`
    // inside `system { }`).
    | Capability
    // A dedicated `migration { rename ... }` block, isolated from the domain
    // model, that disambiguates the derived snapshot→model migration diff.
    | Migration;

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

// A dedicated, domain-model-isolated migration surface.  A
// `migration "<name>" { … }` block is a permanent, ledger-style record whose
// `rename` steps disambiguate the derived snapshot→model diff: an explicit
// `rename Agg.old -> new` maps the old snapshot column to the new model
// column BEFORE the diff classifies drops/adds, so the engine emits a
// `renameColumn` (+ `alterColumnType` on a type change) instead of the
// data-losing drop+add the one-drop-one-add heuristic can't collapse.  The
// block is naturally inert once its rename is baked into the baseline
// snapshot (the next diff finds no old column to rename), so no separate
// applied-history file is needed.  The step is keyword-free (`Agg.old ->
// new`) — `rename` is NOT introduced as a keyword because it is used
// pervasively as a domain identifier (operation/workflow/function names)
// across the corpus; the `->` carries the intent.  A `RenameStep` is either a
// COLUMN rename (`Agg.old -> new`) or a TABLE/aggregate rename
// (`OldName -> NewAggregate`).
Migration:
    'migration' name=STRING '{'
        (renames+=RenameStep (','? renames+=RenameStep)* ','?)?
    '}';

// A rename step: column (has the `.field` selector) or table/aggregate (bare
// `OldName -> NewAggregate`).  The two are disambiguated by the token after
// the first identifier — `.` selects a column, `->` a whole table.  Only the
// LIVE side is a cross-reference: a column rename's `aggregate` is the still-
// present aggregate; a table rename's `toAggregate` is the post-rename
// aggregate.  The dead side (`from` old column / `fromTable` old name) is a
// bare identifier the model no longer declares — a ledger block legitimately
// names things that have since moved on, so it is NOT cross-referenced.
RenameStep:
    ColumnRename | TableRename;

ColumnRename:
    aggregate=[Aggregate:ID] '.' from=UserFieldName '->' to=UserFieldName;

// `OldName -> NewAggregate` — the aggregate's table `plural(snake(OldName))`
// is renamed to `plural(snake(NewAggregate))` in the derived diff, cascading
// to the aggregate's owned child tables (parts / value-collections /
// associations) and their owner FK columns.  `fromTable` is the OLD, now-
// absent aggregate name (bare ID); `toAggregate` is the live cross-reference.
TableRename:
    fromTable=ID '->' toAggregate=[Aggregate:ID];

SystemMember:
    Subdomain | Deployable | BoundedContext | TestE2E | UserBlock | AuthBlock | TenancyDecl | ThemeBlock | Ui | Api | Storage | Resource | ChannelSource | Layout | Capability | FunctionDecl;

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
    ID | 'id' | 'permissions'
    // `migration` is hard only at the top-level `Migration` block head;
    // soft in field-name position so a domain field named `migration` parses.
    | 'migration';

// System-level OIDC authentication config.  Sibling to `user { … }`: the
// user block declares the claim SHAPE, this block declares WHO issues the
// token and how its claims map onto that shape.  `provider:` names a preset
// (resolved to issuer/endpoints during lowering); `keycloak` / `custom` are
// the self-hosted path and require an explicit `oidc { issuer: … }`.  At most
// one per system, admissible only alongside a `user { … }` block (validator
// enforces).  Loom owns no auth runtime — declaring this generates a token
// verifier (filling the existing per-backend verifier seam) plus the /auth/*
// redirect handshake, nothing more.
AuthBlock:
    'auth' '{'
        (
            ('provider' ':' provider=ID ','?)
          | ('oidc' oidc=OidcConfig ','?)
          | ('sessions' ':' sessions=SessionMode ','?)
          | ('claims' ':' claims=ClaimsMap ','?)
          | ('enforcement' ':' enforcement=Enforcement ','?)
        )*
    '}';

OidcConfig:
    '{'
        (
            ('issuer' ':' issuer=AuthConfigValue ','?)
          | ('clientId' ':' clientId=AuthConfigValue ','?)
          | ('clientSecret' ':' clientSecret=AuthConfigValue ','?)
          | ('audience' ':' audience=AuthConfigValue ','?)
          | ('scopes' ':' '[' scopes+=STRING (',' scopes+=STRING)* ','? ']' ','?)
        )*
    '}';

// A config value is either a string literal or an `env("VAR")` reference
// resolved at runtime — mirrors the storage connection-source pattern so
// issuer URLs and client secrets never land in source.
AuthConfigValue:
      {infer LiteralAuthValue} value=STRING
    | {infer EnvAuthValue} 'env' '(' env=STRING ')';

ClaimsMap:
    '{'
        (entries+=ClaimEntry (',' entries+=ClaimEntry)* ','?)?
    '}';

// Maps an IdP claim path (`realm_access.roles`) onto a `user { … }`
// field.  The target reuses UserFieldName so `id` / `permissions` are
// admissible.
ClaimEntry:
    field=UserFieldName ':' path=STRING;

SessionMode returns string:
    'cookie' | 'jwt';

Enforcement returns string:
    'denyByDefault' | 'opt';

// System-level tenancy declaration.  Sibling to `user { … }` and
// `auth { … }`: names WHICH user claim partitions the data
// (`user.tenantId`) and WHICH aggregate is the tenant registry
// (`of Organization`).  The `user.` prefix is fixed surface syntax; both
// bindings are real cross-references — `claim` resolves against the
// system's `user { … }` fields (a targeted `ddd-scope.ts` arm exposes
// them in this position only) and `registry` against the globally
// exported aggregates, so a bad name is a linking error, not a themed
// validator code.  At most one per system (validator enforces).
//
//   tenancy by user.tenantId of Organization
TenancyDecl:
    'tenancy' 'by' 'user' '.' claim=[UserField:UserFieldName] 'of' registry=[Aggregate:ID];

// E2E test against a running deployable.  The body reuses the per-
// aggregate TestStatement vocabulary (let / expect / bare-call), but
// expressions can additionally reference the magic
// `api` identifier rooted at the named deployable's HTTP surface
// (e.g., `api.orders.create({...})`).  Renders to a vitest test file
// at the system output root.
TestE2E:
    'test' 'e2e' name=STRING 'against' deployable=[Deployable:LooseName]
        ('verifies' verifies=[TestCase:TraceId])? '{'
        body+=TestStatement*
    '}';

Subdomain:
    'subdomain' name=ID '{'
        (contexts+=BoundedContext | permissions+=PermissionsBlock)*
    '}';

// Per-subdomain permission catalogue.  Each declaration becomes a typed
// identifier (`permissions.<name>`) usable in operation / workflow /
// view-bind expressions; lowering rewrites the reference to its
// runtime string `<lowercase-subdomain>.<name>` so handlers can compare
// against `currentUser.permissions: string[]` claims without
// hand-spelling the strings.  Multiple `permissions { ... }` blocks
// in one subdomain merge their declarations.
PermissionsBlock:
    'permissions' '{'
        (decls+=PermissionDecl (','? decls+=PermissionDecl)* ','?)?
    '}';

PermissionDecl:
    name=ID;

Deployable:
    'deployable' name=LooseName '{'
        // The optional `{ … }` block decomposes the platform bundle into
        // orthogonal realization axes.  `platform` stays a direct string
        // property (every AST/IR consumer reads `d.platform` as a string);
        // the block is additive and optional, so bare `platform: dotnet`
        // parses unchanged.  Axis values are `LooseName` — the menu is
        // enforced by the validator, not the parser (the `design:` precedent).
        ('platform' ':' platform=Platform
            ('{' (
                  'persistence' ':' persistence=LooseName ','?
                | 'directoryLayout' ':' directoryLayout=LooseName ','?
            )* '}')?
            ','?)
        // The remaining clauses are ORDER-INDEPENDENT: each is introduced by
        // a distinct keyword, so an interleaving `(...)*` group parses them in
        // any order (same shape as the realization-axes sub-block above). The
        // value of a ref clause is a single token consumed before the loop
        // re-checks the next clause keyword, so reordering introduces no
        // ambiguity. (`platform` stays first as the deployable's lead.)
        (
            // Contexts the deployable hosts (refs are BoundedContext, not the
            // subdomain wrappers).
            ('contexts' ':' '[' contextRefs+=[BoundedContext:ID] (',' contextRefs+=[BoundedContext:ID])* ','? ']' ','?)
            // The deployable's dataSource ↔ context bindings.  Each ref points
            // at a system-level `dataSource { for: …, kind: …, use: … }`
            // declaration. Validator enforces (a) every listed dataSource's
            // `for:` is one of `contexts:`; (b) per (context, kind) uniqueness;
            // (c) every aggregate's required kind has a matching dataSource for
            // its hosting context.
          | ('dataSources' ':' '[' dataSourceRefs+=[Resource:LooseName] (',' dataSourceRefs+=[Resource:LooseName])* ','? ']' ','?)
          | ('targets' ':' targets=[Deployable:LooseName] ','?)
            // Explicit api composition. Backend deployables declare which
            // contracts they serve via `serves:`.
          | ('serves' ':' serves+=[Api:ID] (',' serves+=[Api:ID])* ','?)
            // UI binding — references a `ui { ... }` block at system scope:
            //   ui: WebApp                            // sugar — no params
            //   ui: WebApp { Sales: salesApi, ... }   // compose-block
            // (The legacy colon-less `ui WebApp { framework: react }` block
            // form was removed — set `framework:` on the `ui` declaration.)
          | (uiSugar=UiSugarBinding | uiCompose=UiComposeBinding)
            // `hosts:` is the host↔ui relation. Bracketed multi form mirrors
            // `contexts:`/`dataSources:`; the bare single form takes one ref.
            // (The bracketed form avoids the unbracketed-comma swallow where
            // `hosts: A, design` would read `design` as another ref.)
          | ('hosts' ':' (
                '[' hosts+=[Ui:ID] (',' hosts+=[Ui:ID])* ','? ']'
              | hosts+=[Ui:ID]
            ) ','?)
          | ('port' ':' port=INT ','?)
          | ('auth' ':' auth=AuthMode ','?)
          | ('design' ':' design=DesignPack ','?)
            // Optional favicon path — relative to the .ddd source file. The
            // React generator copies it into `public/favicon.<ext>` and the
            // index.html shell emits a `<link rel="icon">`.
          | ('favicon' ':' favicon=STRING ','?)
        )*
    '}';

// Frontend composition.  `ui: WebApp { Sales: salesApi }` binds each UI api
// parameter (the `Sales` declared as `api Sales: SalesApi` in the ui block)
// to the backend deployable that supplies that contract.  Validator enforces
// that `salesApi.serves: SalesApi`.
UiComposeBinding:
    'ui' ':' ref=[Ui:ID] '{'
        (bindings+=UiParamBinding (',' bindings+=UiParamBinding)* ','?)?
    '}';

UiParamBinding:
    name=LooseName ':' source=[Deployable:LooseName];

// The per-(context, kind) binding from a context's aggregates to a physical
// `storage` — the configured realization of a logical need.  All `for:` /
// `kind:` / `use:` are required by the validator; declared as optional in the
// grammar so missing-field diagnostics are friendlier than a hard parse
// error.  Per-kind config keys (schema, every, retain, …) are validated
// against the resolved storage's `type`.
Resource:
    'resource' name=LooseName '{'
        ('for'  ':' context=[BoundedContext:ID] ','?)?
        ('kind' ':' kind=DataSourceKind ','?)?
        ('use'  ':' use=[Storage:LooseName] ','?)?
        ('schema'         ':' schema=STRING ','?)?
        ('tablePrefix'    ':' tablePrefix=STRING ','?)?
        ('keyPrefix'      ':' keyPrefix=STRING ','?)?
        ('ttl'            ':' ttl=INT ','?)?
        ('every'          ':' every=INT ','?)?
        ('retain'         ':' retain=INT ','?)?
        ('isolationLevel' ':' isolationLevel=IsolationLevel ','?)?
        ('readonly'       ':' readonly?='true' ','?)?
        ('shape'          ':' shape=SavingShape ','?)?
        ('index' ':' '[' indexes+=IndexSpec (',' indexes+=IndexSpec)* ','? ']' ','?)?
        ('config' ':' '{' (config+=ConfigEntry (',' config+=ConfigEntry)* ','?)? '}' ','?)?
    '}';

// A manual performance index on the storage binding — pure infrastructure,
// never on the aggregate.  The target entity is named EXPLICITLY
// (`Project.name`), never inferred from which table happens to own the
// column — the binding knows the context's shape, so the index says which
// entity it is on.  `Entity.col` is a single-column index; `Entity.(a, b)` a
// composite.  The entity may be an aggregate OR one of its contained parts
// (an inner entity's own table).  Always non-unique (uniqueness is the domain
// `unique (...)` invariant).
IndexSpec:
    entity=ID '.' ('(' columns+=LooseName (',' columns+=LooseName)* ')' | columns+=LooseName);

DataSourceKind returns string:
    'state' | 'eventLog' | 'snapshot' | 'cache' | 'replica'
    | 'objectStore' | 'queue' | 'api';

UiSugarBinding:
    'ui' ':' ref=[Ui:ID] ','?;

// Frameworks the `ui:` mount lowers against.  `react` renders TSX against a
// design pack (`mantine`/`shadcn`); `phoenixLiveView` renders HEEx against
// the `coreComponents` pack as part of a fullstack Elixir deployable (plain
// Ecto/Phoenix).  `svelte` renders Svelte 5 (SvelteKit static SPA) against a
// svelte-format design pack (`shadcnSvelte`/`flowbite`); `vue` renders Vue 3
// (Vite SPA + vue-router) against a vue-format design pack
// (`vuetify`/`shadcnVue`).
Framework returns string:
    'react' | 'svelte' | 'vue' | 'angular' | 'feliz' | 'phoenixLiveView';

// Backend platforms accept a quoted `family@version` pin
// (`platform: "node@v4"`) via the STRING alternative — symmetric with
// `DesignPack` below.  Bareword keywords are unchanged so every existing
// source parses identically; the validator + lowering
// (`parseBuiltinPlatformRef`) are the resolution authority.  `node` is the
// canonical name for the JS runtime backend (Hono web framework); `elixir`
// for the plain Ecto/Phoenix backend; `python` for the FastAPI + SQLAlchemy
// backend.
Platform returns string:
    'dotnet' | 'node' | 'react' | 'svelte' | 'vue' | 'angular' | 'feliz' | 'static' | 'elixir' | 'python' | 'java' | STRING;

// Design-system pack selector — picks the template pack the UI
// generator renders pages against.  `mantine` (default), `shadcn`,
// and `mui` are React/TSX packs; `coreComponents` is the HEEx pack for
// the Phoenix LiveView platform; `shadcnSvelte` and `flowbite` are
// the Svelte packs; `vuetify` and `shadcnVue` are the Vue packs;
// `angularMaterial`, `primeng`, and `spartanNg` are the Angular packs.
// STRING points at a custom pack:
// a directory with `pack.json` resolved relative to the .ddd file.
// Only meaningful when the deployable mounts a UI; ignored
// otherwise.  Named `design` (not `ui`) to avoid colliding with
// the test-DSL's `ui.workflows.X(...)` accessor.
DesignPack returns string:
    'mantine' | 'shadcn' | 'mui' | 'chakra' | 'coreComponents' | 'daisyui' | 'shadcnSvelte' | 'flowbite' | 'vuetify' | 'shadcnVue' | 'angularMaterial' | 'primeng' | 'spartanNg' | STRING;
// Per-deployable auth opt-in.  `required` enables JWT-decode middleware
// and the user-supplied verifier hook on a backend; `ui` mounts the
// login redirect + route guard on a frontend (react / LiveView) under a
// system `auth { … }` block.  Absence keeps the deployable open
// (existing behaviour).  Future modes (`optional`, `forbidden`) can
// extend the union without touching consumers.
AuthMode returns string:
    'required' | 'ui';

// ---------------------------------------------------------------------------
// Page metamodel
//
// `ui` is a SystemMember peer to `module` / `deployable` / `theme` /
// `user`.  It owns pages, components, scaffold directives, and an
// optional sidebar menu.  Six declaration keywords are introduced:
//   ui, page, component, scaffold, state, menu
// Plus two expression-level reserved tokens (later in the grammar):
//   match, else
//
// `section` and `link` inside `menu`, and `framework` inside the `ui`
// declaration, are soft keywords scoped to their parent block — they
// remain free as ordinary identifiers elsewhere.
// ---------------------------------------------------------------------------

Ui:
    'ui' name=ID withClause=WithClause? '{'
        // The UI's framework is part of its own technical identity, not
        // derived from the host backend.  Optional + additive — existing
        // sources omit it and keep the legacy "framework derived from the
        // deployable's platform" path until the `hosts:` work consumes it.
        ('framework' ':' framework=Framework ','?)?
        members+=UiMember*
    '}';

UiMember:
    UiApiParam | UiChannelParam | UiNotification | UiFunction | Page | Component | Store | Area | MenuBlock;

// Shared client-side state container — a top-level `ui` member, sibling to
// `page` / `component`.  Holds named `state {}` + named `action`s, reused
// VERBATIM from the page/component surface; the body interleaves both
// (`StoreDecl: StateBlock | ActionDecl`).  There is NO `use` clause — a store
// is referenced purely by DOTTED qualified name from a page/component body
// (`Cart.lines` read, `Cart.clear()` call); the per-page store dependency is
// DERIVED from the page's resolved refs at emit time, never bound per-surface.
//
// An optional `persist: memory|local|session|url` modifier picks where the
// store's state lives (default = in-memory).  ONE new keyword `persist:`; the
// value is a validated *identifier* (`StorePersist.value`), NOT a keyword, so
// `url` / `local` / `session` / `memory` stay usable as ordinary
// field/aggregate names everywhere — sidestepping the reserved-word breakage
// that literal value keywords would cause.  The value ∈
// {memory,local,session,url} is checked in the AST validator
// (`loom.store-lifetime-invalid`); lowering maps it onto the
// `StoreIR.lifetime` enum.
Store:
    'store' name=ID ('persist' ':' lifetime=LooseName)? '{'
        decls+=StoreDecl*
    '}';

StoreDecl:
    StateBlock | ActionDecl;

// Page grouping — an `area` clusters pages (and sub-areas) into a named
// functional division.  Grouping is by containment: a contained page's file
// lands at `src/pages/<area-path>/<page>.tsx`, the path joining down the
// nesting.  Optional + additive — area-less pages stay flat.  Carries
// name + members only; a base `route:` prefix and cascading
// layout/requires/label are the documented growth path.
Area:
    'area' name=ID '{'
        members+=AreaMember*
    '}';

AreaMember:
    Page | Area;

// ---- api declaration (system-level) ----------------------------
//
// First-class API contract derived from a module's domain (its
// aggregates, repositories, workflows, views).  Full surface
// auto-derived from `from <Module>`; future: customization
// (hide, rename, expose subset, version).
//
//   api SalesApi from Sales
//
// Peer to module / ui / deployable.  Pure declarative — what's
// available; consumers (ui, deployable) reference it by name.
Api:
    'api' name=ID withClause=WithClause? ('from' source=[Subdomain:ID])?
        ('{'
            ('urlStyle' ':' urlStyle=('literal' | 'resource'))?
            (statuses+=ApiStatus)*
            (routes+=Route)*
        '}')?;

// Per-error HTTP status override for the exception-less ProblemDetails
// translator.  `httpStatus <Error> -> <Code>` overrides the stdlib default for
// an `error` payload this api can return.  `httpStatus` (not `status`) is the
// clause head so the very common `status: OrderStatus` field name keeps
// parsing without a soft keyword; the `->` ("maps to") separator matches house
// style (`route`/`link`/`migration`).
ApiStatus:
    'httpStatus' error=ID '->' code=INT;

// Explicit transport binding:
//
//   route POST "/orders" -> Ordering.PlaceOrder
//
// A single line binding an HTTP method + path to a named handler in a
// bounded context.  `target` is a `HandlerRef` (`Context.Handler`); the
// `context` segment is a real cross-ref (existing global scope for
// `BoundedContext`), while the `handler` segment is a plain name resolved
// by the IR validator (it spans commandHandler | queryHandler | workflow
// handle — three kinds one Langium cross-ref can't span cleanly).  These
// nodes ride alongside `ApiIR` and are not yet read by any backend.
Route:
    'route' method=HttpMethod path=STRING '->' target=HandlerRef;

HttpMethod returns string:
    'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

HandlerRef:
    context=[BoundedContext:ID] '.' handler=ID;

// ---- storage declaration (system-level) ------------------------
//
// First-class declaration of a storage instance — a typed slot the deployable
// composition picks up via the `dataSources:` clause (a deployable lists the
// system-level `dataSource { for:, kind:, use: }` bindings it hosts).
// Reusable across deployables (one Postgres serves the api server + worker
// service).
//
//   storage primarySql   { type: postgres }
//   storage hotCache     { type: redis }
//   storage warehouse    { type: clickhouse }
//
// type enum: postgres | mysql | sqlite | inMemory (transactional
// stores); redis (cache); elastic | meilisearch (search); kafka
// (events); clickhouse | bigquery (analytics).  Only postgres /
// inMemory have generator-side support; the rest parse + validate
// but emit nothing yet.
Storage:
    'storage' name=LooseName '{'
        ('type' ':' type=StorageType ','?)
        ('instance' ':' instance=ID ','?)?
        ('connection' ':' connection=ConnectionSource ','?)?
        ('config' ':' '{' (config+=ConfigEntry (',' config+=ConfigEntry)* ','?)? '}' ','?)?
    '}';

// Generic vendor-parameter map.  Keys are validated per sourceType against
// the registry's config schema in IR validation; no per-vendor clause
// keywords are introduced.
ConfigEntry:
    key=LooseName ':' value=ConfigValue;

ConfigValue:
      {infer StringConfigValue} value=STRING
    | {infer IntConfigValue}    value=INT
    | {infer BoolConfigValue}   value=BoolLiteral;

BoolLiteral returns string: 'true' | 'false';

StorageType returns string:
      'postgres' | 'mysql' | 'sqlite' | 'inMemory'
    | 'redis'
    | 'elastic' | 'meilisearch'
    | 'kafka'
    | 'clickhouse' | 'bigquery'
    | 's3' | 'rabbitmq' | 'nats' | 'restApi';

ConnectionSource:
      {infer ServiceConnectionSource} 'service' '(' service=ID ')'
    | {infer EnvConnectionSource}     'env'     '(' env=STRING ')'
    | {infer SecretConnectionSource}  'secret'  '(' secret=ID ')'
    | {infer LiteralConnectionSource} 'literal' '(' literal=STRING ')';

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

// ---- channel subscription (ui surface) --------------------------
//
//   channel Orders: Sales.Lifecycle
//
// Subscribes this UI to a context's `delivery: broadcast` channel.
// The wire format (SSE vs WebSocket) is an infra fact derived from
// the frontend's platform — never stated here; the scope provider
// resolves `channel` within the named context.
UiChannelParam:
    'channel' name=ID ':' context=[BoundedContext:ID] '.' channel=[Channel:ID];

// Frontend logic escape hatch:
//
//   function initials(name: string): string extern from "./helpers/initials"
//
// A typed pure function implemented by a hand-written module.  Loom emits
// a typed signature (`src/lib/extern/<name>.signature.ts`) + a conformance
// shim (`src/lib/<name>.ts`, `export const <name>: <Name>Fn = _impl`) so a
// missing module or mismatched signature fails `tsc` — the fail-fast.
// Page bodies call it through the shim.  Extern-only (a bodied ui-level
// function has no walker consumer); the keyword reuses the aggregate-member
// `function` — ui-member position disambiguates.
UiFunction:
    'function' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' ':' returnType=TypeRef
        'extern' 'from' externPath=STRING;

// ---- live-event handler --------------------------------------------
//
//   on Orders.OrderShipped(e) { toast("Order " + e.order + " shipped") }
//
// Renders the event itself (toast / feed / badge) when it arrives on
// the subscribed channel's realtime wire.  Restricts the body to
// `toast(<expr>)` calls (validator rule `loom.ui-handler-unsupported`).
// A live READ needs no marker — an ordinary cached query auto-freshens.
UiNotification:
    'on' param=[UiChannelParam:ID] '.' event=[EventDecl:ID]
        '(' bind=ID ')' '{' body+=AssignOrCallStmt* '}';

// ---- page ---------------------------------------------------------------

Page:
    'page' name=ID ('(' (params+=Parameter (',' params+=Parameter)*)? ')')? '{'
        props+=PageProp*
    '}';

PageProp:
      RouteProp | TitleProp | RequiresProp | StateBlock | DerivedProp | ActionDecl | BodyProp | PageMenuMeta
    | LayoutProp | DescriptionProp | OgImageProp | CanonicalProp;

// Named, typed page/component event handler — `action next() { … }`.
// Names today's anonymous handler lambda: a declared identity + a typed
// payload param list + a statement block (reusing the existing `Parameter`
// and `Statement` rules — NO new statement semantics).  Positionally
// distinct from the `ActionType` param-slot type (`action(Order)`,
// a handler-typed component PARAM) and the `Action {}` render
// primitive (PascalCase builder-call in body position) — `action`
// here leads a member declaration in a page/component body.  A
// call site references it by bare name (`onSubmit: next`); the
// reference resolves + carries the action's param type during
// lowering so backends never re-resolve.
ActionDecl:
    'action' name=(ID | 'write') '(' (params+=Parameter (',' params+=Parameter)*)? ')'
        '{' stmts+=Statement* '}';

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

// Named layout declaration.  A page or ui can opt into a named layout
// (`layout: AdminFrame`) which lowers to a wrapping React Router
// layout-route around the page body, similar to the default AppShell but
// built from user-defined slots.  Reserved names `default` and `none` cannot
// be redeclared (validator).
//
// Each slot's body is a single Expression evaluated in the same
// scope as a page body — so it can reference walker-stdlib primitives
// (Sticky, Container, Group, …) and user-declared components.
// `main` is a special slot with no body — it marks
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

// Per-page sidebar metadata.  Read by the menu emitter when
// no explicit `ui`-level `menu { ... }` block is declared.  Recognised
// keys are `section` (string), `label` (string), `order` (int),
// `hidden` (bool).  We accept any `ID` here and let the validator
// enforce the allowed names — same pattern `ThemeProp` uses.
// Promoting these to grammar-level keywords would pollute the lexer and
// break user fields named `order` / `label` / `hidden` in domain
// aggregates (e.g. `event LineAdded { order: Id<Order> }`).
PageMenuMeta:
    'menu' '{'
        (entries+=MenuMetaEntry (','? entries+=MenuMetaEntry)* ','?)?
    '}';

MenuMetaEntry:
    name=LooseName ':' value=Expression;

// ---- component ----------------------------------------------------------

// A `component` is normally a typed function from params to a walked
// body.  An `extern` component instead hands rendering to a
// hand-written file: `component X(...) extern from "<src-relative
// path>"` declares the typed param contract but no `body:` — the
// generator imports the user's module at call sites and emits a
// `<Name>.props.ts` typed-props interface (the UI escape hatch).  The
// `extern` keyword always carries its `from` path; the body is omitted
// (the validator pins both halves of this exclusivity).
Component:
    'component' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')'
        (extern?='extern' 'from' externPath=STRING)?
        ('{'
            decls+=ComponentDecl*
            ('body' ':' body=Expression)?
        '}')?;

ComponentDecl:
    StateBlock | DerivedProp | ActionDecl;

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
    ID | CommonSoftKeywords
    // StateFieldName-only extras (structural keywords not in the shared
    // value core; page/component `state {}` field name).  Composing CommonSoftKeywords here also closes the
    // "declarable-but-unreadable" class (M-T5.18 Track C, BUG-004: `e.resource`).
;

// ---- menu ---------------------------------------------------------------

// Optional `ui`-level sidebar block.  When present, it is the source
// of truth for sidebar structure; when absent, sidebar is derived
// from per-page `menu { … }` metadata (PageMenuMeta) grouped by
// `section`.
MenuBlock:
    'menu' '{'
        sections+=MenuSection*
    '}';

MenuSection:
    'section' label=STRING '{'
        (links+=MenuLink (','? links+=MenuLink)* ','?)?
    '}';

// Page links use a real Langium cross-reference now that scaffold
// expansion runs at the AST level.  Synthesised pages are real `Page` AST
// nodes by the time the linker runs, so `[Page:ID]` resolves through
// Langium's standard machinery — IDE affordances (autocomplete, go-to-def,
// find-refs, rename) follow.
MenuLink:
      'link' page=[Page:QualifiedPageName] ('{' (props+=MenuLinkProp (','? props+=MenuLinkProp)* ','?)? '}')?
    | 'link' externalLabel=STRING '->' externalUrl=STRING;

// Same approach as MenuMetaEntry — `LooseName` + validator-side
// check of the allowed key names (`label`, `order`).
MenuLinkProp:
    name=LooseName ':' value=Expression;

// ---------------------------------------------------------------------------
// Traceability — Requirement / Solution / TestCase.
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
// code.
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
// example aggregates).  The validator enforces the allowed key set
// { type, title, status, priority }, that `type` + `title` are
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
    Subdomain | BoundedContext | Aggregate | ValueObject | EventDecl
  | Repository | Workflow | View | Operation | Deployable | Api;

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

BoundedContext:
    'context' name=ID withClause=WithClause? '{'
        members+=ContextMember*
    '}';

ContextMember:
    EnumDecl | ValueObject | Aggregate | EventDecl | PayloadDecl | Repository | Workflow | View
    | Seed | Criterion | Retrieval | FilterDecl | StampDecl | ImplementsDecl | Channel | DomainService
    | Projection | PolicyDecl | CommandHandler | QueryHandler;

// Application-layer handlers — top-level context members, effectively a
// workflow `handle` lifted out when the orchestration is single-aggregate.
// Function-signature form mirrors `Operation` / `HandleDecl`; the body reuses
// the same `Statement*` grammar (load → mutate → save → return).
//
//   commandHandler PlaceOrder(cmd: PlaceOrderCommand): OrderResponse { … }
//   queryHandler   GetOrderById(q: OrdersByIdQuery): OrderResponse { … }
//
// `queryHandler` ALWAYS carries a return type (it produces a response);
// `commandHandler` MAY omit it (a `: void`-equivalent destroy-style
// handler).  Layering contracts (queryHandler must not save; a
// commandHandler may touch only one aggregate) are enforced by the IR
// validator, not the grammar.
// An `extern` handler is BODYLESS (`;`): it declares the signature (params +
// return contract) but hands the implementation to a scaffold-once, user-owned
// impl file the generated dispatch calls (one external-service call around one
// aggregate).  `'{' … '}' | ';'` is the discriminator (distinct tokens — the
// AST stays non-recursive, mirroring FunctionDecl's `'=' | '{'`); the
// extern-vs-body pairing is enforced by the AST validator
// (`loom.extern-handler-has-body` / `loom.handler-missing-body`), not the
// grammar.
CommandHandler:
    (extern?='extern')? 'commandHandler' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' (':' returnType=TypeRef)?
        ( '{' body+=Statement* '}' | ';' );

QueryHandler:
    (extern?='extern')? 'queryHandler' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' ':' returnType=TypeRef
        ( '{' body+=Statement* '}' | ';' );

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

// `abstract` base + `extends` subtype + `inheritanceUsing(…)` layout are
// the aggregate-inheritance surface.  An `abstract` base can never be
// instantiated, has no repository, and emits no table of its own; `extends
// <Base>` may only target an `abstract` aggregate.  `inheritanceUsing(…)` is a
// header colon modifier — all aggregate config lives on the header, alongside
// `persistedAs(…)` / `shape(…)`.
Aggregate:
    // `crossTenant` is a header flag mirroring `isAbstract` — declares
    // shared-reference data that opts out of the tenant filter under a
    // `tenancy by` system.  Positioned before the colon modifiers and the
    // with-clause: `aggregate Plan crossTenant { … }`,
    // `aggregate Invoice crossTenant with x { … }`.
    //
    // The aggregate id is always a `guid` — Loom mints it.
    // M-T5.17 (finding #1) — Phase 2 cutover: the enum-axis modifiers are COLON
    // clauses (`persistedAs: eventLog`), matching every other enum-value pick in
    // Loom (`type:`, `kind:`, `platform:`).  The legacy paren form was removed
    // (corpus codemodded).  The three are ORDER-INDEPENDENT (a distinct keyword
    // leads each, so the interleaving `(…)*` group is unambiguous), which also
    // kills the old silent reorder-is-a-parse-error papercut.  `crossTenant`
    // leads beside `abstract` (both boolean adjectives before `aggregate`).
    (isAbstract?='abstract')? (crossTenant?='crossTenant')? 'aggregate' name=ID ('extends' superType=[Aggregate:ID])?
        (
            ('persistedAs' ':' persistedAs=TruthKind ','?)
          | ('shape' ':' shape=SavingShape ','?)
          | ('inheritanceUsing' ':' inheritanceUsing=InheritanceLayout ','?)
        )*
        withClause=WithClause? '{'
        members+=AggregateMember*
    '}';

// Inheritance table layout — a header colon modifier on aggregates
// participating in inheritance.
//   - `sharedTable` — TPH: one table for the whole hierarchy + a `kind`
//     discriminator column.  `Party id` refs target the single base table.
//   - `ownTable`    — TPC: one table per concrete; no base table.  Bare
//     `Party id` refs to such a base are forbidden (FK target ambiguous).
// Only valid on an `abstract` base or an `extends` subtype.  A
// `persistedAs: eventLog` or `shape: document` concrete of a `sharedTable`
// base is forced to `ownTable` — a validator error, so the author writes the
// forced modifier explicitly.
InheritanceLayout returns string:
    'sharedTable' | 'ownTable';

// The aggregate's primary truth kind, a header colon modifier (replaces the
// former body `persistenceStrategy:` clause).  Values align to the
// `dataSource` `kind` set so the IR→binding mapping is an identity.  Default
// (absent) is `state`.
TruthKind returns string:
    'eventLog' | 'state';

// Saving shape of the materialised read model / snapshot — how the
// aggregate's hierarchy is physically laid out.  Header colon modifier on the
// aggregate (`shape: document`); colon entry on the `dataSource` binding
// (`shape: document`).  Three points on the relational↔document spectrum
// (default absent = `relational`):
//   - `relational` — table-per-entity (root columns + child tables + join tables)
//   - `embedded`   — queryable root row + contained parts folded into JSONB columns
//   - `document`   — the whole aggregate serialised as one opaque JSONB blob (Marten-style)
SavingShape returns string:
    'relational' | 'embedded' | 'document';

// ---- macro `with` clause ----------------------------------------
//
// Attaches one or more macro invocations to an aggregate (later: ui,
// property).  Macro names resolve against a TS-side registry loaded
// from the toolchain stdlib and from project-local `.loom/macros/*.ts`
// modules.  Expansion runs at the AST level (see the macro expander)
// before linking, so synthesised members participate in scope resolution
// and validation as if user-written.
WithClause:
    'with' calls+=MacroCall (',' calls+=MacroCall)*;

MacroCall:
    name=ID ('(' (args+=MacroArg (',' args+=MacroArg)*)? ')')?;

// Arg names accept the same soft-keyword set as LooseName so
// macros may use `modules:`, `aggregates:`, etc. as parameter
// names — the same identifier surface the legacy `scaffold` directive
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
// IDE go-to-definition on macro args is served by a custom
// DefinitionProvider rather than by routing through Langium's linker.
MacroArgValue:
    {infer MacroArgString} string=STRING
    | {infer MacroArgBool} bool=('true' | 'false')
    | {infer MacroArgInt} int=INT
    | {infer MacroArgRef} ref=ID
    | {infer MacroArgRefList} '[' (refs+=ID (',' refs+=ID)*)? ']';

AggregateMember:
    Containment | DerivedProp | Invariant | Unique | FunctionDecl | Operation | Create | Destroy | EntityPart | TestBlock | Property
    | FilterDecl | StampDecl | ImplementsDecl | Apply;

// ---- capability source surface ----------------------------------
//
// `filter` / `stamp` are first-class aggregate/context members lowering to
// `AggregateIR.contextFilters` / `.contextStamps`; `implements <Cap>` is the
// typed capability application.  A `capability` declaration's body is built
// from these same node types, and the expander splices them into a host's
// members[] — anything a capability contributes, a user can hand-write.
//
// At ContextMember position `filter` / `stamp` propagate to every aggregate
// inside the context at lowering time (see `lowerContext`).

// `filter <expr>` declares a query-filter predicate.  At aggregate
// scope it applies to that aggregate only.  At context scope it
// applies to every aggregate inside (propagated at lowering time).
FilterDecl:
    'filter' expr=Expression;

// `stamp <event> { ... }` declares lifecycle-stamping assignments.
// At aggregate scope applies to that aggregate; at context scope
// propagates to every aggregate.
StampDecl:
    'stamp' event=StampEvent '{'
        assignments+=AssignOrCallStmt*
    '}';

StampEvent returns string:
    'onCreate' | 'onUpdate';

// ---- policy block ------------------------------------------------
//
// A `policy {}` context member declares record-level read reachability for
// tenant-owned aggregates: the directional read ladder
// `local`/`deep`/`global`.  Each `allow <level> on <Aggregate>` rule selects
// one aggregate's read scope, lowering to a rewrite of that aggregate's
// `tenantOwned` capability filter (its `contextFilters` entry) — so it rides
// the exact per-backend query-filter seams the tenant floor already uses.
//
// This surface is the read ladder only.  The full policy DSL
// (operation/view/workflow gates, field masking, `function`/`let` helpers)
// is later work and is deliberately NOT in this grammar.
//
// `target` is a bare `ID` resolved by NAME against the enclosing context's
// aggregates in IR validation (`loom.policy-*` diagnostics) — NOT a Langium
// cross-reference, so an unknown aggregate surfaces a controlled `loom.*`
// error rather than a generic linker message, and the scope provider needs no
// change.  `name` is optional (a context may hold one anonymous policy).
//
// FUNCTION FORM: `policy <Name>(<params>): bool ( = <expr> | { <expr> } )` is
// a named, ambient, parameterised boolean AUTHORIZATION predicate — the
// reusable twin of an inline `requires` gate, referenced from a
// `requires PolicyName(args)` clause and INLINED at that gate (like a
// `criterion … of bool`).  It shares the `policy` head with the read-ladder
// block; the two are disambiguated after the name by the next token — `(`
// opens a function, `{` opens a read-ladder block.  The parentheses are
// therefore REQUIRED (even for zero params).  `returnType` present ⇒ function
// form; a block form leaves it undefined.
PolicyDecl:
    'policy' (
        '{' rules+=PolicyReadRule* '}'
      | name=ID (
            '(' (params+=Parameter (',' params+=Parameter)*)? ')' ':' returnType=TypeRef
                ( '=' body=Expression | '{' body=Expression '}' )
          | '{' rules+=PolicyReadRule* '}'
        )
    );

// `allow [write] <level> on <Aggregate>` — the optional `write` verb selects
// the ladder: bare = the read reachability ladder; `write` gates INSTANCE
// mutations (update-style ops, destroy, applier dispatch) on the target row's
// write scope.  `write global` PARSES but is an IR validator error
// (`loom.policy-write-global-unsupported`) — root-subtree-wide mutation is a
// footgun; only `write local` (the default floor) and `write deep` are
// offered.  There is deliberately NO `read` verb synonym: `read` is far too
// common a user identifier (`let read = …`) to promote to a keyword, so the
// read form stays bare.  The rule name stays `PolicyReadRule` (both verbs are
// policy rules structurally); the IR splits them by verb.
//
// `deny [write] on <Aggregate>` — the DENY-WINS carve-out.  `effect`
// discriminates the two forms: `allow` carries a widening `level`
// (local/deep/global); `deny` is ALL-OR-NOTHING at the aggregate — no level
// word (a partial deny is field-mask / `data {}` row-clause territory of a
// later slice).  Deny reuses the same optional `write` verb: bare `deny on X`
// denies READ (the aggregate becomes invisible; the write command load —
// which reuses the read filter — fails too), `deny write on X` denies only
// WRITE (reads stay, mutations 404).  Deny wins over allow, resolved in
// enrichment.  Only new keyword is `deny` (`read` is still not one).
PolicyReadRule:
      effect='allow' (verb=PolicyVerb)? level=ReadLevel 'on' target=ID
    | effect='deny' (verb=PolicyVerb)? 'on' target=ID;

// The optional policy verb.  Absent = read.  `write` is the only new keyword —
// see the note above on why `read` is not one.
PolicyVerb returns string:
    'write';

// The directional read ladder:
//   - `local`  — the caller's own org node (today's `tenantId ==` floor; default)
//   - `deep`   — the caller's org + all descendants (`dataKey` path prefix)
//   - `global` — all in the caller's tenant (tenant-root-floored)
// A closed set — an unknown level name is a parse error, so no validator arm
// is needed for it.
ReadLevel returns string:
    'local' | 'deep' | 'global';

// `implements <Cap>` is the typed capability-application form — a synonym of
// `with <Cap>`: the expander splices the referenced capability's fields +
// filter + stamp into the host aggregate (or, at context scope, every
// aggregate in the context).  Resolved by the expander's document-wide
// capability inventory, like `with` (see `Capability` below), not a Langium
// cross-reference.
ImplementsDecl:
    'implements' cap=ID;

// ---- typed capability declaration -------------------------------
//
// A `capability` is a PURE MIXIN: a named bundle of fields + `filter` +
// `stamp`, everything in its body PROVIDED to implementors.  No
// ownership keywords (`requires`/`provides`) — declaring a member IS the
// capability providing it; no operations / structure (those stay
// macros).  A `capability` is the declared, in-language successor to the
// field/filter/stamp macros (`audit`/`softDelete`): its body holds the
// same AST member nodes a macro emits (`Property`/`FilterDecl`/
// `StampDecl`).
//
// Aggregates opt in via the `with` / `implements` clause.  References are
// resolved by the macro expander's document-wide inventory (like macro
// names + macro-arg refs — see `WithClause` / `MacroArgValue` above and
// the rationale at `MacroArgValue`), NOT a Langium cross-reference: macro
// expansion runs before linking, so the expander splices a referenced
// capability's members into the host aggregate's `members[]`,
// indistinguishable from user-written ones.  Everything downstream
// (scope, lower, enrich, validate, codegen) is unchanged.
//
// Top-level declarable (a `SystemMember`); globally visible because the
// expander resolves by name, not by Langium scope.
Capability:
    'capability' name=ID '{'
        (members+=CapabilityMember ','?)*
    '}';

CapabilityMember:
    Property | FilterDecl | StampDecl;

TestBlock:
    'test' name=STRING ('verifies' verifies=[TestCase:TraceId])? '{'
        body+=TestStatement*
    '}';

TestStatement:
    ExpectStmt | PreconditionStmt | LetStmt | EmitStmt | AssignOrCallStmt;

// Assertions are method-based: `expect(<actual>).<matcher>(…)`.  The matcher
// is an intrinsic (`toBe` / `toThrow` / `toHaveText` / …) recognised by the
// lowering + validator — a bare-boolean `expect <x>` is rejected
// (`checkExpectMatcher`).  The throw assertion is `expect(<call>).toThrow()`
// (optionally `.toThrow(<status>)` in an e2e api body).
ExpectStmt:
    'expect' expr=Expression;

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

// Channel — the publisher-side contract for how a context's events are
// transported.  A context member, declared beside its events; `carries:`
// selects a subset of the context's events, and the orthogonal `delivery` x
// `retention` knobs express pub/sub vs work-queue vs durable stream.  The
// contract names no transport — `channelSource` (system scope) binds it to a
// physical `storage`.  `key:` is the partition/ordering field (validated to
// exist on the carried events).
Channel:
    'channel' name=ID '{'
        ('carries'   ':' carries+=[EventDecl:ID] (',' carries+=[EventDecl:ID])* ','?)
        ('delivery'  ':' delivery=ChannelDelivery ','?)?
        ('retention' ':' retention=ChannelRetention ','?)?
        ('key'       ':' key=ID ','?)?
    '}';

ChannelDelivery  returns string: 'broadcast' | 'queue';
ChannelRetention returns string: 'ephemeral' | 'log' | 'work';

// ChannelSource — the physical binding for a channel, system-scope, the
// messaging twin of `dataSource`/`Resource`.  `for:` names the channel
// (bare name), `use:` the `storage` that realises it.  The channel<->storage
// compatibility matrix is enforced by the validator.
ChannelSource:
    'channelSource' name=LooseName '{'
        ('for' ':' channel=ID ','?)
        ('use' ':' use=[Storage:LooseName] ','?)?
    '}';

// Payload — a structured-data carrier crossing a boundary.  `payload` is the
// umbrella; the four sugar keywords carry intent (command / query / response
// / error) but the same structural-record wire contract.  `event` keeps its
// own legacy `EventDecl` surface and is unified at the IR layer, so it is not
// a `PayloadKind` here.
//
// Two forms:
//   1. Record:  `payload X { a: int  b: string }` — the flat-field shape.
//   2. Named union:  `payload Foo = A | B | C` — a discriminated union whose
//      variants are type references (each an atom, no inline `or` needed —
//      `|` is the separator).  Identity is by name; the anonymous `A or B`
//      form (in any type position) lowers to the same union IR shape.
PayloadDecl:
    kind=PayloadKind name=ID (
        '=' variants+=TypeAtom ('|' variants+=TypeAtom)*
      | '{' (fields+=Property (','? fields+=Property)* ','?)? '}'
    );

PayloadKind returns string:
    'payload' | 'command' | 'query' | 'response' | 'error';

Repository:
    'repository' name=ID 'for' aggregate=[Aggregate:ID] '{'
        finds+=FindDecl*
    '}';

FindDecl:
    'find' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' ':' returnType=TypeRef
        ('requires' gate=Expression)?
        ('where' filter=Expression)?
        IgnoringClause?;

// Selective capability-filter bypass.  A trailing clause on a read (find /
// view / inline `Repo.findAll`) that lets it skip a capability's contributed
// query-filter(s), keyed on the CAPABILITY name.  `ignoring *` bypasses every
// capability filter on the aggregate; `ignoring A, B` bypasses exactly those
// capabilities' filters.  Capability names are bare IDs resolved by name
// (like `with` / `implements`), NOT Langium cross-references — the expander
// resolves capabilities by its document-wide inventory, so there is no
// Langium scope for them.  `ignoring` is a SOFT keyword (it stays admissible
// as a NameRef / member name elsewhere), so existing identifiers named
// `ignoring` keep parsing.
fragment IgnoringClause:
    'ignoring' (bypassAll?='*' | bypass+=ID (',' bypass+=ID)*);

// Workflow — context-level orchestration of multiple aggregates.  The
// body reuses operation-body Statement rules (precondition, let, emit,
// call) but the validator restricts mutation forms (`:=`, `+=`, `-=`)
// to operation bodies only.
Workflow:
    'workflow' name=ID (eventSourced?='eventSourced')?
        (transactional?='transactional' ('(' isolation=IsolationLevel ')')?)?
    '{'
        members+=WorkflowMember*
    '}';

// The workflow body is MEMBERS-ONLY — no free statements, no header params.
// A workflow is a state-bearing entity like an aggregate: state (`Property`),
// starters (`create`), continuation commands (`handle`), event reactors
// (`on`), and event folds (`apply`).
//
// `function` — a private, expression-bodied pure helper, the aggregate-parity
// member (workflows are state-bearing entities like aggregates, so they get
// the same helper-factoring surface).  Restricted to the expression form
// (`function f(...): T = expr`) by the validator
// (`loom.workflow-function-block-body`): a workflow body is not a class, so an
// expression-bodied helper is INLINED at each call site during lowering (like
// a parameterised `criterion`), needing no per-backend emission.  Block-bodied
// / recursive helpers are a later slice.
WorkflowMember:
    WorkflowCreateDecl | Apply | OnDecl | HandleDecl | Property | FunctionDecl;

// A workflow starter.  Param-shape discriminates the trigger (resolved at
// lowering, not parse time):
//   create(event: E) by <expr>  → event-triggered (allocate-if-correlation-misses)
//   create(c: Command)          → explicit command-triggered
//   create(p1: T1, p2: T2, …)   → implicit command sugar (legacy paren-body lands here)
// `by` reuses CorrelationExpr (the restricted name/postfix grammar `on` uses, so a
// BuilderCall can't swallow the body block).
WorkflowCreateDecl:
    'create' (name=ID)?
        '(' (params+=Parameter (',' params+=Parameter)*)? ')'
        ('by' correlation=CorrelationExpr)?
    '{'
        body+=Statement*
    '}';


// A named orchestration command handler on a workflow: `handle
// confirm(orderId: Order id) { … }`.  Like the legacy paren-form body, a
// handle body loads/creates aggregates, calls their operations, and emits;
// `handle` is a fresh keyword so it can never start a Statement.  Multiple
// handles make a workflow a multi-command saga.
HandleDecl:
    'handle' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' '{'
        body+=Statement*
    '}';

// Extrinsic event subscription / continuation: `on(paid: PaymentReceived)
// { … }` reacts to a fact from outside the workflow's own scope.  Mirrors the
// aggregate `Apply` rule.  The `by <expr>` routing clause is deferred to the
// correlation slice (it carries no surface meaning without workflow
// correlation fields, and `by` collides with existing identifier usage until
// handled as a soft keyword there).
OnDecl:
    'on' '(' param=LooseName ':' event=[EventDecl:ID] ')'
        ('by' correlation=CorrelationExpr)?
    '{'
        body+=Statement*
    '}';

// The `by <expr>` routing/correlation expression.  Restricted to a name or
// postfix chain (`paid.orderId`, `event.order`, bare `p`) — NOT the full
// `Expression` — for the same reason `ForIterable` is restricted: a
// `BuilderCall` (`Name { … }`) would otherwise swallow the reactor's own
// `{ body }` block.  These are the only forms a `by` clause ever takes.
CorrelationExpr infers Expression:
    NameRef ({infer PostfixChain.head=current} suffixes+=PostfixSuffix+)?;

// SQL-92 isolation levels.  Optional on `transactional`; default
// (when omitted) uses the database connection's configured level
// (Postgres = read committed; SQL Server = read committed).
IsolationLevel returns string:
    'readUncommitted' | 'readCommitted' | 'repeatableRead' | 'serializable';

// Projection — a read model folded from FOREIGN events.  The passive
// read-half of an event-sourced workflow: declared state fields (`Property`)
// + pure `on(e: Event)` folds, keyed by a correlation column.  No command
// side (no create/handle/emit, no operations) — a projection originates
// nothing, it only reflects.  `keyed by` is REQUIRED (no inference, unlike a
// workflow's derived correlation field): a read-model schema routinely
// carries several foreign ids, so a single-id rule would be ambiguous.  `key`
// is a plain name (like `Channel`'s `key:`), resolved to a declared state
// field by the validator (`loom.projection-key-*`).
Projection:
    'projection' name=ID 'keyed' 'by' key=ID '{'
        members+=ProjectionMember*
    '}';

ProjectionMember:
    ProjectionOn | Property;

// A pure fold over one foreign event.  Mirrors the workflow `OnDecl` reactor
// spelling; the body is an apply-style pure fold (`:=` + field-derivation only,
// enforced by loom.projection-fold-impure — no emit / repo / op calls).  The
// optional `by <expr>` extracts the routing key from the event; omitted, it
// defaults to `e.<key>` (the key field is required present on every event).
ProjectionOn:
    'on' '(' param=LooseName ':' event=[EventDecl:ID] ')'
        ('by' correlation=CorrelationExpr)?
    '{'
        body+=Statement*
    '}';

// View — a saved, strongly-typed query over one source aggregate or
// workflow.  Two forms share the same head:
//
//   Shorthand:
//     view ActiveOrders = Order where status == Confirmed
//     Result shape = source aggregate's existing wire shape.
//
//   Full form:
//     view OrderSummary {
//       orderId: Id<Order>
//       lineCount: int
//       from Order where status != Cancelled
//       bind orderId = id, lineCount = lines.count
//     }
//     Output shape declared as fields, each backed by a typed
//     bind expression evaluated against the source aggregate.
//
// A view's source is an aggregate (the wire shape is its repository read),
// a workflow (the wire shape is its persisted instance / saga-state row),
// or a projection (the wire shape is its persisted `<Proj>Row` read model).
// The grammar admits all three; the validator restricts the workflow case
// (shorthand only, non-event-sourced) but permits the full-form bind-follow
// over a projection source (reading projection + repos at query time is legal
// because a view is a query, not a replayable fold).
type ViewSource = Aggregate | Workflow | Projection;

View:
    'view' name=ID
    (
        '=' source=[ViewSource:ID] ('requires' gate=Expression)? 'where' filter=Expression IgnoringClause?
      | '{'
            fields+=Property*
            'from' source=[ViewSource:ID]
            ('requires' gate=Expression)?
            ('where' filter=Expression)?
            IgnoringClause?
            'bind' binds+=BindEntry (',' binds+=BindEntry)* ','?
        '}'
    );

BindEntry:
    name=ID '=' expr=Expression;

// Seed — first-boot data for a context's aggregates.  Declarative form: a
// named dataset of typed records, each lowering through the aggregate's
// canonical create, so invariants hold.  `raw` opts a block into table-level
// inserts.  The imperative (workflow-shaped) body, `@handle` cross-row refs,
// and the deferred `key` clause are later slices.  Each row's value is an
// ObjectLit shaped like the aggregate's create parameters — no `id` field;
// the framework mints ids.
Seed:
    'seed' (dataset=ID)? (raw?='raw')? '{'
        rows+=SeedRow*
    '}';

SeedRow:
    aggregate=[Aggregate:ID] value=ObjectLit;

// Criterion — a named, parameterised, pure boolean predicate over a
// candidate type `T` (the Specification Pattern, Evans / Spring-Data
// style).
//
//   criterion ActiveCustomer of Customer = active
//   criterion InRegion(region: string) of Customer = region == region
//   criterion HasManagerRole of bool = currentUser.role == "manager"
//   criterion CanForceClose of Order = status != Closed
//
// `of <T>` names the candidate type.  Inside the body, bare names and
// `this` resolve against the candidate aggregate's fields (the same
// convention as `invariant` / `derived` / `function` bodies); criteria
// over `bool` are pure ambient predicates with no candidate.
//
// A criterion reference in any boolean-expression position (`view ...
// where`, repository `find ... where`, an `invariant`, an operation
// guard) is inlined at lowering time into the host expression — so
// composition (`ActiveCustomer && InRegion("EU")`) falls out of the
// ordinary boolean operators with no extra machinery and no per-backend
// query-engine change.  The lowered predicate flows through the same
// where→SQL path the inline filter does today.
Criterion:
    'criterion' name=ID ('(' (params+=Parameter (',' params+=Parameter)*)? ')')? 'of' target=TypeRef
    ('as' alias=ID)?
    (
        '=' body=Expression
    );

// Retrieval — a named query *bundle*: a composed predicate (`where`,
// the same expression position as `criterion`/`find … where`, so it
// references criteria and `this.<field>` candidate refs) plus the
// shaping a real query carries — `sort` ordering and a `loads` fetch
// shape.  Pagination is NOT a slot here: `page` is a call-site argument
// on `Repo.run(R(args), page?)`, never part of the declaration.
//
//   retrieval AllActive of Customer = ActiveCustomer
//   retrieval HighValueInRegion(region: string) of Order {
//     where: InRegion(region) && OrderTotalAtLeast(1000)
//     sort:  [total desc, createdAt asc]
//     loads: [this.lines[].product]
//   }
//
// `sort` / `loads` admit the `sort`/`loads`/`asc`/`desc` keywords as
// soft keywords (LooseName / NameRefIdent) so user code naming a field
// `sort` / `loads` / `asc` / `desc` keeps parsing.
Retrieval:
    'retrieval' name=ID ('(' (params+=Parameter (',' params+=Parameter)*)? ')')? 'of' target=TypeRef
    (
        '=' where=Expression
      | '{' 'where' ':' where=Expression
            ('sort'  ':' '[' (sort+=SortItem (',' sort+=SortItem)*)? ']')?
            ('loads' ':' '[' (loads+=LoadPath (',' loads+=LoadPath)*)? ']')?
        '}'
    );

// A single sort term — a candidate path and a direction.  `direction`
// is a discriminator field (not an `{infer}` action) per the grammar
// convention; defaults to ascending when omitted.
SortItem:
    path=LoadPath (direction=SortDirection)?;

SortDirection returns string:
    'asc' | 'desc';

// A structural path through the candidate aggregate for `sort` / `loads`
// — flat-list rule (head + dotted tail), with an optional `[]` marker on
// any segment meaning "across the collection" (mirrors `contains`
// syntax).  Not an Expression: restricted to structural paths (no filters /
// lambdas).  A leading `this` is admitted and stripped at lowering so
// `this.lines[].product` and `lines[].product` are equivalent.
LoadPath:
    ('this' '.')? segments+=LoadSegment ('.' segments+=LoadSegment)*;

LoadSegment:
    name=LooseName (collection?='[]')?;

// Domain service — a stateless, named, context-level container of
// NON-mutating `operation`s (the pure-calculator floor).
// Operations take aggregates / value objects / primitives by value,
// return a value or an `or`-union error, and may `throw` for the
// bug regime.  Strict no-infra: an IR validator rejects repo /
// extern / api / workflow-start / emit / this-write inside a body.
// Callable from operation / workflow / api bodies via a member call
// (`Pricing.quote(cart, customer)`), lowered to a Call with
// `callKind: "domain-service"`.
//
//   domainService Pricing {
//     operation quote(cart: Cart, customer: Customer): Money {
//       return cart.subtotal - customer.tier.discount(cart.subtotal)
//     }
//     operation applyCoupon(price: Money, coupon: Coupon): Money or CouponExpired {
//       if (coupon.isExpired) return CouponExpired { code: coupon.code }
//       return price - coupon.discount
//     }
//   }
DomainService:
    'domainService' name=ID '{'
        operations+=DomainServiceOperation*
    '}';

// Statement body ONLY (no `= Expression` shorthand — deferred).
// Reuses the existing `Parameter` / `TypeRef` / `Statement` rules; the
// `TypeRef` already parses `or`-unions (`Money or CouponExpired`).  Does
// NOT carry `private` / `extern` / `audited` / `when` — those are
// aggregate-operation-only.
DomainServiceOperation:
    'operation' name=(ID | 'write') '(' (params+=Parameter (',' params+=Parameter)*)? ')'
    (':' returnType=TypeRef)? '{'
        stmts+=Statement*
    '}';

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

// Field access modifier — single optional keyword controlling the
// field's role in input DTOs, update wire shape, and view/API read
// exposure.  See `src/ir/enrich/enrichments.ts` for resolution rules and
// `FieldIR.access` in `src/ir/types/loom-ir.ts` for downstream semantics.
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
    name=(ID | CommonSoftKeywords
        // Property-only (soft here but not in every value position):
        | 'await')
    ':' type=TypeRef
    (provenanced?='provenanced')?
    sensitivity=SensitivityClause?
    (access=FieldAccess)?
    // Default value — `field: T = <expr>`.  Placed after the access
    // modifier so the expression can't greedily swallow a trailing
    // modifier keyword.  Enables synthesising a create when no explicit
    // one is declared; for now it lowers onto the FieldIR and downstream
    // phases may consume it.
    ('=' default=Expression)?
    ('check' check=Expression)?;

// Information-flow sensitivity tag(s) on a property.  Tags are bare
// identifiers, opaque to the compiler — `pii`, `phi`, `cred` are
// conventional choices but any identifier is accepted.  Multiple tags
// (`sensitive(pii, audited)`) declare the value carries every listed
// classification simultaneously.
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

// A uniqueness invariant.  `unique (a, b)` declares a natural-key / identity
// rule — no two rows may share the listed tuple.  It is a set-level invariant
// (it structurally cannot run in the per-instance `AssertInvariants()` floor),
// so the compiler DERIVES its enforcement: a DB unique index (partial under
// `softDeletable`) plus a per-backend 23505 → 409 conflict mapping.  Columns
// are bare aggregate field names (flat list, not cross-refs — the validator
// resolves them against the aggregate's fields with a did-you-mean hint).
Unique:
    'unique' '(' columns+=LooseName (',' columns+=LooseName)* ')';

// A pure helper over its parameters.  Two body forms:
//   `= Expression`        — expression form; SQL-inlinable like a `criterion`.
//   `{ Statement* }`      — block form; `let` + branch + bug-regime
//                           `throw`/`require`, still PURE (no repo, no
//                           mutation, no `emit`/`extern`).  The block form is
//                           NOT queryable.  `'='` vs `'{'` is the discriminator
//                           (distinct tokens — the AST stays non-recursive).
FunctionDecl:
    'function' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' ':' returnType=TypeRef
        ( '=' body=Expression
        | '{' block+=Statement* '}'
        );

// `when Expr` — the canCommand state gate: the route evaluates the predicate
// against the loaded aggregate before the body runs (false → 409 Disallowed)
// and auto-exposes a side-effect-free `GET /{id}/can_<op>` returning
// `{ allowed }`.  Distinct from `requires` (auth, 403) and `precondition`
// (argument validation inside the body, 400).
Operation:
    (private?='private')? 'operation' name=(ID | 'write') '(' (params+=Parameter (',' params+=Parameter)*)? ')' (extern?='extern')? (audited?='audited')? (':' returnType=TypeRef)? ('when' when=Expression)? '{'
        body+=Statement*
    '}';

// Lifecycle factory action — `create [name](params) { body }`.  The
// body populates a pre-bound fresh `this`; the framework owns
// persistence (allocate id → persist → return the populated
// instance).  Parens are required — a factory almost always takes
// arguments.  An unnamed `create(...)` is the aggregate's canonical
// creator.  Lowers to an `OperationIR` with `kind: "create"`; never
// joins `agg.operations` (which stays mutate-only).
Create:
    'create' (name=ID)? '(' (params+=Parameter (',' params+=Parameter)*)? ')' (audited?='audited')? '{'
        body+=Statement*
    '}';

// Lifecycle terminator — `destroy [name][(params)] { body }`.  The
// instance is loaded by id; the body runs (cleanup / soft-delete
// state) and the framework removes it.  A body that throws aborts
// removal — the precondition mechanism.  Parens are optional so the
// canonical hard delete reads `destroy { }`.  Lowers to an
// `OperationIR` with `kind: "destroy"`.
Destroy:
    'destroy' (name=ID)? ('(' (params+=Parameter (',' params+=Parameter)*)? ')')? (audited?='audited')? '{'
        body+=Statement*
    '}';

// Applier — the event-fold body of an event-sourced aggregate
// (`persistedAs: eventLog`).  `apply(e: OrderPlaced) { … }` binds the
// emitted event instance to `param` and mutates `this` to fold it into
// state.  Under the event-log discipline the command bodies
// (`operation`/`create`) may only `emit`; the actual state transition
// lives here.  Applier bodies are pure folds — assignments (`:=`/`+=`/
// `-=`) and derivations only, no `emit` and no side-effecting calls.
// Lowers to `ApplyIR`; never joins `agg.operations`.
Apply:
    'apply' '(' param=LooseName ':' event=[EventDecl:ID] ')' '{'
        body+=Statement*
    '}';

Parameter:
    name=LooseName ':' type=TypeRef;

// The soft keywords admitted as ordinary identifiers in EVERY "value"
// position: a field name (`Property.name`), a parameter / object-field /
// call-arg name (`LooseName`), and a bare name-ref in expression position
// (`NameRefIdent`).  These are the purely-defensive keywords (payload family,
// storage / dataSource keys, page-metadata, tenancy, retrieval, capability,
// generic carriers, …) that carry structural meaning ONLY at their own
// declaration site and must never steal a domain identifier.  Factored here
// (M-T5.18 Track A) so a new such keyword is admitted ONCE instead of threaded
// into three rules by hand; `keyword-identifier-completeness.test.ts` proves
// the factoring is byte-identical, and a keyword with a HARD position in one of
// the three rules stays a per-rule extra, NOT here.
CommonSoftKeywords returns string:
      'action' | 'asc' | 'body' | 'by' | 'canonical' | 'command' | 'config' | 'connection'
      | 'crossTenant' | 'dataSources' | 'desc' | 'description' | 'env' | 'envelope' | 'error' | 'eventLog'
      | 'every' | 'favicon' | 'filter' | 'handle' | 'immutable' | 'implements' | 'instance' | 'internal'
      | 'isolationLevel' | 'keyPrefix' | 'kind' | 'literal' | 'loads' | 'managed' | 'migration' | 'money'
      | 'objectStore' | 'ogImage' | 'option' | 'or' | 'paged' | 'parent' | 'payload' | 'query'
      | 'queue' | 'readonly' | 'replica' | 'resource' | 'response' | 'retain' | 'retrieval' | 'schema'
      | 'secret' | 'service' | 'snapshot' | 'sort' | 'stamp' | 'state' | 'store' | 'tablePrefix'
      | 'tenancy' | 'title' | 'token' | 'ttl' | 'use' | 'write';

// LooseName — admissible identifiers in name positions that need to
// accept Loom keywords as ordinary names.  Used by `Parameter.name`
// (so `id` works as a route-param name on pages — `page Detail(id:
// Id<Order>)` — the IdRef magic-identifier doesn't shadow it),
// `MenuMetaEntry.name` (so `section: "Sales"` admits the same
// keyword `MenuSection` reserves), `MenuLinkProp.name` (likewise),
// and `CallArg.name` (so `Form(state: foo)` is legal even though
// `state` is reserved by `StateBlock`).  Adding a token here does
// NOT make it parseable as a NameRef in expression position — that
// remains `NameRefIdent`.  Validators enforce semantic constraints
// (e.g. only specific names are valid for menu metadata).
LooseName returns string:
    ID | CommonSoftKeywords
    // LooseName-only (soft here but not in every value position):
    | 'aggregates' | 'allow' | 'api' | 'await' | 'bind' | 'cache' | 'component' | 'contains'
    | 'contexts' | 'deep' | 'design' | 'directoryLayout' | 'framework' | 'global' | 'id' | 'ignoring'
    | 'link' | 'local' | 'menu' | 'modules' | 'of' | 'page' | 'permissions' | 'persistence'
    | 'policy' | 'route' | 'section' | 'static' | 'targets' | 'transactional' | 'ui' | 'urlStyle'
    | 'views' | 'workflows';

// A dotted page reference for `menu { link <Area>.<Page> }` — lets a menu link
// disambiguate role-named scaffold pages (`List` / `New` / `Detail`) by their
// area, e.g. `link Orders.List`.  A single segment (`link Home`) still parses
// and resolves by bare name.  The area-qualified name is exported by
// `DddScopeComputation` (see ddd-scope.ts).
QualifiedPageName returns string:
    LooseName ('.' LooseName)*;

// ---------------------------------------------------------------------------
// Type references
// ---------------------------------------------------------------------------

// ML-postfix generic instantiation: `customer paged`, `event envelope`,
// `string envelope paged`.  The `(ctors+=GenericCtor)*` list accumulates
// left-associatively, so `string envelope paged` folds to
// `paged(envelope(string))` in lowering.  Array/optional stay outermost —
// `customer paged[]` is array-of-(paged customer).  The constructors are a
// blessed closed keyword set; keyword tokens can't be confused with an
// adjacent ID field name, which is what makes the otherwise-ambiguous postfix
// form (`a: string b: int`) safe.  User-declared generics +
// identifier-postfix instantiation are deferred.
// Anonymous `or` unions: `A or B or C` in any type position.  Postfix
// constructors (`paged` / `envelope` / `option`) and the array / optional
// markers bind tighter than `or`, so `string or int option` parses as
// `string or (int option)` and `A or B[]` as `A or (B[])`.  The head atom's
// fields stay on `TypeRef` itself (backward-compatible: a non-union TypeRef
// has an empty `alternatives`, and every existing consumer reading `.base` /
// `.ctors` / `.array` / `.optional` is unchanged); each `or` adds one more
// `TypeAtom`.  Lowering folds the head + alternatives into a single `union`
// TypeIR when `alternatives` is non-empty.
TypeRef:
    base=BaseType (ctors+=GenericCtor)* (array?='[]')? (optional?='?')?
    ('or' alternatives+=TypeAtom)*;

// One type-union variant — the same atom shape as a `TypeRef` head, used for
// the `or`-alternative tail and for named-union `payload Foo = A | B` arms.
TypeAtom:
    base=BaseType (ctors+=GenericCtor)* (array?='[]')? (optional?='?')?;

GenericCtor returns string:
    'paged' | 'envelope' | 'option';

BaseType:
    PrimitiveType | SlotType | ActionType | SelfType | IdType | NamedType;

PrimitiveType:
    name=('int' | 'long' | 'decimal' | 'money' | 'string' | 'bool' | 'datetime' | 'guid' | 'json');

// Element-shaped param type for component slot injection.  Valid only on a
// `component`'s parameter list; values flow as JSX (`React.ReactNode`-ish in
// TS land) from the caller's expression scope into the component's body, where
// a bare ref `paramName` renders the caller's expr at that position.  The
// validator pins the position restriction.
SlotType:
    name='slot';

// Function-valued param type for component behaviour injection —
// `slot` carries elements, `action` carries behaviours.
// Bare `action` is a zero-arg callback; `action(Order)` declares the
// callback's single argument type explicitly on the param (argument types are
// never inferred from call sites — lambda param types flow forward from the
// expected type).  Valid only on a component's parameter list; the caller
// passes a (block-body) lambda whose body is walked and hoisted in the
// caller's scope, exactly as `onSubmit` is.
ActionType:
    name='action' ('(' arg=TypeRef ')')?;

// `Self id` — a self-referential entity reference, valid only inside a
// `capability` body (the anchored-type / Eiffel `like Current` construct).
// `Self` resolves to the implementing aggregate's own type: the expander
// rewrites `Self id` → `<Host> id` when it splices the capability into an
// aggregate, so lowering and the backends only ever see a concrete `X id`.  A
// `Self id` outside a capability is a validation error.
SelfType:
    selfRef?='Self' 'id';

IdType:
    target=[NamedDecl:ID] 'id';

NamedType:
    target=[NamedDecl:ID];

// EventDecl / PayloadDecl join the union so a bare name in a type position can
// resolve to a transport type (an `event` or a `command`/`query`/… payload).
// The scope provider (ddd-scope.ts) only *offers* these in a workflow
// `create`/`handle` parameter position — `create(e: PaymentReceived) by …`,
// `handle settle(c: SettleOrder)` — so they cannot leak into aggregate field /
// operation-param / UI positions, where a bare event name stays unresolved.
// IdType (`X id`) filters them back out — `PaymentReceived id` is meaningless.
type NamedDecl = Aggregate | EntityPart | EnumDecl | ValueObject | EventDecl | PayloadDecl;

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

Statement:
    PreconditionStmt
  | RequiresStmt
  | LetStmt
  | EmitStmt
  | ForStmt
  | IfLetStmt
  | ReturnStmt
  // A `match SUBJECT { Variant b => <stmts> }` used for its EFFECTS — the
  // statement form of the match, whose arms run statements (`state := …`,
  // `navigate(…)`) rather than yield a value.  Keyword-led, so no ambiguity
  // with `AssignOrCallStmt` (which starts with a NameRef).
  | MatchStmt
  | AssignOrCallStmt;

// The effect-form match.  Distinct from the value-yielding `MatchExpr`
// (its arms are `=> Expression`): here each arm runs a statement block, so
// state-writes and multi-statement bodies parse.  Reuses `MatchSubject` (so the
// subject may be `await <call>`) and `TypeAtom` for the variant tag.  Arm bodies
// are a braced block or a single unbraced statement (`{` unambiguously opens a
// block — no statement starts with `{`).
MatchStmt:
    'match' subject=MatchSubject '{'
        (varArms+=VariantStmtArm (','? varArms+=VariantStmtArm)* ','?)?
        ('else' '=>' ('{' elseBody+=Statement* '}' | elseBody+=Statement) ','?)?
    '}';

VariantStmtArm:
    varType=TypeAtom (binding=ID)? '=>' ('{' body+=Statement* '}' | body+=Statement);

// `if let <var> = <source> { <then> } else { <else> }` — bind an optional
// retrieval result (`Repo.find(<Criterion>)`) and branch on its presence.
// `<var>` is bound (unwrapped, non-null) only in the then-body; the optional
// `else` runs when no row matched.  The single option/null-handling construct
// in a workflow body — without it a nullable repo return has nowhere to go
// (see the `loom.workflow-*` checks).  `source` reuses `ForIterable` (NameRef
// + postfix suffixes), exactly the `Repo.find(C)` shape, which also keeps a
// trailing `{ }` block from being swallowed by a `BuilderCall` the way the
// loop iterable does.
IfLetStmt:
    'if' 'let' var=(ID | 'write') '=' source=ForIterable '{'
        thenBody+=Statement*
    '}' ('else' '{'
        elseBody+=Statement*
    '}')?;

// `return <expr>` — an operation's designed-in outcome.  Produces the
// operation's declared `or`-union return value; the route translates an
// `error`-variant result to a ProblemDetails status, a success variant to
// HTTP 200.
ReturnStmt:
    'return' value=Expression;

// `for <var> in <iterable> { <body> }` — iterate an aggregate array
// (typically `Repo.run(<Retrieval>(args), page?)`), binding each element
// to `<var>` in the body.  The body reuses `Statement*`, so op-calls,
// lets, emits, and nested loops all parse.  Each iteration's mutations to
// `<var>` persist via a per-iteration save (see the for-each lowering).
// `for` is already a hard keyword elsewhere (`repository X for Agg`); the
// leading statement position disambiguates the loop.
ForStmt:
    'for' var=ID 'in' iterable=ForIterable '{'
        body+=Statement*
    '}';

// The loop iterable is restricted to a name or a postfix chain
// (`customers`, `Customers.run(R(args), …)`) — deliberately NOT the full
// `Expression`, because `BuilderCall` (`Name { … }`) would otherwise
// swallow the loop's own `{ body }` block.  These are the only forms
// that produce an aggregate array anyway.
ForIterable infers Expression:
    NameRef ({infer PostfixChain.head=current} suffixes+=PostfixSuffix+)?;

PreconditionStmt:
    'precondition' expr=Expression;

// Authorization gate.  Semantically `requires` reads as "this caller
// is allowed to invoke this op / workflow" — a declarative
// authorization check that maps to HTTP 403, distinct from
// `precondition` (a domain validity check that maps to 400).  The
// expression types to bool exactly like `precondition`; failure
// short-circuits the body and surfaces as ForbiddenException (.NET)
// / ForbiddenError (TS).
RequiresStmt:
    'requires' expr=Expression;

LetStmt:
    'let' name=(ID | 'write') '=' expr=Expression;

EmitStmt:
    'emit' event=[EventDecl:ID] '{'
        (fields+=EmitField (',' fields+=EmitField)* ','?)?
    '}';

EmitField:
    name=LooseName ':' value=Expression;

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
    ID | CommonSoftKeywords
    // LValueIdent-only extras (structural keywords not in the shared
    // value core; assignment / call statement target).  Composing CommonSoftKeywords here also closes the
    // "declarable-but-unreadable" class (M-T5.18 Track C, BUG-004: `e.resource`).
    | 'aggregates' | 'api' | 'contains' | 'contexts' | 'create' | 'destroy' | 'id' | 'modules'
    | 'permissions' | 'ui' | 'views' | 'workflows';

// ---------------------------------------------------------------------------
// Expressions (precedence climbing, lowest to highest)
// ---------------------------------------------------------------------------

// `Lambda` lives at the top of the precedence ladder (a whole-expression
// form: a call arg / handler value), NOT as a `PrimaryExpr`.  Keeping it out
// of binary operands removes the `ID '=>'` ambiguity with match arms: in
// `match { status == Confirmed => "x" }` the `Confirmed => "x"` must not be
// parsed as a lambda inside the `==` RHS, stealing the arm's `=>`.
Expression:
    Lambda | MatchExpr | TernaryExpr;

// Predicate-arms expression — first arm whose `cond` evaluates to
// `true` returns its value; optional `else` is the fallthrough.
// Lives in the expression engine so it can appear anywhere an
// expression is allowed (page bodies, derived properties, view
// `bind` exprs, filter lambdas, function bodies, etc.).
//
// `match` only enters this rule when followed by `{` or a `subject`
// expression — bare occurrences of `match` as an identifier remain
// free.  Two forms share one rule, disambiguated by `subject`
// presence:
//   * boolean-arms  — `match { cond => value, … else => … }`
//     (the predicate-arms form; `subject` absent).
//   * variant-match — `match SUBJECT { VariantType binding => value, … }`
//     dispatches a `or`-union scrutinee by variant, optionally binding
//     the matched variant to a name narrowed to that variant's type.
// The `subject` is the disambiguator: present ⇒ arms parse as variant
// arms (`varType ...`), absent ⇒ as boolean arms (`cond ...`).  This
// resolves the `Type binding =>` vs `cond =>` ambiguity — a single
// arm rule could not tell a bare-NameRef cond from a bare type atom.
// Validator may warn on non-exhaustive matches that lack `else`.
MatchExpr:
    'match' (subject=MatchSubject '{'
                 (varArms+=VariantArm (','? varArms+=VariantArm)* ','?)?
                 ('else' '=>' elseExpr=Expression ','?)?
             '}'
           | '{'
                 (arms+=MatchArm (','? arms+=MatchArm)* ','?)?
                 ('else' '=>' elseExpr=Expression ','?)?
             '}');

MatchArm:
    cond=Expression '=>' value=Expression;

// The variant-match scrutinee.  Reuses `ForIterable` (a `NameRef` plus
// optional postfix suffixes) so a bare name (`outcome`) or a simple
// member read (`wrapper.value`) parses — and crucially so a trailing
// `{` opens the arm block instead of being swallowed as a `BuilderCall`
// /ObjectLit (the same reason `if let … = ForIterable` uses it).  The
// "subject must be a simple ref / let-bound name, not a side-effecting
// call" constraint is enforced by the validator
// (`loom.match-subject-not-simple`), not the grammar, so a call subject
// gets a friendly diagnostic rather than a raw parse error.
//
// EXCEPTION — an `await`-marked call (`match await placeOrder(draft) { … }`).
// A frontend action may discriminate the `or`-union result of a remote op by
// awaiting it in the subject position.  `await <scrutinee>` wraps it in an
// `AwaitExpr`; this is the only place a call subject is admitted (bare,
// unmarked call subjects stay rejected).  `await` is a soft keyword (see
// `LooseName`) so a field named `await` parses.
MatchSubject infers Expression:
      {infer AwaitExpr} 'await' inner=MatchScrutinee
    | MatchScrutinee;

MatchScrutinee infers Expression:
    NameRef ({infer PostfixChain.head=current} suffixes+=PostfixSuffix+)?;

// One variant-match arm: a union variant type, an optional binding
// name (narrowed to the variant in the arm body), then the value.
// `varType` reuses `TypeAtom` (the same atom shape a union variant is
// declared with); `binding` is optional (`NotFound => x` is legal
// alongside `NotFound n => x`).
VariantArm:
    varType=TypeAtom (binding=ID)? '=>' value=Expression;

// Anonymous (inline, unnamed) retrieval literal — the call-site twin of a
// declared `retrieval`, accepted by `Repo.run(...)`.  Same `where:` / `sort:`
// / `loads:` block as the declaration, minus the name and `of <T>` (the
// candidate is the `run` repository's aggregate).  Keyword-led
// (`retrieval { … }`) so it is an unambiguous primary expression — a bare `{`
// would be an ObjectLit.  `where` is a criterion reference; `sort` / `loads`
// reuse the declared-retrieval `SortItem` / `LoadPath` rules.
RetrievalLiteral:
    'retrieval' '{'
        'where' ':' where=Expression
        ('sort'  ':' '[' (sort+=SortItem (',' sort+=SortItem)*)? ']')?
        ('loads' ':' '[' (loads+=LoadPath (',' loads+=LoadPath)*)? ']')?
    '}';

TernaryExpr infers Expression:
    OrExpr (
        {infer TernaryExpr.cond=current} '?' thenExpr=Expression ':' elseExpr=Expression
    )?;

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
    // A trailing `ignoring` clause is admitted on the whole postfix chain so an
    // inline read `Repo.findAll(...) ignoring softDeletable` / `... ignoring *`
    // parses.  It is only meaningful on a repo read call; the lowering for
    // `Repo.findAll`/`Repo.run` consumes `bypass`/`bypassAll`, and the IR
    // validator rejects it elsewhere.  Kept on the chain (a
    // discriminator/flat-list, not a recursive action) so it never alters the
    // existing PostfixChain shape for callers that ignore it.
    PrimaryExpr ({infer PostfixChain.head=current} suffixes+=PostfixSuffix+ IgnoringClause?)?;

PostfixSuffix:
      {infer MemberSuffix} '.' member=MemberName
        ( call?='(' (args+=CallArg (',' args+=CallArg)*)? ')' )?
    | {infer CallSuffix}   '(' (args+=CallArg (',' args+=CallArg)*)? ')';

// Call arguments admit an optional `name:` prefix.
// Positional usage (`Money(10.5, "USD")`) keeps working; named usage
// (`OperationForm(of: Order, op: confirm)`) lets
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
    ID | CommonSoftKeywords
    // MemberName-only extras (structural keywords not in the shared
    // value core; member access after `.`).  Composing CommonSoftKeywords here also closes the
    // "declarable-but-unreadable" class (M-T5.18 Track C, BUG-004: `e.resource`).
    | 'aggregates' | 'api' | 'contains' | 'contexts' | 'create' | 'destroy' | 'find' | 'id'
    | 'ignoring' | 'modules' | 'permissions' | 'ui' | 'views' | 'where' | 'workflows';

// Lambdas accept either a single expression body or a brace-wrapped block of
// statements.  Block bodies are required for multi-statement event handlers in
// pages — e.g. `c => { draft.customerId := c.customerId; step := 1 }`.  The
// block reuses the existing `Statement` rule so all of `let`, `:=`, `+=`,
// `-=`, calls, and `emit` are admissible inside.
Lambda:
    param=ID '=>' (
        body=Expression
      | '{' stmts+=Statement* '}'
    );

PrimaryExpr infers Expression:
      RetrievalLiteral
    | BuilderCall
    | ObjectLit
    | ParenExpr
    | ListLit
    | TemplateString
    | LiteralExpr
    | MoneyLit
    | PrimitiveConversion
    | NowExpr
    | ThisRef
    | IdRef
    | NameRef;

// String interpolation — a backtick-delimited template with `{expr}` holes,
// e.g. `Order {id} for {customer.name}`.  It lowers to plain string
// concatenation of the literal segments and the `string()`-converted holes,
// so NO backend sees a new node — it rides the existing `+` / `convert` paths.
// `strings` holds the N+1 literal segments, `holes` the N hole expressions,
// interleaved segment / hole / segment / … .  Holes are full expressions,
// EXCEPT ones carrying a literal `{ }` block (object / `match` / builder
// literals): the dedicated `interpolation` lexer mode (see `DddTokenBuilder`)
// drops `{` / `}` inside a hole so the first `}` closes it.  A literal brace in
// text is written `\{` / `\}`; a literal backtick `` \` ``.
TemplateString infers Expression:
    {infer TemplateStr} (
        strings+=TEMPLATE_FULL
      | strings+=TEMPLATE_START holes+=Expression
        (strings+=TEMPLATE_MIDDLE holes+=Expression)*
        strings+=TEMPLATE_END
    );

// Bracketed list literal — `[3, 2, 1]`.  Used as the value of named
// args that admit a list shape (e.g. `Grid { cols: [3, 2, 1] }` for
// responsive breakpoints).  Heterogeneous expression elements are
// admitted at the grammar level; the type system / each consumer
// validates element shape per use site.
ListLit:
    {infer ListLit} '[' (elements+=Expression (',' elements+=Expression)* ','?)? ']';

// Universal construction form.  Replaces `new Part { ... }`
// and the walker-call form (`Form(state: ..., body: ...)`).  The
// type name resolves at lowering time:
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
    name=LooseName ':' value=Expression;

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
// convert.  Used for things the strict binary validator requires
// to be explicit: `"Hello " + string(age)` instead of bare
// `"Hello " + age`, `money(decimalField)` to bridge a typed decimal
// into money, `decimal(moneyValue)` for the lossy projection.
//
// Targets (infallible only):
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
    ID | CommonSoftKeywords
    // NameRefIdent-only (soft here but not in every value position):
    | 'aggregates' | 'api' | 'bind' | 'cache' | 'component' | 'contains' | 'contexts' | 'create'
    | 'design' | 'destroy' | 'framework' | 'ignoring' | 'link' | 'menu' | 'modules' | 'page'
    | 'permissions' | 'route' | 'section' | 'static' | 'targets' | 'ui' | 'urlStyle' | 'views'
    | 'workflows';

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

hidden terminal WS: /\s+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;

terminal STRING: /"(\\.|[^"\\])*"/;
// Backtick template segments.  Each token is `<delim>text<delim>` with
// single-char delimiters; `text` admits `\.` escapes and any char except
// backtick / backslash / `{` (a literal `{` is written `\{`).  FULL is a
// hole-free `` `…` ``; START `` `…{ ``, MIDDLE `` }…{ ``, END `` }…` ``.
// MIDDLE and END begin with `}` and are placed by `DddTokenBuilder` ONLY in
// the `interpolation` lexer mode, so they never shadow the block-closing `}`
// keyword in ordinary code.
terminal TEMPLATE_FULL:   /`(\\.|[^`\\{])*`/;
terminal TEMPLATE_START:  /`(\\.|[^`\\{])*\{/;
terminal TEMPLATE_MIDDLE: /\}(\\.|[^`\\{])*\{/;
terminal TEMPLATE_END:    /\}(\\.|[^`\\{])*`/;
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
