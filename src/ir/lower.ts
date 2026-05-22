import type { Reference } from "langium";
import {
  type BuiltinPackFamily,
  parseBuiltinDesignRef,
} from "../generator/_packs/builtin-formats.js";
import type {
  Aggregate,
  Api,
  BoundedContext,
  Component,
  Containment,
  Deployable,
  DerivedProp,
  EntityPart,
  EnumDecl,
  EventDecl,
  Expression,
  FunctionDecl,
  Invariant,
  MenuBlock,
  Model,
  Operation,
  Page,
  Property,
  Repository,
  Requirement,
  Scaffold,
  Solution,
  StateField,
  Statement,
  Storage,
  System,
  Targetable,
  TestBlock,
  TestCase,
  TestE2E,
  ThemeBlock,
  Ui,
  ValueObject,
  View,
  Workflow,
} from "../language/generated/ast.js";
import {
  isAggregate,
  isAssignOrCallStmt,
  isBoundedContext,
  isContainment,
  isDeployable,
  isDerivedProp,
  isEmitStmt,
  isEntityPart,
  isEnumDecl,
  isEventDecl,
  isExpectStmt,
  isExpectThrowsStmt,
  isFunctionDecl,
  isInvariant,
  isLetStmt,
  isMemberAccess,
  isModule,
  isNameRef,
  isObjectLit,
  isOperation,
  isPermissionsBlock,
  isPreconditionStmt,
  isProperty,
  isRepository,
  isRequirement,
  isRequiresStmt,
  isSolution,
  isSystem,
  isTestBlock,
  isTestCase,
  isTestE2E,
  isThemeBlock,
  isUserBlock,
  isValueObject,
  isView,
  isWorkflow,
} from "../language/generated/ast.js";
import { parseBuiltinPlatformRef } from "../platform/registry.js";
import type {
  AggregateIR,
  ApiIR,
  BoundedContextIR,
  CodeRefIR,
  CodeRefKind,
  ComponentIR,
  ContainmentIR,
  DeployableIR,
  DerivedIR,
  EntityPartIR,
  EnumIR,
  EventIR,
  ExprIR,
  FieldIR,
  FunctionIR,
  IdValueType,
  InvariantIR,
  LoomModel,
  MenuBlockIR,
  MenuLinkIR,
  MenuMetaIR,
  ModuleBindingIR,
  ModuleIR,
  ModuleStorageRole,
  OperationIR,
  PageIR,
  ParamIR,
  PermissionDeclIR,
  Platform,
  RepositoryIR,
  RequirementIR,
  RequirementStatus,
  RequirementType,
  ScaffoldIR,
  ScaffoldOriginIR,
  ScaffoldSelector,
  SolutionIR,
  StateFieldIR,
  StmtIR,
  StorageIR,
  StorageKind,
  SystemIR,
  TestCaseIR,
  TestE2EIR,
  TestIR,
  TestStmtIR,
  ThemeIR,
  TypeIR,
  UiApiParamIR,
  UiHelperImportIR,
  UiIR,
  UiParamBindingIR,
  UserIR,
  ValueObjectIR,
  ViewIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "./loom-ir.js";
import {
  cstText,
  type Env,
  inAggregate,
  inferExprType,
  inPart,
  inValueObject,
  lowerExpr,
  lowerStatement,
  lowerType,
  newEnv,
  withLocal,
} from "./lower-expr.js";
import {
  buildExpandContext,
  expandScaffoldToExplicitBody,
  type ScaffoldExpandContext,
} from "./scaffold-expander.js";

/** Fold a bareword built-in family or pinned `family@version`
 *  reference (or `undefined`) into the fully-qualified form the rest
 *  of the toolchain stores.  Lowering resolves the toolchain default
 *  for bareword built-ins so that
 *  every downstream consumer (generator dispatch, build matrix,
 *  snapshot tests) sees an unambiguous `family@version` string and
 *  doesn't need its own copy of the resolution logic.  Custom paths
 *  pass through verbatim; nothing to qualify there. */
function qualifyDesign(raw: string | undefined, fallback: BuiltinPackFamily): string {
  const value = raw ?? fallback;
  const parsed = parseBuiltinDesignRef(value);
  // Built-in family: return the parsed `family@version` (handles both
  // bareword input -> latest-version-resolved, and pinned input -> as-is).
  // Anything else (custom path, unknown family) flows through verbatim;
  // the loader's reference-dir resolution handles the rest.
  return parsed ? parsed.qualified : value;
}

/** Split a `platform:` value into the family (the closed `Platform`
 *  union every consumer branches on) and the fully-qualified ref
 *  (`family@version`, mirrors `qualifyDesign`).  Bareword backend →
 *  family + `family@latest`.  Backend pin (`hono@v4`) → family + the
 *  pin verbatim.  Frontend / unknown (`react`, `static`) → value for
 *  both (no version axis here).  Byte-identical for every existing
 *  source: `family` equals the bareword, so all `platform === "…"`
 *  logic is unchanged; `platformRef` is additive (dispatch still keys
 *  on `platform` for now). */
function qualifyPlatform(raw: string | undefined): {
  family: Platform;
  ref: string;
} {
  const value = raw ?? "hono";
  const parsed = parseBuiltinPlatformRef(value);
  return parsed
    ? { family: parsed.family as Platform, ref: parsed.qualified }
    : { family: value as Platform, ref: value };
}

// ---------------------------------------------------------------------------
// Lowering — structure layer.
//
// Walks the AST top-down (Model → System → Module → Context →
// Aggregate / Part / VO / Event / Repository → members) producing
// IR shapes.  Expression / statement / type-inference machinery
// lives in `lower-expr.ts`; this file only deals with the
// hierarchical IR built around those expressions.
// ---------------------------------------------------------------------------

export function lowerModel(model: Model): LoomModel {
  const systems: SystemIR[] = [];
  const looseContexts: BoundedContextIR[] = [];
  const requirements: RequirementIR[] = [];
  const solutions: SolutionIR[] = [];
  const testCases: TestCaseIR[] = [];
  for (const m of model.members) {
    if (isSystem(m)) systems.push(lowerSystem(m));
    // Top-level loose contexts (legacy single-deployable mode) have
    // no enclosing system, so no user block ever applies — the env's
    // `currentUser` resolution falls through to ordinary lookup.
    else if (isBoundedContext(m)) looseContexts.push(lowerContext(m));
    else if (isRequirement(m)) requirements.push(lowerRequirement(m));
    else if (isSolution(m)) solutions.push(lowerSolution(m));
    else if (isTestCase(m)) testCases.push(lowerTestCase(m));
  }
  return { systems, contexts: looseContexts, requirements, solutions, testCases };
}

// ---------------------------------------------------------------------------
// Traceability lowering
// ---------------------------------------------------------------------------

const REQUIREMENT_TYPES: ReadonlySet<string> = new Set<RequirementType>([
  "UserStory",
  "UseCase",
  "AcceptanceCriteria",
  "BusinessReq",
]);
const REQUIREMENT_STATUSES: ReadonlySet<string> = new Set<RequirementStatus>([
  "Draft",
  "Approved",
  "InProgress",
  "Done",
]);

/** Reads a scalar value out of a requirement prop-bag entry.  Bare
 *  identifiers (`UserStory`) lower to a NameRef whose `.name` we want;
 *  quoted titles to a StringLit; priorities to an IntLit.  Returns the
 *  raw string / number, or undefined for shapes we don't recognise
 *  (the validator reports those). */
function requirementPropValue(
  expr: Expression | undefined,
): string | number | undefined {
  if (!expr) return undefined;
  switch (expr.$type) {
    case "NameRef":
      return (expr as { name: string }).name;
    case "StringLit":
      return (expr as { value: string }).value;
    case "IntLit":
      return (expr as { value: number }).value;
    default:
      return undefined;
  }
}

function lowerRequirement(r: Requirement): RequirementIR {
  let type: RequirementType = "UserStory";
  let title = "";
  let status: RequirementStatus | undefined;
  let priority: number | undefined;
  for (const p of r.props) {
    const v = requirementPropValue(p.value);
    switch (p.name) {
      case "type":
        if (typeof v === "string" && REQUIREMENT_TYPES.has(v)) type = v as RequirementType;
        break;
      case "title":
        if (typeof v === "string") title = v;
        break;
      case "status":
        if (typeof v === "string" && REQUIREMENT_STATUSES.has(v)) status = v as RequirementStatus;
        break;
      case "priority":
        if (typeof v === "number") priority = v;
        break;
    }
  }
  return { id: r.name, type, title, status, priority, parentId: r.parent?.ref?.name };
}

function lowerSolution(s: Solution): SolutionIR {
  return {
    id: s.name,
    forRequirement: s.requirement?.ref?.name ?? "",
    title: s.title ?? "",
    entitles: lowerCodeRefs(s.entitles),
  };
}

function lowerTestCase(t: TestCase): TestCaseIR {
  return {
    id: t.name,
    verifies: t.requirement?.ref?.name ?? "",
    title: t.title ?? "",
    covers: lowerCodeRefs(t.covers),
  };
}

function lowerCodeRefs(
  refs: readonly Reference<Targetable>[],
): CodeRefIR[] {
  const out: CodeRefIR[] = [];
  for (const ref of refs) {
    const node = ref.ref;
    if (!node) continue; // unresolved — reported by the linker/validator
    out.push({ qualifiedName: ref.$refText, kind: codeRefKindOf(node) });
  }
  return out;
}

function codeRefKindOf(node: Targetable): CodeRefKind {
  switch (node.$type) {
    case "Module":
      return "module";
    case "BoundedContext":
      return "context";
    case "Aggregate":
      return "aggregate";
    case "Operation":
      return "operation";
    case "ValueObject":
      return "valueobject";
    case "EventDecl":
      return "event";
    case "Repository":
      return "repository";
    case "Workflow":
      return "workflow";
    case "View":
      return "view";
    case "Deployable":
      return "deployable";
    case "Api":
      return "api";
  }
}

function lowerSystem(sys: System): SystemIR {
  // Pre-pass over members: pull the user block out first so every
  // context lowering downstream sees the same shape.  At most one
  // block per system (validator enforces; we take the last one if
  // the parser somehow accepts more).  User fields use a separate
  // grammar rule (`UserField`) so the canonical JWT claim name `id`
  // (otherwise reserved for aggregate identity) is admissible.
  let user: UserIR | undefined;
  let theme: ThemeIR | undefined;
  for (const m of sys.members) {
    if (isUserBlock(m)) {
      user = {
        fields: m.fields.map(
          (f): FieldIR => ({
            name: f.name,
            type: lowerType(f.type),
            optional: !!f.type?.optional,
          }),
        ),
      };
    } else if (isThemeBlock(m)) {
      // Theme props are name/value pairs; we lower into a typed
      // partial.  Validation (known names, hex colours, radius
      // enum, no duplicates) lives in validate.ts so the IR
      // doesn't have to carry a "rejected props" channel.
      theme = lowerTheme(m);
    }
  }
  const modules: ModuleIR[] = [];
  const deployables: DeployableIR[] = [];
  const e2eBlocks: TestE2E[] = [];
  // Bare `context` declarations directly under a `system` block live in
  // an implicit anonymous module so we can index them like any other.
  const looseContexts: BoundedContextIR[] = [];
  for (const m of sys.members) {
    if (isModule(m)) {
      // Module-scoped permissions catalogue.  Multiple
      // `permissions { ... }` blocks merge their declarations;
      // the runtime string is computed once here so emitters and
      // resolvers don't have to spell the convention separately.
      const permissions: PermissionDeclIR[] = [];
      for (const blk of m.permissions ?? []) {
        if (!isPermissionsBlock(blk)) continue;
        for (const d of blk.decls) {
          permissions.push({
            name: d.name,
            runtimeString: `${m.name.toLowerCase()}.${d.name}`,
          });
        }
      }
      modules.push({
        name: m.name,
        contexts: m.contexts.map((c) => lowerContext(c, user, permissions)),
        permissions,
      });
    } else if (isBoundedContext(m)) {
      // Loose contexts under a system don't sit inside a module,
      // so `permissions.X` references inside them stay unresolved
      // (the validator will surface a friendly diagnostic).
      looseContexts.push(lowerContext(m, user));
    } else if (isDeployable(m)) {
      deployables.push(lowerDeployable(m));
    } else if (isTestE2E(m)) {
      e2eBlocks.push(m);
    }
  }
  if (looseContexts.length > 0) {
    modules.push({ name: "_default", contexts: looseContexts, permissions: [] });
  }
  // React deployable's `moduleNames` inheritance from `targets:` is
  // an enrichment, not a structural lowering — see
  // `src/ir/enrichments.ts`.
  // E2E test bodies reference the magic `api.<aggregate>.<method>(…)`
  // chain; resolution happens at render time against the target
  // deployable's IR.  The lowering env is minimal — bare-name lookups
  // would mostly be `unknown` anyway because e2e tests don't sit
  // inside a bounded context.  The `user` field carries the system's
  // user block down so that e2e bodies could reference `currentUser`
  // if auth handling is extended in the future; the auth validator
  // doesn't surface diagnostics from e2e because tests aren't user
  // input received by the system at runtime.
  const e2eEnv: Env = { locals: new Map(), user };
  // Test kind comes from the target deployable's platform: react →
  // UI test (Playwright spec via page objects), anything else →
  // api test (vitest+fetch).  This avoids reserving a `'ui'` keyword
  // that would shadow the body's `ui.X.Y(...)` identifiers.
  const e2eTests: TestE2EIR[] = [];
  for (const b of e2eBlocks) {
    const targetName = b.deployable?.ref?.name ?? "";
    const target = deployables.find((d) => d.name === targetName);
    const targetPlatform = target?.platform;
    // Test-kind dispatch.
    //   - `react` / `static` are frontend-only → only `ui` (Playwright).
    //   - `dotnet` / `hono` are backend-only → only `api` (vitest+fetch).
    //   - `phoenixLiveView` is fullstack — emit BOTH a UI spec (driven
    //     by Playwright page objects) AND an API spec (driven by
    //     fetch against the deployable's HTTP surface).
    const isFrontendOnly = targetPlatform === "react" || targetPlatform === "static";
    const isFullstack = targetPlatform === "phoenixLiveView";
    if (isFrontendOnly) {
      e2eTests.push(lowerE2E(b, e2eEnv, "ui"));
    } else if (isFullstack) {
      e2eTests.push(lowerE2E(b, e2eEnv, "ui"));
      e2eTests.push(lowerE2E(b, e2eEnv, "api"));
    } else {
      e2eTests.push(lowerE2E(b, e2eEnv, "api"));
    }
  }
  // Page metamodel.  `ui { ... }` blocks are SystemMembers;
  // lower each into a UiIR and attach to the system.  Order
  // preserves source order so the scaffold expander emits pages in a
  // stable sequence.  Lowering is shallow at this layer: pages,
  // components, scaffolds, and the optional menu block are each turned
  // into their literal IR shape (no scaffold expansion, no body type
  // inference yet — those come later in the pipeline).
  const uis = sys.members
    .filter((m): m is Ui => m.$type === "Ui")
    .map((u) => lowerUi(u));
  // Api declarations — system-level peers to module / ui / deployable.
  const apis = sys.members
    .filter((m): m is Api => m.$type === "Api")
    .map(
      (a): ApiIR => ({
        name: a.name,
        sourceModule: a.source?.$refText ?? "",
      }),
    );
  const storages = sys.members
    .filter((m): m is Storage => m.$type === "Storage")
    .map((s): StorageIR => ({
      name: s.name,
      type: s.type as StorageKind,
    }));
  const built: SystemIR = {
    name: sys.name,
    modules,
    deployables,
    e2eTests,
    user,
    theme,
    uis,
    apis,
    storages,
  };
  // Scaffold expander always runs.  Every page with a
  // recognised `scaffoldOrigin` gets `body` rewritten to a
  // walker-stdlib composition; the React emitter then routes
  // through the walker.  The legacy archetype path
  // (renderers/preparers/templates) has been deleted — this
  // branch is the only generator path now.  `scaffoldOrigin` is
  // intentionally preserved on each rewritten page so the
  // per-aggregate page-object emitter still produces the rich
  // `e2e/pages/<agg>.ts` helper classes (rich domain methods:
  // fill, submit, expectRow).
  expandScaffoldPages(built);
  return built;
}

/** In-place rewrite of every UI's pages.  When the
 *  expander handles a page's `scaffoldOrigin`, swap `body` with
 *  the synthesised walker-stdlib expression and clear the
 *  `scaffoldOrigin` discriminator so the React emitter dispatches
 *  through the walker path instead of the archetype path. */
function expandScaffoldPages(sys: SystemIR): void {
  for (const ui of sys.uis) {
    const ctx = buildExpandContext(sys, ui);
    for (const page of ui.pages) {
      if (!page.scaffoldOrigin) continue;
      const expanded = expandScaffoldToExplicitBody(page.scaffoldOrigin, ctx);
      if (!expanded) continue;
      // Compute the conventional emit path so the rewritten page
      // lands at `src/pages/<plural>/<arch>.tsx` (matches what the
      // scaffold renderer would have used).  Preserves URL/file
      // shape when scaffold expansion becomes the default.
      page.emitPath = conventionalEmitPath(page.scaffoldOrigin, ctx);
      page.body = expanded;
      // Detail-page expansion references `id` as a
      // route param (`Sales.Order.byId(id)`).  The scaffold AST
      // expander synthesises detail pages with `route:
      // "/<plural>/:id"` but no declarative `params` block, so
      // the walker has no way to resolve `id` as a typed route
      // param.  Synthesise it here so the walker emits
      // `useParams<{id: string}>()` correctly.
      if (
        page.scaffoldOrigin.kind === "aggregate-detail" &&
        !page.params.some((p) => p.name === "id")
      ) {
        page.params.push({
          name: "id",
          type: { kind: "primitive", name: "string" },
        });
      }
      // INTENTIONALLY leave `page.scaffoldOrigin` set — the page-
      // object emitter dispatches on it to keep producing the
      // per-aggregate `e2e/pages/<agg>.ts` classes (with their
      // rich domain methods: fill, submit, expectRow…) while the
      // page-emitter detects `expandedFromScaffold` and routes
      // through the walker instead of the archetype renderer.
      // Without this, the default flip would lose ~80 lines of e2e
      // helper code per aggregate.
      page.expandedFromScaffold = true;
    }
  }
}

function conventionalEmitPath(
  origin: ScaffoldOriginIR,
  ctx: ScaffoldExpandContext,
): string | undefined {
  if (
    origin.kind === "aggregate-list" ||
    origin.kind === "aggregate-new" ||
    origin.kind === "aggregate-detail"
  ) {
    const agg = ctx.aggregatesByName.get(origin.aggregateName);
    if (!agg) return undefined;
    const slug = pluralSnake(agg.name);
    const file =
      origin.kind === "aggregate-list"
        ? "list"
        : origin.kind === "aggregate-new"
          ? "new"
          : "detail";
    return `src/pages/${slug}/${file}.tsx`;
  }
  if (origin.kind === "workflow-form") {
    const wf = ctx.workflowsByName.get(origin.workflowName);
    if (!wf) return undefined;
    return `src/pages/workflows/${snakeOnly(wf.name)}.tsx`;
  }
  if (origin.kind === "view-list") {
    return `src/pages/views/${snakeOnly(origin.viewName)}.tsx`;
  }
  if (origin.kind === "home") return "src/pages/home.tsx";
  if (origin.kind === "workflows-index") return "src/pages/workflows/index.tsx";
  if (origin.kind === "views-index") return "src/pages/views/index.tsx";
  return undefined;
}

function snakeOnly(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function pluralSnake(s: string): string {
  // tiny inline copy of util/naming → avoids the
  // `import { plural, snake }` pulling more types than we need.
  const snake = s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  if (snake.endsWith("y") && !/[aeiou]y$/.test(snake)) {
    return snake.slice(0, -1) + "ies";
  }
  if (/(s|x|z|ch|sh)$/.test(snake)) return snake + "es";
  return snake + "s";
}

function lowerTheme(
  block: ThemeBlock,
): ThemeIR {
  const out: ThemeIR = {};
  for (const p of block.props) {
    const value = p.value;
    switch (p.name) {
      case "primary":
        out.primary = value;
        break;
      case "neutral":
        out.neutral = value;
        break;
      case "radius":
        if (
          value === "none" ||
          value === "sm" ||
          value === "md" ||
          value === "lg" ||
          value === "xl"
        ) {
          out.radius = value;
        }
        break;
      case "fontFamily":
        out.fontFamily = value;
        break;
      // Unknown property names land in the validator's reject path;
      // we silently drop them here so the IR shape stays clean.
    }
  }
  return out;
}

function lowerE2E(
  block: TestE2E,
  env: Env,
  kind: "api" | "ui",
): TestE2EIR {
  const inner = block.body;
  let curEnv = env;
  const statements: TestStmtIR[] = [];
  for (const s of inner) {
    if (isExpectStmt(s)) {
      statements.push({
        kind: "expect",
        expr: lowerExpr(s.expr, curEnv),
        source: cstText(s.expr),
      });
    } else if (isExpectThrowsStmt(s)) {
      statements.push({
        kind: "expect-throws",
        expr: lowerExpr(s.expr, curEnv),
        source: cstText(s.expr),
      });
    } else {
      // `expect` / `expectThrows` are filtered above; the remaining
      // shapes are exactly `Statement`.
      const r = lowerStatement(s as Statement, curEnv);
      statements.push(r.stmt);
      curEnv = r.envAfter;
    }
  }
  return {
    name: block.name,
    kind,
    deployableName: block.deployable?.ref?.name ?? "",
    statements,
    verifiesTestCase: block.verifies?.ref?.name,
  };
}

function lowerDeployable(d: Deployable): DeployableIR {
  const { family: platform, ref: platformRef } = qualifyPlatform(d.platform);
  // `auth: required` is currently the only AuthMode.  Future modes
  // (`optional` / `forbidden`) would extend this branch.
  const auth = d.auth === "required" ? { required: true } : undefined;
  // `design` defaults only on platforms that actually render UI in
  // this deployable — keeping the IR honest about which deployables
  // mount a frontend.  `react`/`static` always render React (TSX
  // packs).  `phoenixLiveView` is fullstack and always renders HEEx
  // against the `ashPhoenix` pack.  `dotnet` is dual-mode: it renders
  // an embedded React SPA when (and only when) the deployable declares
  // `ui:`; backend-only dotnet drops the field.  Other platforms
  // (`hono`) silently drop `design:` and the validator already warns.
  const uiName =
    d.uiSugar?.ref?.ref?.name ??
    d.uiCompose?.ref?.ref?.name ??
    d.uiBlock?.ref?.ref?.name ??
    undefined;
  const design =
    platform === "react" || platform === "static"
      ? qualifyDesign(d.design, "mantine")
      : platform === "phoenixLiveView"
        ? qualifyDesign(d.design, "ashPhoenix")
        : platform === "dotnet" && uiName
          ? qualifyDesign(d.design, "mantine")
          : undefined;
  // Page-metamodel UI binding.  The grammar accepts two
  // surface forms — `ui: WebApp` (sugar) and `ui WebApp { framework: react }`
  // (full block).  Both lower to the same `uiName` + optional
  // `uiFramework` here.  `uiName` is computed above so the `design`
  // default can branch on it for dual-mode platforms (fullstack
  // dotnet).  Validator enforces that the referenced ui
  // exists, the platform supports a UI mount, and the framework value
  // is one of the v0-allowed alternatives.
  // Explicit `framework: …` in the full block wins; otherwise default
  // from the platform.  Fullstack dotnet renders React; phoenixLiveView
  // renders LiveView; react/static render React.  Backends without a
  // `ui:` binding leave this undefined.
  const uiFramework =
    d.uiBlock?.framework ??
    (uiName
      ? platform === "phoenixLiveView"
        ? "phoenixLiveView"
        : platform === "react" || platform === "static" || platform === "dotnet"
          ? "react"
          : undefined
      : undefined);
  // Explicit api composition.
  const serves = (d.serves ?? []).map((r) => r.ref?.name ?? "").filter(Boolean);
  const uiBindings = (d.uiCompose?.bindings ?? []).map(
    (b): UiParamBindingIR => ({
      paramName: b.name,
      sourceDeployableName: b.source?.ref?.name ?? "",
    }),
  );
  // Per-module storage bindings.
  const moduleBindings = (d.moduleBindings ?? []).map(
    (b): ModuleBindingIR => ({
      moduleName: b.name?.ref?.name ?? "",
      storages: (b.storages ?? []).map((sb) => ({
        role: sb.role as ModuleStorageRole,
        storageName: sb.storage?.ref?.name ?? "",
      })),
    }),
  );
  return {
    name: d.name,
    platform,
    platformRef,
    moduleNames: moduleBindings.map((b) => b.moduleName).filter(Boolean),
    port: d.port ?? defaultPort(platform),
    targetName: d.targets?.ref?.name,
    auth,
    design,
    uiName,
    uiFramework,
    serves,
    uiBindings,
    moduleBindings,
  };
}

function defaultPort(platform: Platform | undefined): number {
  if (platform === "dotnet") return 8080;
  if (platform === "react") return 3001;
  if (platform === "static") return 3001;
  if (platform === "phoenixLiveView") return 4000;
  return 3000;
}

// ---------------------------------------------------------------------------
// Page metamodel lowering.
//
// Each `ui { ... }` SystemMember lowers to a `UiIR` carrying its
// pages, components, scaffold directives, and an optional menu block
// in source order.  This layer is intentionally shallow:
//   - Page bodies / component bodies / state init expressions lower
//     through the existing expression engine (`lowerExpr`); type
//     resolution falls out from the same `Env`.
//   - Scaffold directives stay as literal `ScaffoldIR` carrying their
//     selector + targets.  The expander walks the system's
//     domain IR to synthesise concrete pages from each directive.
//   - Validator obligations catch the rest: ui-name
//     uniqueness, deployable-references-existing-ui, scaffold target
//     resolution, etc.
// ---------------------------------------------------------------------------

function lowerUi(ui: Ui): UiIR {
  const pages: PageIR[] = [];
  const components: ComponentIR[] = [];
  const scaffolds: ScaffoldIR[] = [];
  const apiParams: UiApiParamIR[] = [];
  const helperImports: UiHelperImportIR[] = [];
  let menu: MenuBlockIR | undefined;
  for (const m of ui.members) {
    if (m.$type === "Page") pages.push(lowerPage(m));
    else if (m.$type === "Component") components.push(lowerComponent(m));
    else if (m.$type === "Scaffold") scaffolds.push(lowerScaffold(m));
    else if (m.$type === "UiApiParam") {
      apiParams.push({
        name: m.name,
        apiName: m.apiRef?.$refText ?? "",
      });
    } else if (m.$type === "UiHelperImport") {
      helperImports.push({ name: m.name, path: m.path });
    } else if (m.$type === "MenuBlock") {
      // First menu block wins.  Validator flags a duplicate
      // `menu { ... }` block at ui scope as an error.
      if (!menu) menu = lowerMenuBlock(m);
    }
  }
  return {
    name: ui.name,
    pages,
    components,
    scaffolds,
    menu,
    apiParams,
    helperImports,
  };
}

function lowerPage(p: Page): PageIR {
  const params = (p.params ?? []).map((param) => ({
    name: param.name,
    type: lowerType(param.type),
  }));
  // Walk the unordered prop list to extract route / title / requires /
  // body / state / per-page menu meta.  Multiple state blocks merge
  // (matches `permissions` block multiplicity).
  let route: string | undefined;
  let title: ExprIR | undefined;
  let requires: ExprIR | undefined;
  let body: ExprIR | undefined;
  let menuMeta: MenuMetaIR | undefined;
  const state: StateFieldIR[] = [];
  // A neutral env is fine here — the page-IR expression nodes
  // will get richer when the validator and emitter
  // wire in the page-scoped scope.
  const env: Env = { locals: new Map(), user: undefined };
  for (const prop of p.props) {
    if (prop.$type === "RouteProp") route = prop.value;
    else if (prop.$type === "TitleProp") title = lowerExpr(prop.value, env);
    else if (prop.$type === "RequiresProp") requires = lowerExpr(prop.expr, env);
    else if (prop.$type === "BodyProp") body = lowerExpr(prop.expr, env);
    else if (prop.$type === "StateBlock") {
      for (const f of prop.fields) state.push(lowerStateField(f, env));
    } else if (prop.$type === "PageMenuMeta") {
      // Last block wins — validator flags repeated menu
      // metadata blocks on a single page.
      menuMeta = {
        entries: prop.entries.map((e) => ({
          name: e.name,
          value: lowerExpr(e.value, env),
        })),
      };
    }
  }
  // Pass-1 AST-to-AST scaffold expansion populates
  // synthesised pages with body expressions like
  // `List(of: Order)` / `Form(creates: T)` / etc.  We infer the
  // page's `scaffoldOrigin` discriminator and `source` from the
  // body shape so the React emitter dispatches identically
  // whether the page came from source or from the AST expander.
  const inferred = inferScaffoldOrigin(p, body);
  return {
    name: p.name,
    params,
    route,
    title,
    requires,
    state,
    body,
    menuMeta,
    source: inferred ? "scaffold" : "explicit",
    scaffoldOrigin: inferred,
  };
}

/** Inspect a synthesised page's body to recover the
 *  `scaffoldOrigin` discriminator the legacy IR-level expander
 *  used to set.  When the body matches the synthesiser's
 *  characteristic shape (`List(of: <Agg>)`, `Form(creates: <Agg>)`,
 *  `Detail(of: <Agg>, by: id)`, `Form(runs: <wf>)`, `List(of: view
 *  <View>)`, the standalone Home / WorkflowsIndex / ViewsIndex
 *  sentinels), returns the matching origin.  Otherwise returns
 *  `undefined` — the page is treated as user-explicit. */
function inferScaffoldOrigin(
  page: Page,
  body: ExprIR | undefined,
): ScaffoldOriginIR | undefined {
  if (!body || body.kind !== "call") return undefined;
  const callName = body.name;
  const argNames = body.argNames ?? [];
  const argRef = (i: number): string | undefined => {
    const arg = body.args[i];
    if (!arg) return undefined;
    if (arg.kind === "ref") return arg.name;
    if (arg.kind === "literal" && arg.lit === "string") return arg.value;
    return undefined;
  };
  // Sentinel page names — Home / WorkflowsIndex / ViewsIndex
  // synthesised by the AST expander.  Match on the body call's
  // function name (which the synthesiser sets to the same string
  // by convention).
  if (callName === "Home") return { kind: "home" };
  if (callName === "WorkflowsIndex") return { kind: "workflows-index" };
  if (callName === "ViewsIndex") return { kind: "views-index" };
  // Aggregate-list / new / detail are distinguished by the body's
  // call name (`List` / `Form` with `creates:` / `Detail`).  The
  // first named arg's value names the aggregate; the page name
  // suffix (`List` / `New` / `Detail`) lets us double-check kind.
  if (callName === "List" && argNames[0] === "of") {
    const aggName = argRef(0);
    if (!aggName) return undefined;
    if (aggName.startsWith("view ")) {
      // `List(of: view <ViewName>)` — view-list page.
      return { kind: "view-list", viewName: aggName.slice(5), contextName: "" };
    }
    return {
      kind: "aggregate-list",
      aggregateName: aggName,
      contextName: "",
    };
  }
  if (callName === "Form" && argNames[0] === "creates") {
    const aggName = argRef(0);
    if (!aggName) return undefined;
    return {
      kind: "aggregate-new",
      aggregateName: aggName,
      contextName: "",
    };
  }
  if (callName === "Detail" && argNames[0] === "of") {
    const aggName = argRef(0);
    if (!aggName) return undefined;
    return {
      kind: "aggregate-detail",
      aggregateName: aggName,
      contextName: "",
    };
  }
  if (callName === "Form" && argNames[0] === "runs") {
    const wfName = argRef(0);
    if (!wfName) return undefined;
    return {
      kind: "workflow-form",
      workflowName: wfName,
      contextName: "",
    };
  }
  // Doesn't match any synthesiser shape — page is user-explicit.
  void page;
  return undefined;
}

function lowerComponent(c: Component): ComponentIR {
  const params = c.params.map((param) => ({
    name: param.name,
    type: lowerType(param.type),
  }));
  const env: Env = { locals: new Map(), user: undefined };
  const state: StateFieldIR[] = [];
  for (const decl of c.decls ?? []) {
    if (decl.$type === "StateBlock") {
      for (const f of decl.fields) state.push(lowerStateField(f, env));
    }
  }
  const body = lowerExpr(c.body, env);
  return { name: c.name, params, state, body };
}

function lowerStateField(
  f: StateField,
  env: Env,
): StateFieldIR {
  return {
    name: f.name,
    type: lowerType(f.type),
    init: f.init ? lowerExpr(f.init, env) : undefined,
  };
}

function lowerScaffold(s: Scaffold): ScaffoldIR {
  return {
    selector: s.selector as ScaffoldSelector,
    targets: s.targets.map((t) => t).filter(Boolean),
  };
}

function lowerMenuBlock(m: MenuBlock): MenuBlockIR {
  const env: Env = { locals: new Map(), user: undefined };
  return {
    sections: m.sections.map((sec) => ({
      label: sec.label,
      links: sec.links.map((l): MenuLinkIR => {
        // Page links use a real Langium cross-reference.
        // Scaffold-synthesised pages are first-class AST nodes by
        // link time, so `[Page:LooseName]` resolves through the
        // standard linker.  We carry the resolved page's name into
        // the IR for the menu emitter (which iterates `ui.pages` by
        // name).  Unresolved refs surface as Langium linker errors,
        // not silent shim misses.
        const pageRef = l.page?.ref;
        if (pageRef) {
          return {
            kind: "page",
            pageName: pageRef.name,
            props: (l.props ?? []).map((p) => ({
              name: p.name,
              value: lowerExpr(p.value, env),
            })),
          };
        }
        if (l.page?.$refText) {
          // Reference exists but didn't resolve — preserve the text
          // for diagnostics.  The validator / Langium linker has
          // already reported the unresolved reference.
          return {
            kind: "page",
            pageName: l.page.$refText,
            props: (l.props ?? []).map((p) => ({
              name: p.name,
              value: lowerExpr(p.value, env),
            })),
          };
        }
        // External link: `link "Docs" -> "https://..."`.
        return {
          kind: "external",
          label: l.externalLabel ?? "",
          url: l.externalUrl ?? "",
        };
      }),
    })),
  };
}

function lowerContext(
  ctx: BoundedContext,
  user?: UserIR,
  modulePermissions?: PermissionDeclIR[],
): BoundedContextIR {
  // Lowering produces a faithful AST projection only.  Auto-included
  // `findAll`, react `moduleNames` inheritance, and wire-shape
  // derivation all live in `enrichLoomModel` (src/ir/enrichments.ts)
  // which runs after lowering.  `user` (when set) threads the
  // system's user-claim shape into every expression context so the
  // `currentUser` magic identifier resolves to a typed shape.
  // `modulePermissions` (when set) does the same for the
  // `permissions.<name>` magic-identifier resolution; loose contexts
  // not bundled in a module pass undefined.
  const env = newEnv(ctx, user, modulePermissions);
  const enums: EnumIR[] = [];
  const valueObjects: ValueObjectIR[] = [];
  const events: EventIR[] = [];
  const aggregates: AggregateIR[] = [];
  const repositories: RepositoryIR[] = [];
  const workflows: WorkflowIR[] = [];
  const views: ViewIR[] = [];
  for (const m of ctx.members) {
    if (isEnumDecl(m)) enums.push(lowerEnum(m));
    else if (isValueObject(m)) valueObjects.push(lowerValueObject(m, env));
    else if (isEventDecl(m)) events.push(lowerEvent(m));
    else if (isAggregate(m)) aggregates.push(lowerAggregate(m, env));
    else if (isRepository(m)) repositories.push(lowerRepository(m, user, modulePermissions));
    else if (isWorkflow(m)) workflows.push(lowerWorkflow(m, env, ctx));
    else if (isView(m)) views.push(lowerView(m, env));
  }
  return {
    name: ctx.name,
    enums,
    valueObjects,
    events,
    aggregates,
    repositories,
    workflows,
    views,
  };
}

function lowerEnum(e: EnumDecl): EnumIR {
  return { name: e.name, values: e.values.map((v) => v.name) };
}

function lowerValueObject(vo: ValueObject, env: Env): ValueObjectIR {
  const inner = inValueObject(env, vo);
  const props = vo.members.filter(isProperty) as Property[];
  return {
    name: vo.name,
    fields: props.map((p) => lowerField(p)),
    derived: vo.members.filter(isDerivedProp).map((d) => lowerDerived(d, inner)),
    invariants: [
      ...vo.members.filter(isInvariant).map((i) => lowerInvariant(i, inner)),
      ...lowerPropertyChecks(props, inner),
    ],
    functions: vo.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner)),
  };
}

function lowerEvent(e: EventDecl): EventIR {
  return {
    name: e.name,
    fields: e.fields.map((f) => lowerField(f)),
  };
}

function lowerAggregate(agg: Aggregate, env: Env): AggregateIR {
  const idValueType = (agg.idKind ?? "guid") as IdValueType;
  const inner = inAggregate(env, agg);
  const props = agg.members.filter(isProperty) as Property[];
  const containments = agg.members.filter(isContainment).map(lowerContainment);
  const parts: EntityPartIR[] = [];
  for (const m of agg.members) {
    if (isEntityPart(m)) parts.push(lowerEntityPart(m, agg, inner));
  }
  const derived = agg.members.filter(isDerivedProp).map((d) => lowerDerived(d, inner));
  const invariants = [
    ...agg.members.filter(isInvariant).map((i) => lowerInvariant(i, inner)),
    ...lowerPropertyChecks(props, inner),
  ];
  const functions = agg.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner));
  const operations = (agg.members.filter(isOperation) as Operation[]).map((op) =>
    lowerOperation(op, inner),
  );
  const tests: TestIR[] = [];
  for (const m of agg.members) {
    if (isTestBlock(m)) tests.push(lowerTest(m, inner));
  }
  return {
    name: agg.name,
    idValueType,
    fields: props.map(lowerField),
    contains: containments,
    derived,
    invariants,
    functions,
    operations,
    parts,
    tests,
  };
}

function lowerTest(block: TestBlock, env: Env): TestIR {
  let inner = env;
  const statements: TestStmtIR[] = [];
  for (const s of block.body) {
    if (isExpectStmt(s)) {
      statements.push({
        kind: "expect",
        expr: lowerExpr(s.expr, inner),
        source: cstText(s.expr),
      });
    } else if (isExpectThrowsStmt(s)) {
      statements.push({
        kind: "expect-throws",
        expr: lowerExpr(s.expr, inner),
        source: cstText(s.expr),
      });
    } else {
      const r = lowerStatement(s as Statement, inner);
      statements.push(r.stmt);
      inner = r.envAfter;
    }
  }
  return { name: block.name, statements, verifiesTestCase: block.verifies?.ref?.name };
}

function lowerEntityPart(part: EntityPart, agg: Aggregate, outer: Env): EntityPartIR {
  const inner = inPart(outer, agg, part);
  const props = part.members.filter(isProperty) as Property[];
  return {
    name: part.name,
    parentName: agg.name,
    parentIdValueType: (agg.idKind ?? "guid") as IdValueType,
    fields: props.map(lowerField),
    contains: part.members.filter(isContainment).map(lowerContainment),
    derived: part.members.filter(isDerivedProp).map((d) => lowerDerived(d, inner)),
    invariants: [
      ...part.members.filter(isInvariant).map((i) => lowerInvariant(i, inner)),
      ...lowerPropertyChecks(props, inner),
    ],
    functions: part.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner)),
  };
}

function lowerRepository(
  repo: Repository,
  user?: UserIR,
  modulePermissions?: PermissionDeclIR[],
): RepositoryIR {
  return {
    name: repo.name,
    aggregateName: repo.aggregate?.ref?.name ?? "Unknown",
    finds: repo.finds.map((f) => {
      const aggRoot = repo.aggregate?.ref;
      // Build env: each find param + the aggregate's properties as
      // `this`-rooted refs so the filter can reference them by name.
      // `user` is threaded so `currentUser` resolves to a typed ref —
      // the validator (`validateAuth`) then rejects any current-user
      // reference inside a where filter, since row-level filtering by
      // user is not supported there.
      let env = newEnv(repo.$container as BoundedContext, user, modulePermissions);
      if (aggRoot) env = inAggregate(env, aggRoot);
      for (const p of f.params) {
        env = withLocal(env, p.name, "param", lowerType(p.type));
      }
      return {
        name: f.name,
        params: f.params.map((p) => ({ name: p.name, type: lowerType(p.type) })),
        returnType: lowerType(f.returnType),
        filter: f.filter ? lowerExpr(f.filter, env) : undefined,
      };
    }),
  };
}

function lowerView(view: View, env: Env): ViewIR {
  // Filter + bind expressions resolve against the source
  // aggregate's schema — same env shape repository find filters
  // use.  Bare names (`status`, `lines.count`, `total`) lower to
  // this-rooted property / containment / derived refs.
  const source = view.source?.ref;
  let inner = env;
  if (source) inner = inAggregate(env, source);
  const filter = view.filter ? lowerExpr(view.filter, inner) : undefined;
  // Full-form views declare an output record.  Each `fields+=Property`
  // gives us a typed field; each `binds+=BindEntry` gives us the
  // expression that produces its value at projection time.  The
  // shorthand form leaves `fields` empty and we surface
  // `output: undefined` so emitters fall back to the aggregate's
  // wire shape.
  const hasOutput = view.fields.length > 0;
  let output: ViewIR["output"] | undefined;
  if (hasOutput) {
    const binds = view.binds.map((b) => ({
      name: b.name,
      expr: lowerExpr(b.expr, inner),
      type: inferExprType(b.expr, inner),
    }));
    // Walk every bind expression for `Id<X>` follow patterns;
    // each unique path becomes one bulk-load + map at emission
    // time.  Order by path length (shortest first) so each
    // hop's prerequisites are guaranteed to load before it.
    const auxByKey = new Map<string, { path: string[]; aggName: string }>();
    for (const b of binds) {
      collectIdFollows(b.expr, auxByKey);
    }
    const ordered = [...auxByKey.values()].sort((a, b) => a.path.length - b.path.length);
    const auxiliaries = ordered.map((a) => ({
      ...a,
      mapVar: mapVarForPath(a.path, a.aggName),
    }));
    output = {
      fields: view.fields.map((p) => lowerField(p)),
      binds,
      auxiliaries,
    };
  }
  return {
    name: view.name,
    aggregateName: source?.name ?? "Unknown",
    filter,
    output,
  };
}

/** Walk a bind expression's IR tree and capture every `Id<X>`
 *  follow as an auxiliary path entry.  Single-hop
 *  (`customerId.name`) yields path `["customerId"]` with target
 *  Customer; two-hop (`customerId.regionId.name`) yields paths
 *  `["customerId"]` (Customer) AND `["customerId", "regionId"]`
 *  (Region) — the longer path's prerequisites get loaded first
 *  thanks to dependency ordering at emission time. */
function collectIdFollows(
  expr: ExprIR,
  out: Map<string, { path: string[]; aggName: string }>,
): void {
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPath(expr.receiver);
    if (path) {
      const key = path.join(".");
      if (!out.has(key)) {
        out.set(key, { path, aggName: expr.receiverType.targetName });
      }
    }
    collectIdFollows(expr.receiver, out);
    return;
  }
  if (expr.kind === "member") {
    collectIdFollows(expr.receiver, out);
    return;
  }
  switch (expr.kind) {
    case "method-call":
      collectIdFollows(expr.receiver, out);
      for (const a of expr.args) collectIdFollows(a, out);
      return;
    case "call":
      for (const a of expr.args) collectIdFollows(a, out);
      return;
    case "lambda":
      // Lambda body is now optional — single-expression form
      // sets `body`, block-body form sets `block`.  Block bodies don't
      // contribute Id-follow paths in v0 (they only appear in event
      // handlers, not in `bind`/`derived`/filter expressions where this
      // walker runs); recurse into `body` only when present.
      if (expr.body) collectIdFollows(expr.body, out);
      return;
    case "match":
      // Recurse through every arm condition + value plus the
      // `else` branch.  Match expressions can appear inside view
      // `bind` exprs and `derived` bodies; their Id-follow members
      // must still surface for the bulk-load auxiliary planner.
      for (const arm of expr.arms) {
        collectIdFollows(arm.cond, out);
        collectIdFollows(arm.value, out);
      }
      if (expr.otherwise) collectIdFollows(expr.otherwise, out);
      return;
    case "binary":
      collectIdFollows(expr.left, out);
      collectIdFollows(expr.right, out);
      return;
    case "unary":
      collectIdFollows(expr.operand, out);
      return;
    case "ternary":
      collectIdFollows(expr.cond, out);
      collectIdFollows(expr.then, out);
      collectIdFollows(expr.otherwise, out);
      return;
    case "paren":
      collectIdFollows(expr.inner, out);
      return;
    case "new":
    case "object":
      for (const f of expr.fields) collectIdFollows(f.value, out);
      return;
  }
}

/** Map-variable name for an auxiliary at a given path.  Single-hop
 *  paths get a clean `<agg>ById`; multi-hop paths suffix the
 *  intermediate Pascal'd field names so two paths that happen to
 *  reach the same target aggregate via different intermediates
 *  get distinct map vars. */
function mapVarForPath(path: string[], aggName: string): string {
  const baseName = aggName.charAt(0).toLowerCase() + aggName.slice(1);
  if (path.length === 1) return `${baseName}ById`;
  // Multi-hop: e.g. ["customerId", "regionId"] → "regionByCustomerId"
  const prefix = path
    .slice(0, -1)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return `${baseName}By${prefix}`;
}

/** Extract the chain of source-field names from an Id-typed
 *  expression that's rooted in a `ref` and built up through
 *  `member` accesses on Id-typed receivers.  Returns undefined for
 *  any expression that doesn't fit this shape (calls, lambdas,
 *  member access through non-Id receivers, etc.). */
function idFollowPath(e: ExprIR): string[] | undefined {
  if (e.kind === "ref" && e.type?.kind === "id") {
    return [e.name];
  }
  if (e.kind === "member" && e.receiverType.kind === "id") {
    const inner = idFollowPath(e.receiver);
    if (!inner) return undefined;
    return [...inner, e.member];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Member lowerings
// ---------------------------------------------------------------------------

function lowerField(p: Property): FieldIR {
  return {
    name: p.name,
    type: lowerType(p.type),
    optional: !!p.type?.optional,
    display: !!p.display,
    provenanced: !!p.provenanced,
  };
}

function lowerContainment(c: Containment): ContainmentIR {
  return {
    name: c.name,
    partName: c.partType?.ref?.name ?? "Unknown",
    collection: !!c.collection,
  };
}

function lowerDerived(d: DerivedProp, env: Env): DerivedIR {
  return {
    name: d.name,
    type: lowerType(d.type),
    expr: lowerExpr(d.expr, env),
  };
}

function lowerInvariant(
  i: Invariant,
  env: Env,
): InvariantIR {
  return {
    expr: lowerExpr(i.expr, env),
    guard: i.guard ? lowerExpr(i.guard, env) : undefined,
    source: cstText(i.expr),
    // `private invariant ...` opts out of the wire
    // layers (frontend Zod, Hono routes, FluentValidation).  The
    // domain-layer `AssertInvariants()` floor still enforces it.
    scope: i.serverOnly ? "server-only" : undefined,
  };
}

/** Synthesise an InvariantIR from an inline `field: T check <expr>`
 *  clause on a Property.  Inline-check sugar — the synthesised
 *  invariant appears in the parent's `invariants` list so the existing
 *  wire-validator + domain-floor pipelines pick it up uniformly. */
function lowerPropertyChecks(
  props: Property[],
  env: Env,
): InvariantIR[] {
  const out: InvariantIR[] = [];
  for (const p of props) {
    if (!p.check) continue;
    out.push({
      expr: lowerExpr(p.check, env),
      // Normalise whitespace so multi-line `check` clauses don't
      // carry indentation into error messages.
      source: `${p.name} check ${cstText(p.check).replace(/\s+/g, " ").trim()}`,
    });
  }
  return out;
}

function lowerFunction(f: FunctionDecl, env: Env): FunctionIR {
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of f.params) {
    const t = lowerType(p.type);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  return {
    name: f.name,
    params,
    returnType: lowerType(f.returnType),
    body: lowerExpr(f.body, inner),
  };
}

function lowerOperation(op: Operation, env: Env): OperationIR {
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of op.params) {
    const t = lowerType(p.type);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  const stmts: StmtIR[] = [];
  for (const s of op.body) {
    const result = lowerStatement(s, inner);
    stmts.push(result.stmt);
    inner = result.envAfter;
  }
  return {
    name: op.name,
    visibility: op.private ? "private" : "public",
    params,
    statements: stmts,
    extern: !!op.extern,
  };
}

// ---------------------------------------------------------------------------
// Workflow lowering
//
// Body statements are parsed using the operation-body Statement rules
// (precondition, let, emit, AssignOrCallStmt) but the workflow surface
// is a strict subset:
//   - LetStmt RHS may be `Agg.create({...})` (factory-let),
//     `Repo.method(args)` (repo-let), or any other Expression
//     (expr-let).
//   - AssignOrCallStmt is allowed only in its bare-call form
//     `name.op(args)` — mutation forms (`:=`, `+=`, `-=`) belong to
//     aggregate operations and surface as validator errors.
//   - precondition / emit lower identically to operation bodies.
//
// `savesAtExit` is computed after the walk: every factory-let always
// saves; a repo-let saves only when a later `op-call` targets it.
// ---------------------------------------------------------------------------

function lowerWorkflow(wf: Workflow, env: Env, ctx: BoundedContext): WorkflowIR {
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of wf.params) {
    const t = lowerType(p.type);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  const aggsByName = new Map<string, Aggregate>();
  const reposByName = new Map<string, Repository>();
  const repoForAgg = new Map<string, string>(); // aggName -> repoName
  for (const m of ctx.members) {
    if (isAggregate(m)) aggsByName.set(m.name, m);
    else if (isRepository(m)) {
      reposByName.set(m.name, m);
      const target = m.aggregate?.ref;
      if (target?.name) repoForAgg.set(target.name, m.name);
    }
  }
  const letAggs = new Map<string, { aggName: string; repoName: string }>();
  const statements: WorkflowStmtIR[] = [];
  for (const s of wf.body) {
    const lowered = lowerWorkflowStatement(s, inner, aggsByName, reposByName, repoForAgg);
    statements.push(lowered.stmt);
    inner = lowered.envAfter;
    if (lowered.binding) letAggs.set(lowered.binding.name, lowered.binding);
  }
  // savesAtExit: factory-lets always; repo-lets only when targeted
  // by a later op-call (validator already restricts which statement
  // shapes can mutate).
  const opCallTargets = new Set<string>();
  for (const st of statements) {
    if (st.kind === "op-call") opCallTargets.add(st.target);
  }
  const savesAtExit: WorkflowIR["savesAtExit"] = [];
  for (const st of statements) {
    if (st.kind === "factory-let") {
      const repoName = repoForAgg.get(st.aggName) ?? plural(st.aggName);
      savesAtExit.push({ name: st.name, aggName: st.aggName, repoName });
    } else if (st.kind === "repo-let" && opCallTargets.has(st.name)) {
      savesAtExit.push({
        name: st.name,
        aggName: st.aggName,
        repoName: st.repoName,
      });
    }
  }
  return {
    name: wf.name,
    params,
    transactional: !!wf.transactional,
    isolation: wf.isolation as
      | "readUncommitted"
      | "readCommitted"
      | "repeatableRead"
      | "serializable"
      | undefined,
    statements,
    savesAtExit,
  };
}

function plural(s: string): string {
  if (s.endsWith("y") && !/[aeiou]y$/.test(s)) return s.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(s)) return s + "es";
  return s + "s";
}

interface LoweredWorkflowStmt {
  stmt: WorkflowStmtIR;
  envAfter: Env;
  binding?: { name: string; aggName: string; repoName: string };
}

function lowerWorkflowStatement(
  stmt: Statement,
  env: Env,
  aggsByName: Map<string, Aggregate>,
  reposByName: Map<string, Repository>,
  repoForAgg: Map<string, string>,
): LoweredWorkflowStmt {
  if (isPreconditionStmt(stmt)) {
    return {
      stmt: {
        kind: "precondition",
        expr: lowerExpr(stmt.expr, env),
        source: cstText(stmt.expr),
      },
      envAfter: env,
    };
  }
  if (isRequiresStmt(stmt)) {
    return {
      stmt: {
        kind: "requires",
        expr: lowerExpr(stmt.expr, env),
        source: cstText(stmt.expr),
      },
      envAfter: env,
    };
  }
  if (isEmitStmt(stmt)) {
    return {
      stmt: {
        kind: "emit",
        eventName: stmt.event?.ref?.name ?? "Unknown",
        fields: stmt.fields.map((f) => ({
          name: f.name,
          value: lowerExpr(f.value, env),
        })),
      },
      envAfter: env,
    };
  }
  if (isLetStmt(stmt)) {
    const expr = stmt.expr;
    // factory-let: `Agg.create({fields})`
    const factory = matchFactoryCall(expr, aggsByName);
    if (factory) {
      const repoName = repoForAgg.get(factory.aggName) ?? plural(factory.aggName);
      const fields = factory.fields.map((f) => ({
        name: f.name,
        value: lowerExpr(f.value, env),
      }));
      const aggType: TypeIR = { kind: "entity", name: factory.aggName };
      return {
        stmt: {
          kind: "factory-let",
          name: stmt.name,
          aggName: factory.aggName,
          fields,
        },
        envAfter: withLocal(env, stmt.name, "let", aggType),
        binding: { name: stmt.name, aggName: factory.aggName, repoName },
      };
    }
    // repo-let: `Repo.method(args)`
    const repoCall = matchRepoCall(expr, reposByName);
    if (repoCall) {
      const args = repoCall.args.map((a) => lowerExpr(a, env));
      // Resolve the find's declared return type (or for getById:
      // single non-null aggregate of the repo's target).
      const repo = repoCall.repo;
      const aggName = repo.aggregate?.ref?.name ?? "Unknown";
      let returnType: TypeIR = { kind: "entity", name: aggName };
      if (repoCall.method !== "getById") {
        const find = repo.finds.find((f) => f.name === repoCall.method);
        if (find) returnType = lowerType(find.returnType);
      }
      // The let binding's local type is the unwrapped aggregate
      // (validator rejects array/optional repo-lets).  Use the
      // declared return type so the validator can flag misuse.
      const localType: TypeIR = returnType;
      return {
        stmt: {
          kind: "repo-let",
          name: stmt.name,
          repoName: repo.name,
          aggName,
          method: repoCall.method,
          args,
          returnType,
        },
        envAfter: withLocal(env, stmt.name, "let", localType),
        binding: { name: stmt.name, aggName, repoName: repo.name },
      };
    }
    // expr-let: scalar / generic expression
    const exprIR = lowerExpr(stmt.expr, env);
    const t = inferExprType(stmt.expr, env);
    return {
      stmt: { kind: "expr-let", name: stmt.name, type: t, expr: exprIR },
      envAfter: withLocal(env, stmt.name, "let", t),
    };
  }
  if (isAssignOrCallStmt(stmt)) {
    const lv = stmt.target;
    if (!stmt.op && lv.call && lv.tail.length === 1) {
      // `name.op(args)` — op-call on a let binding.
      const aggName = aggNameForLocal(env, lv.head);
      const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
      return {
        stmt: {
          kind: "op-call",
          target: lv.head,
          aggName: aggName ?? "Unknown",
          op: lv.tail[0]!,
          args,
        },
        envAfter: env,
      };
    }
    // Anything else (mutation forms, bare calls, deep paths) becomes
    // an expr-let with no name — represented as an expr-let with a
    // synthetic placeholder so the validator can flag it.
    const placeholder: ExprIR = {
      kind: "ref",
      name: lv.head,
      refKind: "unknown",
    };
    return {
      stmt: {
        kind: "expr-let",
        name: "__bad__",
        type: { kind: "primitive", name: "string" },
        expr: placeholder,
      },
      envAfter: env,
    };
  }
  // Fallback — shouldn't hit, but stay safe.
  return {
    stmt: {
      kind: "expr-let",
      name: "__bad__",
      type: { kind: "primitive", name: "string" },
      expr: { kind: "ref", name: "unknown", refKind: "unknown" },
    },
    envAfter: env,
  };
}

/** Look up the let-binding's bound aggregate name from its local
 *  type.  Returns undefined when the binding doesn't resolve to an
 *  entity. */
function aggNameForLocal(env: Env, name: string): string | undefined {
  const local = env.locals.get(name);
  if (!local) return undefined;
  if (local.type.kind === "entity") return local.type.name;
  return undefined;
}

interface FactoryMatch {
  aggName: string;
  fields: { name: string; value: Expression }[];
}

function matchFactoryCall(
  expr: Expression | undefined,
  aggsByName: Map<string, Aggregate>,
): FactoryMatch | undefined {
  if (!expr || !isMemberAccess(expr) || !expr.call) return undefined;
  if (expr.member !== "create") return undefined;
  const recv = expr.receiver;
  if (!isNameRef(recv)) return undefined;
  if (!aggsByName.has(recv.name)) return undefined;
  if (expr.args.length !== 1) return undefined;
  const argWrap = expr.args[0];
  // Factory calls take a single object literal positional
  // arg.  Reject the named-arg form here; the caller falls through
  // to a generic call lowering rather than the factory shape.
  if (!argWrap || argWrap.name) return undefined;
  const arg = argWrap.value;
  if (!isObjectLit(arg)) return undefined;
  return {
    aggName: recv.name,
    fields: arg.fields.map((f) => ({ name: f.name, value: f.value })),
  };
}

interface RepoMatch {
  repo: Repository;
  method: string;
  args: Expression[];
}

function matchRepoCall(
  expr: Expression | undefined,
  reposByName: Map<string, Repository>,
): RepoMatch | undefined {
  if (!expr || !isMemberAccess(expr) || !expr.call) return undefined;
  const recv = expr.receiver;
  if (!isNameRef(recv)) return undefined;
  const repo = reposByName.get(recv.name);
  if (!repo) return undefined;
  // Peel CallArg wrappers — repo finds are positional.
  return {
    repo,
    method: expr.member,
    args: (expr.args ?? []).map((a) => a.value),
  };
}
