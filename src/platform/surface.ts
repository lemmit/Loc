import type { BoundedContextIR, DeployableIR, Platform, SystemIR } from "../ir/loom-ir.js";
import type { MigrationsIR } from "../ir/migrations-ir.js";

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
  /** Whether deployables on this platform mount a `ui:` binding
   * (i.e. render pages from a `ui { ... }` SystemMember).  React
   * and static frontends do; dotnet and hono backends don't;
   * phoenixLiveView does AS A FULLSTACK platform — its single
   * deployable both `serves:` an Api and mounts a `ui:`.
   * Consulted by the deployable validator instead of hardcoded
   * platform-string lists. */
  readonly mountsUi: boolean;
  /** Repository method names this platform auto-emits for every
   * aggregate.  A user-declared find with one of these names would
   * collide with the auto-emitted method (TS: duplicate function
   * implementation; .NET: same).  Used by the IR validator to
   * surface the collision as a parse-time diagnostic instead of a
   * downstream tsc/csc error.  Names are case-sensitive and use
   * the DSL's casing (lowerCamelCase) — the validator compares
   * against `find.name` directly. */
  readonly reservedRepositoryFindNames: ReadonlySet<string>;
  /** All files for one deployable's project, paths relative to the
   * deployable's folder under `<outdir>/`. */
  emitProject(args: {
    contexts: BoundedContextIR[];
    deployable: DeployableIR;
    sys: SystemIR;
    /** Per-deployable slice of `buildMigrations(sys, snapshots)` — only
     *  the modules where `module.migrationsOwner === deployable.name`.
     *  When absent / empty, the platform emits no migration files.
     *  Frontend platforms (react / static) ignore this arg. */
    migrations?: MigrationsIR[];
    /** Generate-time observability switch — when true, the platform
     * emits trace-level domain instrumentation (domain-injected
     * `value_computed`, `precondition_evaluated`, etc.).  Off keeps the
     * artefact lean and the domain layer pure. */
    emitTrace?: boolean;
  }): Map<string, string>;
  /** Inputs for the deployable's docker-compose service stanza. */
  composeService(args: {
    deployable: DeployableIR;
    sys: SystemIR;
    slug: string;
  }): ComposeServiceShape;
}
