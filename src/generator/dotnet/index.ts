import type { Model } from "../../language/generated/ast.js";
import { lowerModel } from "../../ir/lower.js";
import { enrichLoomModel } from "../../ir/enrichments.js";
import type {
  BoundedContextIR,
  DeployableIR,
  RepositoryIR,
  SystemIR,
} from "../../ir/loom-ir.js";
import { plural } from "../../util/naming.js";
import { emitAuthFiles } from "./auth-emit.js";
import { emitCqrs } from "./cqrs-emit.js";
import { emitWorkflows } from "./workflow-emit.js";
import { emitViews } from "./view-emit.js";
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
  renderId,
  renderIDomainEvent,
  renderNoopDispatcher,
  renderProgram,
  renderRepositoryImpl,
  renderRepositoryInterface,
  renderTestCsproj,
  renderTestsFile,
  renderValueObject,
} from "./templates.js";

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
export function generateDotnet(model: Model): Map<string, string> {
  // See generator/typescript/index.ts:generateTypeScript for the
  // lowering + enrichment two-step.
  const loom = enrichLoomModel(lowerModel(model));
  return generateDotnetForContexts(loom.contexts);
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
): Map<string, string> {
  const out = new Map<string, string>();
  if (namespace !== undefined) {
    // Single project containing all the given contexts under one namespace.
    emitProjectFromContexts(contexts, namespace, out, system);
  } else {
    for (const ctx of contexts) {
      emitContext(ctx, ctx.name, out);
    }
  }
  return out;
}

function emitProjectFromContexts(
  contexts: BoundedContextIR[],
  ns: string,
  out: Map<string, string>,
  system?: { deployable: DeployableIR; sys: SystemIR },
): void {
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
      emitAggregate(agg, ctx, ns, out);
    }
    emitWorkflows(ctx, ns, out);
    emitViews(ctx, ns, out);
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
  out.set("Api/DomainExceptionFilter.cs", renderExceptionFilter(ns));
  // Slice 1A auth files — emitted only when the deployable opts in
  // via `auth: required` AND the system declares a user block (the
  // validator already rejects the half-state).  When emitted, the
  // Program.cs adopts the middleware mount + DI registrations.
  const authRequired = !!(
    system?.deployable.auth?.required && system.sys.user
  );
  if (authRequired && system?.sys) {
    emitAuthFiles(system.sys, ns, out);
  }
  emitProject(merged, ns, out, { authRequired });
  emitTestProject(merged, ns, out);
}

function emitContext(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  emitIds(ctx, ns, out);
  emitEnums(ctx, ns, out);
  emitValueObjects(ctx, ns, out);
  emitEvents(ctx, ns, out);
  emitCommon(ns, out);
  emitDispatcher(ns, out);
  for (const agg of ctx.aggregates) {
    emitAggregate(agg, ctx, ns, out);
  }
  emitWorkflows(ctx, ns, out);
  emitViews(ctx, ns, out);
  emitInfrastructure(ctx, ns, out);
  emitProject(ctx, ns, out);
  emitTestProject(ctx, ns, out);
}

// ---------------------------------------------------------------------------
// Shared / per-context emission helpers
// ---------------------------------------------------------------------------

function emitIds(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  for (const agg of ctx.aggregates) {
    out.set(`Domain/Ids/${agg.name}Id.cs`, renderId(agg.name, agg.idValueType, ns));
    for (const part of agg.parts) {
      out.set(
        `Domain/Ids/${part.name}Id.cs`,
        renderId(part.name, agg.idValueType, ns),
      );
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

function emitValueObjects(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  out.set(
    "Domain/ValueObjects/_namespace.cs",
    `// Auto-generated namespace marker.\nnamespace ${ns}.Domain.ValueObjects;\n`,
  );
  for (const vo of ctx.valueObjects) {
    out.set(`Domain/ValueObjects/${vo.name}.cs`, renderValueObject(vo, ns));
  }
}

function emitEvents(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  out.set("Domain/Events/IDomainEvent.cs", renderIDomainEvent(ns));
  for (const ev of ctx.events) {
    out.set(`Domain/Events/${ev.name}.cs`, renderEvent(ev, ns));
  }
}

function emitCommon(ns: string, out: Map<string, string>): void {
  out.set("Domain/Common/DomainException.cs", renderCommon(ns));
}

function emitDispatcher(ns: string, out: Map<string, string>): void {
  out.set(
    "Infrastructure/Events/NoopDomainEventDispatcher.cs",
    renderNoopDispatcher(ns),
  );
}

// ---------------------------------------------------------------------------
// Per-aggregate emission
// ---------------------------------------------------------------------------

function emitAggregate(
  agg: import("../../ir/loom-ir.js").AggregateIR,
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  const aggFolder = plural(agg.name);
  const repo = findRepoFor(ctx, agg.name);

  for (const part of agg.parts) {
    out.set(
      `Domain/${aggFolder}/${part.name}.cs`,
      renderEntity(part, false, ns, agg.name),
    );
  }
  out.set(`Domain/${aggFolder}/${agg.name}.cs`, renderEntity(agg, true, ns, agg.name));
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
    renderRepositoryImpl(agg, repoWithViews, ns, buildFindBodies(agg, repoWithViews)),
  );
  out.set(
    `Infrastructure/Persistence/Configurations/${agg.name}Configuration.cs`,
    renderConfiguration(agg, ns, ctx),
  );
  emitCqrs(agg, repo, ctx, ns, out);
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
): void {
  out.set("Infrastructure/Persistence/AppDbContext.cs", renderDbContext(ctx, ns));
  out.set("Api/DomainExceptionFilter.cs", renderExceptionFilter(ns));
}

function emitProject(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
  options?: { authRequired?: boolean },
): void {
  const hasExtern = ctx.aggregates.some((a) =>
    a.operations.some((o) => o.extern),
  );
  out.set(
    "Program.cs",
    renderProgram(ctx, ns, { authRequired: !!options?.authRequired }),
  );
  out.set(`${ns}.csproj`, renderCsproj(ns, hasExtern));
  out.set("Dockerfile", renderDockerfile(ns));
  out.set(".dockerignore", renderDockerignore());
  out.set("certs/.gitkeep", "");
}

function emitTestProject(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  // Only emit a test csproj when at least one aggregate declares a `test`
  // block — otherwise the project would have nothing to compile.
  const anyTests = ctx.aggregates.some((a) => a.tests.length > 0);
  if (!anyTests) return;
  out.set(`Tests/${ns}.Tests/${ns}.Tests.csproj`, renderTestCsproj(ns));
}

function findRepoFor(
  ctx: BoundedContextIR,
  name: string,
): RepositoryIR | undefined {
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
