// ---------------------------------------------------------------------------
// byLayer — the real LayoutAdapter for the dotnet platform.  Captures the
// path conventions the existing dotnet emitter spells out inline in
// `../index.ts` and `../cqrs-emit.ts`.  Today the orchestrator hard-codes
// these paths at each emit-fn call site; this adapter exposes them as a
// single pure `pathFor()` so the orchestrator rewire (later F5 slice) can
// drop the inline strings and dispatch through the adapter.
//
// The byLayer convention groups files by ARCHITECTURAL LAYER first:
//
//   Domain/                      — IDs, enums, value objects, events,
//                                  aggregate roots + parts, derived
//                                  helpers (DomainException,
//                                  IDomainEvent)
//   Application/                 — request / response DTOs, MediatR
//                                  commands + queries + handlers,
//                                  validation behaviors
//   Infrastructure/              — EF Core DbContext + configurations,
//                                  repositories, join-table entities,
//                                  domain-event dispatcher,
//                                  AuditableInterceptor
//   Api/                         — controllers + DomainExceptionFilter
//   Tests/<Ns>.Tests/            — xUnit project + per-aggregate test
//                                  classes
//   <root>/                      — Program.cs, <Ns>.csproj, Dockerfile,
//                                  Middleware/, certs/, ...
//
// `byFeature` (the real sibling adapter, `./by-feature-layout.ts`)
// colocates one aggregate's application + API artifacts under
// `Features/<Plural>/` — same artifacts, different on-disk arrangement
// (plus a post-emit namespace rewrite, `../layout-namespaces.ts`).
// ---------------------------------------------------------------------------

import { plural, upperFirst } from "../../../util/naming.js";
import type { EmitCtx, EmittedArtifact, LayoutAdapter } from "../../_adapters/index.js";

/** Categories every dotnet artifact carries.  The emitter at each call
 *  site sets `category` so the layout adapter can route consistently.
 *  Adding a new file kind = add a new category arm here + a category
 *  string at the emit site. */
export type DotnetArtifactCategory =
  // Domain/
  | "id"
  | "enum"
  | "valueobject"
  | "event"
  | "domain-common" // DomainException, IDomainEvent
  | "entity" // aggregate root + parts (under Domain/<Plural>/)
  | "repository-interface" // I<Agg>Repository.cs (under Domain/<Plural>/)
  // Application/
  | "request-dto"
  | "response-dto"
  | "command" // includes per-op + create
  | "command-handler"
  | "command-validator" // FluentValidation class colocated with commands
  | "query" // includes get-by-id + per-find
  | "query-handler"
  | "validation-behavior"
  | "execution-context-behavior"
  | "extern-handler-interface"
  | "extern-handler-stub"
  // Workflow artifacts live under per-context shared folders,
  // not under any single aggregate's plural folder.
  | "workflow-request"
  | "workflow-command"
  | "workflow-handler"
  // Infrastructure/
  | "dbcontext"
  | "ef-configuration"
  | "join-entity"
  | "join-entity-configuration"
  | "repository-impl"
  | "document-poco" // Infrastructure/Persistence/Documents/<Agg>Document.cs (shape(document))
  | "event-record-poco" // Infrastructure/Persistence/Events/<Agg>EventRecord.cs (persistedAs(eventLog))
  | "event-dispatcher"
  | "auditable-interceptor"
  | "domain-log"
  // Api/
  | "controller"
  | "exception-filter"
  // Tests/
  | "test-csproj"
  | "test-class"
  // <root>/
  | "program"
  | "csproj"
  | "dockerfile"
  | "dockerignore"
  | "request-logging-middleware"
  | "certs-marker"
  | "namespace-marker" // empty marker files like Domain/Enums/_namespace.cs
  // Migrations live alongside Infrastructure/Migrations/ (per-deployable).
  | "migration"
  | "migrations-config";

/** Extension to the shared EmittedArtifact: a typed `category` and the
 *  optional aggregate / context association the path adapter needs to
 *  route (e.g. an entity's folder is its aggregate's plural name). */
export interface DotnetArtifact extends EmittedArtifact {
  category: DotnetArtifactCategory;
  /** Name of the aggregate the artifact belongs to.  Required for the
   *  per-aggregate categories (`entity`, `repository-impl`, etc.) so
   *  the folder can pick up the plural form. */
  aggregateName?: string;
  /** Namespace (== deployable name).  Tests are placed under
   *  `Tests/<Ns>.Tests/<Plural>/`, so the test-class category needs
   *  the namespace too. */
  ns?: string;
}

/** Folder under Domain/ that holds the aggregate's root + part entity
 *  files.  `plural("Order") === "Orders"`.  Single source of truth for
 *  every per-aggregate dotnet category. */
const aggFolder = (name: string): string => plural(upperFirst(name));

function pathForCategory(artifact: DotnetArtifact): string {
  const cat = artifact.category;
  const name = artifact.name;
  const agg = artifact.aggregateName;
  const ns = artifact.ns;
  switch (cat) {
    case "id":
      return `Domain/Ids/${name}`;
    case "enum":
      return `Domain/Enums/${name}`;
    case "valueobject":
      return `Domain/ValueObjects/${name}`;
    case "event":
      return `Domain/Events/${name}`;
    case "domain-common":
      return `Domain/Common/${name}`;
    case "entity":
      if (!agg)
        throw new Error(`byLayer.pathFor: 'entity' artifact missing aggregateName (${name})`);
      return `Domain/${aggFolder(agg)}/${name}`;
    case "repository-interface":
      if (!agg)
        throw new Error(
          `byLayer.pathFor: 'repository-interface' artifact missing aggregateName (${name})`,
        );
      return `Domain/${aggFolder(agg)}/${name}`;
    case "request-dto":
      if (!agg) throw new Error(`byLayer.pathFor: 'request-dto' missing aggregateName (${name})`);
      return `Application/${aggFolder(agg)}/Requests/${name}`;
    case "response-dto":
      if (!agg) throw new Error(`byLayer.pathFor: 'response-dto' missing aggregateName (${name})`);
      return `Application/${aggFolder(agg)}/Responses/${name}`;
    case "command":
    case "command-handler":
    case "command-validator":
      if (!agg) throw new Error(`byLayer.pathFor: '${cat}' missing aggregateName (${name})`);
      return `Application/${aggFolder(agg)}/Commands/${name}`;
    case "query":
    case "query-handler":
      if (!agg) throw new Error(`byLayer.pathFor: '${cat}' missing aggregateName (${name})`);
      return `Application/${aggFolder(agg)}/Queries/${name}`;
    case "workflow-request":
    case "workflow-command":
    case "workflow-handler":
      // Workflows live outside any single aggregate's plural folder.
      return `Application/Workflows/${name}`;
    case "validation-behavior":
      return `Application/Common/${name}`;
    case "execution-context-behavior":
      return `Application/Common/${name}`;
    case "extern-handler-interface":
    case "extern-handler-stub":
      if (!agg) throw new Error(`byLayer.pathFor: '${cat}' missing aggregateName (${name})`);
      return `Application/${aggFolder(agg)}/Handlers/${name}`;
    case "dbcontext":
      return `Infrastructure/Persistence/${name}`;
    case "ef-configuration":
      return `Infrastructure/Persistence/Configurations/${name}`;
    case "join-entity":
      return `Infrastructure/Persistence/JoinTables/${name}`;
    case "join-entity-configuration":
      return `Infrastructure/Persistence/Configurations/${name}`;
    case "repository-impl":
      return `Infrastructure/Repositories/${name}`;
    case "document-poco":
      return `Infrastructure/Persistence/Documents/${name}`;
    case "event-record-poco":
      return `Infrastructure/Persistence/Events/${name}`;
    case "event-dispatcher":
      return `Infrastructure/Events/${name}`;
    case "auditable-interceptor":
      return `Infrastructure/Persistence/${name}`;
    case "domain-log":
      return `Domain/Common/${name}`;
    case "controller":
      return `Api/${name}`;
    case "exception-filter":
      return `Api/${name}`;
    case "test-csproj":
      if (!ns) throw new Error("byLayer.pathFor: 'test-csproj' missing ns");
      return `Tests/${ns}.Tests/${name}`;
    case "test-class":
      if (!ns || !agg)
        throw new Error(`byLayer.pathFor: 'test-class' missing ns / aggregateName (${name})`);
      return `Tests/${ns}.Tests/${aggFolder(agg)}/${name}`;
    case "namespace-marker":
      // The caller passes the FULL relative path of the marker
      // (`Domain/Enums/_namespace.cs`).  Markers carry no aggregate
      // hint so we trust the name verbatim.
      return name;
    case "request-logging-middleware":
      return `Middleware/${name}`;
    case "migration":
    case "migrations-config":
      // Per-deployable migrations land under `Infrastructure/Migrations/`
      // in the current emitter (see `emitDotnetMigrations`).  The
      // caller passes the bare file name; we splice in the prefix.
      return `Infrastructure/Migrations/${name}`;
    case "certs-marker":
      return `certs/${name}`;
    case "program":
    case "csproj":
    case "dockerfile":
    case "dockerignore":
      // Top-level project files — name == final path.
      return name;
  }
}

export const byLayerLayoutAdapter: LayoutAdapter = {
  name: "byLayer",

  pathFor(artifact: EmittedArtifact, _ctx: EmitCtx): string {
    // The artifact MUST carry a category (DotnetArtifactCategory) for
    // the dotnet byLayer router.  This narrows the input at the
    // boundary so the per-category switch can be exhaustive.  Callers
    // outside the dotnet emitter aren't supposed to reach this adapter
    // — the validator wires `layout: byLayer` to dotnet-only.
    if (!artifact.category) {
      throw new Error(
        `byLayer.pathFor: artifact '${artifact.name}' is missing a category (DotnetArtifactCategory).  ` +
          `Every dotnet emit site must tag its artifact with the right category before dispatching through the layout adapter.`,
      );
    }
    return pathForCategory(artifact as DotnetArtifact);
  },
};
