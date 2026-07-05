import type {
  LayoutAdapter,
  PlatformAdapterDefaults,
  PlatformAdapters,
  StyleAdapter,
} from "../generator/_adapters/index.js";
import type { SourceMapRecorder } from "../generator/_trace/sourcemap.js";
import type {
  ComponentIR,
  DeployableIR,
  EnrichedBoundedContextIR,
  Platform,
  SystemIR,
} from "../ir/types/loom-ir.js";
import type { MigrationsIR } from "../ir/types/migrations-ir.js";

// ---------------------------------------------------------------------------
// D-PHOENIX-SURFACE — framework host-capability building blocks.
//
// Encode the "host serves a framework iff it provides that framework's
// runtime" rule ONCE, as composable sets, rather than re-listing
// frameworks on every surface object (the lookup-table anti-pattern
// D-PHOENIX-SURFACE open-question #3 warns against).  A static-asset
// host's `hostableFrameworks` is exactly `STATIC_BUNDLE_FRAMEWORKS`;
// a runtime-coupled host unions its runtime framework on top.
// ---------------------------------------------------------------------------

/** Frameworks that compile to static assets and are therefore hostable
 *  by any platform that serves a static root.  `static` is React's
 *  UI-only alias (same Vite-built bundle); `svelte` is the SvelteKit
 *  adapter-static bundle; `vue` is the Vite-built Vue 3 bundle;
 *  `angular` is the `ng build` static `dist/<app>/browser` bundle.
 *  A new static-bundle framework joins here and becomes embeddable in
 *  every static-asset host with no per-host edit.
 *  (Phoenix is the one exception — it serves embedded SPAs under the
 *  `/app` path prefix, which SvelteKit needs `paths.base` wiring
 *  for; its surface lists its hostable set explicitly until that
 *  lands.) */
export const STATIC_BUNDLE_FRAMEWORKS: ReadonlySet<string> = new Set([
  "react",
  "static",
  "svelte",
  "vue",
  "angular",
]);

// ---------------------------------------------------------------------------
// Platform surface contract.
//
// A small public interface every platform implementation
// (dotnet / hono / react) exposes to the system orchestrator.
// Lets `system/index.ts` dispatch over a registry instead of
// `if (platform === "dotnet") ... else if (platform === "node") ...`
// branches, while INTENTIONALLY leaving each platform's internal
// emission strategy unconstrained — Hono uses procedural routes
// builders, .NET uses CQRS templates, React uses procedural TSX.
// That drift is a feature: the generated code reads idiomatically
// for each ecosystem.
//
// Add a new platform by:
//   1. Implement `PlatformSurface`.  Two layouts exist (see
//      docs/platforms.md):
//      - DEFAULT — a thin `src/platform/<name>.ts` surface delegating to
//        the emitters under `src/generator/<name>/`.  dotnet, elixir, java,
//        python, react, vue and svelte all follow this.
//      - VERSIONED PACKAGE — `src/platform/<family>/v<N>/index.ts`, a full
//        in-tree backend package (only `hono` today; see
//        docs/backend-packages.md).
//   2. Register it in `src/platform/registry.ts`.
//   3. Extend the `Platform` IR type + grammar.
// ---------------------------------------------------------------------------

export interface ComposeServiceShape {
  /** Environment variables: ordered tuples to keep yaml output stable. */
  env: Array<[string, string]>;
  /** Names of the env entries above that are SENSITIVE (passwords, app
   *  secret keys, tokens) and must NOT be emitted as plaintext in a
   *  k8s `ConfigMap`.  The backend is the source of truth for this — the
   *  k8s emitter routes these into a `Secret` instead (see
   *  docs/kubernetes.md), rather than guessing from the variable name.
   *  Compose ignores it (dev secrets are inline either way).  The DB
   *  connection string is handled separately via `dependsOnDb` and does
   *  not need to be listed here.  Omit / empty when the backend has no
   *  non-DB secrets (hono / .NET / python / the frontends). */
  secretEnvKeys?: readonly string[];
  /** Whether this service should `depends_on: db` with a healthcheck wait. */
  dependsOnDb: boolean;
  /** Health-check path relative to the service's HTTP root. */
  healthPath: string;
  /** The internal port the service's HTTP listener binds to. */
  internalPort: number;
  /** Frontend whose built bundle fetches the API at a RELATIVE `/api`, served
   *  in compose by an in-process proxy (vite `preview` for react/vue/svelte; a
   *  tiny static+proxy `server.mjs` for angular).  That proxy needs to know
   *  where the backend is — and inside the compose network the backend is its
   *  SERVICE name, not `localhost`.  When set, the orchestrator injects
   *  `VITE_API_PROXY_TARGET` (→ the target backend's compose service) into the
   *  frontend's env so the proxy reaches it; the bundle stays same-origin
   *  (no CORS, no separate API host). */
  injectsApiProxyTarget?: boolean;
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

/** The pure-data half of a platform surface — the static descriptor
 *  fields with NO code-generation behaviour.  Split out from
 *  `PlatformSurface` so the front half of the toolchain (language
 *  validators, IR lowering / enrich / validate) can read platform
 *  facts from `platform/metadata.ts` WITHOUT importing the surface
 *  objects (which statically pull every backend generator).  The
 *  descriptor table in `metadata.ts` is the client-safe source of
 *  truth for these fields; `descriptor-consistency.test.ts` pins it
 *  against the live surfaces.  See docs/decisions.md / the registry
 *  metadata/generation split. */
export interface PlatformDescriptor {
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
  /** The set of `ui { framework: … }` values this platform can serve
   * when it `hosts:` a UI — the capability behind D-PHOENIX-SURFACE
   * (`docs/decisions.md`).
   *
   * Principled rule, not a hand-maintained lookup table: a host can
   * serve a framework **iff it provides the runtime that framework
   * requires**.  A framework that compiles to static assets (`react`,
   * `static`) is hostable by any static-asset host — every backend that
   * serves a static root (`dotnet` → `wwwroot`, `hono` → static
   * middleware, `phoenixLiveView` → `priv/static`) plus the standalone
   * frontend hosts.  A runtime-coupled framework (LiveView, spelled
   * `phoenixLiveView` here) is hostable only by its runtime — Phoenix
   * alone.  This is why Phoenix has the richest set
   * (`{phoenixLiveView, react, static}`): it is the only platform that
   * is *both* a server-render runtime *and* a static-asset host.
   *
   * Dormant in this phase: the field records the capability; the
   * deployable validator's `hosts:`/`framework:` membership check that
   * consumes it lands with the grammar work.  Until then nothing reads
   * it, so populating it changes no generated output.  Values are
   * `Framework` grammar strings (today `react` | `phoenixLiveView`,
   * plus `static` as React's alias). */
  readonly hostableFrameworks: ReadonlySet<string>;
  /** Repository method names this platform auto-emits for every
   * aggregate.  A user-declared find with one of these names would
   * collide with the auto-emitted method (TS: duplicate function
   * implementation; .NET: same).  Used by the IR validator to
   * surface the collision as a parse-time diagnostic instead of a
   * downstream tsc/csc error.  Names are case-sensitive and use
   * the DSL's casing (lowerCamelCase) — the validator compares
   * against `find.name` directly. */
  readonly reservedRepositoryFindNames: ReadonlySet<string>;
}

/** The full platform surface — its data descriptor plus the
 *  code-generation behaviour (`emitProject` / `composeService` / the
 *  adapter menu and the reserved lifecycle hooks).  Implemented by each
 *  `src/platform/<name>.ts`; resolved only through the generation
 *  registry (`platform/registry.ts`), which is server-side / never
 *  bundled into the client.  The front half consumes
 *  `PlatformDescriptor` via `metadata.ts` instead. */
export interface PlatformSurface extends PlatformDescriptor {
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
    /** The deployable's resolved STYLE / LAYOUT adapters
     *  (D-REALIZATION-AXES `application:` / `directoryLayout:`).  The
     *  system orchestrator resolves these from the deployable's axis
     *  selection via `resolveStyle` / `resolveLayout` and passes them
     *  here; the surface forwards them into its generator's `EmitCtx`.
     *  Absent for frontends and in legacy single-context generate mode —
     *  the generator then falls back to its hardcoded default sibling
     *  (byte-identical under today's size-1 menus). */
    styleAdapter?: StyleAdapter;
    layoutAdapter?: LayoutAdapter;
    /** Generate-time source-map recorder (`--sourcemap`, off by default —
     *  see docs/plans/source-map-debug-kickoff.md).  Platforms that
     *  implement the emit bracket record whole-file construct regions
     *  into it as they place each per-aggregate/-operation artifact;
     *  absent means "record nothing" — every platform without a bracket
     *  yet is a no-op here, not an error. */
    sourcemap?: SourceMapRecorder;
    /** `.ddd` source text for every path an `OriginRef` can resolve to,
     *  keyed the same way as `GenerateSystemOptions.sourceTexts`
     *  (`src/system/index.ts`) — forwarded verbatim, no scoping.  Feeds
     *  target-native debug-info dialects a platform may weave into its own
     *  output (e.g. the .NET backend's enhanced C# `#line` directives, M7
     *  phase 6a); platforms without one simply ignore it.  No effect
     *  unless `sourcemap` is also present (same honest-skip convention). */
    sourceTexts?: ReadonlyMap<string, string>;
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
}
