import { enrichLoomModel } from "../../ir/enrichments.js";
import type { BoundedContextIR, DeployableIR, RepositoryIR, SystemIR } from "../../ir/loom-ir.js";
import { lowerModel } from "../../ir/lower.js";
import type { Model } from "../../language/generated/ast.js";
import { plural } from "../../util/naming.js";
import { generateReactForContexts } from "../react/index.js";
import { emitAuthFiles } from "./auth-emit.js";
import { emitCqrs } from "./cqrs-emit.js";
import { renderDomainLog, renderDomainLogBehavior } from "./emit/domain-log.js";
import { buildFindBodies } from "./find-emit.js";
import {
  renderCommon,
  renderConfiguration,
  renderCsproj,
  renderDbContext,
  renderDockerfile,
  renderDockerignore,
  renderEntity,
  renderEnum,
  renderEvent,
  renderExceptionFilter,
  renderIDomainEvent,
  renderId,
  renderNoopDispatcher,
  renderProgram,
  renderRepositoryImpl,
  renderRepositoryInterface,
  renderTestCsproj,
  renderTestsFile,
  renderValueObject,
} from "./emit.js";
import { hasAnyWireValidator, renderValidationBehavior } from "./validator-emit.js";
import { emitViews } from "./view-emit.js";
import { emitWorkflows } from "./workflow-emit.js";

// ---------------------------------------------------------------------------
// .NET backend entry point.
//
// `generateDotnet(model)` returns a Map of relative paths → file
// contents.  Per bounded context it produces:
//
//   Domain/Ids/                    — record-struct ID types
//   Domain/Enums/                  — enums
//   Domain/ValueObjects/           — immutable record-classes
//   Domain/Events/                 — IDomainEvent + per-event records
//   Domain/Common/                 — DomainException, IDomainEventDispatcher
//   Domain/<Plural>/               — aggregate root, parts, repo interface
//   Application/<Plural>/Requests/ — wire-shape request DTOs
//   Application/<Plural>/Responses/— wire-shape response DTOs
//   Application/<Plural>/Commands/ — Mediator commands + handlers
//   Application/<Plural>/Queries/  — Mediator queries + handlers
//   Infrastructure/Persistence/    — AppDbContext + EF configurations
//   Infrastructure/Repositories/   — EF-backed repositories
//   Infrastructure/Events/         — NoopDomainEventDispatcher
//   Api/                           — controllers + DomainExceptionFilter
//   Tests/<Plural>/                — xUnit test classes (when `test` blocks
//                                    are declared in the .ddd source)
//   Program.cs, <ns>.csproj        — hosting entry + project file
// ---------------------------------------------------------------------------

/**
 * Legacy entry: lowers the whole model and emits one project from each
 * top-level bounded context (used by `ddd generate dotnet <file>`).
 */
export function generateDotnet(
  model: Model,
  options: { emitTrace?: boolean } = {},
): Map<string, string> {
  // See generator/typescript/index.ts:generateTypeScript for the
  // lowering + enrichment two-step.
  const loom = enrichLoomModel(lowerModel(model));
  return generateDotnetForContexts(loom.contexts, undefined, undefined, options);
}

/**
 * System-mode entry: emits a single .NET project from a pre-filtered
 * list of contexts under the chosen namespace.  When emitting for a
 * deployable, the namespace is the deployable name.  When called with
 * a single context, the namespace is that context's name (legacy).
 *
 * `system` (when present) carries the system-wide user-claim shape +
 * the deployable's auth setting — the entry threads them into the
 * Auth/* file emitter and the Program.cs middleware mount.  Loose
 * top-level contexts (no enclosing system) skip that path entirely.
 */
export function generateDotnetForContexts(
  contexts: BoundedContextIR[],
  namespace?: string,
  system?: { deployable: DeployableIR; sys: SystemIR },
  options: { emitTrace?: boolean } = {},
): Map<string, string> {
  const out = new Map<string, string>();
  const emitTrace = !!options.emitTrace;
  if (namespace !== undefined) {
    // Single project containing all the given contexts under one namespace.
    emitProjectFromContexts(contexts, namespace, out, system, emitTrace);
  } else {
    for (const ctx of contexts) {
      emitContext(ctx, ctx.name, out, emitTrace);
    }
  }
  return out;
}

function emitProjectFromContexts(
  contexts: BoundedContextIR[],
  ns: string,
  out: Map<string, string>,
  system?: { deployable: DeployableIR; sys: SystemIR },
  emitTrace = false,
): void {
  // Fullstack-dotnet branch — when the deployable declares a `ui:`
  // mount, the .NET project hosts an embedded React SPA from
  // `wwwroot/`.  Controllers move to `/api/*` so the SPA's path
  // namespace stays free for client-side routing; `Program.cs` adds
  // `UseStaticFiles` + `MapFallbackToFile`; the Dockerfile becomes
  // multi-stage and copies the SPA bundle into `wwwroot/`.  See
  // `src/platform/dotnet.ts:mountsUi` + `src/ir/lower.ts` for the
  // upstream wiring.
  const hasEmbeddedSpa = !!system?.deployable.uiName;
  const routePrefix = hasEmbeddedSpa ? "api/" : undefined;
  // Common files written once per project, regardless of how many
  // contexts contribute their domain code.
  emitCommon(ns, out);
  emitDispatcher(ns, out);
  out.set("Domain/Events/IDomainEvent.cs", renderIDomainEvent(ns));
  // Each context contributes its enums / VOs / events / aggregates.
  for (const ctx of contexts) {
    emitIds(ctx, ns, out);
    emitEnums(ctx, ns, out);
    emitValueObjects(ctx, ns, out);
    for (const ev of ctx.events) {
      out.set(`Domain/Events/${ev.name}.cs`, renderEvent(ev, ns));
    }
    for (const agg of ctx.aggregates) {
      emitAggregate(agg, ctx, ns, out, routePrefix, emitTrace);
    }
    emitWorkflows(ctx, ns, out, { routePrefix });
    emitViews(ctx, ns, out, { routePrefix });
  }
  // DbContext + project shell are emitted once, with all aggregates
  // collected from the union of contexts.
  const merged: BoundedContextIR = {
    name: ns,
    enums: contexts.flatMap((c) => c.enums),
    valueObjects: contexts.flatMap((c) => c.valueObjects),
    events: contexts.flatMap((c) => c.events),
    aggregates: contexts.flatMap((c) => c.aggregates),
    repositories: contexts.flatMap((c) => c.repositories),
    workflows: contexts.flatMap((c) => c.workflows),
    views: contexts.flatMap((c) => c.views),
  };
  out.set("Infrastructure/Persistence/AppDbContext.cs", renderDbContext(merged, ns));
  // FluentValidation pipeline — emit the generic
  // ValidationBehavior + the csproj package ref + the
  // Program.cs registrations only when at least one aggregate
  // has wire-translatable invariants / preconditions.  Computed
  // before the exception filter render so its FluentValidation
  // arm is gated on the same flag.
  const usesValidators = merged.aggregates.some(hasAnyWireValidator);
  out.set("Api/DomainExceptionFilter.cs", renderExceptionFilter(ns, { usesValidators }));
  // Auth files — emitted only when the deployable opts in
  // via `auth: required` AND the system declares a user block (the
  // validator already rejects the half-state).  When emitted, the
  // Program.cs adopts the middleware mount + DI registrations.
  const authRequired = !!(system?.deployable.auth?.required && system.sys.user);
  if (authRequired && system?.sys) {
    emitAuthFiles(system.sys, ns, out);
  }
  if (usesValidators) {
    out.set("Application/Common/ValidationBehavior.cs", renderValidationBehavior(ns));
  }
  emitProject(merged, ns, out, {
    authRequired,
    usesValidators,
    hasEmbeddedSpa,
    emitTrace,
  });
  emitTestProject(merged, ns, out);
  // Fullstack mode — generate the React project under ClientApp/.
  // The SPA hits `/api/*` on its own origin (apiBaseUrl: ""), so
  // `api/config.ts` produces `fetch("/api/...")`-shaped calls that
  // line up with the .NET controllers' new route prefix.  Filter
  // out files the .NET project owns (Dockerfile, .dockerignore,
  // certs, e2e suite — the .NET project ships its own equivalents
  // at the root).
  if (hasEmbeddedSpa && system) {
    const spaFiles = generateReactForContexts(contexts, system.sys, system.deployable, {
      apiBaseUrl: "/api",
      pathPrefix: "ClientApp/",
    });
    for (const [path, content] of spaFiles) {
      // The React generator's pack also ships `Dockerfile` /
      // `.dockerignore` / `certs/.gitkeep` at the project root —
      // duplicates of the .NET project's equivalents and unused in
      // fullstack mode (the .NET Dockerfile multi-stage owns the
      // SPA build).  Skip them so the file map stays clean.  The
      // e2e harness lives outside ClientApp/ in fullstack mode (or
      // not at all — users own that surface).
      if (
        path === "ClientApp/Dockerfile" ||
        path === "ClientApp/.dockerignore" ||
        path === "ClientApp/certs/.gitkeep" ||
        path.startsWith("ClientApp/e2e/")
      )
        continue;
      out.set(path, content);
    }
    out.set("ClientApp/.gitignore", "node_modules\ndist\n");
  }
}

function emitContext(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
  emitTrace = false,
): void {
  emitIds(ctx, ns, out);
  emitEnums(ctx, ns, out);
  emitValueObjects(ctx, ns, out);
  emitEvents(ctx, ns, out);
  emitCommon(ns, out);
  emitDispatcher(ns, out);
  for (const agg of ctx.aggregates) {
    emitAggregate(agg, ctx, ns, out, undefined, emitTrace);
  }
  emitWorkflows(ctx, ns, out);
  emitViews(ctx, ns, out);
  // Same FluentValidation gate as the system path — drives the
  // pipeline behavior emit + csproj + Program.cs registration +
  // the DomainExceptionFilter arm.
  const usesValidators = ctx.aggregates.some(hasAnyWireValidator);
  emitInfrastructure(ctx, ns, out, usesValidators);
  if (usesValidators) {
    out.set("Application/Common/ValidationBehavior.cs", renderValidationBehavior(ns));
  }
  emitProject(ctx, ns, out, { usesValidators, emitTrace });
  emitTestProject(ctx, ns, out);
}

// ---------------------------------------------------------------------------
// Shared / per-context emission helpers
// ---------------------------------------------------------------------------

function emitIds(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  for (const agg of ctx.aggregates) {
    out.set(`Domain/Ids/${agg.name}Id.cs`, renderId(agg.name, agg.idValueType, ns));
    for (const part of agg.parts) {
      out.set(`Domain/Ids/${part.name}Id.cs`, renderId(part.name, agg.idValueType, ns));
    }
  }
}

function emitEnums(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  // Always emit a marker so `using <ns>.Domain.Enums;` resolves even
  // when the project has no enums in scope (deployables that include
  // only modules without enums would otherwise fail to compile).
  out.set(
    "Domain/Enums/_namespace.cs",
    `// Auto-generated namespace marker.\nnamespace ${ns}.Domain.Enums;\n`,
  );
  for (const e of ctx.enums) {
    out.set(`Domain/Enums/${e.name}.cs`, renderEnum(e, ns));
  }
}

function emitValueObjects(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  out.set(
    "Domain/ValueObjects/_namespace.cs",
    `// Auto-generated namespace marker.\nnamespace ${ns}.Domain.ValueObjects;\n`,
  );
  for (const vo of ctx.valueObjects) {
    out.set(`Domain/ValueObjects/${vo.name}.cs`, renderValueObject(vo, ns));
  }
}

function emitEvents(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  out.set("Domain/Events/IDomainEvent.cs", renderIDomainEvent(ns));
  for (const ev of ctx.events) {
    out.set(`Domain/Events/${ev.name}.cs`, renderEvent(ev, ns));
  }
}

function emitCommon(ns: string, out: Map<string, string>): void {
  out.set("Domain/Common/DomainException.cs", renderCommon(ns));
}

function emitDispatcher(ns: string, out: Map<string, string>): void {
  out.set("Infrastructure/Events/NoopDomainEventDispatcher.cs", renderNoopDispatcher(ns));
}

// ---------------------------------------------------------------------------
// Per-aggregate emission
// ---------------------------------------------------------------------------

function emitAggregate(
  agg: import("../../ir/loom-ir.js").AggregateIR,
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
  routePrefix?: string,
  emitTrace = false,
): void {
  const aggFolder = plural(agg.name);
  const repo = findRepoFor(ctx, agg.name);

  for (const part of agg.parts) {
    out.set(
      `Domain/${aggFolder}/${part.name}.cs`,
      renderEntity(part, false, ns, agg.name, emitTrace),
    );
  }
  out.set(
    `Domain/${aggFolder}/${agg.name}.cs`,
    renderEntity(agg, true, ns, agg.name, emitTrace),
  );
  // Views whose source is this aggregate become parameterless,
  // filtered, list-returning finds on the repository.  Synthesised
  // here so all the existing find emission paths (interface,
  // implementation, EF Core configuration) pick them up uniformly.
  const repoWithViews = mergeViewsAsFinds(agg, repo, ctx);
  out.set(
    `Domain/${aggFolder}/I${agg.name}Repository.cs`,
    renderRepositoryInterface(agg, repoWithViews, ns),
  );
  out.set(
    `Infrastructure/Repositories/${agg.name}Repository.cs`,
    renderRepositoryImpl(agg, repoWithViews, ns, buildFindBodies(agg, repoWithViews), emitTrace),
  );
  out.set(
    `Infrastructure/Persistence/Configurations/${agg.name}Configuration.cs`,
    renderConfiguration(agg, ns, ctx),
  );
  emitCqrs(agg, repo, ctx, ns, out, { routePrefix });
  const testsFile = renderTestsFile(agg, ctx, ns);
  if (testsFile) {
    out.set(`Tests/${ns}.Tests/${aggFolder}/${agg.name}Tests.cs`, testsFile);
  }
}

// ---------------------------------------------------------------------------
// Infrastructure & project shell
// ---------------------------------------------------------------------------

function emitInfrastructure(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
  usesValidators: boolean,
): void {
  out.set("Infrastructure/Persistence/AppDbContext.cs", renderDbContext(ctx, ns));
  out.set("Api/DomainExceptionFilter.cs", renderExceptionFilter(ns, { usesValidators }));
}

function emitProject(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
  options?: {
    authRequired?: boolean;
    usesValidators?: boolean;
    hasEmbeddedSpa?: boolean;
    emitTrace?: boolean;
  },
): void {
  const hasExtern = ctx.aggregates.some((a) => a.operations.some((o) => o.extern));
  const usesValidators = !!options?.usesValidators;
  const hasEmbeddedSpa = !!options?.hasEmbeddedSpa;
  const emitTrace = !!options?.emitTrace;
  out.set(
    "Program.cs",
    renderProgram(ctx, ns, {
      authRequired: !!options?.authRequired,
      usesValidators,
      hasEmbeddedSpa,
      emitTrace,
    }),
  );
  out.set(`${ns}.csproj`, renderCsproj(ns, hasExtern, usesValidators));
  out.set("Dockerfile", renderDockerfile(ns, { hasEmbeddedSpa }));
  out.set(".dockerignore", renderDockerignore());
  out.set("certs/.gitkeep", "");
  if (emitTrace) {
    // Domain-layer logger plumbing — emitted only on --trace so the
    // default artefact stays free of an AsyncLocal accessor + the
    // pipeline behavior that sets it.
    out.set("Domain/Common/DomainLog.cs", renderDomainLog(ns));
    out.set("Application/Common/DomainLogBehavior.cs", renderDomainLogBehavior(ns));
  }
}

function emitTestProject(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  // Only emit a test csproj when at least one aggregate declares a `test`
  // block — otherwise the project would have nothing to compile.
  const anyTests = ctx.aggregates.some((a) => a.tests.length > 0);
  if (!anyTests) return;
  out.set(`Tests/${ns}.Tests/${ns}.Tests.csproj`, renderTestCsproj(ns));
}

function findRepoFor(ctx: BoundedContextIR, name: string): RepositoryIR | undefined {
  return ctx.repositories.find((r) => r.aggregateName === name);
}

/** Synthesise a repository that includes the user-declared finds
 *  PLUS one parameterless filtered find per matching view.  Lets
 *  every downstream emitter (interface, implementation, find-emit,
 *  CQRS) treat views uniformly with declared finds. */
function mergeViewsAsFinds(
  agg: import("../../ir/loom-ir.js").AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): RepositoryIR | undefined {
  const matching = ctx.views.filter((v) => v.aggregateName === agg.name);
  if (matching.length === 0) return repo;
  const arrayReturn: import("../../ir/loom-ir.js").TypeIR = {
    kind: "array",
    element: { kind: "entity", name: agg.name },
  };
  const synthesised = matching.map((v) => ({
    name: v.name,
    params: [],
    returnType: arrayReturn,
    filter: v.filter,
  }));
  if (!repo) {
    return {
      name: `${agg.name}Repository`,
      aggregateName: agg.name,
      finds: synthesised,
    };
  }
  return { ...repo, finds: [...repo.finds, ...synthesised] };
}
