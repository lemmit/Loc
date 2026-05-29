import type { PlatformAdapterDefaults, PlatformAdapters } from "../generator/_adapters/index.js";
import type {
  ComponentIR,
  DeployableIR,
  EnrichedBoundedContextIR,
  Platform,
  SystemIR,
} from "../ir/types/loom-ir.js";
import type { MigrationsIR } from "../ir/types/migrations-ir.js";

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
  // -------------------------------------------------------------------------
  // Reserved slots for future cross-cutting concerns (Phase 3 / 4 of the
  // proposal corpus).  Currently undefined on every backend; the
  // orchestrator emits nothing when absent.  Wiring lands per concern.
  // -------------------------------------------------------------------------
  /** Audit sidecar — a separate container for the audit subsystem
   *  (e.g. a log aggregator that drains audit-record events).
   *  Filled by backends that implement `emitAuditInit`. */
  auditSidecar?: ComposeSidecar;
  /** Policy initialisation command — an entrypoint wrapper that runs
   *  before the main service to load / verify compliance policies
   *  (sensitivity-and-compliance / authorization phases). */
  policyInitCmd?: string[];
  /** Mount path inside the container for the i18n catalog directory.
   *  Filled by backends that implement `emitI18nAdapter`. */
  i18nCatalogDir?: string;
}

/** Sidecar container shape — minimal subset of the compose service
 *  attributes a sidecar needs.  Used by `ComposeServiceShape.auditSidecar`
 *  (and any future sidecar reservations).  Intentionally smaller than the
 *  full service shape because sidecars don't expose a public health path. */
export interface ComposeSidecar {
  /** Docker image reference (e.g. `vector:0.39`). */
  image: string;
  /** Environment variables — ordered tuples for stable yaml output. */
  env: Array<[string, string]>;
  /** Optional internal port if the sidecar exposes one (typically
   *  scraped by an observability backend). */
  internalPort?: number;
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
  /** Whether the platform is a frontend-only deployable (renders a
   * UI bundle but owns no server logic / DB).  True for `react` and
   * `static`; false for backends (`hono`, `dotnet`) and the
   * fullstack `phoenixLiveView`.  Replaces hardcoded
   * `platform === "react" || platform === "static"` checks in
   * lowering / enrichment.
   *
   * Frontend-only platforms get their `moduleNames` inherited from
   * the deployable they `targets:`, since they have no domain code
   * of their own — they just consume the backend's wire shapes. */
  readonly isFrontend: boolean;
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
   * deployable's folder under `<outdir>/`.
   *
   * Contexts are typed as `EnrichedBoundedContextIR[]` because the
   * system orchestrator (`src/system/index.ts`) only ever invokes
   * `emitProject` after `enrichLoomModel` has run.  Threading the brand
   * through the surface lets each platform's `wireShapeFor` callers see
   * enriched aggregates / parts at compile time, without local
   * `as Enriched...` casts. */
  emitProject(args: {
    contexts: EnrichedBoundedContextIR[];
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
    /** Top-level (workspace-wide) components declared as bare
     *  `ModelMember`s in any reachable `.ddd` document — pure render
     *  functions visible to every page in every ui.  Today only the
     *  React generator consumes them (emits one
     *  `src/components/<Name>.tsx` per ui that references the
     *  component); other platforms ignore the arg. */
    topLevelComponents?: ComponentIR[];
  }): Map<string, string>;
  /** Inputs for the deployable's docker-compose service stanza. */
  composeService(args: {
    deployable: DeployableIR;
    sys: SystemIR;
    slug: string;
  }): ComposeServiceShape;

  /** This backend's persistence / style / layout adapter menu +
   *  defaults.  Frontend platforms (`react` / `static`) omit both —
   *  they carry no domain code and version via the design-pack axis.
   *
   *  Exposed as a METHOD (not an eager field) on purpose: each surface
   *  is loaded early via `registry.ts`, inside the tolerated
   *  `registry → <surface> → generator → enrich → registry` import
   *  cycle.  Building the menu lazily reads the adapter bindings at
   *  call time — after every module finished initialising — avoiding
   *  init-order TDZ.  See D-ADAPTER-HOME in `docs/decisions.md`. */
  adapters?(): PlatformAdapters;
  /** Default adapter per `persistence:` strategy / `style:` / `layout:`
   *  when the source doesn't pin one.  Present iff `adapters()` is. */
  adapterDefaults?(): PlatformAdapterDefaults;

  // ---------------------------------------------------------------------------
  // Reserved no-op lifecycle hooks for future cross-cutting concerns.
  //
  // Each is OPTIONAL today and undefined on every backend; the orchestrator
  // reads with `?.` and emits nothing when absent.  Filling a hook on a
  // backend lands that backend's adapter for the named concern — the
  // signature pins the data shape so adopters don't redesign the boundary.
  //
  // Concerns and the proposals they back:
  //   - emitAuthGate           docs/proposals/authorization.md
  //   - emitAuditInit          docs/proposals/audit-and-logging.md
  //   - emitCompliancePolicy   docs/proposals/sensitivity-and-compliance.md
  //   - emitTenancyFilter      docs/proposals/multi-tenancy-design-note.md
  //   - emitI18nAdapter        docs/proposals/i18n.md
  // ---------------------------------------------------------------------------

  /** Lines spliced into the deployable's bootstrap to install the
   *  authorization gate (policy evaluator + per-route guard wiring). */
  emitAuthGate?(args: {
    contexts: EnrichedBoundedContextIR[];
    deployable: DeployableIR;
    sys: SystemIR;
  }): string[];

  /** Lines spliced into the deployable's bootstrap to initialise the
   *  audit subsystem (record persister + behaviour-pipeline attachment). */
  emitAuditInit?(args: {
    contexts: EnrichedBoundedContextIR[];
    deployable: DeployableIR;
    sys: SystemIR;
  }): string[];

  /** Lines spliced into the deployable's bootstrap to load / verify
   *  compliance policies (sensitivity mask DTOs + sink-call classification). */
  emitCompliancePolicy?(args: {
    contexts: EnrichedBoundedContextIR[];
    deployable: DeployableIR;
    sys: SystemIR;
  }): string[];

  /** Lines spliced into the repository / query layer to enforce tenant
   *  isolation (DataKey leftmost = TenantId per multi-tenancy proposal). */
  emitTenancyFilter?(args: {
    contexts: EnrichedBoundedContextIR[];
    deployable: DeployableIR;
    sys: SystemIR;
  }): string[];

  /** Lines spliced into the deployable's bootstrap to wire the i18n
   *  adapter (catalog loader + locale switch). */
  emitI18nAdapter?(args: {
    contexts: EnrichedBoundedContextIR[];
    deployable: DeployableIR;
    sys: SystemIR;
  }): string[];
}
