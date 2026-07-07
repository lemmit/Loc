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
    System | Subdomain | BoundedContext | ValueObject | EnumDecl | PayloadDecl | Requirement | Solution | TestCase | Component
    // Implicit-system composition (Tier 2): the deployment-shape members are
    // also admissible at file top level and compose into the project's single
    // `system` — so deployment can live in its own file.  See
    // docs/proposals/implicit-system-composition.md.
    | Deployable | Storage | Resource | ChannelSource | Ui | ThemeBlock | UserBlock | AuthBlock | Api | Layout | TestE2E
    // Typed capabilities (typed-capabilities.md): a `capability` pure-mixin is
    // top-level declarable (and a `SystemMember` inside `system { }`).
    | Capability;

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
    Subdomain | Deployable | BoundedContext | TestE2E | UserBlock | AuthBlock | TenancyDecl | ThemeBlock | Ui | Api | Storage | Resource | ChannelSource | Layout | Capability;

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

// System-level OIDC authentication config (D-AUTH-OIDC).  Sibling to
// `user { … }`: the user block declares the claim SHAPE, this block
// declares WHO issues the token and how its claims map onto that shape.
// `provider:` names a preset (resolved to issuer/endpoints during
// lowering); `keycloak` / `custom` are the self-hosted path and require
// an explicit `oidc { issuer: … }`.  At most one per system, admissible
// only alongside a `user { … }` block (validator enforces).  Loom owns
// no auth runtime — declaring this generates a token verifier (filling
// the existing per-backend verifier seam) plus the /auth/* redirect
// handshake, nothing more.
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

// System-level tenancy declaration (multi-tenancy Phase 1a; cross-refs
// since 1b.1 — see docs/plans/multi-tenancy-implementation.md).  Sibling
// to `user { … }` and `auth { … }`: names WHICH user claim partitions
// the data (`user.tenantId`) and WHICH aggregate is the tenant registry
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
        // D-REALIZATION-AXES: the optional `{ … }` block decomposes the
        // platform bundle into six orthogonal realization axes.  `platform`
        // stays a direct string property (every AST/IR consumer reads
        // `d.platform` as a string); the block is additive and optional, so
        // bare `platform: dotnet` parses unchanged.  Axis values are
        // `LooseName` — the menu is enforced by the validator, not the
        // parser (the `design:` precedent).
        ('platform' ':' platform=Platform
            ('{' (
                  'foundation' ':' foundation=LooseName ','?
                | 'application' ':' application=LooseName ','?
                | 'persistence' ':' persistence=LooseName ','?
                | 'directoryLayout' ':' directoryLayout=LooseName ','?
                | 'transport' ':' transport=LooseName ','?
                | 'runtime' ':' runtime=LooseName ','?
            )* '}')?
            ','?)
        // The remaining clauses are ORDER-INDEPENDENT: each is introduced by
        // a distinct keyword, so an interleaving `(...)*` group parses them in
        // any order (same shape as the realization-axes sub-block above). The
        // value of a ref clause is a single token consumed before the loop
        // re-checks the next clause keyword, so reordering introduces no
        // ambiguity. (`platform` stays first as the deployable's lead.)
        (
            // D-STORAGE-SPLIT: contexts the deployable hosts (refs are
            // BoundedContext, not the subdomain wrappers).
            ('contexts' ':' '[' contextRefs+=[BoundedContext:ID] (',' contextRefs+=[BoundedContext:ID])* ','? ']' ','?)
            // D-STORAGE-SPLIT: the deployable's dataSource ↔ context bindings.
            // Each ref points at a system-level `dataSource { for: …, kind: …,
            // use: … }` declaration. Validator enforces (a) every listed
            // dataSource's `for:` is one of `contexts:`; (b) per (context, kind)
            // uniqueness; (c) every aggregate's required kind has a matching
            // dataSource for its hosting context.
          | ('dataSources' ':' '[' dataSourceRefs+=[Resource:LooseName] (',' dataSourceRefs+=[Resource:LooseName])* ','? ']' ','?)
          | ('targets' ':' targets=[Deployable:LooseName] ','?)
            // Slice 11.26 — explicit api composition. Backend deployables
            // declare which contracts they serve via `serves:`.
          | ('serves' ':' serves+=[Api:ID] (',' serves+=[Api:ID])* ','?)
            // UI binding — references a `ui { ... }` block at system scope:
            //   ui: WebApp                            // sugar — no params
            //   ui: WebApp { Sales: salesApi, ... }   // compose-block
            //   ui WebApp { framework: react }        // legacy block form
          | (uiSugar=UiSugarBinding | uiCompose=UiComposeBinding | uiBlock=UiBlockBinding)
            // D-PHOENIX-SURFACE: `hosts:` is the host↔ui relation. Bracketed
            // multi form mirrors `contexts:`/`dataSources:`; the bare single
            // form takes one ref. (The bracketed form avoids the
            // unbracketed-comma swallow where `hosts: A, design` would read
            // `design` as another ref.)
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

// D-STORAGE-SPLIT: the per-(context, kind) binding from a context's
// aggregates to a physical `storage` — the RFC's `resource` (the
// configured realization of a logical need).  All `for:` / `kind:` /
// `use:` are required by the validator; declared as optional in the
// grammar so missing-field diagnostics are friendlier than a hard parse
// error.  Per-kind config keys (schema, every, retain, …) are
// validated against the resolved storage's `type`.
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

// A manual performance index on the storage binding (uniqueness-and-indexes.md
// §3.2, D-INDEX-INFRA) — pure infrastructure, never on the aggregate.  The
// target entity is named EXPLICITLY (`Project.name`), never inferred from
// which table happens to own the column — the binding knows the context's
// shape, so the index says which entity it is on.  `Entity.col` is a
// single-column index; `Entity.(a, b)` a composite.  The entity may be an
// aggregate OR one of its contained parts (an inner entity's own table).
// Always non-unique (uniqueness is the domain `unique (...)` invariant).
IndexSpec:
    entity=ID '.' ('(' columns+=LooseName (',' columns+=LooseName)* ')' | columns+=LooseName);

DataSourceKind returns string:
    'state' | 'eventLog' | 'snapshot' | 'cache' | 'replica'
    | 'objectStore' | 'queue' | 'api';

UiSugarBinding:
    'ui' ':' ref=[Ui:ID] ','?;

UiBlockBinding:
    'ui' ref=[Ui:ID] '{'
        ('framework' ':' framework=Framework ','?)?
    '}';

// Frameworks the `ui:` mount lowers against.  `react` renders TSX
// against a design pack (`mantine`/`shadcn`); `phoenixLiveView`
// renders HEEx against the `coreComponents` pack as part of a fullstack
// Elixir deployable (plain Ecto/Phoenix).  (The `liveview` framework alias was RETIRED —
// `phoenixLiveView` is the only spelling, mirroring the retired platform
// aliases.)  Future values (`blazor-wasm`, `blazor-server`, …) extend
// this enum when their codegen backends land.  `svelte` renders Svelte 5
// (SvelteKit static SPA) against a svelte-format design pack
// (`shadcnSvelte`/`flowbite`); `vue` renders Vue 3 (Vite SPA +
// vue-router) against a vue-format design pack
// (`vuetify`/`shadcnVue`).
Framework returns string:
    'react' | 'svelte' | 'vue' | 'angular' | 'phoenixLiveView';

// Backend platforms accept a quoted `family@version` pin
// (`platform: "node@v4"`) via the STRING alternative — symmetric
// with `DesignPack` below.  Bareword keywords are unchanged so
// every existing source parses identically; the validator + lowering
// (`parseBuiltinPlatformRef`) are the resolution authority.
// `node` is the canonical language-ecosystem name for the JS runtime
// backend (Hono web framework); the framework name surfaces as the
// `transport:` value, not as a platform alias.
// `elixir` is the D-ELIXIR-PLATFORM canonical name for the
// language-ecosystem platform.  The legacy `phoenix` / `phoenixLiveView`
// platform aliases were RETIRED (mirroring the retired `hono` → `node`
// alias): `elixir` is now the only spelling and `platform: phoenix` /
// `platform: phoenixLiveView` fail validation as unknown platforms.
// `python` is the canonical language-ecosystem name for the
// FastAPI + SQLAlchemy backend.  (The `fastapi` framework-spelled
// platform alias was RETIRED — `python` is the only spelling and
// `platform: fastapi` fails validation as an unknown platform.)
Platform returns string:
    'dotnet' | 'node' | 'react' | 'svelte' | 'vue' | 'angular' | 'static' | 'elixir' | 'python' | 'java' | STRING;

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
        // D-PHOENIX-SURFACE: the UI's framework is part of its own
        // technical identity, not derived from the host backend.
        // Optional + additive — existing sources omit it and keep the
        // legacy "framework derived from the deployable's platform"
        // path until the `hosts:` work consumes it.
        ('framework' ':' framework=Framework ','?)?
        members+=UiMember*
    '}';

UiMember:
    UiApiParam | UiChannelParam | UiNotification | UiFunction | Page | Component | Store | Area | MenuBlock;

// Shared client-side state container — a top-level `ui` member, sibling to
// `page` / `component` (named-actions-and-stores.md §3, Stage 5).  Holds named
// `state {}` + named `action`s, reused VERBATIM from the page/component
// surface; the body interleaves both (`StoreDecl: StateBlock | ActionDecl`).
// There is NO `use` clause — a store is referenced purely by DOTTED qualified
// name from a page/component body (`Cart.lines` read, `Cart.clear()` call);
// the per-page store dependency is DERIVED from the page's resolved refs at
// emit time (derive-don't-stamp), never bound per-surface.
//
// The **lifetime ladder** (frontend-state-management.md §3.1): an optional
// `persist: memory|local|session|url` modifier picks where the store's state
// lives (default = in-memory).  ONE new keyword `persist:`; the value is a
// validated *identifier* (`StorePersist.value`), NOT a keyword, so `url` /
// `local` / `session` / `memory` stay usable as ordinary field/aggregate names
// everywhere — sidestepping the reserved-word breakage that literal value
// keywords would cause.  The value ∈ {memory,local,session,url} is checked in
// the AST validator (`loom.store-lifetime-invalid`); lowering maps it onto the
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
// nesting.  Optional + additive — area-less pages stay flat.  v1 carries
// name + members only; a base `route:` prefix and cascading
// layout/requires/label are the documented growth path
// (docs/proposals/unfoldable-page-scaffolding.md).
Area:
    'area' name=ID '{'
        members+=AreaMember*
    '}';

AreaMember:
    Page | Area;

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
    'api' name=ID 'from' source=[Subdomain:ID]
        ('{'
            ('urlStyle' ':' urlStyle=('literal' | 'resource'))?
            (statuses+=ApiStatus)*
        '}')?;

// Per-error HTTP status override for the exception-less ProblemDetails
// translator (exception-less.md A1).  `httpStatus <Error> <Code>` overrides the
// stdlib default for an `error` payload this api can return.  `httpStatus`
// (not the proposal's `status`) is the clause head so the very common
// `status: OrderStatus` field name keeps parsing without a soft keyword.
ApiStatus:
    'httpStatus' error=ID code=INT;

// ---- storage declaration (system-level) ------------------------
//
// First-class declaration of a storage instance — a typed slot the deployable
// composition picks up via the `dataSources:` clause (a deployable lists the
// system-level `dataSource { for:, kind:, use: }` bindings it hosts; see
// D-STORAGE-SPLIT).  Reusable across deployables (one Postgres serves the api
// server + worker service).
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
        ('instance' ':' instance=ID ','?)?
        ('connection' ':' connection=ConnectionSource ','?)?
        ('config' ':' '{' (config+=ConfigEntry (',' config+=ConfigEntry)* ','?)? '}' ','?)?
    '}';

// Generic vendor-parameter map (RFC §3.1/§8).  Keys are validated per
// sourceType against the registry's config schema in IR validation; no
// per-vendor clause keywords are introduced.
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

// ---- channel subscription (channels.md Part I, ui surface) --------
//
//   channel Orders: Sales.Lifecycle
//
// Subscribes this UI to a context's `delivery: broadcast` channel.
// The wire format (SSE vs WebSocket) is an infra fact derived from
// the frontend's platform — never stated here; the scope provider
// resolves `channel` within the named context.
UiChannelParam:
    'channel' name=ID ':' context=[BoundedContext:ID] '.' channel=[Channel:ID];

// Frontend logic escape hatch (extern-function-hook-escape-hatch.md §3):
//
//   function initials(name: string): string extern from "./helpers/initials"
//
// A typed pure function implemented by a hand-written module.  Loom emits
// a typed signature (`src/lib/extern/<name>.signature.ts`) + a conformance
// shim (`src/lib/<name>.ts`, `export const <name>: <Name>Fn = _impl`) so a
// missing module or mismatched signature fails `tsc` — the fail-fast.
// Page bodies call it through the shim.  v1 is extern-only (a bodied
// ui-level function has no walker consumer); the keyword reuses the
// aggregate-member `function` — ui-member position disambiguates.
UiFunction:
    'function' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' ':' returnType=TypeRef
        'extern' 'from' externPath=STRING;

// ---- live-event handler --------------------------------------------
//
//   on Orders.OrderShipped(e) { toast("Order " + e.order + " shipped") }
//
// Renders the event itself (toast / feed / badge) when it arrives on
// the subscribed channel's realtime wire.  v1 restricts the body to
// `toast(<expr>)` calls (validator rule `loom.ui-handler-unsupported`).
// A live READ needs no marker — an ordinary cached query auto-freshens
// (channels.md Part II).
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

// Named, typed page/component event handler — `action next() { … }`
// (named-actions-and-stores.md, Proposal A Stage 1).  Names today's
// anonymous handler lambda: a declared identity + a typed payload
// param list + a statement block (reusing the existing `Parameter`
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

// Named layout declaration (Phase 8).  A page or ui can opt into a
// named layout (`layout: AdminFrame`) which lowers to a wrapping
// React Router layout-route around the page body, similar to v1's
// `default` AppShell but built from user-defined slots.  Reserved
// names `default` and `none` cannot be redeclared (validator).
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

// A `component` is normally a typed function from params to a walked
// body.  An `extern` component instead hands rendering to a
// hand-written file: `component X(...) extern from "<src-relative
// path>"` declares the typed param contract but no `body:` — the
// generator imports the user's module at call sites and emits a
// `<Name>.props.ts` typed-props interface (the UI escape hatch; see
// docs/proposals/extern-component-escape-hatch.md).  The `extern`
// keyword always carries its `from` path; the body is omitted (the
// validator pins both halves of this exclusivity).
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
    ID | 'filter' | 'stamp' | 'implements' | 'write'
    // DataSource clause keys (PR-3 / D-STORAGE-SPLIT) are admitted as
    // soft so user pages can still declare a state field named `kind`,
    // `schema`, `every`, etc.  Without this, `state { kind: string }`
    // stopped parsing the moment `'kind'` appeared as a literal in the
    // `DataSource` rule.
    | 'kind' | 'schema' | 'tablePrefix' | 'keyPrefix' | 'ttl' | 'every'
    | 'retain' | 'isolationLevel' | 'readonly' | 'use'
    | 'eventLog' | 'snapshot' | 'replica' | 'objectStore' | 'queue' | 'config';

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
      'link' page=[Page:QualifiedPageName] ('{' (props+=MenuLinkProp (','? props+=MenuLinkProp)* ','?)? '}')?
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
    | Projection | PolicyDecl;

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
// the aggregate-inheritance surface (aggregate-inheritance.md, I1).  An
// `abstract` base can never be instantiated, has no repository, and emits
// no table of its own; `extends <Base>` may only target an `abstract`
// aggregate.  `inheritanceUsing(…)` is a header paren modifier (D-RENAME,
// amended by D-DOCUMENT-AXIS §4 — all aggregate config on the header),
// alongside `persistedAs(…)` / `shape(…)`.
Aggregate:
    // `crossTenant` (multi-tenancy Phase 1a) is a header flag mirroring
    // `isAbstract` — declares shared-reference data that opts out of the
    // tenant filter under a `tenancy by` system.  Positioned after the
    // `ids` clause, before the paren modifiers and the with-clause:
    // `aggregate Plan crossTenant { … }`,
    // `aggregate Invoice ids guid crossTenant with x { … }`.
    (isAbstract?='abstract')? 'aggregate' name=ID ('extends' superType=[Aggregate:ID])? ('ids' idKind=IdKind)? (crossTenant?='crossTenant')? ('persistedAs' '(' persistedAs=TruthKind ')')? ('shape' '(' shape=SavingShape ')')? ('inheritanceUsing' '(' inheritanceUsing=InheritanceLayout ')')? withClause=WithClause? '{'
        members+=AggregateMember*
    '}';

// The only aggregate id kind Loom emits is `guid`.  `ids int|long|string`
// were removed: no backend implemented id generation for a non-guid PK (the
// create path minted a fresh id only for guid; a non-guid create collided on
// the second insert), so the surface was a footgun.  `ids guid` stays a legal
// (no-op) explicit spelling of the default.  See docs/plans/non-guid-id-http-params.md.
IdKind returns string:
    'guid';

// D-RENAME (amended by D-DOCUMENT-AXIS §4): inheritance table layout — a
// header paren modifier on aggregates participating in inheritance.
//   - `sharedTable` — TPH: one table for the whole hierarchy + a `kind`
//     discriminator column.  `Party id` refs target the single base table.
//   - `ownTable`    — TPC: one table per concrete; no base table.  Bare
//     `Party id` refs to such a base are forbidden (FK target ambiguous).
// Only valid on an `abstract` base or an `extends` subtype.  A
// `persistedAs(eventLog)` or `shape(document)` concrete of a `sharedTable`
// base is forced to `ownTable` (D-ES-TPH) — a validator error, so the
// author writes the forced modifier explicitly.
InheritanceLayout returns string:
    'sharedTable' | 'ownTable';

// D-DOCUMENT-AXIS: the aggregate's primary truth kind, a header paren
// modifier (replaces the former body `persistenceStrategy:` clause).
// Values align to the `dataSource` `kind` set so the IR→binding mapping
// is an identity.  Default (absent) is `state`.
TruthKind returns string:
    'eventLog' | 'state';

// D-DOCUMENT-AXIS: saving shape of the materialised read model /
// snapshot — how the aggregate's hierarchy is physically laid out.
// Header paren modifier on the aggregate (`shape(document)`); colon
// entry on the `dataSource` binding (`shape: document`).  Three points
// on the relational↔document spectrum (default absent = `relational`):
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
// (The legacy capability-scoped `filter for "<name>"` variant was
// removed in typed-capabilities Phase 6 — a capability co-locates its
// own filter, so the string-group qualifier is unnecessary.)
FilterDecl:
    'filter' expr=Expression;

// `stamp <event> { ... }` declares lifecycle-stamping assignments.
// At aggregate scope applies to that aggregate; at context scope
// propagates to every aggregate.  (The legacy `stamp for "<name>"`
// qualifier was removed in typed-capabilities Phase 6.)
StampDecl:
    'stamp' event=StampEvent '{'
        assignments+=AssignOrCallStmt*
    '}';

StampEvent returns string:
    'onCreate' | 'onUpdate';

// ---- policy block (authorization.md §3; multi-tenancy Phase 2 P2.4) ------
//
// A `policy {}` context member declares record-level read reachability for
// tenant-owned aggregates: the directional read ladder
// `local`/`deep`/`global` (≈ authorization.md's `Self`/`Descendants`/`All`).
// Each `allow <level> on <Aggregate>` rule selects one aggregate's read
// scope, lowering to a rewrite of that aggregate's `tenantOwned` capability
// filter (its `contextFilters` entry) — so it rides the exact per-backend
// query-filter seams the tenant floor already uses.
//
// MINIMAL P2.4 SURFACE — the read ladder only.  The full policy DSL
// (operation/view/workflow gates, field masking, `function`/`let` helpers,
// `deny`) is later proposal work and is deliberately NOT in this grammar.
//
// `target` is a bare `ID` resolved by NAME against the enclosing context's
// aggregates in phase ⑦ (`loom.policy-*` diagnostics) — NOT a Langium
// cross-reference, so an unknown aggregate surfaces a controlled `loom.*`
// error rather than a generic linker message, and the scope provider needs no
// change.  `name` is optional (a context may hold one anonymous policy).
//
// FUNCTION FORM (authorization Phase 3.2, docs/plans/authorization-phase3-2.md):
// `policy <Name>(<params>): bool ( = <expr> | { <expr> } )` is a named, ambient,
// parameterised boolean AUTHORIZATION predicate — the reusable twin of an inline
// `requires` gate, referenced from a `requires PolicyName(args)` clause and
// INLINED at that gate (like a `criterion … of bool`).  It shares the `policy`
// head with the read-ladder block; the two are disambiguated after the name by
// the next token — `(` opens a function, `{` opens a read-ladder block.  The
// parentheses are therefore REQUIRED (even for zero params).  `returnType`
// present ⇒ function form; a block form leaves it undefined.
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
// the ladder (authorization Phase 3 P3.1, docs/plans/authorization-phase3.md):
// bare = the read reachability ladder (Phase 2, unchanged); `write` gates
// INSTANCE mutations (update-style ops, destroy, applier dispatch) on the target
// row's write scope.  `write global` PARSES but is a phase-⑦ validator error
// (`loom.policy-write-global-unsupported`) — root-subtree-wide mutation is a
// footgun; only `write local` (the default floor) and `write deep` are offered.
// There is deliberately NO `read` verb synonym: `read` is far too common a user
// identifier (`let read = …`) to promote to a keyword, so the read form stays
// bare.  The rule name stays `PolicyReadRule` (both verbs are policy rules
// structurally); the IR splits them by verb.
PolicyReadRule:
    'allow' (verb=PolicyVerb)? level=ReadLevel 'on' target=ID;

// The optional policy verb.  Absent = read (Phase 2 behavior).  `write` is the
// only new keyword — see the note above on why `read` is not one.
PolicyVerb returns string:
    'write';

// The directional read ladder (docs/plans/multi-tenancy-phase2.md P2.4):
//   - `local`  — the caller's own org node (today's `tenantId ==` floor; default)
//   - `deep`   — the caller's org + all descendants (`dataKey` path prefix)
//   - `global` — all in the caller's tenant (tenant-root-floored)
// A closed set — an unknown level name is a parse error, so no validator arm
// is needed for it.
ReadLevel returns string:
    'local' | 'deep' | 'global';

// `implements <Cap>` is the typed capability-application form
// (typed-capabilities.md) — a synonym of `with <Cap>`: the expander splices
// the referenced capability's fields + filter + stamp into the host aggregate
// (or, at context scope, every aggregate in the context).  Resolved by the
// expander's document-wide capability inventory, like `with` (see `Capability`
// below), not a Langium cross-reference.  (The legacy `implements "name"`
// string-group form was removed in typed-capabilities Phase 6.)
ImplementsDecl:
    'implements' cap=ID;

// ---- typed capability declaration (typed-capabilities.md) -------
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
// capability's members into the host aggregate's `members[]` at phase ②,
// indistinguishable from user-written ones.  Everything downstream
// (scope, lower, enrich, validate, codegen) is unchanged.
//
// Top-level declarable (a `SystemMember`); globally visible because the
// expander resolves by name, not by Langium scope.  See
// docs/plans/typed-capabilities-implementation.md.
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
// (optionally `.toThrow(<status>)` in an e2e api body); it replaces the old
// `expectThrows` statement keyword.
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
// transported (channels.md, Slice 1).  A context member, declared beside
// its events; `carries:` selects a subset of the context's events, and the
// orthogonal `delivery` x `retention` knobs express pub/sub vs work-queue
// vs durable stream.  The contract names no transport — `channelSource`
// (system scope) binds it to a physical `storage`.  `key:` is the
// partition/ordering field (validated to exist on the carried events).
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
// (bare name; Slice 1), `use:` the `storage` that realises it.  The
// channel<->storage compatibility matrix is enforced by the validator.
ChannelSource:
    'channelSource' name=LooseName '{'
        ('for' ':' channel=ID ','?)
        ('use' ':' use=[Storage:LooseName] ','?)?
    '}';

// Payload — a structured-data carrier crossing a boundary
// (payload-transport-layer.md, P1).  `payload` is the umbrella; the four
// sugar keywords carry intent (command / query / response / error) but
// the same structural-record wire contract.  `event` keeps its own
// legacy `EventDecl` surface and is unified at the IR layer, so it is not
// a `PayloadKind` here.
//
// Two forms (payload-transport-layer.md, P4):
//   1. Record:  `payload X { a: int  b: string }` — the P1 flat-field shape.
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
        ('where' filter=Expression)?
        IgnoringClause?;

// Selective capability-filter bypass (named-filter-bypass.md, §11).  A trailing
// clause on a read (find / view / inline `Repo.findAll`) that lets it skip a
// capability's contributed query-filter(s), keyed on the CAPABILITY name.
// `ignoring *` bypasses every capability filter on the aggregate; `ignoring A, B`
// bypasses exactly those capabilities' filters.  Capability names are bare IDs
// resolved by name (like `with` / `implements`), NOT Langium cross-references —
// the expander resolves capabilities by its document-wide inventory, so there is
// no Langium scope for them.  `ignoring` is a SOFT keyword (it stays admissible
// as a NameRef / member name elsewhere), so existing identifiers named
// `ignoring` keep parsing.
fragment IgnoringClause:
    'ignoring' (bypassAll?='*' | bypass+=ID (',' bypass+=ID)*);

// Workflow — context-level orchestration of multiple aggregates.  The
// body reuses operation-body Statement rules (precondition, let, emit,
// call) but the validator restricts mutation forms (`:=`, `+=`, `-=`)
// to operation bodies only.  See docs/workflow.md for semantics.
Workflow:
    'workflow' name=ID (eventSourced?='eventSourced')?
        (transactional?='transactional' ('(' isolation=IsolationLevel ')')?)?
    '{'
        members+=WorkflowMember*
    '}';

// A2-S5f (workflow-and-applier.md): the workflow body is MEMBERS-ONLY — no
// free statements, no header params.  A workflow is now a state-bearing entity
// like an aggregate: state (`Property`), starters (`create`), continuation
// commands (`handle`), event reactors (`on`), and event folds (`apply`).  The
// legacy `workflow X(params) { stmts }` is migrated to
// `workflow X { create(params) { stmts } }` by scripts/migrate-workflows-to-create.mjs.
//
// `function` — a private, expression-bodied pure helper, the aggregate-parity
// member (workflows are state-bearing entities like aggregates, so they get the
// same helper-factoring surface).  Restricted to the expression form
// (`function f(...): T = expr`) by the validator (`loom.workflow-function-block-body`):
// a workflow body is not a class, so an expression-bodied helper is INLINED at
// each call site during lowering (like a parameterised `criterion`), needing no
// per-backend emission.  Block-bodied / recursive helpers are a later slice.
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


// A named orchestration command handler on a workflow (A2-S5c): `handle
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
// aggregate `Apply` rule.  See workflow-and-applier.md §"Member forms".  The
// `by <expr>` routing clause is deferred to the correlation slice (it carries
// no surface meaning without workflow correlation fields, and `by` collides
// with existing identifier usage until handled as a soft keyword there).
OnDecl:
    'on' '(' param=LooseName ':' event=[EventDecl:ID] ')'
        ('by' correlation=CorrelationExpr)?
    '{'
        body+=Statement*
    '}';

// The `by <expr>` routing/correlation expression (A2-S3).  Restricted to a
// name or postfix chain (`paid.orderId`, `event.order`, bare `p`) — NOT the
// full `Expression` — for the same reason `ForIterable` is restricted: a
// `BuilderCall` (`Name { … }`) would otherwise swallow the reactor's own
// `{ body }` block.  These are the only forms a `by` clause ever takes.
CorrelationExpr infers Expression:
    NameRef ({infer PostfixChain.head=current} suffixes+=PostfixSuffix+)?;

// SQL-92 isolation levels.  Optional on `transactional`; default
// (when omitted) uses the database connection's configured level
// (Postgres = read committed; SQL Server = read committed).
IsolationLevel returns string:
    'readUncommitted' | 'readCommitted' | 'repeatableRead' | 'serializable';

// Projection — a read model folded from FOREIGN events (projection.md).  The
// passive read-half of an event-sourced workflow: declared state fields
// (`Property`) + pure `on(e: Event)` folds, keyed by a correlation column.
// No command side (no create/handle/emit, no operations) — a projection
// originates nothing, it only reflects.  `keyed by` is REQUIRED (no inference,
// unlike a workflow's derived correlation field): a read-model schema routinely
// carries several foreign ids, so a single-id rule would be ambiguous.  `key`
// is a plain name (like `Channel`'s `key:`), resolved to a declared state field
// by the validator (`loom.projection-key-*`).
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
// workflow (workflow-instance-views.md).  Two forms share the same head:
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
// A view's source is an aggregate (the wire shape is its repository read)
// or a workflow (the wire shape is its persisted instance / saga-state row —
// see docs/proposals/workflow-instance-views.md).  The grammar admits both;
// the validator restricts the workflow case (shorthand only, non-event-sourced).
type ViewSource = Aggregate | Workflow;

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

// Seed — first-boot data for a context's aggregates (database-seeding.md).
// Declarative form: a named dataset of typed records, each lowering through
// the aggregate's canonical create (D-SEED-PATH), so invariants hold.  `raw`
// opts a block into table-level inserts.  The imperative (workflow-shaped)
// body, `@handle` cross-row refs, and the deferred `key` clause are later
// slices.  Each row's value is an ObjectLit shaped like the aggregate's
// create parameters — no `id` field; the framework mints ids.
Seed:
    'seed' (dataset=ID)? (raw?='raw')? '{'
        rows+=SeedRow*
    '}';

SeedRow:
    aggregate=[Aggregate:ID] value=ObjectLit;

// Criterion — a named, parameterised, pure boolean predicate over a
// candidate type `T` (the Specification Pattern, Evans / Spring-Data
// style).  See docs/criterion.md.
//
//   criterion ActiveCustomer of Customer = active
//   criterion InRegion(region: string) of Customer = region == region
//   criterion HasManagerRole of bool = currentUser.role == "manager"
//   criterion CanForceClose of Order { where: status != Closed }
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
    (
        '=' body=Expression
      | '{' 'where' ':' body=Expression '}'
    );

// Retrieval — a named query *bundle*: a composed predicate (`where`,
// the same expression position as `criterion`/`find … where`, so it
// references criteria and `this.<field>` candidate refs) plus the
// shaping a real query carries — `sort` ordering and a `loads` fetch
// shape.  Pagination is NOT a slot here: `page` is a call-site argument
// on `Repo.run(R(args), page?)`, never part of the declaration.  See
// docs/proposals/retrieval.md.  Lowers to RetrievalIR
// (docs/proposals/reified-criteria.md).
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
// syntax).  Not an Expression: load-specifications.md restricts these to
// structural paths (no filters / lambdas).  A leading `this` is admitted
// and stripped at lowering so `this.lines[].product` and
// `lines[].product` are equivalent.
LoadPath:
    ('this' '.')? segments+=LoadSegment ('.' segments+=LoadSegment)*;

LoadSegment:
    name=LooseName (collection?='[]')?;

// Domain service — a stateless, named, context-level container of
// NON-mutating `operation`s (the pure-calculator floor, v1 Shape A).
// Operations take aggregates / value objects / primitives by value,
// return a value or an `or`-union error, and may `throw` for the
// bug regime.  Strict no-infra: a phase-⑦ validator rejects repo /
// extern / api / workflow-start / emit / this-write inside a body.
// Callable from operation / workflow / api bodies via a member call
// (`Pricing.quote(cart, customer)`), lowered to a Call with
// `callKind: "domain-service"`.  See docs/proposals/domain-services.md.
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

// v1: statement body ONLY (no `= Expression` shorthand — deferred).
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
    name=(ID | 'money' | 'immutable' | 'managed' | 'token' | 'internal' | 'secret'
        // Phase 2 page-metadata + favicon keywords — soft in property position.
        | 'description' | 'ogImage' | 'canonical' | 'favicon'
        // Storage / connection-source soft keywords — soft in property
        // position so user-declared fields named `env`, `service`, etc.
        // (showcase.ddd: `event BuildPromoted { … env: string … }`) still parse.
        | 'instance' | 'connection' | 'service' | 'env' | 'literal'
        // DataSource clause keys (PR-3) — soft in property position so
        // user-declared fields named `kind`, `schema`, `every`, etc.
        // (banking.ddd: `entity AccountTransaction { kind: string }`) still parse.
        | 'kind' | 'schema' | 'tablePrefix' | 'keyPrefix' | 'ttl' | 'every'
        | 'retain' | 'isolationLevel' | 'readonly' | 'use'
        | 'eventLog' | 'snapshot' | 'replica' | 'objectStore' | 'queue' | 'config' | 'resource' | 'dataSources'
        // Payload-family keywords (payload-transport-layer.md, P1) — soft in
        // property position so pre-existing fields named `payload`, `error`,
        // `query`, etc. (e.g. `event Foo { payload: string }`) keep parsing.
        // They act as hard keywords only at `ContextMember` position, where
        // `PayloadDecl` (`kind=PayloadKind name=ID '{'`) begins.
        | 'payload' | 'command' | 'query' | 'response' | 'error'
        // Generic-carrier keywords (payload-transport-layer.md, P3/P4) — soft
        // in property position so a pre-existing field named `paged` /
        // `envelope` / `option` / `or` keeps parsing.  Hard only in the
        // `GenericCtor` postfix-type slot / the `or` union separator.
        | 'paged' | 'envelope' | 'option' | 'or'
        // Retrieval keywords (retrieval.md) — soft in property position so
        // user-declared fields named `sort` / `loads` / `asc` / `desc` /
        // `retrieval` keep parsing.  Hard only inside the `Retrieval` slots.
        | 'retrieval' | 'sort' | 'loads' | 'asc' | 'desc'
        // `by` / `handle` soft in property position so fields named `by`
        // (`event Bumped { by: int }`) / `handle` (`engineer { handle: string }`)
        // keep parsing — hard only in the reactor clause / workflow handle member.
        | 'by' | 'handle'
        // `action` soft in property position so audit-shaped fields
        // (`AuditEntry { action: string }`) keep parsing — hard only in the
        // `ActionType` type position (Tier 2).
        | 'action'
        // `state` / `title` / `body` soft in property position so common domain
        // fields by those names (`state: Status`, `title: string`, `body: string`)
        // parse — they are hard keywords only in the page DSL (`state { … }`
        // block, page `title:` / `body:` metadata) and the storage-kind enum,
        // none of which begins an aggregate / VO / event member.  All three are
        // already in `LooseName`; this mirrors them for the `Property.name`
        // dispatch (which can't reuse `LooseName` wholesale because that set
        // includes member-starter keywords like `contains`).
        | 'state' | 'title' | 'body'
        // `parent` is hard only in the Requirement hierarchy clause
        // (`requirement R parent R0`); soft in property position so the
        // canonical self-referential field `parent: Self id?` (and any
        // domain field named `parent`) parses.
        | 'parent'
        // `store` is hard only as the leading keyword of the `Store` UI member
        // (`store Cart { … }`); soft in property position so a pre-existing
        // domain field named `store` (`Receipt { store: string }`,
        // persistence-shapes.ddd) keeps parsing (named-actions-and-stores.md §3).
        | 'store'
        // `await` is hard only as the match-subject marker
        // (`match await op() { … }`, async-actions-and-effects.md Stage 2);
        // soft in property position so a domain field named `await` parses.
        | 'await'
        // Tenancy keywords (multi-tenancy Phase 1a) — soft in property
        // position so a pre-existing field named `tenancy` / `crossTenant`
        // keeps parsing.  Hard only in the `TenancyDecl` head / `Aggregate`
        // header flag slot.
        | 'tenancy' | 'crossTenant'
        // Capability source-surface keywords — soft in property position so an
        // aggregate / VO / event field named `filter` / `stamp` / `implements`
        // parses (already soft in `StateFieldName` / `MemberName` /
        // `NameRefIdent`).  Hard only at aggregate / context member position
        // (`FilterDecl` / `StampDecl` / `ImplementsDecl`).
        | 'filter' | 'stamp' | 'implements'
        // Policy verb keywords (P3.1) admitted in property position so a
        // field named `read` / `write` parses.
        | 'write')
    ':' type=TypeRef
    (provenanced?='provenanced')?
    sensitivity=SensitivityClause?
    (access=FieldAccess)?
    // Default value — `field: T = <expr>`.  Placed after the access
    // modifier so the expression can't greedily swallow a trailing
    // modifier keyword.  Enables synthesising a create when no explicit
    // one is declared (see docs/proposals); for now it lowers onto the
    // FieldIR and downstream phases may consume it.
    ('=' default=Expression)?
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

// A uniqueness invariant (uniqueness-and-indexes.md, D-UNIQUE-DOMAIN).
// `unique (a, b)` declares a natural-key / identity rule — no two rows may
// share the listed tuple.  It is a set-level invariant (it structurally
// cannot run in the per-instance `AssertInvariants()` floor), so the
// compiler DERIVES its enforcement: a DB unique index (partial under
// `softDeletable`) plus a per-backend 23505 → 409 conflict mapping.  Columns
// are bare aggregate field names (flat list, not cross-refs — the validator
// resolves them against the aggregate's fields with a did-you-mean hint).
Unique:
    'unique' '(' columns+=LooseName (',' columns+=LooseName)* ')';

// A pure helper over its parameters (domain-services.md).  Two body forms:
//   `= Expression`        — expression form; SQL-inlinable like a `criterion`.
//   `{ Statement* }`      — block form (rev. 4); `let` + branch + bug-regime
//                           `throw`/`require`, still PURE (no repo, no
//                           mutation, no `emit`/`extern`).  The block form is
//                           NOT queryable.  `'='` vs `'{'` is the discriminator
//                           (distinct tokens — the AST stays non-recursive).
FunctionDecl:
    'function' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' ':' returnType=TypeRef
        ( '=' body=Expression
        | '{' block+=Statement* '}'
        );

// `when Expr` — the canCommand state gate (criterion.md, use site 2): the
// route evaluates the predicate against the loaded aggregate before the
// body runs (false → 409 Disallowed) and auto-exposes a side-effect-free
// `GET /{id}/can_<op>` returning `{ allowed }`.  Distinct from `requires`
// (auth, 403) and `precondition` (argument validation inside the body, 400).
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
// joins `agg.operations` (which stays mutate-only).  See
// docs/proposals/lifecycle-operations.md.
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
// (`persistedAs(eventLog)`).  `apply(e: OrderPlaced) { … }` binds the
// emitted event instance to `param` and mutates `this` to fold it into
// state.  Under the event-log discipline the command bodies
// (`operation`/`create`) may only `emit`; the actual state transition
// lives here.  Applier bodies are pure folds — assignments (`:=`/`+=`/
// `-=`) and derivations only, no `emit` and no side-effecting calls.
// Lowers to `ApplyIR`; never joins `agg.operations`.  See
// docs/proposals/workflow-and-applier.md.
Apply:
    'apply' '(' param=LooseName ':' event=[EventDecl:ID] ')' '{'
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
    // `of` is a hard keyword only in the `criterion <Name>(...) of <T>`
    // rule.  Admit it as a soft keyword everywhere LooseName is used so
    // the page-metamodel arg name `of` keeps parsing — `CreateForm(of: Order)`,
    // `CreateForm { of: x }` — and pre-existing files that named a field `of`
    // are unaffected (mirrors the `money` / field-access soft-keyword
    // treatment).
    | 'of'
    | 'id' | 'permissions' | 'contains'
    | 'ui' | 'page' | 'component' | 'store' | 'state' | 'menu'
    | 'section' | 'link' | 'route' | 'title' | 'body' | 'framework' | 'static'
    | 'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views'
    | 'design' | 'targets'
    | 'bind' | 'api'
    // `await` is hard only as the `match await op()` subject marker
    // (async-actions-and-effects.md Stage 2); soft everywhere else so a
    // field / param named `await` keeps parsing.
    | 'await'
    // `by` is a hard keyword only in the `on(...) by <expr>` reactor clause
    // (workflow-and-applier.md A2-S3); admit it as a soft keyword in
    // field / parameter / object-field / emit-field name position so
    // pre-existing identifiers named `by` (e.g.
    // `event Bumped { by: int }`) keep parsing.
    | 'by'
    // `handle` is a hard keyword only as the `handle name(...) { }` workflow
    // member (A2-S5c); admit it as a soft keyword in identifier positions so
    // pre-existing fields/params named `handle` (showcase.ddd) keep parsing.
    | 'handle'
    // `cache` is a hard keyword as a `DataSourceKind`; admit it as soft so a
    // field / theme key named `cache` parses.  (`primary` / `search` / `events`
    // / `bi` were legacy storage roles in the old `modules: { … }` clause,
    // removed with D-STORAGE-SPLIT — they are no longer keywords, so they need
    // no escape hatch and are ordinary identifiers again.)
    | 'cache'
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
    | 'description' | 'ogImage' | 'canonical' | 'favicon'
    // Storage / dataSource clause + connection-source keywords admitted
    // as soft so user code can still name a field `env`, `service`,
    // `instance`, `connection`, or `literal` (showcase.ddd uses
    // `env: string` as an event field, for instance).
    | 'instance' | 'connection' | 'service' | 'env' | 'literal'
    // DataSource clause keys (PR-3) admitted as soft so user code can
    // still use `kind`, `schema`, `every`, etc. as parameter / property
    // / loose-name positions.  `cache` is already admitted above
    // (storage roles), `for` predates this PR as a hard keyword.
    | 'kind' | 'schema' | 'tablePrefix' | 'keyPrefix' | 'ttl' | 'every'
    | 'retain' | 'isolationLevel' | 'readonly' | 'use'
    | 'eventLog' | 'snapshot' | 'replica' | 'objectStore' | 'queue' | 'config' | 'resource' | 'dataSources'
    // Api-body keyword (lifecycle Phase 2 / D-URLSTYLE) admitted as soft
    // so user code can still name a field `urlStyle`.  (`resource` is
    // already soft-admitted just above.)
    | 'urlStyle'
    // Payload-family keywords (payload-transport-layer.md, P1) admitted as
    // soft in loose-name positions; hard only at `ContextMember`
    // (`PayloadDecl`).
    | 'payload' | 'command' | 'query' | 'response' | 'error'
    // Generic-carrier keywords (payload-transport-layer.md, P3/P4) admitted as
    // soft in loose-name positions; hard only in the `GenericCtor`
    // postfix-type slot.  `option` joins the blessed set in P4.
    | 'paged' | 'envelope' | 'option'
    // Anonymous type-union separator (payload-transport-layer.md, P4) admitted
    // as soft so user code can still name a field / parameter `or`; hard only
    // between `TypeAtom`s in a `TypeRef`.
    | 'or'
    // D-REALIZATION-AXES — the six platform-block axis keywords admitted
    // as soft so user code can still name a field `application`,
    // `transport`, `runtime`, etc.  `transactional` is the `runtime`
    // default value and is ALSO the storage-isolation flag keyword
    // (`transactional?='transactional'`) — admit it here so it parses as
    // a `LooseName` value in the `runtime:` slot.
    | 'foundation' | 'application' | 'persistence' | 'directoryLayout'
    | 'transport' | 'runtime' | 'transactional'
    // Retrieval keywords (retrieval.md) admitted as soft so user code can
    // still name a field `retrieval` / `sort` / `loads` / `asc` / `desc`.
    // Hard only inside the `Retrieval` rule's slots.
    | 'retrieval' | 'sort' | 'loads' | 'asc' | 'desc'
    // `action` (extern-component-escape-hatch.md, Tier 2) admitted as soft
    // so user code can still name a field / arg `action`; hard only in the
    // `ActionType` type position.
    | 'action'
    // `ignoring` (named-filter-bypass.md, §11) is a soft keyword — hard only in
    // the `IgnoringClause` filter-bypass tail on a read (find / view / inline
    // `Repo.findAll`).  Admit it here so user code can still name a field /
    // parameter `ignoring`.
    | 'ignoring'
    // Capability source-surface keywords (`FilterDecl` / `StampDecl` /
    // `ImplementsDecl`) are hard only at aggregate / context member position;
    // admit them here so a field / parameter / call-arg named `filter` /
    // `stamp` / `implements` parses (matches their admission in
    // `StateFieldName` / `MemberName` / `NameRefIdent`).
    | 'filter' | 'stamp' | 'implements'
    // Tenancy keywords (multi-tenancy Phase 1a) admitted as soft so user
    // code can still name a field / parameter `tenancy` / `crossTenant`.
    // `tenancy` is hard only at the head of the `TenancyDecl` SystemMember;
    // `crossTenant` only in the `Aggregate` header flag slot.
    | 'tenancy' | 'crossTenant'
    // `parent` is hard only in the `Requirement` hierarchy clause
    // (`requirement R parent R0`); admit it here so it parses as a call-arg /
    // object-literal field name — e.g. the tenant-registry signup factory
    // `Organization.create({ name: nm, parent: par })` setting the immutable
    // self-FK the `tenantRegistry` capability provides (multi-tenancy Phase 2).
    // Already soft in `Property.name`; this mirrors it for `LooseName`.
    | 'parent'
    // Policy-block keywords (authorization.md §3; multi-tenancy Phase 2 P2.4)
    // admitted as soft so user code can still name a field / parameter / arg
    // `policy` / `allow` / `local` / `deep` / `global`.  `policy` is hard only
    // at the head of the `PolicyDecl` ContextMember; `allow` / the three
    // `ReadLevel` words only inside a `policy {}` block's read rules.
    // `read` / `write` (the P3.1 policy verb) are soft only in the optional
    // verb slot of a `PolicyReadRule`; admit them here so user code can still
    // name a field / parameter / arg `read` / `write`.
    | 'policy' | 'allow' | 'local' | 'deep' | 'global' | 'write';

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

// ML-postfix generic instantiation (payload-transport-layer.md, P3):
// `customer paged`, `event envelope`, `string envelope paged`.  The
// `(ctors+=GenericCtor)*` list accumulates left-associatively, so
// `string envelope paged` folds to `paged(envelope(string))` in lowering.
// Array/optional stay outermost — `customer paged[]` is array-of-(paged
// customer).  The constructors are a blessed closed keyword set (v1, A7a);
// keyword tokens can't be confused with an adjacent ID field name, which is
// what makes the otherwise-ambiguous postfix form (`a: string b: int`)
// safe.  User-declared generics + identifier-postfix instantiation are
// deferred (A7b).
// Anonymous `or` unions (payload-transport-layer.md, P4): `A or B or C` in
// any type position.  Postfix constructors (`paged` / `envelope` / `option`)
// and the array / optional markers bind tighter than `or` (the pin in the
// proposal's "`or` precedence with `option`" note), so `string or int option`
// parses as `string or (int option)` and `A or B[]` as `A or (B[])`.  The
// head atom's fields stay on `TypeRef` itself (backward-compatible: a
// non-union TypeRef has an empty `alternatives`, and every existing consumer
// reading `.base` / `.ctors` / `.array` / `.optional` is unchanged); each
// `or` adds one more `TypeAtom`.  Lowering folds the head + alternatives into
// a single `union` TypeIR when `alternatives` is non-empty.
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

// Element-shaped param type for component slot injection — see
// `docs/page-metamodel.md`.  Valid only on a `component`'s parameter
// list; values flow as JSX (`React.ReactNode`-ish in TS land) from
// the caller's expression scope into the component's body, where
// a bare ref `paramName` renders the caller's expr at that
// position.  The validator pins the position restriction.
SlotType:
    name='slot';

// Function-valued param type for component behaviour injection —
// `slot` carries elements, `action` carries behaviours
// (extern-component-escape-hatch.md, Tier 2).  Bare `action` is a
// zero-arg callback; `action(Order)` declares the callback's single
// argument type explicitly on the param (argument types are never
// inferred from call sites — lambda param types flow forward from
// the expected type).  Valid only on a component's parameter list;
// the caller passes a (block-body) lambda whose body is walked and
// hoisted in the caller's scope, exactly as `onSubmit` is.
ActionType:
    name='action' ('(' arg=TypeRef ')')?;

// `Self id` — a self-referential entity reference, valid only inside a
// `capability` body (typed-capabilities.md; the anchored-type / Eiffel
// `like Current` construct).  `Self` resolves to the implementing aggregate's
// own type: the expander rewrites `Self id` → `<Host> id` when it splices the
// capability into an aggregate, so lowering and the backends only ever see a
// concrete `X id`.  A `Self id` outside a capability is a validation error.
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
  // `navigate(…)`) rather than yield a value.  Introduced for
  // `match await op() { … }` in a frontend action body
  // (async-actions-and-effects.md Stage 2); keyword-led, so no ambiguity with
  // `AssignOrCallStmt` (which starts with a NameRef).
  | MatchStmt
  | AssignOrCallStmt;

// The effect-form match (Stage 2).  Distinct from the value-yielding `MatchExpr`
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
// retrieval result (`Repo.find(<Criterion>)`, criterion.md use site 3) and
// branch on its presence.  `<var>` is bound (unwrapped, non-null) only in the
// then-body; the optional `else` runs when no row matched.  The single
// option/null-handling construct in a workflow body — without it a nullable
// repo return has nowhere to go (see the `loom.workflow-*` checks).  `source`
// reuses `ForIterable` (NameRef + postfix suffixes), exactly the `Repo.find(C)`
// shape, which also keeps a trailing `{ }` block from being swallowed by a
// `BuilderCall` the way the loop iterable does.
IfLetStmt:
    'if' 'let' var=(ID | 'write') '=' source=ForIterable '{'
        thenBody+=Statement*
    '}' ('else' '{'
        elseBody+=Statement*
    '}')?;

// `return <expr>` — an operation's designed-in outcome (exception-less.md).
// Produces the operation's declared `or`-union return value; the route
// translates an `error`-variant result to a ProblemDetails status, a success
// variant to HTTP 200.
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
// that produce an aggregate array in v1 anyway.
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
// / ForbiddenError (TS).  See docs/auth.md.
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
    ID | 'id' | 'permissions' | 'contains' | 'ui' | 'api'
       | 'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views'
       // Soft-admit the lifecycle keywords so a bare-statement call
       // target like `ui.products.create({...})` parses (mirrors
       // MemberName).
       | 'create' | 'destroy'
       // Payload-family keywords (payload-transport-layer.md, P1) — soft in
       // l-value position so an assignment target naming a field `error`,
       // `query`, etc. parses; hard only at `ContextMember` (`PayloadDecl`).
       | 'payload' | 'command' | 'query' | 'response' | 'error'
       // Generic-carrier keywords (payload-transport-layer.md, P3/P4) — soft in
       // l-value position; hard only in the `GenericCtor` postfix-type slot /
       // the `or` union separator.
       | 'paged' | 'envelope' | 'option' | 'or'
       // `by` / `handle` soft in l-value position so an assignment target
       // naming a field `by` / `handle` (`handle := handle`) parses — hard only
       // in the reactor clause / workflow handle member (A2-S3/S5c).
       | 'by' | 'handle'
       // `action` soft in l-value position (Tier 2 `ActionType` is the only
       // hard position).
       | 'action'
       // `store` soft in l-value position so an assignment target naming a
       // field `store` (`store := store`, persistence-shapes.ddd) parses —
       // hard only as the `Store` UI-member leading keyword (Stage 5).
       | 'store'
       // Tenancy keywords (multi-tenancy Phase 1a) soft in l-value position
       // so an assignment target naming a field `tenancy` / `crossTenant`
       // parses.  Hard only in the `TenancyDecl` head / `Aggregate` header
       // flag slot.
       | 'tenancy' | 'crossTenant'
       // Capability source-surface keywords — soft in l-value position so an
       // assignment target naming a field `filter` / `stamp` / `implements`
       // (`filter := s`) parses, completing #1645's admission (Property.name /
       // LooseName / StateFieldName / MemberName / NameRefIdent all admit
       // them; l-value position was the missed spot).  Hard only at
       // aggregate / context member position.
       | 'filter' | 'stamp' | 'implements'
       // Policy verb keywords (P3.1) — soft in l-value position (`read := x`).
       | 'write';

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
// presence (variant-match.md):
//   * boolean-arms  — `match { cond => value, … else => … }`
//     (the original predicate-arms form; `subject` absent).
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
// v1 "subject must be a simple ref / let-bound name, not a
// side-effecting call" constraint is enforced by the validator
// (`loom.match-subject-not-simple`), not the grammar, so a call subject
// gets a friendly diagnostic rather than a raw parse error.
//
// EXCEPTION — an `await`-marked call (`match await placeOrder(draft) { … }`).
// A frontend action may discriminate the `or`-union result of a remote op by
// awaiting it in the subject position (async-actions-and-effects.md, Proposal B
// Stage 2).  `await <scrutinee>` wraps it in an `AwaitExpr`; this is the only
// place a call subject is admitted (bare, unmarked call subjects stay rejected).
// `await` is a soft keyword (see `LooseName`) so a field named `await` parses.
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
// declared `retrieval`, accepted by `Repo.run(...)` (criterion.md, use site 3).
// Same `where:` / `sort:` / `loads:` block as the declaration, minus the name
// and `of <T>` (the candidate is the `run` repository's aggregate).  Keyword-led
// (`retrieval { … }`) so it is an unambiguous primary expression — a bare `{`
// would be an ObjectLit.  `where` is a criterion reference in this release;
// `sort` / `loads` reuse the declared-retrieval `SortItem` / `LoadPath` rules.
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
    // parses (named-filter-bypass.md, §11).  It is only meaningful on a repo
    // read call; the lowering for `Repo.findAll`/`Repo.run` consumes
    // `bypass`/`bypassAll`, and the IR validator rejects it elsewhere.  Kept on
    // the chain (a discriminator/flat-list, not a recursive action) so it never
    // alters the existing PostfixChain shape for callers that ignore it.
    PrimaryExpr ({infer PostfixChain.head=current} suffixes+=PostfixSuffix+ IgnoringClause?)?;

PostfixSuffix:
      {infer MemberSuffix} '.' member=MemberName
        ( call?='(' (args+=CallArg (',' args+=CallArg)*)? ')' )?
    | {infer CallSuffix}   '(' (args+=CallArg (',' args+=CallArg)*)? ')';

// Call arguments admit an optional `name:` prefix (Slice 1.5).
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
    // `by` / `handle` admitted after `.` so member access like `e.by`,
    // `this.handle` keeps parsing (`by`/`handle` are hard only in the reactor
    // clause / workflow handle member).
    'by' | 'handle' |
    ID | 'id' | 'permissions' | 'contains' | 'ui' | 'api'
       | 'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views'
       | 'filter' | 'stamp' | 'implements'
       // Policy verb keywords (P3.1) admissible after `.` so a member named
       // `read` / `write` parses.
       | 'write'
       // `create` / `destroy` are hard keywords for the lifecycle
       // member rules (`Create` / `Destroy`) but must stay admissible
       // after `.` so the e2e + page surfaces keep parsing —
       // `Order.create({...})`, `api.products.create(...)`,
       // `Sales.Customer.create.mutate(...)`.  Magic-identifier
       // dispatch lives in lowering, not the grammar.
       | 'create' | 'destroy'
       // `find` is a hard keyword in `FindDecl` (`find foo(): T ...`) but must
       // be admissible after `.` so the built-in `Repo.find(<Criterion>)`
       // criterion lookup (the source of an `if let`, criterion.md use site 3)
       // parses as a member call — the sibling of the plain-ID `findAll`/`run`.
       | 'find'
       // `where` is a hard keyword in `FindDecl` (`find foo(): T where ...`)
       // and `View` (`view X = Y where ...` and the full form's `from Y where`),
       // but it's also the collection-op name in `arr.where(λ)` — see
       // `src/util/collection-ops.ts` and the `case "where":` arms in the TS /
       // Phoenix renderers.  Admit it here so expression-position uses parse.
       | 'where'
       // Payload-family keywords (payload-transport-layer.md, P1) admitted
       // after `.` so member access like `Sales.Customer.all.error` (a
       // generated-hook field) keeps parsing; hard only at `ContextMember`.
       | 'payload' | 'command' | 'query' | 'response' | 'error'
       // Generic-carrier keywords (payload-transport-layer.md, P3/P4) admitted
       // after `.` so member access on a field named `paged` / `envelope` /
       // `option` / `or` keeps parsing; hard only in the `GenericCtor`
       // postfix-type slot / the `or` union separator.
       | 'paged' | 'envelope' | 'option' | 'or'
       // `action` admitted after `.` (Tier 2 `ActionType` is the only hard
       // position).
       | 'action'
       // `store` admitted after `.` so member access on a field named `store`
       // parses — hard only as the `Store` UI-member leading keyword (Stage 5).
       | 'store'
       // Page-metadata + favicon soft keywords admitted after `.` so member
       // access on a field named `description` / `title` / `body` / `state` /
       // etc. parses — e.g. a scaffolded view-list column over a `description`
       // field (`o => Text { o.description }`).  These are already soft in
       // `Property.name` / `LooseName`; hard only in the page DSL metadata
       // slots (`title:` / `body:` / `description:` / the `state { … }` block).
       | 'description' | 'ogImage' | 'canonical' | 'favicon'
       | 'title' | 'body' | 'state'
       // `ignoring` (named-filter-bypass.md, §11) admitted after `.` so member
       // access on a field named `ignoring` keeps parsing.  Hard only in the
       // `IgnoringClause` read tail.
       | 'ignoring'
       // Tenancy keywords (multi-tenancy Phase 1a) admitted after `.` so
       // member access on a field named `tenancy` / `crossTenant` keeps
       // parsing (`this.tenancy`).  Hard only in the `TenancyDecl` head /
       // `Aggregate` header flag slot.
       | 'tenancy' | 'crossTenant';

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
      RetrievalLiteral
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
       // Lifecycle keywords admitted as bare NameRefs so an expression
       // can use one as the receiver of a member access — e.g. the
       // generated-hook handle in a page lambda
       // (`onSubmit: v => create.mutateAsync(v)`).  They only act as
       // hard keywords at aggregate-member position (`Create`/`Destroy`).
       | 'create' | 'destroy'
       | 'contains' | 'page' | 'component' | 'store' | 'state' | 'menu'
       | 'section' | 'link' | 'route' | 'title' | 'body' | 'framework' | 'static'
       | 'modules' | 'contexts' | 'aggregates' | 'workflows' | 'views'
       | 'design' | 'targets' | 'bind'
       // `by` admitted as a bare NameRef so expressions can read a field
       // named `by` (e.g. `emit Bumped { by: by }`).  Hard only in the
       // `on(...) by <expr>` reactor clause.
       | 'by'
       | 'handle'
       // `cache` is a hard keyword as a `DataSourceKind`; admit it as soft so a
    // field / theme key named `cache` parses.  (`primary` / `search` / `events`
    // / `bi` were legacy storage roles in the old `modules: { … }` clause,
    // removed with D-STORAGE-SPLIT — they are no longer keywords, so they need
    // no escape hatch and are ordinary identifiers again.)
    | 'cache'
       | 'filter' | 'stamp' | 'implements'
       // Policy verb keywords (P3.1) — soft in NameRef so an expression can
       // read a field named `read` / `write`.
       | 'write'
       | 'immutable' | 'managed' | 'token' | 'internal' | 'secret'
       // Phase 2 page-metadata + favicon keywords admitted as NameRef
       // so expressions can read a field named `description`,
       // `ogImage`, etc. (e.g. `description != null` in a derived
       // property — see showcase.ddd).
       | 'description' | 'ogImage' | 'canonical' | 'favicon'
       // Storage / connection-source soft keywords — see LooseName for
       // the rationale.  Admitted here so expressions can read a field
       // named `env`, `service`, etc.
       | 'instance' | 'connection' | 'service' | 'env' | 'literal'
       // DataSource clause keys (PR-3) — admitted as bare NameRefs so
       // expression bodies can reference a state/property field named
       // `kind` (`Field { kind + ":", bind: v }` in walker tests).
       | 'kind' | 'schema' | 'tablePrefix' | 'keyPrefix' | 'ttl' | 'every'
       | 'retain' | 'isolationLevel' | 'readonly' | 'use'
       | 'eventLog' | 'snapshot' | 'replica' | 'objectStore' | 'queue' | 'config' | 'resource' | 'dataSources'
       | 'urlStyle'
       // Payload-family keywords (payload-transport-layer.md, P1) admitted as
       // bare NameRefs so expressions can read a field named `payload`,
       // `error`, `query`, etc.  Hard only at `ContextMember` (`PayloadDecl`).
       | 'payload' | 'command' | 'query' | 'response' | 'error'
       // Generic-carrier keywords (payload-transport-layer.md, P3/P4) admitted
       // as bare NameRefs so expressions can read a field named `paged` /
       // `envelope` / `option` / `or`.  Hard only in the `GenericCtor`
       // postfix-type slot / the `or` union separator.
       | 'paged' | 'envelope' | 'option' | 'or'
       // Retrieval keywords (retrieval.md) admitted as bare NameRefs so an
       // expression can read a field named `retrieval` / `sort` / `loads` /
       // `asc` / `desc`.  Hard only inside the `Retrieval` rule's slots.
       | 'retrieval' | 'sort' | 'loads' | 'asc' | 'desc'
       // `action` admitted as a bare NameRef (Tier 2 `ActionType` is the only
       // hard position).
       | 'action'
       // `ignoring` (named-filter-bypass.md, §11) admitted as a bare NameRef so
       // an expression can read a field named `ignoring`.  Hard only in the
       // `IgnoringClause` read tail.
       | 'ignoring'
       // Tenancy keywords (multi-tenancy Phase 1a) admitted as bare NameRefs
       // so an expression can read a field named `tenancy` / `crossTenant`.
       // Hard only in the `TenancyDecl` head / `Aggregate` header flag slot.
       | 'tenancy' | 'crossTenant';

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
