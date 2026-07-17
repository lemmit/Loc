import { type AstNode, AstUtils } from "langium";
import type {
  Aggregate,
  Api,
  Apply,
  BoundedContext,
  Channel,
  ChannelSource,
  ConfigEntry,
  ConnectionSource,
  Create,
  Criterion,
  Deployable,
  Destroy,
  DomainService,
  EntityPart,
  EnumDecl,
  EventDecl,
  Expression,
  FunctionDecl,
  Layout,
  LoadPath,
  Model,
  ObjectLit,
  Operation,
  PayloadDecl,
  Property,
  Repository,
  Resource,
  Retrieval,
  Seed,
  Statement,
  Storage,
  Subdomain,
  System,
  SystemMember,
  TestBlock,
  TestE2E,
  ThemeBlock,
  TimerSource,
  TypeRef,
  Ui,
  UserBlock,
  ValueObject,
} from "../../language/generated/ast.js";
import {
  isAggregate,
  isApi,
  isApply,
  isAuthBlock,
  isBoundedContext,
  isChannel,
  isChannelSource,
  isColumnRename,
  isCommandHandler,
  isComponent,
  isContainment,
  isCreate,
  isCriterion,
  isDeployable,
  isDerivedProp,
  isDestroy,
  isDomainService,
  isEntityPart,
  isEnumDecl,
  isEventDecl,
  isExpectStmt,
  isFunctionDecl,
  isInvariant,
  isLayout,
  isMigration,
  isObjectLit,
  isOperation,
  isPayloadDecl,
  isPermissionsBlock,
  isPolicyDecl,
  isProjection,
  isProperty,
  isQueryHandler,
  isRepository,
  isRequirement,
  isResource,
  isRetrieval,
  isSeed,
  isSolution,
  isStorage,
  isSubdomain,
  isSystem,
  isTenancyDecl,
  isTestBlock,
  isTestCase,
  isTestE2E,
  isThemeBlock,
  isTimerSource,
  isUi,
  isUnique,
  isUserBlock,
  isValueObject,
  isView,
  isWorkflow,
} from "../../language/generated/ast.js";
import { stdFunctions } from "../../language/stdlib.js";
import { descriptorFor } from "../../platform/metadata.js";
import { plural, snake } from "../../util/naming.js";
import { parseDurationMs } from "../../util/timer.js";
import { emitsRestCreate } from "../enrich/wire-projection.js";
import type {
  AggregateIR,
  ApiIR,
  AuthIR,
  BoundedContextIR,
  ChannelIR,
  ChannelSourceIR,
  CommandHandlerIR,
  ComponentIR,
  ConfigEntryIR,
  ConnectionSourceIR,
  CriterionIR,
  DataSourceIR,
  DataSourceKind,
  DeployableIR,
  DomainServiceIR,
  EntityPartIR,
  EnumIR,
  EventIR,
  ExprIR,
  FieldIR,
  IdValueType,
  LayoutIR,
  LoadPlanIR,
  LoadSegmentIR,
  PayloadIR,
  PermissionDeclIR,
  PolicyDenyIR,
  PolicyReadLevelIR,
  PolicyWriteLevelIR,
  ProjectionIR,
  QueryHandlerIR,
  RawLoomModel,
  RenameIntentIR,
  RepositoryIR,
  RequirementIR,
  RetrievalIR,
  SeedIR,
  SeedRowIR,
  SolutionIR,
  SortTermIR,
  StorageIR,
  StorageKind,
  SubdomainIR,
  SystemIR,
  TableRenameIntentIR,
  TenancyIR,
  TestCaseIR,
  TestE2EIR,
  TestIR,
  TestStmtIR,
  ThemeIR,
  TimerSourceIR,
  UserIR,
  ValueObjectIR,
  ViewIR,
  WorkflowIR,
} from "../types/loom-ir.js";
import { lit } from "../types/loom-ir.js";
import { classifyPage, type PageKind, type PageNameCtx } from "../util/page-kind.js";
import { lowerAuth } from "./lower-auth.js";
import type { ContextLevelCapabilities } from "./lower-capabilities.js";
import {
  collectCapabilities,
  collectContextLevelCapabilities,
  collectFilters,
  collectStamps,
  EMPTY_CONTEXT_CAPABILITIES,
  resolveBypass,
} from "./lower-capabilities.js";
import { lowerDeployable } from "./lower-deployment.js";
import { lowerDomainService } from "./lower-domain-service.js";
import {
  criterionRefOf,
  lowerExpr,
  setAmbientEnumIndex,
  setTopLevelFnIndex,
} from "./lower-expr.js";
import {
  lowerApply,
  lowerContainment,
  lowerCreate,
  lowerDerived,
  lowerDestroy,
  lowerEntityPart,
  lowerField,
  lowerFunction,
  lowerInvariant,
  lowerOperation,
  lowerPropertyChecks,
  lowerUnique,
} from "./lower-members.js";
import { lowerProjection } from "./lower-projection.js";
import { lowerRequirement, lowerSolution, lowerTestCase } from "./lower-requirements.js";
import { lowerStatement } from "./lower-stmt.js";
import {
  cstText,
  type Env,
  findEntityByName,
  findValueObjectByName,
  inAggregate,
  inValueObject,
  lowerAtom,
  lowerType,
  newEnv,
  setAmbientDeclIndex,
  withLocal,
} from "./lower-types.js";
import { lowerComponent, lowerLayout, lowerUi } from "./lower-ui.js";
import { lowerView } from "./lower-view.js";
import { lowerCommandHandler, lowerQueryHandler, lowerWorkflow } from "./lower-workflow.js";
import { originFor } from "./origin.js";
import { buildExpandContext, type WalkerExpandContext } from "./walker-primitive-expander.js";

// ---------------------------------------------------------------------------
// Lowering — structure layer.
//
// Walks the AST top-down (Model → System → Module → Context →
// Aggregate / Part / VO / Event / Repository → members) producing
// IR shapes.  Expression / statement / type-inference machinery
// lives in `lower-expr.ts`; this file only deals with the
// hierarchical IR built around those expressions.
// ---------------------------------------------------------------------------

export function lowerModel(model: Model): RawLoomModel {
  // Single-document lowering = a one-element project (composes the file's
  // own `system` with any top-level domain members it declares).
  return lowerProject([model]);
}

/** Lower an entire project — every `.ddd` document in the import graph —
 *  composing the lone `system { }` block (its name + singletons +
 *  deployment) with top-level `subdomain` / `context` declarations from
 *  ANY file into one project system.  See
 *  docs/old/proposals/implicit-system-composition.md.
 *
 *  Resolution: exactly one `system` block in the project ⇒ fold every
 *  top-level domain member into it (the user / permission threading in
 *  `lowerSystem` then applies to them).  Zero or many systems ⇒ legacy
 *  behaviour: top-level `context`s stay loose (single-deployable mode);
 *  a stray top-level `subdomain` is a validation error
 *  (`loom.top-level-domain-needs-single-system`), but its contexts are
 *  still lowered loose here so nothing is silently dropped. */
export function lowerProject(models: ReadonlyArray<Model>): RawLoomModel {
  const allMembers = models.flatMap((m) => m.members);
  // Index the project-global ambient root-level enums (value name → enum
  // name) so a bare enum-value reference (`priority: Normal`) resolves to
  // its qualified const even when the enum is declared in a sibling kernel
  // file.  Installed before any body is lowered; first declaration wins on
  // a cross-enum value-name collision (the validator owns the ambiguity).
  // See `setAmbientEnumIndex` in lower-expr.ts.
  const ambientEnumIndex = new Map<string, string>();
  for (const m of allMembers) {
    if (!isEnumDecl(m)) continue;
    for (const v of m.values) {
      if (!ambientEnumIndex.has(v.name)) ambientEnumIndex.set(v.name, m.name);
    }
  }
  setAmbientEnumIndex(ambientEnumIndex);
  // Project-global index of TOP-LEVEL (ambient) helper `function`s (stdlib
  // Phase B) — declared at file root or inside a `system { }`, visible
  // workspace-wide.  Expression-form functions INLINE at every call site
  // during lowering (`inlineTopLevelFn` in lower-expr.ts), so they need this
  // ambient index rather than an owning aggregate.  First declaration wins on
  // a name collision (the validator owns any ambiguity).  Local functions
  // (aggregate / VO / workflow members) are NOT indexed here — they keep the
  // emitted `this.<fn>` path via `resolveCallKind`.
  const topLevelFnIndex = new Map<string, FunctionDecl>();
  const addTopLevelFn = (m: { $type: string; name?: string }): void => {
    if (isFunctionDecl(m) && !topLevelFnIndex.has(m.name)) topLevelFnIndex.set(m.name, m);
  };
  for (const m of allMembers) {
    addTopLevelFn(m);
    if (isSystem(m)) for (const sm of m.members) addTopLevelFn(sm);
  }
  // Ambient std prelude (stdlib Phase C) — merge the built-in functions LAST,
  // and only for names the user did not declare, so a user top-level function
  // of the same name shadows the prelude (`addTopLevelFn` is first-wins).
  for (const [name, fn] of stdFunctions())
    if (!topLevelFnIndex.has(name)) topLevelFnIndex.set(name, fn);
  setTopLevelFnIndex(topLevelFnIndex);
  // Project-global name → decl index for every value object / enum / entity
  // across the import graph (recursing into systems / subdomains / contexts).
  // Backstops the `findXByName` lookups in lower-types so a macro-emitted
  // param type (e.g. a `crudish` update field) or a VO literal pointing at a
  // sibling-file shared-kernel decl resolves instead of collapsing to
  // `string` / a `free` call.  First declaration wins on a name collision
  // (the validator owns the ambiguity diagnostic).
  const ambientVOs = new Map<string, ValueObject>();
  const ambientEnums = new Map<string, EnumDecl>();
  const ambientEntities = new Map<string, Aggregate | EntityPart>();
  const ambientDomainServices = new Map<string, DomainService>();
  const indexMembers = (members: readonly AstNode[]): void => {
    for (const m of members) {
      if (isValueObject(m)) {
        if (!ambientVOs.has(m.name)) ambientVOs.set(m.name, m);
      } else if (isEnumDecl(m)) {
        if (!ambientEnums.has(m.name)) ambientEnums.set(m.name, m);
      } else if (isAggregate(m)) {
        if (!ambientEntities.has(m.name)) ambientEntities.set(m.name, m);
      } else if (isDomainService(m)) {
        if (!ambientDomainServices.has(m.name)) ambientDomainServices.set(m.name, m);
      }
      if ("members" in m && Array.isArray((m as { members?: unknown }).members)) {
        indexMembers((m as { members: AstNode[] }).members);
      }
    }
  };
  indexMembers(allMembers);
  setAmbientDeclIndex({
    valueObjects: ambientVOs,
    enums: ambientEnums,
    entities: ambientEntities,
    domainServices: ambientDomainServices,
  });
  const systemNodes = allMembers.filter(isSystem);
  // Every top-level system-scoped declaration across the import graph —
  // domain (Tier 1: subdomain / context) plus deployment (Tier 2:
  // deployable / storage / resource / ui / theme / user / api / layout /
  // e2e).  These fold into the project's single system.
  const topLevelSystemMembers = allMembers.filter(
    (
      m,
    ): m is
      | Subdomain
      | BoundedContext
      | Deployable
      | Storage
      | Resource
      | ChannelSource
      | Ui
      | ThemeBlock
      | UserBlock
      | Api
      | Layout
      | TestE2E =>
      isSubdomain(m) ||
      isBoundedContext(m) ||
      isDeployable(m) ||
      isStorage(m) ||
      isResource(m) ||
      isChannelSource(m) ||
      isUi(m) ||
      isThemeBlock(m) ||
      isUserBlock(m) ||
      isApi(m) ||
      isLayout(m) ||
      isTestE2E(m),
  );
  const compose = systemNodes.length === 1;

  const systems: SystemIR[] = [];
  const looseContexts: BoundedContextIR[] = [];
  const rootValueObjects: ValueObjectIR[] = [];
  const rootEnums: EnumIR[] = [];
  const rootPayloads: PayloadIR[] = [];
  const components: ComponentIR[] = [];
  const requirements: RequirementIR[] = [];
  const solutions: SolutionIR[] = [];
  const testCases: TestCaseIR[] = [];
  const renameIntents: RenameIntentIR[] = [];
  const tableRenameIntents: TableRenameIntentIR[] = [];
  // Root-level VOs / enums have no enclosing context — pass an empty
  // env so `lowerValueObject`'s `inValueObject(env, vo)` still works.
  const rootEnv: Env = { locals: new Map() };
  for (const m of allMembers) {
    if (isSystem(m)) {
      systems.push(lowerSystem(m, compose ? topLevelSystemMembers : []));
    } else if (isBoundedContext(m)) {
      // Folded into the single system above when composing; otherwise a
      // legacy loose context (single-deployable mode).
      if (!compose) looseContexts.push(lowerContext(m));
    } else if (isSubdomain(m)) {
      // Folded when composing; otherwise a validation error — still lower
      // its contexts loose so the IR names them.
      if (!compose) for (const c of m.contexts) looseContexts.push(lowerContext(c));
    } else if (isValueObject(m)) rootValueObjects.push(lowerValueObject(m, rootEnv));
    else if (isEnumDecl(m)) rootEnums.push(lowerEnum(m));
    else if (isPayloadDecl(m)) rootPayloads.push(lowerPayload(m, rootEnv));
    else if (isComponent(m)) components.push(lowerComponent(m));
    else if (isRequirement(m)) requirements.push(lowerRequirement(m));
    else if (isSolution(m)) solutions.push(lowerSolution(m));
    else if (isTestCase(m)) testCases.push(lowerTestCase(m));
    else if (isMigration(m)) {
      // Schema-evolution intent (M-T2.1): each step becomes a rename intent the
      // phase-⑨ migration builder folds into its diff.  The live aggregate is
      // resolved to its owning bounded context so the builder can pin the
      // module + Postgres schema.  Names stay RAW (the builder snake-cases them
      // exactly as it does aggregate fields / table names).
      for (const step of m.renames) {
        if (isColumnRename(step)) {
          const agg = step.aggregate.ref;
          renameIntents.push({
            migration: m.name,
            aggregate: agg?.name ?? step.aggregate.$refText,
            context: AstUtils.getContainerOfType(agg, isBoundedContext)?.name ?? "",
            from: step.from,
            to: step.to,
            origin: originFor(step),
          });
        } else {
          // Table/aggregate rename (`OldName -> NewAggregate`).  Only the NEW
          // aggregate is cross-referenced (the old name is gone); it pins the
          // context/module.  `fromTable` is the old, now-absent name.
          const agg = step.toAggregate.ref;
          tableRenameIntents.push({
            migration: m.name,
            fromAggregate: step.fromTable,
            toAggregate: agg?.name ?? step.toAggregate.$refText,
            context: AstUtils.getContainerOfType(agg, isBoundedContext)?.name ?? "",
            origin: originFor(step),
          });
        }
      }
    }
  }
  return {
    systems,
    contexts: looseContexts,
    rootValueObjects,
    rootEnums,
    rootPayloads,
    components,
    requirements,
    solutions,
    testCases,
    renameIntents,
    tableRenameIntents,
  };
}

/** Merge several lowered models — one per `.ddd` document in a
 *  multi-file project — into a single `LoomModel` that the rest of
 *  the pipeline (enrichments, validator, generators) consumes
 *  unchanged.  Used by the CLI's project loader after lowering each
 *  reachable document independently.  Concatenation is structurally
 *  safe because every nested IR node references its source AST and
 *  carries its own resolved cross-references; the merge is just an
 *  in-order union of the top-level slices.  Duplicate-name detection
 *  is left to the validator. */
export function mergeLoomModels(models: RawLoomModel[]): RawLoomModel {
  if (models.length === 1) return models[0]!;
  return {
    systems: models.flatMap((m) => m.systems),
    contexts: models.flatMap((m) => m.contexts),
    rootValueObjects: models.flatMap((m) => m.rootValueObjects),
    rootEnums: models.flatMap((m) => m.rootEnums),
    rootPayloads: models.flatMap((m) => m.rootPayloads),
    components: models.flatMap((m) => m.components),
    requirements: models.flatMap((m) => m.requirements),
    solutions: models.flatMap((m) => m.solutions),
    testCases: models.flatMap((m) => m.testCases),
    renameIntents: models.flatMap((m) => m.renameIntents),
    tableRenameIntents: models.flatMap((m) => m.tableRenameIntents),
  };
}

/** Lower a `system { … }` block.  `extraDomainMembers` are top-level
 *  `subdomain` / `context` declarations from sibling files (the import
 *  graph) that compose into THIS system — see `lowerProject` /
 *  docs/old/proposals/implicit-system-composition.md.  They are folded in
 *  alongside `sys.members` so the `user` / `permissions` threading below
 *  applies to them identically to a nested declaration. */
function lowerSystem(sys: System, extraMembers: ReadonlyArray<SystemMember> = []): SystemIR {
  // `extraMembers` are top-level system-scoped declarations from sibling
  // files (the import graph) that compose into THIS system — subdomains
  // and contexts (Tier 1) plus the deployment shape (Tier 2: deployable /
  // storage / resource / ui / theme / user / api / layout / e2e).  Fold
  // them in alongside `sys.members` so every member-kind pass below treats
  // them identically to a nested declaration.
  const members: ReadonlyArray<SystemMember> =
    extraMembers.length > 0 ? [...sys.members, ...extraMembers] : sys.members;
  // Pre-pass over members: pull the user block out first so every
  // context lowering downstream sees the same shape.  At most one
  // block per system (validator enforces; we take the last one if
  // the parser somehow accepts more).  User fields use a separate
  // grammar rule (`UserField`) so the canonical JWT claim name `id`
  // (otherwise reserved for aggregate identity) is admissible.
  let user: UserIR | undefined;
  let theme: ThemeIR | undefined;
  let auth: AuthIR | undefined;
  let tenancy: TenancyIR | undefined;
  for (const m of members) {
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
    } else if (isAuthBlock(m)) {
      // System-level OIDC config (D-AUTH-OIDC).  At most one block per
      // system (validator enforces; last wins if the parser accepts
      // more).  Provider-preset resolution lives in `lowerAuth`.
      auth = lowerAuth(m);
    } else if (isTenancyDecl(m)) {
      // System-level tenancy declaration (multi-tenancy Phase 1a; real
      // cross-references since 1b.1).  At most one per system (validator
      // enforces; last wins if the parser accepts more).  Existence is the
      // linker's job now — lowering stays total on an unresolved ref by
      // falling back to the source text, so the IR downstream is unchanged
      // (plain names).
      tenancy = {
        claimField: m.claim?.ref?.name ?? m.claim?.$refText ?? "",
        registryName: m.registry?.ref?.name ?? m.registry?.$refText ?? "",
      };
    } else if (isThemeBlock(m)) {
      // Theme props are name/value pairs; we lower into a typed
      // partial.  Validation (known names, hex colours, radius
      // enum, no duplicates) lives in validate.ts so the IR
      // doesn't have to carry a "rejected props" channel.
      theme = lowerTheme(m);
    }
  }
  const subdomains: SubdomainIR[] = [];
  const deployables: DeployableIR[] = [];
  const e2eBlocks: TestE2E[] = [];
  // Bare `context` declarations directly under a `system` block live in
  // an implicit anonymous subdomain so we can index them like any other.
  const looseContexts: BoundedContextIR[] = [];
  // Fold sibling-file top-level `subdomain` / `context` declarations in
  // with this system's own members.  Only the Subdomain / BoundedContext
  // branches below match them; Deployable / TestE2E / Ui / … stay
  // system-block-only (Tier 1), so iterating the union is safe.
  for (const m of members) {
    if (isSubdomain(m)) {
      // Subdomain-scoped permissions catalogue.  Multiple
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
      subdomains.push({
        name: m.name,
        contexts: m.contexts.map((c) => lowerContext(c, user, permissions)),
        permissions,
      });
    } else if (isBoundedContext(m)) {
      // Loose contexts under a system don't sit inside a subdomain,
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
    subdomains.push({ name: "_default", contexts: looseContexts, permissions: [] });
  }
  // React deployable's `contextNames` inheritance from `targets:` is
  // an enrichment, not a structural lowering — see
  // `src/ir/enrich/enrichments.ts`.
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
    const isFrontendOnly = !!targetPlatform && descriptorFor(targetPlatform).isFrontend;
    const isFullstack = targetPlatform === "elixir";
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
  // into their literal IR shape.  Scaffold expansion and body type
  // inference happen in subsequent passes.
  // Thread the system user shape so a page's `requires` gate (and any other
  // page-scope `currentUser` reference) resolves to a `current-user` ref.
  const uis = members.filter((m): m is Ui => m.$type === "Ui").map((u) => lowerUi(u, user));
  // Api declarations — system-level peers to module / ui / deployable.
  const apis = members
    .filter((m): m is Api => m.$type === "Api")
    .map(
      (a): ApiIR => ({
        name: a.name,
        sourceModule: a.source?.$refText ?? "",
        urlStyle: a.urlStyle === "resource" ? "resource" : "literal",
        errorStatuses: Object.fromEntries((a.statuses ?? []).map((s) => [s.error, s.code])),
        routes: (a.routes ?? []).map((r) => ({
          method: r.method,
          path: r.path,
          target: {
            context: r.target.context?.$refText ?? "",
            handler: r.target.handler,
          },
        })),
      }),
    );
  const storages = members
    .filter((m): m is Storage => m.$type === "Storage")
    .map(
      (s): StorageIR => ({
        name: s.name,
        type: s.type as StorageKind,
        ...(s.instance ? { instance: s.instance } : {}),
        ...(s.connection ? { connection: lowerConnectionSource(s.connection) } : {}),
        ...(s.config.length ? { config: s.config.map(lowerConfigEntry) } : {}),
      }),
    );
  const dataSources = members
    .filter((m): m is Resource => m.$type === "Resource")
    .map(
      (d): DataSourceIR => ({
        name: d.name,
        contextName: d.context?.ref?.name ?? "",
        kind: d.kind as DataSourceKind,
        storageName: d.use?.ref?.name ?? "",
        ...(d.schema ? { schema: d.schema } : {}),
        ...(d.tablePrefix ? { tablePrefix: d.tablePrefix } : {}),
        ...(d.keyPrefix ? { keyPrefix: d.keyPrefix } : {}),
        ...(typeof d.ttl === "number" ? { ttl: d.ttl } : {}),
        ...(typeof d.every === "number" ? { every: d.every } : {}),
        ...(typeof d.retain === "number" ? { retain: d.retain } : {}),
        ...(d.isolationLevel
          ? {
              isolationLevel: d.isolationLevel as DataSourceIR["isolationLevel"],
            }
          : {}),
        ...(d.readonly ? { readonly: true } : {}),
        ...(d.shape == null ? {} : { shape: d.shape as DataSourceIR["shape"] }),
        ...(d.indexes.length
          ? {
              manualIndexes: d.indexes.map((spec) => ({
                entity: spec.entity,
                columns: [...spec.columns],
              })),
            }
          : {}),
        ...(d.config.length ? { config: d.config.map(lowerConfigEntry) } : {}),
      }),
    );
  // Named `layout <Name> { … }` SystemMembers (Phase 8).  Each slot's
  // body is a page-body-shaped expression lowered against the same
  // env shape pages use.  No params or state — layouts are static
  // wrappers, not parametric components.
  const channelSources = members
    .filter((m): m is ChannelSource => m.$type === "ChannelSource")
    .map(
      (cs): ChannelSourceIR => ({
        name: cs.name,
        channelName: cs.channel ?? "",
        storageName: cs.use?.ref?.name ?? "",
      }),
    );
  // TimerSource — time as an event source (scheduling.md, M-T4.1).  Resolve the
  // `for:` event to its declaring context (for owner derivation) and normalise
  // the cadence to the discriminated `TimerCadenceIR`.  A malformed `every:`
  // (rejected by `loom.timer-cadence`) lowers to `everyMs: 0`; validation, not
  // lowering, is where the user learns of it.
  const timerSources = members
    .filter((m): m is TimerSource => m.$type === "TimerSource")
    .map(
      (ts): TimerSourceIR => ({
        name: ts.name,
        event: ts.event?.ref?.name ?? "",
        context: ts.event?.ref
          ? (AstUtils.getContainerOfType(ts.event.ref, isBoundedContext)?.name ?? "")
          : "",
        cadence: ts.cron
          ? { kind: "cron", cron: ts.cron }
          : { kind: "every", everyMs: parseDurationMs(ts.every ?? "") },
        ...(ts.timezone ? { timezone: ts.timezone } : {}),
        ...(ts.overlap ? { overlap: true } : {}),
      }),
    );
  const layouts = members
    .filter((m): m is Layout => m.$type === "Layout")
    .map((l): LayoutIR => lowerLayout(l));
  const built: SystemIR = {
    name: sys.name,
    subdomains,
    deployables,
    e2eTests,
    user,
    auth,
    tenancy,
    theme,
    uis,
    apis,
    storages,
    dataSources,
    channelSources,
    timerSources,
    layouts,
  };
  // Scaffold post-passes.  A page's kind (`<Agg>` list/new/detail, `<Wf>`
  // form/instances, `<View>`, the singleton dashboards, or `custom`) is derived
  // on demand from its role-scoped name + area via `classifyPage` — no stamped
  // `origin` (slice 3c).  These passes drop the create surface for
  // non-constructible aggregates and apply per-page side effects (emit path,
  // auto-`id` param for detail pages).  Every scaffold page — dashboards
  // included — already carries its full body from the macro, so there is no
  // inline sentinel left to expand.
  dropNonConstructibleNewPages(built);
  stripNonConstructibleListCreate(built);
  applyPageSideEffects(built);
  return built;
}

/** A page's classification context for the given ui — the served aggregate /
 *  workflow / view names `classifyPage` matches role-scoped page names against
 *  (slice 3c: replaces the stamped `PageIR.origin`). */
function nameCtxOf(ctx: WalkerExpandContext): PageNameCtx {
  return {
    aggregateNames: [...ctx.aggregatesByName.keys()],
    workflowNames: [...ctx.workflowsByName.keys()],
    viewNames: [...ctx.viewsByName.keys()],
  };
}

/** Drop the scaffolded `<Agg>New` page for an aggregate with no REST create
 *  surface (`!emitsRestCreate` — no canonical `create`, or no creation event
 *  for an ES aggregate).  The backends emit no POST route for such an
 *  aggregate, so a scaffolded create form would submit to a route that
 *  doesn't exist; the matching list "New" button is suppressed in the list
 *  scaffolder.  Removing the page here (before the origin / expand passes)
 *  also drops it from the router and menu, which derive from `ui.pages` at
 *  emit time. */
function dropNonConstructibleNewPages(sys: SystemIR): void {
  for (const ui of sys.uis) {
    const ctx = buildExpandContext(sys, ui);
    const nameCtx = nameCtxOf(ctx);
    ui.pages = ui.pages.filter((page) => {
      const kind = classifyPage(page, nameCtx);
      if (kind.kind !== "aggregate-new") return true;
      const agg = ctx.aggregatesByName.get(kind.aggregateName);
      return !agg || emitsRestCreate(agg);
    });
  }
}

/** Suppress the list "New <agg>" button for an aggregate with no REST create
 *  surface — the backends emit no POST route, so the create surface must not
 *  appear.  The macro-emitted list body always carries the button, so we
 *  strip it here, where the create fact (`emitsRestCreate`) is available.
 *  Mirrors `dropNonConstructibleNewPages`, which drops the matching `New`
 *  page. */
function stripNonConstructibleListCreate(sys: SystemIR): void {
  for (const ui of sys.uis) {
    const ctx = buildExpandContext(sys, ui);
    const nameCtx = nameCtxOf(ctx);
    for (const page of ui.pages) {
      const kind = classifyPage(page, nameCtx);
      if (kind.kind !== "aggregate-list" || !page.body) continue;
      const agg = ctx.aggregatesByName.get(kind.aggregateName);
      if (!agg || emitsRestCreate(agg)) continue;
      page.body = stripCreateButton(page.body, `${pluralSnake(agg.name)}-list-create`);
    }
  }
}

/** Remove any `Button(…, testid: <testid>)` call node from `e`'s subtree
 *  (the scaffolded list's "New" button), keeping `args`/`argNames` aligned. */
function stripCreateButton(e: ExprIR, testid: string): ExprIR {
  if (e.kind !== "call") return e;
  const keep: number[] = [];
  e.args.forEach((a, i) => {
    if (!isButtonWithTestid(a, testid)) keep.push(i);
  });
  const args = keep.map((i) => stripCreateButton(e.args[i]!, testid));
  const argNames = e.argNames ? keep.map((i) => e.argNames![i]) : e.argNames;
  return { ...e, args, argNames };
}

function isButtonWithTestid(e: ExprIR, testid: string): boolean {
  if (e.kind !== "call" || e.name !== "Button") return false;
  return (e.argNames ?? []).some((n, i) => {
    if (n !== "testid") return false;
    const v = e.args[i];
    return v?.kind === "literal" && v.value === testid;
  });
}

function lowerConfigEntry(entry: ConfigEntry): ConfigEntryIR {
  const v = entry.value;
  switch (v.$type) {
    case "StringConfigValue":
      return { key: entry.key, value: { kind: "string", value: v.value } };
    case "IntConfigValue":
      return { key: entry.key, value: { kind: "int", value: v.value } };
    case "BoolConfigValue":
      return { key: entry.key, value: { kind: "bool", value: v.value === "true" } };
  }
}

function lowerConnectionSource(node: ConnectionSource): ConnectionSourceIR {
  switch (node.$type) {
    case "ServiceConnectionSource":
      return { kind: "service", service: node.service };
    case "EnvConnectionSource":
      return { kind: "env", env: node.env };
    case "SecretConnectionSource":
      return { kind: "secret", secret: node.secret };
    case "LiteralConnectionSource":
      return { kind: "literal", literal: node.literal };
  }
}

/** Per-page side effects driven by the page's derived kind: compute the
 *  conventional emit path and synthesise the `id` route param on
 *  aggregate-/instance-detail pages. */
function applyPageSideEffects(sys: SystemIR): void {
  for (const ui of sys.uis) {
    const ctx = buildExpandContext(sys, ui);
    const nameCtx = nameCtxOf(ctx);
    for (const page of ui.pages) {
      const kind = classifyPage(page, nameCtx);
      if (kind.kind === "custom") continue;
      // `area` is authoritative for file placement (slice 3a): a page declared
      // inside an `area { … }` block already had its `emitPath` set from the
      // area containment path in `lowerUi` (`src/pages/orders/list.tsx`).  Only
      // fall back to the conventional path for area-less scaffold pages (the
      // Home / Workflows / Views index singletons, workflow + view pages).
      if (!page.area || page.area.length === 0) {
        page.emitPath = conventionalEmitPath(kind, ctx);
      }
      // Detail page bodies reference `id` as a route param
      // (`api.Order.byId(id)`).  Scaffold emits the detail page with
      // route `/<plural>/:id` but no declarative `params` block, so
      // synthesise the typed param here for the walker to consume
      // when it emits `useParams<{id: string}>()`.
      if (
        (kind.kind === "aggregate-detail" || kind.kind === "workflow-instance-detail") &&
        !page.params.some((p) => p.name === "id")
      ) {
        page.params.push({
          name: "id",
          type: { kind: "primitive", name: "string" },
        });
      }
    }
  }
}

function conventionalEmitPath(kind: PageKind, ctx: WalkerExpandContext): string | undefined {
  if (
    kind.kind === "aggregate-list" ||
    kind.kind === "aggregate-new" ||
    kind.kind === "aggregate-detail"
  ) {
    const agg = ctx.aggregatesByName.get(kind.aggregateName);
    if (!agg) return undefined;
    const slug = pluralSnake(agg.name);
    const file =
      kind.kind === "aggregate-list" ? "list" : kind.kind === "aggregate-new" ? "new" : "detail";
    return `src/pages/${slug}/${file}.tsx`;
  }
  if (kind.kind === "workflow-form") {
    const wf = ctx.workflowsByName.get(kind.workflowName);
    if (!wf) return undefined;
    return `src/pages/workflows/${snakeOnly(wf.name)}.tsx`;
  }
  if (kind.kind === "workflow-instances-list" || kind.kind === "workflow-instance-detail") {
    const wf = ctx.workflowsByName.get(kind.workflowName);
    if (!wf) return undefined;
    const file = kind.kind === "workflow-instances-list" ? "instances" : "instance_detail";
    return `src/pages/workflows/${snakeOnly(wf.name)}/${file}.tsx`;
  }
  if (kind.kind === "view-list") {
    return `src/pages/views/${snakeOnly(kind.viewName)}.tsx`;
  }
  if (kind.kind === "home") return "src/pages/home.tsx";
  if (kind.kind === "workflows-index") return "src/pages/workflows/index.tsx";
  if (kind.kind === "views-index") return "src/pages/views/index.tsx";
  // `custom` pages emit at the default `src/pages/<page-snake>.tsx`
  // path — return undefined so the page-emitter falls back to its
  // default.
  return undefined;
}

function snakeOnly(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function pluralSnake(s: string): string {
  return plural(snake(s));
}

function lowerTheme(block: ThemeBlock): ThemeIR {
  const out: ThemeIR = {};
  for (const p of block.props) {
    const value = p.value;
    switch (p.name) {
      case "primary":
        out.primary = value;
        break;
      case "secondary":
        out.secondary = value;
        break;
      case "accent":
        out.accent = value;
        break;
      case "success":
        out.success = value;
        break;
      case "warning":
        out.warning = value;
        break;
      case "error":
        out.error = value;
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
      case "fontFamilyMono":
        out.fontFamilyMono = value;
        break;
      case "colorScheme":
        if (value === "light" || value === "dark" || value === "auto") {
          out.colorScheme = value;
        }
        break;
      // Unknown property names land in the validator's reject path;
      // we silently drop them here so the IR shape stays clean.
    }
  }
  return out;
}

function lowerE2E(block: TestE2E, env: Env, kind: "api" | "ui"): TestE2EIR {
  const inner = block.body;
  let curEnv = env;
  const statements: TestStmtIR[] = [];
  for (const s of inner) {
    if (isExpectStmt(s)) {
      statements.push(expectStmtIR(lowerExpr(s.expr, curEnv), cstText(s.expr)));
    } else {
      // `expect` is filtered above; the remaining shapes are exactly
      // `Statement`.
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

function lowerContext(
  ctx: BoundedContext,
  user?: UserIR,
  modulePermissions?: PermissionDeclIR[],
): BoundedContextIR {
  // Lowering produces a faithful AST projection only.  Auto-included
  // `findAll`, react `contextNames` inheritance, and wire-shape
  // derivation all live in `enrichLoomModel` (src/ir/enrich/enrichments.ts)
  // which runs after lowering.  `user` (when set) threads the
  // system's user-claim shape into every expression context so the
  // `currentUser` magic identifier resolves to a typed shape.
  // `modulePermissions` (when set) does the same for the
  // `permissions.<name>` magic-identifier resolution; loose contexts
  // not bundled in a module pass undefined.
  // Ambient resource handles in scope for this context (Phase 4):
  // system-level `resource X { for: <thisCtx>, kind, … }` declarations,
  // keyed by name → infra kind.  Workflow bodies resolve `files.put(…)`
  // against this map.  Empty for loose contexts (no enclosing system).
  const resources = new Map<string, DataSourceKind>();
  const sys = AstUtils.getContainerOfType(ctx, isSystem);
  if (sys) {
    for (const m of sys.members) {
      if (isResource(m) && m.context?.ref === ctx && m.kind) {
        resources.set(m.name, m.kind as DataSourceKind);
      }
    }
  }
  const env = newEnv(ctx, user, modulePermissions, resources);
  const enums: EnumIR[] = [];
  const valueObjects: ValueObjectIR[] = [];
  const events: EventIR[] = [];
  const payloads: PayloadIR[] = [];
  const aggregates: AggregateIR[] = [];
  const repositories: RepositoryIR[] = [];
  const workflows: WorkflowIR[] = [];
  const commandHandlers: CommandHandlerIR[] = [];
  const queryHandlers: QueryHandlerIR[] = [];
  const views: ViewIR[] = [];
  const criteria: CriterionIR[] = [];
  const domainServices: DomainServiceIR[] = [];
  const channels: ChannelIR[] = [];
  const projections: ProjectionIR[] = [];
  const retrievals: RetrievalIR[] = [];
  const seeds: SeedIR[] = [];
  // Context-level capabilities propagate to every aggregate inside.
  // Lower them here in the context env (no `this` binding); each
  // aggregate's lowering re-uses the lowered IR directly.  The `this`
  // references inside a context-level filter resolve later when the
  // expression is rendered with a per-aggregate lambda binder.
  const ctxCaps = collectContextLevelCapabilities(ctx, env);
  for (const m of ctx.members) {
    if (isEnumDecl(m)) enums.push(lowerEnum(m));
    else if (isValueObject(m)) valueObjects.push(lowerValueObject(m, env));
    else if (isEventDecl(m)) events.push(lowerEvent(m));
    else if (isPayloadDecl(m)) payloads.push(lowerPayload(m, env));
    else if (isAggregate(m)) aggregates.push(lowerAggregate(m, env, ctxCaps));
    else if (isRepository(m)) repositories.push(lowerRepository(m, user, modulePermissions));
    else if (isDomainService(m)) domainServices.push(lowerDomainService(m, env));
    else if (isView(m)) views.push(lowerView(m, env));
    else if (isCriterion(m)) criteria.push(lowerCriterion(m, env));
    else if (isChannel(m)) channels.push(lowerChannel(m));
    else if (isProjection(m)) projections.push(lowerProjection(m, env));
    else if (isRetrieval(m)) retrievals.push(lowerRetrieval(m, env));
    else if (isSeed(m)) seeds.push(lowerSeed(m, env));
  }
  // Workflows lower in a SECOND pass so they can see the context's already-
  // lowered `aggregates` + `domainServices` (domain-services.md rev. 4, the
  // `mutating` tier): a workflow's exit-saves must include the aggregates a
  // called `mutating` service writes (`computeSaves` derives WHICH args are
  // mutated from the resolved service op + aggregate ops).  Aggregates and
  // domain services never reference workflows, so deferring is safe.
  for (const m of ctx.members) {
    if (isWorkflow(m)) workflows.push(lowerWorkflow(m, env, ctx, { aggregates, domainServices }));
    // Application-layer handlers (unfoldable-api-derivation.md, Layer 3) lower in
    // this same second pass — like workflows, their exit-saves must see the
    // context's already-lowered aggregates + domain services.
    else if (isCommandHandler(m))
      commandHandlers.push(lowerCommandHandler(m, env, ctx, { aggregates, domainServices }));
    else if (isQueryHandler(m))
      queryHandlers.push(lowerQueryHandler(m, env, ctx, { aggregates, domainServices }));
  }
  // `policy {}` read-reachability rules (multi-tenancy Phase 2 P2.4).  A pure
  // structural projection — the per-aggregate `deep`/`global` rewrite of the
  // `tenantOwned` filter happens in enrichment; validation (tenant-owned-ness,
  // hierarchy requirement, unknown/duplicate target) is phase ⑦.
  const policyReadLevels: PolicyReadLevelIR[] = [];
  const policyWriteLevels: PolicyWriteLevelIR[] = [];
  const policyDenies: PolicyDenyIR[] = [];
  for (const m of ctx.members) {
    if (!isPolicyDecl(m)) continue;
    for (const r of m.rules) {
      // `deny [write] on X` (Phase 4) — the deny-wins carve-out.  All-or-nothing
      // at the aggregate (no level); the optional `write` verb selects the
      // access.  Enrichment resolves deny-wins after the allow passes.
      if (r.effect === "deny") {
        const access = r.verb === "write" ? "write" : "read";
        policyDenies.push({
          aggregate: r.target,
          access,
          source: `deny ${r.verb ? `${r.verb} ` : ""}on ${r.target}`,
        });
        continue;
      }
      // The optional `verb` (P3.1) selects the ladder: `write` gates
      // mutations; bare / `read` is the Phase 2 read ladder.
      if (r.verb === "write") {
        policyWriteLevels.push({
          aggregate: r.target,
          level: r.level as PolicyWriteLevelIR["level"],
          source: `allow write ${r.level} on ${r.target}`,
        });
      } else {
        policyReadLevels.push({
          aggregate: r.target,
          level: r.level as PolicyReadLevelIR["level"],
          source: `allow ${r.level} on ${r.target}`,
        });
      }
    }
  }
  return {
    name: ctx.name,
    enums,
    valueObjects,
    events,
    // Unified payload-family view: the context's `event`s projected in as
    // `kind: "event"` payloads, then the author-declared `PayloadDecl`s.
    // `events` above stays populated so existing event emission is
    // untouched.  P2's synthesized `<Agg>Wire` payloads are appended in
    // enrichment, not here.
    payloads: [...events.map(eventToPayload), ...payloads],
    aggregates,
    repositories,
    workflows,
    ...(commandHandlers.length > 0 ? { commandHandlers } : {}),
    ...(queryHandlers.length > 0 ? { queryHandlers } : {}),
    views,
    criteria,
    domainServices,
    channels,
    projections,
    retrievals,
    seeds,
    origin: originFor(ctx),
    ...(policyReadLevels.length > 0 ? { policyReadLevels } : {}),
    ...(policyWriteLevels.length > 0 ? { policyWriteLevels } : {}),
    ...(policyDenies.length > 0 ? { policyDenies } : {}),
  };
}

/** Lower a `channel <Name> { carries: … }` declaration (channels.md, Slice 1)
 *  to its IR record.  Structural only — no expressions.  Knob defaults
 *  reproduce today's in-process broadcast/ephemeral dispatch. */
function lowerChannel(c: Channel): ChannelIR {
  return {
    name: c.name,
    carries: c.carries.map((r) => r.$refText).filter((n) => n.length > 0),
    delivery: (c.delivery as ChannelIR["delivery"]) ?? "broadcast",
    retention: (c.retention as ChannelIR["retention"]) ?? "ephemeral",
    ...(c.key ? { key: c.key } : {}),
  };
}

/** Lower a `seed [dataset] [raw] { Aggregate { … } … }` declaration to its
 *  IR record (database-seeding.md, declarative form).  Each row's value is
 *  an `ObjectLit` shaped like the aggregate's create parameters; its field
 *  initialisers are lowered as ordinary expressions in the context scope
 *  (enum values, value-object object-literals, and pure stdlib builtins like
 *  `now()` all resolve there).  No `this` binding — seed rows construct fresh
 *  instances, they do not operate on an existing aggregate. */
function lowerSeed(s: Seed, env: Env): SeedIR {
  const rows: SeedRowIR[] = s.rows.map((row) => {
    const agg = row.aggregate.ref;
    // Per-field declared type, so a bare object literal in a value-object-
    // typed create field (`contact: { email: … }`) coerces to a VO ctor
    // instead of an unassignable plain object.
    const fieldTypes = new Map<string, TypeRef | undefined>();
    if (agg) for (const m of agg.members) if (isProperty(m)) fieldTypes.set(m.name, m.type);
    return {
      aggregate: agg?.name ?? "Unknown",
      fields: row.value.fields.map((f) => ({
        name: f.name,
        value: lowerSeedValue(f.value, fieldTypes.get(f.name), env),
      })),
    };
  });
  return {
    dataset: s.dataset ?? "default",
    path: s.raw ? "raw" : "domain",
    rows,
  };
}

/** Lower a seed field value, coercing a bare object literal written in a
 *  value-object-typed position (`contact: { email: … }`) into a value-object
 *  ctor call.  The seed grammar allows the unprefixed object form, but the
 *  backends construct value objects as classes — a plain object literal isn't
 *  assignable to the VO type (missing its derived getters / methods).  Other
 *  values lower normally.  Nested value objects coerce recursively. */
function lowerSeedValue(value: Expression, expected: TypeRef | undefined, env: Env): ExprIR {
  if (expected && isObjectLit(value)) {
    const t = lowerType(expected, env);
    if (t.kind === "valueobject") {
      const vo = findValueObjectByName(env, t.name);
      if (vo) return objectLitToVoCtor(value, vo, env);
    }
  }
  return lowerExpr(value, env);
}

/** Build a `value-object-ctor` call IR from a bare object literal and its
 *  target value object.  Args are emitted in the VO's declared field order
 *  (positional backends ignore `argNames`); an omitted entry — a skipped
 *  optional field like `Address.line2` — fills with `null` so the positional
 *  argument list stays aligned with the ctor signature. */
function objectLitToVoCtor(obj: ObjectLit, vo: ValueObject, env: Env): ExprIR {
  const props = vo.members.filter(isProperty) as Property[];
  const byName = new Map(obj.fields.map((f) => [f.name, f.value] as const));
  const args = props.map((p) => {
    const v = byName.get(p.name);
    return v ? lowerSeedValue(v, p.type, env) : lit("null", "null");
  });
  return {
    kind: "call",
    callKind: "value-object-ctor",
    name: vo.name,
    args,
    argNames: props.map((p) => p.name),
  };
}

/** Lower a `criterion <Name>(params) of <T> = <expr>` declaration to
 *  its IR record.  The predicate body is lowered in the criterion's own
 *  scope: an aggregate candidate binds `this` (and bare field names) to
 *  the candidate aggregate; parameters become `param` locals.  Use-sites
 *  do not read this body — they inline a freshly-substituted copy via
 *  `lower-expr.ts` — but it is retained for tooling, traceability and the
 *  forthcoming `Repo.findAll(criterion, …)` surface. */
function lowerCriterion(c: Criterion, env: Env): CriterionIR {
  const targetType = lowerType(c.target);
  let bodyEnv: Env = { ...env, locals: new Map() };
  if (targetType.kind === "entity") {
    const candidate = findEntityByName(env, targetType.name);
    if (candidate && isAggregate(candidate)) bodyEnv = inAggregate(bodyEnv, candidate);
  }
  // `of T as o` — the author's alias for the candidate; a bare `o` resolves as
  // `this` (read-path-architecture.md, "Aligned with criterion").
  if (c.alias) bodyEnv = { ...bodyEnv, candidateAlias: c.alias };
  for (const p of c.params) {
    bodyEnv = withLocal(bodyEnv, p.name, "param", lowerType(p.type));
  }
  return {
    name: c.name,
    params: c.params.map((p) => ({ name: p.name, type: lowerType(p.type) })),
    targetType,
    body: lowerExpr(c.body, bodyEnv),
  };
}

/** Lower a `retrieval <Name>(params) of <T> { where: … sort: … loads: … }`
 *  declaration to RetrievalIR.  The `where` predicate is lowered in the
 *  retrieval's own scope exactly like a criterion body (aggregate
 *  candidate binds `this` + bare field names; parameters become `param`
 *  locals), so it composes criteria and bare predicates the same way a
 *  `find … where` does.  `sort` / `loads` are structural paths, not
 *  expressions — lowered to segment lists.  No `page` (call-site only). */
function lowerRetrieval(r: Retrieval, env: Env): RetrievalIR {
  const targetType = lowerType(r.target);
  let bodyEnv: Env = { ...env, locals: new Map() };
  if (targetType.kind === "entity") {
    const candidate = findEntityByName(env, targetType.name);
    if (candidate && isAggregate(candidate)) bodyEnv = inAggregate(bodyEnv, candidate);
  }
  for (const p of r.params) {
    bodyEnv = withLocal(bodyEnv, p.name, "param", lowerType(p.type));
  }
  const sort: SortTermIR[] = r.sort.map((s) => ({
    path: lowerLoadPath(s.path),
    direction: (s.direction ?? "asc") as "asc" | "desc",
  }));
  const loadPlan: LoadPlanIR =
    r.loads.length > 0
      ? { kind: "explicit", paths: r.loads.map(lowerLoadPath) }
      : { kind: "whole" };
  return {
    name: r.name,
    params: r.params.map((p) => ({ name: p.name, type: lowerType(p.type) })),
    targetType,
    where: lowerExpr(r.where, bodyEnv),
    criterionRef: criterionRefOf(r.where, bodyEnv),
    sort,
    loadPlan,
  };
}

/** Lower a structural `LoadPath` AST node (`this.lines[].product`) to its
 *  candidate-rooted segment list (`this` already stripped by the grammar
 *  optionality). */
function lowerLoadPath(p: LoadPath): LoadSegmentIR[] {
  return p.segments.map((seg) => ({ name: seg.name, collection: !!seg.collection }));
}

function lowerEnum(e: EnumDecl): EnumIR {
  return { name: e.name, values: e.values.map((v) => v.name) };
}

function lowerValueObject(vo: ValueObject, env: Env): ValueObjectIR {
  const inner = inValueObject(env, vo);
  const props = vo.members.filter(isProperty) as Property[];
  return {
    name: vo.name,
    fields: props.map((p) => lowerField(p, inner)),
    derived: vo.members.filter(isDerivedProp).map((d) => lowerDerived(d, inner)),
    invariants: [
      ...vo.members.filter(isInvariant).map((i) => lowerInvariant(i, inner)),
      ...lowerPropertyChecks(props, inner),
    ],
    functions: vo.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner)),
    origin: originFor(vo),
  };
}

function lowerEvent(e: EventDecl): EventIR {
  return {
    name: e.name,
    fields: e.fields.map((f) => lowerField(f)),
    origin: originFor(e),
  };
}

/** Lower a `PayloadDecl` (payload / command / query / response / error) to the
 *  unified `PayloadIR`.  Two forms (the grammar `kind` token doubles as the IR
 *  discriminator in both):
 *    - record:  `payload X { … }`  → `fields`, no `variants`.
 *    - named union (P4):  `payload Foo = A | B`  → `variants` (each arm lowered
 *      as a type atom), empty `fields`.  The variant set is canonicalized only
 *      for identity/duplicate checks; the lowered list preserves source order. */
function lowerPayload(p: PayloadDecl, env?: Env): PayloadIR {
  if (p.variants.length > 0) {
    return {
      name: p.name,
      kind: p.kind as PayloadIR["kind"],
      fields: [],
      variants: p.variants.map((v) => lowerAtom(v, env)),
    };
  }
  // Pass `env` so a field's NamedType reference resolves against the context
  // (or root) namespace.  Macro-spliced records (M-T5.10 `scaffoldHandlers`
  // `response`/`command`/`query`) carry refs the Linker skips — a VO field
  // (`total: Money`) or a sibling `<Part>Response` containment would otherwise
  // collapse to `string`; the env-name fallback in `lowerBase` recovers the
  // real `valueObject`/`entity` type (crudish-param precedent).
  return {
    name: p.name,
    kind: p.kind as PayloadIR["kind"],
    fields: p.fields.map((f) => lowerField(f, env)),
  };
}

/** Project a lowered `event` into the unified payload view as a
 *  `kind: "event"` payload (payload-transport-layer.md P1 — "event is a
 *  payload subtype").  Shares the underlying `FieldIR[]`; no copy needed
 *  since both views are read-only downstream. */
function eventToPayload(e: EventIR): PayloadIR {
  return { name: e.name, kind: "event", fields: e.fields };
}

function lowerAggregate(
  agg: Aggregate,
  env: Env,
  contextLevelCaps: ContextLevelCapabilities = EMPTY_CONTEXT_CAPABILITIES,
): AggregateIR {
  const idValueType = "guid" as IdValueType;
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
  const uniqueKeys = agg.members.filter(isUnique).map(lowerUnique);
  const functions = agg.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner));
  const operations = (agg.members.filter(isOperation) as Operation[]).map((op) =>
    lowerOperation(op, inner),
  );
  // Lifecycle actions — kept in their own arrays so `operations`
  // (consumed by every existing route/OpenAPI/page-object emitter) stays
  // mutate-only until per-kind emission lands (Phase 3).
  const creates = (agg.members.filter(isCreate) as Create[]).map((c) => lowerCreate(c, inner));
  const destroys = (agg.members.filter(isDestroy) as Destroy[]).map((d) => lowerDestroy(d, inner));
  const canonicalCreate = creates.find((c) => c.canonical) ?? null;
  const canonicalDestroy = destroys.find((d) => d.canonical) ?? null;
  const appliers = (agg.members.filter(isApply) as Apply[]).map((a) => lowerApply(a, inner));
  const tests: TestIR[] = [];
  for (const m of agg.members) {
    if (isTestBlock(m)) tests.push(lowerTest(m, inner));
  }
  // Capability source nodes — read structurally from agg.members,
  // concatenated with anything propagated from the enclosing context.
  // Context-level capabilities lower in the context's env (which
  // doesn't bind `this` to any aggregate), then re-bind here.
  const filters = collectFilters(agg, inner, contextLevelCaps);
  const stamps = collectStamps(agg, inner, contextLevelCaps);
  const capabilities = collectCapabilities(agg);
  return {
    name: agg.name,
    idValueType,
    fields: props.map((p) => lowerField(p, inner)),
    contains: containments,
    derived,
    invariants,
    uniqueKeys: uniqueKeys.length > 0 ? uniqueKeys : undefined,
    functions,
    operations,
    creates,
    destroys,
    canonicalCreate,
    canonicalDestroy,
    parts,
    tests,
    contextFilters: filters.length > 0 ? filters.map((f) => f.predicate) : undefined,
    contextFilterRefs: filters.some((f) => f.criterionRef)
      ? filters.map((f) => f.criterionRef)
      : undefined,
    contextFilterOrigins: filters.some((f) => f.capabilityOrigin)
      ? filters.map((f) => f.capabilityOrigin)
      : undefined,
    contextStamps: stamps.length > 0 ? stamps : undefined,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
    persistedAs: agg.persistedAs as "state" | "eventLog" | undefined,
    savingShape: (agg.shape as import("../types/loom-ir.js").SavingShape | undefined) ?? undefined,
    appliers: appliers.length > 0 ? appliers : undefined,
    isAbstract: agg.isAbstract ? true : undefined,
    crossTenant: agg.crossTenant ? true : undefined,
    extendsAggregate: agg.superType?.ref?.name ?? agg.superType?.$refText ?? undefined,
    inheritanceUsing:
      (agg.inheritanceUsing as import("../types/loom-ir.js").InheritanceLayout | undefined) ??
      undefined,
    origin: originFor(agg),
  };
}

function lowerTest(block: TestBlock, env: Env): TestIR {
  let inner = env;
  const statements: TestStmtIR[] = [];
  for (const s of block.body) {
    if (isExpectStmt(s)) {
      statements.push(expectStmtIR(lowerExpr(s.expr, inner), cstText(s.expr)));
    } else {
      const r = lowerStatement(s as Statement, inner);
      statements.push(r.stmt);
      inner = r.envAfter;
    }
  }
  return { name: block.name, statements, verifiesTestCase: block.verifies?.ref?.name };
}

/** Build the `TestStmtIR` for an `expect(...)` test statement.  The
 *  method-based throw assertion `expect(call).toThrow(N?)` is recognised here
 *  and rewritten into the platform-neutral `expect-throws` IR node — so every
 *  backend renders it as a throw exactly as before — with the optional integer
 *  pinning the rejected HTTP status in an e2e api body.  Every other
 *  `expect(...)` carries a value/locator matcher (`toBe`, `toHaveText`, …); a
 *  bare-boolean `expect` is rejected by the validator (`checkExpectMatcher`). */
function expectStmtIR(e: ExprIR, source: string): TestStmtIR {
  if (e.kind === "method-call" && e.isIntrinsicMatcher && e.member === "toThrow") {
    const inner = e.receiver.kind === "paren" ? e.receiver.inner : e.receiver;
    const arg = e.args[0];
    const status =
      arg && arg.kind === "literal" && arg.lit === "int" ? Number(arg.value) : undefined;
    return status != null
      ? { kind: "expect-throws", expr: inner, source, status }
      : { kind: "expect-throws", expr: inner, source };
  }
  return { kind: "expect", expr: e, source };
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
      // The `requires` gate is lowered in the BARE context env (not
      // `inAggregate`, no params), so `currentUser` resolves but the source
      // row's fields do not — the gate decides endpoint access before any row
      // exists, so it may reference only the principal (+ constants).
      // Referencing an aggregate field is then a name-resolution error, exactly
      // the restriction we want (the read-side twin of the view gate).
      const gateEnv = newEnv(repo.$container as BoundedContext, user, modulePermissions);
      return {
        name: f.name,
        params: f.params.map((p) => ({ name: p.name, type: lowerType(p.type) })),
        returnType: lowerType(f.returnType),
        requires: f.gate ? lowerExpr(f.gate, gateEnv) : undefined,
        filter: f.filter ? lowerExpr(f.filter, env) : undefined,
        criterionRef: criterionRefOf(f.filter, env),
        ...resolveBypass(f),
      };
    }),
    origin: originFor(repo),
  };
}
