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
  /** When `"server-only"`, the invariant skips wire-boundary
   *  validators (frontend Zod, Hono routes, FluentValidation) even
   *  when its expression would translate cleanly.  Domain-layer
   *  enforcement via `AssertInvariants()` always runs.  Set by
   *  the `@server-only` annotation in the DSL (slice 21.C).
   *  Absent in slice 21.A — the field exists so 21.B / 21.C don't
   *  break the type. */
  scope?: "server-only";
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
  /** Traceability back-link (Slice 12): the `verifies <TC-id>` clause
   *  naming the TestCase this executable test realises.  Undefined when
   *  the test declares no link.  Enrichment uses it to mark a TestCase
   *  as backed by an executable test. */
  verifiesTestCase?: string;
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

/** A saved, strongly-typed query over one source aggregate.  Two
 *  forms share one IR shape:
 *
 *   - **Shorthand** (`view X = Y where ...`): `output` is undefined;
 *     result is the source aggregate's enriched wire shape (an
 *     array thereof).
 *   - **Full form** (`view X { fields ... from Y where? ... bind ... }`):
 *     `output` is populated with the declared field set and a
 *     bind expression per field.  The view's response shape is a
 *     fresh record matching `output.fields`; the bind expressions
 *     project from the hydrated source aggregate to the row.
 *
 *  Compiles to a per-view method on the source aggregate's
 *  repository plus a `GET /views/<snake_name>` route on each
 *  backend.  Joined sources / per-view parameters come in slice 3. */
export interface ViewIR {
  name: string;
  /** Source aggregate.  Must live in the same context as the
   *  view declaration. */
  aggregateName: string;
  /** Queryable predicate.  Required by the shorthand grammar;
   *  optional in the full form.  Subject to the same restrictions
   *  as repository find filters. */
  filter?: ExprIR;
  /** Custom output shape.  Undefined for the shorthand form. */
  output?: {
    fields: FieldIR[];
    binds: { name: string; expr: ExprIR; type: TypeIR }[];
    /** Foreign aggregates referenced by bind expressions via
     *  `Id<X>` follow.  Multi-hop supported: `path` is the chain of
     *  Id-typed field accesses from the source aggregate outward —
     *  `["customerId"]` for `customerId.name`,
     *  `["customerId", "regionId"]` for
     *  `customerId.regionId.name`.  Each unique path produces one
     *  bulk-load + map at view-emission time.  Auxiliaries are
     *  ordered by path length (shortest first) so each load's
     *  prerequisites are already in scope.  Empty when the view has
     *  no follows. */
    auxiliaries: { path: string[]; aggName: string; mapVar: string }[];
  };
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
  | { kind: "requires"; expr: ExprIR; source: string }
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
  /** Traceability artifacts (Slice 12) — model-wide, since a Solution
   *  or TestCase may reference code across modules and systems. */
  requirements: RequirementIR[];
  solutions: SolutionIR[];
  testCases: TestCaseIR[];
  /** Derived traceability index, populated by `enrichLoomModel`.  Left
   *  undefined by lowering so an unenriched model is a type error to
   *  consume from a report generator. */
  traceability?: TraceabilityIR;
}

// ---------------------------------------------------------------------------
// Traceability (Slice 12)
// ---------------------------------------------------------------------------

export type RequirementType =
  | "UserStory"
  | "UseCase"
  | "AcceptanceCriteria"
  | "BusinessReq";

export type RequirementStatus =
  | "Draft"
  | "Approved"
  | "InProgress"
  | "Done";

export interface RequirementIR {
  id: string;
  type: RequirementType;
  title: string;
  status?: RequirementStatus;
  priority?: number;
  /** Parent requirement id (hierarchy), or undefined for a root. */
  parentId?: string;
}

/** The kind of code symbol a CodeRefIR points at — read off the
 *  resolved AST node's type at lowering time so backends never
 *  re-resolve. */
export type CodeRefKind =
  | "module"
  | "context"
  | "aggregate"
  | "operation"
  | "valueobject"
  | "event"
  | "repository"
  | "workflow"
  | "view"
  | "deployable"
  | "api";

/** A resolved, qualified reference from a Solution/TestCase into the
 *  domain model (`Identity.Auth.LoginSession.start`). */
export interface CodeRefIR {
  qualifiedName: string;
  kind: CodeRefKind;
}

export interface SolutionIR {
  id: string;
  /** Requirement this solution justifies (`for <req>`). */
  forRequirement: string;
  title: string;
  /** Code symbols this solution legitimises (`entitles [...]`). */
  entitles: CodeRefIR[];
}

export interface TestCaseIR {
  id: string;
  /** Requirement this test case verifies (`verifies <req>`). */
  verifies: string;
  title: string;
  /** Code symbols this test case exercises (`covers [...]`). */
  covers: CodeRefIR[];
}

/** Derived traceability / coverage index built by `enrichLoomModel`
 *  in one pure pass.  Every report generator reads these precomputed
 *  views rather than recomputing — the same contract `wireShape` has. */
export interface TraceabilityIR {
  /** Requirement id → its direct child requirement ids. */
  childrenOf: Record<string, string[]>;
  /** Requirement id → TestCase ids that verify it directly OR verify
   *  one of its (transitive) descendants. */
  testsByRequirement: Record<string, string[]>;
  /** Requirement id → Solution id justifying it, or null if none. */
  solutionByRequirement: Record<string, string | null>;
  /** Every targetable code symbol referenced anywhere, keyed by
   *  qualified name (union of all entitles + covers). */
  codeElements: Record<string, CodeRefKind>;
  /** Code qualified name → TestCase ids that `cover` it. */
  testsByCodeElement: Record<string, string[]>;
  /** Code qualified name → ids of executable tests (TestIR /
   *  TestE2EIR names) whose `verifies` testCase covers it. */
  execTestsByCodeElement: Record<string, string[]>;
  /** TestCase id → executable-test names backing it (via the test's
   *  `verifies` back-link). */
  execTestsByTestCase: Record<string, string[]>;
}

/** A deployment plan: modules grouping bounded contexts, plus the
 * deployable artefacts that ship subsets of those modules. */
export interface SystemIR {
  name: string;
  modules: ModuleIR[];
  deployables: DeployableIR[];
  e2eTests: TestE2EIR[];
  /** Optional system-wide user-claim shape.  Populated when the source
   *  declares a `user { ... }` block at system scope.  Required when
   *  any deployable has `auth: { required: true }` (validator
   *  enforces).  The fields are the typed claims that backends decode
   *  JWT tokens into; `currentUser` references in expression bodies
   *  resolve members against this shape. */
  user?: UserIR;
  /** Optional system-wide visual-identity tokens.  Populated when the
   *  source declares a `theme { ... }` block at system scope.  Each
   *  React deployable consumes the same ThemeIR; the platform's
   *  emitter translates the framework-agnostic tokens into Mantine /
   *  shadcn / etc. theming knobs. */
  theme?: ThemeIR;
  /** UI declarations at system scope (Slice 2).  Each is referenced by
   *  zero-or-more deployables via `DeployableIR.uiName`.  Empty when
   *  the system declares no `ui { ... }` blocks.  Order preserves
   *  source order (matters for stable scaffold expansion in Slice 4). */
  uis: UiIR[];
  /** API declarations at system scope.  Each is a contract derived
   *  from a module's domain — its aggregates, repositories,
   *  workflows, views become the api's exposed operations.  UIs
   *  reference apis via their `api X: ApiName` parameters; backend
   *  deployables `serves:` a named api; frontend deployables
   *  `consumes:` an api from a named target. */
  apis: ApiIR[];
  /** Storage declarations at system scope.  Each is a typed slot
   *  the deployable composition picks up via `modules: <M> {
   *  primary: <Storage>, cache: <Storage>, ... }`.  Reusable across
   *  deployables. */
  storages: StorageIR[];
}

/** A single typed storage instance.  v0 type enum covers the
 *  common roles seen in real deployments — postgres / mysql /
 *  sqlite / inMemory for transactional, redis for cache, elastic
 *  / meilisearch for search, kafka for events, clickhouse /
 *  bigquery for analytics. */
export interface StorageIR {
  name: string;
  type: StorageKind;
}

export type StorageKind =
  | "postgres"
  | "mysql"
  | "sqlite"
  | "inMemory"
  | "redis"
  | "elastic"
  | "meilisearch"
  | "kafka"
  | "clickhouse"
  | "bigquery";

/** System-level `theme { ... }` block.  Tokens are semantic so the
 *  same source applies to whatever target the React generator
 *  picks (Mantine today; shadcn/ui or others tomorrow).  All
 *  fields optional — a `theme {}` block is allowed but produces
 *  the platform's defaults.  Color values are validated to be
 *  CSS hex strings (#RGB / #RRGGBB / #RRGGBBAA); radius is one
 *  of the five named scale steps. */
export interface ThemeIR {
  /** Brand color — e.g. "#3b82f6".  Mantine emitter generates a
   *  10-shade ramp from this hex and registers it as the project's
   *  `primaryColor`. */
  primary?: string;
  /** Neutral / gray palette source.  Mantine emitter sets
   *  `colors.gray` to a 10-shade ramp from this hex, which Mantine
   *  uses for muted text, borders, dimmed backgrounds, etc. */
  neutral?: string;
  /** Border-radius scale step.  One of the five named values. */
  radius?: "none" | "sm" | "md" | "lg" | "xl";
  /** Body / control font stack.  Passed through verbatim — caller
   *  is responsible for ensuring the named fonts are available
   *  (web font import, system fallback chain). */
  fontFamily?: string;
}

/** System-level `user { ... }` block.  Each field carries an
 *  ordinary TypeIR — primitives, `Id<X>`, enums, value-objects,
 *  optional `T?` — and contributes to the emitted User type plus
 *  the `currentUser` magic identifier's member-access surface. */
export interface UserIR {
  fields: FieldIR[];
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
  /** Traceability back-link (Slice 12) — see `TestIR.verifiesTestCase`. */
  verifiesTestCase?: string;
}

// ---------------------------------------------------------------------------
// Page metamodel (Slice 2)
//
// Mirrors the grammar productions added in Slice 1.  Every IR node here
// is a one-to-one lowering of a `Ui` / `Page` / `Component` / `Scaffold`
// / `MenuBlock` AST.  Scaffolds are NOT expanded at this layer — they
// stay as literal `ScaffoldIR` directives until the scaffold expander
// runs (Slice 4).  Validator obligations land in Slice 3 and the page
// emitter in Slice 5.
//
// Designed so a future LiveView / Blazor backend can consume the same
// IR — mutations (`:=`), navigations, and component invocations are
// platform-neutral here; their lowering into framework-specific code
// is the per-target generator's concern.
// ---------------------------------------------------------------------------

/** A `ui` SystemMember: pages, components, scaffold directives, and
 *  an optional sidebar menu block. */
export interface UiIR {
  name: string;
  pages: PageIR[];
  components: ComponentIR[];
  scaffolds: ScaffoldIR[];
  /** Optional ui-level menu block.  When undefined the sidebar is
   *  derived from each page's `menuMeta` (see spec §11). */
  menu?: MenuBlockIR;
  /** UI api parameters.  Each entry maps a local handle name (used in
   *  page bodies as `<handle>.<aggregate>.<op>`) to an api the system
   *  declares.  Composition is supplied by the deployable that
   *  deploys this UI. */
  apiParams: UiApiParamIR[];
  /** Slice A6 — user-authored TS helpers brought into the walker
   *  stdlib via `import helper <name> from "<path>"`.  Body refs to
   *  `<name>(...)` emit a TS `import { <name> } from "<path>"` at
   *  the top of the generated page TSX. */
  helperImports: UiHelperImportIR[];
}

/** UI helper import — `import helper formatPrice from "./helpers/price"`.
 *  The path is preserved verbatim; the page TSX includes it as a
 *  named import. */
export interface UiHelperImportIR {
  /** Helper function name (referenced in page bodies). */
  name: string;
  /** Module path (preserved verbatim — caller decides absolute /
   *  relative / package). */
  path: string;
}

/** API declaration — first-class contract derived from a module's
 *  domain.  Auto-derives the full surface (aggregate CRUD +
 *  repository finds + workflows + views).  Future: customization
 *  (hide, rename, expose subset, version). */
export interface ApiIR {
  name: string;
  /** Source module the api derives its surface from. */
  sourceModule: string;
}

/** UI api parameter — local handle + which api it expects. */
export interface UiApiParamIR {
  /** Local name used in page bodies (e.g. `Sales` in `Sales.Customer.all`). */
  name: string;
  /** Name of the system-scope `Api` this parameter expects. */
  apiName: string;
}

/** A page declaration: route + parameters + reactive state + body. */
export interface PageIR {
  name: string;
  params: ParamIR[];
  /** Path-with-`:params` from `route: "..."`.  Always set for pages
   *  written in source; pages synthesised by Slice 4's scaffold
   *  expander populate this from the rewrite rule. */
  route?: string;
  /** Optional title expression.  May interpolate state / data refs. */
  title?: ExprIR;
  /** Auth gate, same syntax as on operations. */
  requires?: ExprIR;
  /** Reactive local fields.  Multiple `state { }` blocks merge here
   *  (matches the `permissions` block multiplicity rule). */
  state: StateFieldIR[];
  /** Single body expression.  Conditional rendering uses `match` in
   *  the expression engine, not a guarded-declaration form. */
  body?: ExprIR;
  /** Per-page menu metadata.  Read by the menu emitter (Slice 6) when
   *  no explicit ui-level menu block is declared. */
  menuMeta?: MenuMetaIR;
  /** Provenance discriminator (Slice 4): `"explicit"` for pages
   *  written in source; `"scaffold"` for pages synthesised by the
   *  expander.  Slice 5's emitter uses this to fast-path the legacy
   *  per-aggregate / per-workflow / per-view builders for the bulk-
   *  scaffold case (byte-equivalence target). */
  source: "explicit" | "scaffold";
  /** Slice 4 only sets this for scaffold-synthesised pages.  Carries
   *  the structural shape of the page so Slice 5's emitter can
   *  dispatch without re-parsing the body expression.  Same source
   *  context the legacy generator's per-aggregate / per-workflow /
   *  per-view loop received. */
  scaffoldOrigin?: ScaffoldOriginIR;
  /** Slice C1 — explicit emit path override for walker-rendered
   *  pages.  When set, the page-emitter writes the rendered TSX to
   *  this path instead of the default `src/pages/<page-snake>.tsx`.
   *  Populated by `expandScaffoldToExplicitBody` so a scaffold-
   *  expanded page lands at the conventional archetype path
   *  (`src/pages/<plural>/list.tsx` for `aggregate-list`, etc.) —
   *  preserves URL/file shape across the C2 default flip. */
  emitPath?: string;
  /** Slice C2 — true when the scaffold expander rewrote `body`
   *  from the original archetype call (e.g. `List(of: …)`) to a
   *  walker-stdlib composition.  `scaffoldOrigin` is intentionally
   *  preserved on these pages so the per-aggregate page-object
   *  emitter still fires; `expandedFromScaffold` tells the
   *  page-emitter to dispatch the rewritten body through the
   *  walker instead of the archetype renderer. */
  expandedFromScaffold?: boolean;
}

/** Provenance for a scaffold-synthesised page.  Each kind names the
 *  domain-IR target plus the page archetype within that target's
 *  generated set. */
export type ScaffoldOriginIR =
  | { kind: "aggregate-list"; aggregateName: string; contextName: string }
  | { kind: "aggregate-new"; aggregateName: string; contextName: string }
  | { kind: "aggregate-detail"; aggregateName: string; contextName: string }
  | { kind: "workflow-form"; workflowName: string; contextName: string }
  | { kind: "view-list"; viewName: string; contextName: string }
  | { kind: "workflows-index" }
  | { kind: "views-index" }
  | { kind: "home" };

/** A user-defined component: typed function from params (and optional
 *  local state) to a body expression.  Components compose other
 *  components but never produce pages or routes. */
export interface ComponentIR {
  name: string;
  params: ParamIR[];
  state: StateFieldIR[];
  body: ExprIR;
}

/** One reactive local field, inside a `page` or `component`. */
export interface StateFieldIR {
  name: string;
  type: TypeIR;
  /** Optional initial value.  Undefined fields default to `null`
   *  for optional types and the type's zero value otherwise (per
   *  spec §6). */
  init?: ExprIR;
}

/** A `scaffold <selector>: <targets>` directive — single fixed multi-
 *  page rewrite over a domain selector.  Slice 4's expander turns this
 *  into literal `PageIR` nodes; this IR carries only the source-level
 *  intent. */
export interface ScaffoldIR {
  selector: ScaffoldSelector;
  targets: string[];
}

export type ScaffoldSelector =
  | "modules"
  | "contexts"
  | "aggregates"
  | "workflows"
  | "views";

/** Per-page sidebar metadata.  Bare entries — validator (Slice 3)
 *  enforces the allowed key names (`section` / `label` / `order` /
 *  `hidden`).  Same shape as `ThemeIR`'s entries: bare key + typed
 *  value, with the validator policing the surface. */
export interface MenuMetaIR {
  entries: { name: string; value: ExprIR }[];
}

/** A `menu { section "S" { link Page, link "L" -> "url" } }` block. */
export interface MenuBlockIR {
  sections: MenuSectionIR[];
}

export interface MenuSectionIR {
  label: string;
  links: MenuLinkIR[];
}

export type MenuLinkIR =
  | {
      kind: "page";
      pageName: string;
      /** Override props (`label`, `order`).  Validator checks the
       *  allowed key names. */
      props: { name: string; value: ExprIR }[];
    }
  | {
      kind: "external";
      label: string;
      url: string;
    };

// ---------------------------------------------------------------------------

export interface ModuleIR {
  name: string;
  contexts: BoundedContextIR[];
  /** Permission catalogue declared via per-module `permissions { ... }`
   *  blocks.  Empty when the module declares none.  Each entry's
   *  `runtimeString` is the value backends compare against
   *  `currentUser.permissions[]` claims; the source-side identifier
   *  (`name`) is what `permissions.<name>` references resolve to in
   *  expression bodies. */
  permissions: PermissionDeclIR[];
}

/** One permission declared in a module's `permissions { }` block. */
export interface PermissionDeclIR {
  /** Source-side identifier used as `permissions.<name>` in
   *  expression bodies. */
  name: string;
  /** Runtime string emitted when a `permissions.<name>` reference
   *  lowers to a literal — `<lowercased-module>.<name>`.  Stable
   *  across regens so claim payloads can be expressed in plain
   *  strings on the wire. */
  runtimeString: string;
}

// `static` is the page-metamodel's UI-only deployable kind: builds a
// Vite bundle and serves it via a small static-asset host (nginx in
// the v0 emitter).  Coexists with `react` until Slice 8 swaps them
// out — keeps every existing test/example green during the rollout.
//
// `phoenixLiveView` is the fullstack Elixir/Ash + Phoenix LiveView
// platform: a single deployable serves an Ash-derived API AND mounts
// a `ui:` whose pages render as LiveView modules against the
// `ashPhoenix` HEEx pack.  Unlike `react`/`static` it owns its own
// database (`needsDb: true`) and never declares `targets:` —
// validator enforces both.
export type Platform = "dotnet" | "hono" | "react" | "static" | "phoenixLiveView";

export interface DeployableIR {
  name: string;
  /** The platform **family** (`"hono"`, `"dotnet"`, `"react"`, …) —
   *  the closed union every downstream consumer branches on.  A
   *  `family@version` pin in the source is normalised here to its
   *  family so `platform === "hono"` etc. stay valid (byte-identical
   *  to pre-backend-packages output). */
  platform: Platform;
  /** Backend-packages B1 — the fully-qualified backend ref
   *  (`"hono@v4"`) after lowering, mirroring `design?`.  Bareword
   *  `platform: hono` resolves through `BUILTIN_PLATFORM_LATEST`;
   *  a pin (`platform: "hono@v4"`) flows through as written.  For
   *  frontend platforms (`react`/`static`) this equals `platform`
   *  (they version via the design/stack axis, not here).  The
   *  system orchestrator's dispatch stays on `platform` in B1; B3
   *  switches it to this field once a family has >1 version. */
  platformRef: string;
  /** Names of modules included in this deployable.  For react frontends,
   * inherited from the targeted backend deployable. */
  moduleNames: string[];
  /** HTTP port the deployable's web server listens on. */
  port: number;
  /** Backend deployable this frontend talks to.  Set only when
   * platform === "react"; the frontend's API base URL is derived from
   * the target's port. */
  targetName?: string;
  /** Design-system template pack the React frontend generator renders
   *  pages against.  Built-ins: "mantine", "chakra", "mui", "shadcn",
   *  "ashPhoenix".  A string starting with "./" or "/" is a custom
   *  pack path resolved relative to the .ddd file (a directory
   *  containing pack.json).  Only meaningful when platform === "react"
   *  (or "static"/"dotnet" with a UI mount, or "phoenixLiveView");
   *  ignored otherwise.
   *
   *  **Phase 0 of pack versioning:** after lowering this field is
   *  always fully qualified (`family@version`, e.g. `"mantine@v7"`)
   *  for built-in packs.  The bareword DSL form `design: mantine`
   *  resolves through `BUILTIN_PACK_LATEST` during lowering, so
   *  downstream consumers (generator dispatch at
   *  `src/generator/react/index.ts:106`, the build-matrix CI test,
   *  snapshot fixtures) see an unambiguous string and don't need to
   *  re-resolve the toolchain default.  Custom paths flow through
   *  verbatim.
   *
   *  Named `design` rather than `ui` because the test DSL already
   *  uses `ui.workflows.X(...)` as a member-access namespace; making
   *  `ui` a keyword in the deployable block would shadow the test-DSL
   *  accessor and break parsing of existing examples. */
  design?: string;
  /** Per-deployable auth opt-in.  Populated when the source declares
   *  `auth: required` on the deployable.  Backends with
   *  `auth.required === true` emit JWT-decode middleware + a verifier
   *  hook the user implements; deployables without this stay open
   *  (existing behaviour). */
  auth?: { required: boolean };
  /** Name of the `ui { ... }` SystemMember this deployable serves
   *  (Slice 1 grammar; Slice 2 IR).  Set when the source declares
   *  either `ui: <Name>` (sugar) or `ui <Name> { framework: ... }`
   *  (full block).  Validator (Slice 3) ensures the referenced ui
   *  exists, the deployable's platform supports a UI mount, and the
   *  framework value is one of the v0-allowed alternatives.  Empty
   *  string is never produced — undefined ⇒ no UI binding. */
  uiName?: string;
  /** Frontend rendering technology — `react` is the only v0 value
   *  (default when `ui:` is set without an explicit `framework:`).
   *  Future LiveView / Blazor backends extend this enum without
   *  breaking the deployable IR. */
  uiFramework?: string;
  /** Slice 11.26 — apis this backend deployable serves.  Each
   *  entry references an `Api` declared at system scope.  Empty
   *  for frontend deployables and for backends that haven't yet
   *  migrated to the explicit composition syntax. */
  serves: string[];
  /** Slice 11.26 — UI api parameter bindings for frontend
   *  deployables.  Each entry binds a UI parameter (declared as
   *  `api <Name>: <Api>` in the ui block) to the backend
   *  deployable that supplies it (which must `serves:` the
   *  param's contract).  Empty for backend deployables and for
   *  frontends whose UI declares no api parameters. */
  uiBindings: UiParamBindingIR[];
  /** Slice 11.27 — per-module storage bindings on a backend
   *  deployable.  Each entry corresponds to one `modules:` entry
   *  with an optional brace block (`Sales { primary: pg, cache:
   *  redis }`).  Bare-list form (`modules: Sales, Marketing`)
   *  produces entries with empty `storages` arrays. */
  moduleBindings: ModuleBindingIR[];
}

/** A single UI-parameter binding on a frontend deployable.
 *  Maps the UI parameter's local name to the backend deployable
 *  that fills it. */
export interface UiParamBindingIR {
  /** Local UI parameter name (matches `api <name>: <Api>` in the ui block). */
  paramName: string;
  /** Name of the backend deployable that supplies the param's contract. */
  sourceDeployableName: string;
}

/** Slice 11.27 — per-module storage bindings on a backend
 *  deployable.  Each entry binds a module's role-keyed storage
 *  slot to a system-scope storage declaration. */
export interface ModuleBindingIR {
  /** Module the bindings apply to. */
  moduleName: string;
  /** Role → storage-name map (`primary`, `cache`, `search`,
   *  `events`, `bi`).  Empty when the source declared the bare
   *  `modules: Sales` form (no brace block). */
  storages: { role: ModuleStorageRole; storageName: string }[];
}

export type ModuleStorageRole =
  | "primary"
  | "cache"
  | "search"
  | "events"
  | "bi";

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type StmtIR =
  | { kind: "precondition"; expr: ExprIR; source: string }
  | { kind: "requires"; expr: ExprIR; source: string }
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
  | "current-user"        // magic identifier — system's `user` block shape
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
      /** Optional parallel array (Slice 1.5): `argNames[i]` is the
       *  source-side `name:` prefix for `args[i]`, or `undefined` for
       *  positional arguments.  Present iff at least one arg was
       *  written with a name; absent for fully-positional calls (the
       *  vast majority — keeps IR compact for v22-shaped code). */
      argNames?: (string | undefined)[];
    }
  | {
      kind: "call";
      callKind: CallKind;
      name: string;
      args: ExprIR[];
      /** Same shape as `method-call.argNames` — see above. */
      argNames?: (string | undefined)[];
    }
  | {
      kind: "lambda";
      param: string;
      /** Single-expression form: `x => expr`.  Mutually exclusive with
       *  `block`.  Existing v22 lambdas always populate this. */
      body?: ExprIR;
      /** Block-body form (Slice 1 grammar): `x => { stmt; stmt; … }`.
       *  Reuses the existing `StmtIR` rule so `let`, `:=`, calls,
       *  emits, etc. are admissible.  React emitter (Slice 5) lowers
       *  state mutations against `state {}` fields to `setX(...)`. */
      block?: StmtIR[];
    }
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
  | { kind: "ternary"; cond: ExprIR; then: ExprIR; otherwise: ExprIR }
  /**
   * Predicate-arms expression (Slice 1 grammar) — first arm whose
   * `cond` evaluates to `true` returns its `value`; if no arm
   * matches, `otherwise` (when present) is the fallthrough.  Lives
   * in the expression engine so it can appear anywhere an expression
   * is allowed (page bodies, `derived` properties, view binds,
   * filter lambdas, function bodies).  Validator (Slice 3) may warn
   * on non-exhaustive matches that lack `otherwise`.
   */
  | {
      kind: "match";
      arms: { cond: ExprIR; value: ExprIR }[];
      otherwise?: ExprIR;
    };

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

// ---------------------------------------------------------------------------
// `currentUser` reference detection.
//
// Every per-platform emitter needs to know "does this operation /
// workflow / view body actually reference the `currentUser` magic
// identifier?" so it can:
//   - thread a `User` parameter into the generated method signature,
//   - inject the request-scoped user accessor into the Mediator
//     handler / Hono route,
//   - decide whether to import the auth types at all.
// One IR-level helper avoids duplicating the walker on each backend.
// ---------------------------------------------------------------------------

/** True when the expression tree contains at least one `current-user`
 *  ref (either bare `currentUser` or a member-access rooted in it). */
export function exprUsesCurrentUser(e: ExprIR | undefined): boolean {
  if (!e) return false;
  if (e.kind === "ref" && e.refKind === "current-user") return true;
  switch (e.kind) {
    case "method-call":
      if (exprUsesCurrentUser(e.receiver)) return true;
      return e.args.some(exprUsesCurrentUser);
    case "member":
      return exprUsesCurrentUser(e.receiver);
    case "binary":
      return exprUsesCurrentUser(e.left) || exprUsesCurrentUser(e.right);
    case "ternary":
      return (
        exprUsesCurrentUser(e.cond) ||
        exprUsesCurrentUser(e.then) ||
        exprUsesCurrentUser(e.otherwise)
      );
    case "unary":
      return exprUsesCurrentUser(e.operand);
    case "paren":
      return exprUsesCurrentUser(e.inner);
    case "call":
      return e.args.some(exprUsesCurrentUser);
    case "lambda":
      return exprUsesCurrentUser(e.body);
    case "new":
    case "object":
      return e.fields.some((f) => exprUsesCurrentUser(f.value));
  }
  return false;
}

/** True when the operation's body — preconditions, assignments,
 *  emits, calls — references `currentUser` anywhere. */
export function operationUsesCurrentUser(op: OperationIR): boolean {
  return op.statements.some(stmtUsesCurrentUser);
}

/** True when the find's `where` filter references `currentUser`.
 *  Slice 1C: such finds gain a `currentUser: User` parameter on the
 *  generated repository method, threaded through CQRS handler /
 *  Hono route call sites. */
export function findUsesCurrentUser(find: FindIR): boolean {
  return exprUsesCurrentUser(find.filter);
}

/** True when the view's where filter or any bind expression
 *  references `currentUser`. */
export function viewUsesCurrentUser(view: ViewIR): boolean {
  if (exprUsesCurrentUser(view.filter)) return true;
  for (const b of view.output?.binds ?? []) {
    if (exprUsesCurrentUser(b.expr)) return true;
  }
  return false;
}

function stmtUsesCurrentUser(s: StmtIR): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
      return exprUsesCurrentUser(s.expr);
    case "let":
      return exprUsesCurrentUser(s.expr);
    case "assign":
    case "add":
    case "remove":
      return exprUsesCurrentUser(s.value);
    case "emit":
      return s.fields.some((f) => exprUsesCurrentUser(f.value));
    case "call":
      return s.args.some(exprUsesCurrentUser);
    case "expression":
      return exprUsesCurrentUser(s.expr);
  }
}
