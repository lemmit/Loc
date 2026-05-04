import type {
  BoundedContextIR,
  DeployableIR,
  Platform,
  SystemIR,
} from "../ir/loom-ir.js";

// ---------------------------------------------------------------------------
// Platform surface contract.
//
// A small public interface every platform implementation
// (dotnet / hono / react) exposes to the system orchestrator.
// Lets `system/index.ts` dispatch over a registry instead of
// `if (platform === "dotnet") ... else if (platform === "hono") ...`
// branches, while INTENTIONALLY leaving each platform's internal
// emission strategy unconstrained — Hono uses procedural routes
// builders, .NET uses CQRS templates, React uses procedural TSX.
// That drift is a feature: the generated code reads idiomatically
// for each ecosystem.
//
// Add a new platform by:
//   1. Implement `PlatformSurface` in `src/platform/<name>/index.ts`.
//   2. Register it in `src/platform/registry.ts`.
//   3. Extend the `Platform` IR type + grammar.
// ---------------------------------------------------------------------------

export interface ComposeServiceShape {
  /** Environment variables: ordered tuples to keep yaml output stable. */
  env: Array<[string, string]>;
  /** Whether this service should `depends_on: db` with a healthcheck wait. */
  dependsOnDb: boolean;
  /** Health-check path relative to the service's HTTP root. */
  healthPath: string;
  /** The internal port the service's HTTP listener binds to. */
  internalPort: number;
}

export interface PlatformSurface {
  /** Discriminator value matching `Platform` in the IR / grammar. */
  readonly name: Platform;
  /** Default deployable port when the user doesn't specify one. */
  readonly defaultPort: number;
  /** Whether deployables on this platform get a postgres database
   * created by the db-init script. */
  readonly needsDb: boolean;
  /** All files for one deployable's project, paths relative to the
   * deployable's folder under `<outdir>/`. */
  emitProject(args: {
    contexts: BoundedContextIR[];
    deployable: DeployableIR;
    sys: SystemIR;
  }): Map<string, string>;
  /** Inputs for the deployable's docker-compose service stanza. */
  composeService(args: {
    deployable: DeployableIR;
    sys: SystemIR;
    slug: string;
  }): ComposeServiceShape;
}
