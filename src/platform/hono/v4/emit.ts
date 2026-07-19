// This orchestrator (project assembly: which files, framework wiring,
// package.json/Dockerfile) is backend-specific, so it lives in the
// hono@v4 *package* and drives the shared neutral emitter library
// under `src/generator/typescript/` by ordinary import (package →
// shared).  Over time the remaining Hono-framework builders
// (routes/workflow/view/auth/observability) move in here too, leaving
// only the framework-neutral helpers (render-expr/stmt, templates,
// zod-refine) in core.

// Hono-framework builders now live in this package (P2b) — siblings.
import type { EmitCtx, LayoutAdapter, StyleAdapter } from "../../../generator/_adapters/index.js";
import { brokerChannelBindings } from "../../../generator/_channels/bindings.js";
import { renderHonoBaseLogCall } from "../../../generator/_obs/render-hono.js";
import type { SourceMapRecorder } from "../../../generator/_trace/sourcemap.js";
import {
  buildBaseReaderFile,
  buildBaseUnionFile,
  buildTpcBaseReaderFile,
} from "../../../generator/typescript/base-reader-builder.js";
import { addTsExtensionsForNodeDebug } from "../../../generator/typescript/debug-imports.js";
import {
  aggregateIsAudited,
  renderAuditStampHelper,
} from "../../../generator/typescript/emit/audit-stamp.js";
import { renderChannelsModule } from "../../../generator/typescript/emit/channels.js";
import { renderDomainServices } from "../../../generator/typescript/emit/domain-service.js";
import { emitTypescriptMigrations } from "../../../generator/typescript/emit/migrations.js";
import {
  MIKRO_INDEX_IMPORTS,
  mikroConnectionSetup,
  renderMikroBaseReader,
  renderMikroConfig,
  renderMikroDocumentRepository,
  renderMikroEmbeddedRepository,
  renderMikroEntities,
  renderMikroEventSourcedRepository,
  renderMikroRepository,
  renderMikroTpcBaseReader,
} from "../../../generator/typescript/emit/mikroorm.js";
import { emitMikroSeeds, emitTypescriptSeeds } from "../../../generator/typescript/emit/seed.js";
import {
  type OpFragment,
  renderAggregate,
  renderEnumsAndValueObjects,
  renderEvents,
  renderHttpIndex,
  renderIds,
  renderSchema,
  renderTestsFile,
} from "../../../generator/typescript/emit.js";
import { buildExternSubclassFile } from "../../../generator/typescript/extern-builder.js";
import { rewriteRelativeImports } from "../../../generator/typescript/layout-imports.js";
import { buildRepositoryFile } from "../../../generator/typescript/repository-builder.js";
import { buildDocumentRepositoryFile } from "../../../generator/typescript/repository-document-builder.js";
import { buildEmbeddedRepositoryFile } from "../../../generator/typescript/repository-embedded-builder.js";
import { buildEventSourcedRepositoryFile } from "../../../generator/typescript/repository-eventsourced-builder.js";
import {
  PORT_POOL_PATH,
  portMembersFromSource,
  type RepoPortSpec,
  renderRepositoryPortsFile,
} from "../../../generator/typescript/repository-port-builder.js";
import { deriveEventSubscriptions, enrichLoomModel } from "../../../ir/enrich/enrichments.js";
import { lowerModel } from "../../../ir/lower/lower.js";
import {
  type BoundedContextIR,
  contextUsesMoney,
  type DataSourceIR,
  type DeployableIR,
  type EnrichedBoundedContextIR,
  type EventIR,
  type FieldIR,
  isMaterializedProjection,
  isQueryTimeProjection,
  type RepositoryIR,
  type SystemIR,
  type TimerSourceIR,
  type TypeIR,
  type UserIR,
} from "../../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../../ir/types/migrations-ir.js";
import type { OriginRef } from "../../../ir/types/origin.js";
import { aggregatesNeedConcurrency } from "../../../ir/util/aggregate-flags.js";
import { contextHasAuditedTarget } from "../../../ir/util/audit-capability.js";
import { durableEventTypes, realtimeEventTypes } from "../../../ir/util/channels.js";
import { aggregateHasFileField } from "../../../ir/util/file-field.js";
import {
  isTpcBase,
  isTphBase,
  tpcConcretesOf,
  tphConcretesOf,
} from "../../../ir/util/inheritance.js";
import { mergeContexts } from "../../../ir/util/merge-contexts.js";
import { contextsHaveProvenancedField } from "../../../ir/util/prov-id.js";
import {
  effectiveSavingShape,
  resolveContextSchema,
  resolveDataSourceConfig,
} from "../../../ir/util/resolve-datasource.js";
import { hierarchyRegistry } from "../../../ir/util/tenant-stance.js";
import type { Model } from "../../../language/generated/ast.js";
import { API_BASE_PATH } from "../../../util/api-base.js";
import { lowerFirst, plural } from "../../../util/naming.js";
import {
  byLayerLayoutAdapter,
  type HonoArtifact,
  type HonoArtifactCategory,
} from "./adapters/by-layer-layout.js";
import { DRIZZLE_CONNECTION_SETUP } from "./adapters/drizzle-persistence.js";
import { layeredStyleAdapter } from "./adapters/layered-style.js";
import { resourceAdapterFor } from "./adapters/resource-clients.js";
import { emitAuthFiles } from "./auth-emit.js";
import { buildExplicitRoutesFile, emitExternHandlerImpls } from "./explicit-handlers-builder.js";
import { emitObservabilityFiles } from "./observability-builder.js";
import { buildProjectionsFile } from "./projection-builder.js";
import { buildQueryProjectionsFile } from "./projection-query-routes-builder.js";
import { buildRealtimeFile } from "./realtime-builder.js";
import { buildRoutesFile } from "./routes-builder.js";
import { anyTimerUsesCron, renderTimerScheduler } from "./scheduler-builder.js";
import { buildViewsRoutesFile } from "./view-routes-builder.js";
import { buildWorkflowsFile } from "./workflow-builder.js";

/** `emitConcurrency` is true when some aggregate in scope declares the
 *  `versioned` capability (optimistic concurrency) — only then does the
 *  repository save's guarded write have anything to throw, so a
 *  concurrency-free project's `domain/errors.ts` stays byte-identical. */
function errorsTs(emitConcurrency: boolean): string {
  return `// Auto-generated.
export class DomainError extends Error {
  constructor(message: string) { super(message); this.name = "DomainError"; }
}
export class AggregateNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "AggregateNotFoundError"; }
}
/** Authorization failure — raised by \`requires\` expressions in
 *  operation / workflow bodies when the resolved currentUser
 *  doesn't satisfy the gate.  The per-route catch maps this to
 *  HTTP 403 (Forbidden). */
export class ForbiddenError extends Error {
  constructor(message: string) { super(message); this.name = "ForbiddenError"; }
}
/** State-gate failure — raised when an operation's 'when' predicate
 *  (the canCommand gate, criterion.md use site 2) evaluates false
 *  against the loaded aggregate.  The per-route catch maps this to
 *  HTTP 409 (Conflict — the request is well-formed and authorized,
 *  but the aggregate's current state disallows it). */
export class DisallowedError extends Error {
  constructor(message: string) { super(message); this.name = "DisallowedError"; }
}
/** Wraps an exception thrown by a user-supplied extern handler.  The
 *  per-router \`app.onError\` maps this to a 500 envelope that names
 *  the offending op + aggregate, instead of the bare
 *  \`{ "error": "internal" }\` operators see when the same throw
 *  bubbles unwrapped.  Domain-layer errors raised by the user
 *  handler (DomainError, ForbiddenError, AggregateNotFoundError)
 *  are NOT wrapped — they bubble through and the router maps them
 *  to their usual status codes. */
export class ExternHandlerError extends Error {
  readonly opName: string;
  readonly aggName: string;
  readonly cause: unknown;
  constructor(opName: string, aggName: string, cause: unknown) {
    const inner = cause instanceof Error ? cause.message : String(cause);
    super(\`Extern handler '\${opName}' on '\${aggName}' threw: \${inner}\`);
    this.name = "ExternHandlerError";
    this.opName = opName;
    this.aggName = aggName;
    this.cause = cause;
  }
}
${
  emitConcurrency
    ? `/** Optimistic-concurrency conflict — raised by the repository's guarded
 *  write when a \`versioned\` aggregate's expected version no longer
 *  matches the stored row (another request won the race).  The per-router
 *  catch maps this to HTTP 409 (Conflict), distinct from the \`disallowed\`
 *  state-gate 409 — a dashboard can tell "stale write" from "state gate"
 *  apart via the \`conflict\` vs \`disallowed\` log event. */
export class ConcurrencyError extends Error {
  constructor(aggregate: string, id: string) {
    super(\`\${aggregate} \${id} was modified by another request\`);
    this.name = "ConcurrencyError";
  }
}
`
    : ""
}`;
}

/** Shared HTTP error shape — RFC 7807 ProblemDetails with the §3.2 `errors[]`
 *  extension for per-field validation failures.  See
 *  docs/old/proposals/validation-error-extension.md.
 *
 *  Emitted once per project at `http/problem-details.ts`; the three router
 *  files (`http/<agg>.ts`, `http/workflows.ts`, `http/views.ts`) import the
 *  `ProblemDetails` Zod schema (for OpenAPI declarations) and the
 *  `defaultHook` (passed to `new OpenAPIHono({ defaultHook })` so Zod parse
 *  failures translate to 422 ProblemDetails with per-field `errors[]`
 *  consumed by the frontend ACL's `applyServerErrors`). */
const PROBLEM_DETAILS_TS = `// Auto-generated.  Do not edit by hand.
import { z } from "zod";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";

/** RFC 7807 ProblemDetails body — the base 5 spec fields plus the §3.2
 *  \`errors[]\` extension (per-field \`{ pointer, message }\` array) that
 *  the runtime emits on 422 validation responses.  Consumed by the
 *  frontend ACL's \`applyServerErrors\` (see docs/old/proposals/frontend-acl.md).
 *  All fields nullable / optional — base 5 per the spec core; \`errors\` is
 *  only present on 422 validation responses.  Phase D of
 *  docs/old/proposals/validation-error-extension.md — all three backends
 *  (Hono / .NET / Phoenix) declare the same shape in lockstep so the
 *  cross-backend parity gate stays green. */
export const ProblemDetails = z.object({
  type: z.string().nullish(),
  title: z.string().nullish(),
  status: z.number().int().nullish(),
  detail: z.string().nullish(),
  instance: z.string().nullish(),
  errors: z.array(z.object({ pointer: z.string(), message: z.string(), code: z.string().nullish() })).nullish(),
}).openapi("ProblemDetails");

/** RFC 6901 JSON pointer from a Zod issue path.  Empty path → empty
 *  pointer (\`""\`, "the whole document").  Segments are slash-joined;
 *  literal \`~\` and \`/\` inside a segment are escaped to \`~0\` / \`~1\`. */
function pointerOf(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "";
  return "/" + path.map((seg) =>
    typeof seg === "string"
      ? seg.replace(/~/g, "~0").replace(/\\//g, "~1")
      : String(seg),
  ).join("/");
}

/** Default Zod-validation hook.  When a route's request validator
 *  rejects input, this fires before the handler runs and produces a 422
 *  ProblemDetails with the per-field \`errors[]\` extension.  The shape
 *  is the contract consumed by the frontend ACL — see
 *  docs/old/proposals/frontend-acl.md and apply-server-errors.ts in the
 *  generated React project.
 *
 *  Validation failures get 422 (Unprocessable Entity, RFC 7807 standard
 *  for input-shape errors).  Domain-rule violations carried by
 *  DomainError continue to emit 400 via the router's \`app.onError\`
 *  catch-all (different fault class, different code). */
export function defaultHook(result: { success: boolean; error?: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string; params?: { loomCode?: string } }> } }, c: Context): Response | undefined {
  if (result.success) return undefined;
  const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";
  const errors = (result.error?.issues ?? []).map((issue) => ({
    pointer: pointerOf(issue.path),
    message: issue.message,
    // A messaged invariant/precondition carries a stable content-hash code (via
    // the refine's params.loomCode) so a client can localise the error;
    // structural zod errors (type/min) have none.
    ...(issue.params?.loomCode ? { code: issue.params.loomCode } : {}),
  }));
  return c.body(
    JSON.stringify({
      type: "about:blank",
      title: "Validation failed",
      status: 422,
      detail: "One or more fields are invalid.",
      instance: c.req.path,
      errors,
    }),
    422,
    { "content-type": "application/problem+json", "x-request-id": trace_id },
  );
}

/** Factory: \`new OpenAPIHono()\` with the validation \`defaultHook\` pre-wired.
 *  Routers import this instead of constructing OpenAPIHono directly so the
 *  hook is always installed without per-router boilerplate. */
export function newApp(): OpenAPIHono {
  return new OpenAPIHono({ defaultHook });
}
`;

/** Provenance lineage types — emitted only when the model declares at
 *  least one `provenanced` field that is actually written.  Each
 *  provenanced write builds a `ProvLineage` referencing the compile-time
 *  rule snapshot in `.loom/loomsnap.json`; it is stored co-located on the
 *  aggregate row (the `<field>_provenance` jsonb column) and appended to
 *  the `provenance_records` history table inside the operation's save
 *  transaction (see routes-builder). */
const PROVENANCE_TS = `// Auto-generated.
export interface ProvInput { path: string; value: unknown; }

export interface ProvLineage {
  /** Points at the per-write-site rule snapshot in \`.loom/loomsnap.json\`. */
  snapshotId: string;
  target: { type: string; field: string };
  inputs: ProvInput[];
  computedValue: unknown;
}
`;

/**
 * Legacy entry: lowers the whole model and emits one project from all
 * top-level bounded contexts.  Used by `ddd generate ts <file> -o <dir>`.
 */
export function generateTypeScript(
  model: Model,
  pins: BackendPins,
  options: { emitTrace?: boolean } = {},
): Map<string, string> {
  // Lowering produces a faithful AST projection; enrichment populates
  // wireShape, the implicit `findAll` find, and react `moduleNames`
  // inheritance.  Every backend consumes the enriched IR, never the
  // raw lowered output.
  const loom = enrichLoomModel(lowerModel(model));
  return generateTypeScriptForContexts(loom.contexts, pins, undefined, options);
}

/**
 * System-mode entry: emits one project from a pre-filtered list of
 * contexts.  Used by the deployable orchestrator to scope the output
 * to a single deployable's modules.
 *
 * `system` (when present) carries the system-wide user-claim shape +
 * the deployable's auth setting.  When the deployable opts in via
 * `auth: required` AND the system declares a user block, the
 * generator emits the auth/* package + mounts the middleware in
 * http/index.ts.  Loose top-level contexts (no enclosing system)
 * skip the auth path entirely.
 */
export function generateTypeScriptForContexts(
  contexts: EnrichedBoundedContextIR[],
  pins: BackendPins,
  system?: {
    deployable: DeployableIR;
    sys: SystemIR;
    migrations?: MigrationsIR[];
    styleAdapter?: StyleAdapter;
    layoutAdapter?: LayoutAdapter;
  },
  options: { emitTrace?: boolean; sourcemap?: SourceMapRecorder } = {},
): Map<string, string> {
  const emitTrace = !!options.emitTrace;
  const sourcemap = options.sourcemap;
  const out = new Map<string, string>();
  const authRequired = !!(system?.deployable.auth?.required && system.sys.user);
  // OIDC turnkey auth (D-AUTH-OIDC): present when the system declares an
  // `auth { oidc { … } }` block AND this deployable opts in.  Drives the
  // generated verifier + `/auth/*` handshake + the `jose` dep, replacing
  // the hand-registered dev stub.
  const oidcAuth = authRequired ? system?.sys.auth : undefined;
  // Emission is forced by presence: any written `provenanced` field turns
  // on the lineage types + co-located `<field>_provenance` columns + the
  // `provenance_records` history table.  Threaded as a flag (rather than
  // read off presence at each call site) so a future build-level switch
  // can force emission for other consumers.
  const emitProvenance = contextsHaveProvenancedField(contexts);
  // Emission is forced by presence: any `audited` command action — an
  // `operation`, or a lifecycle `create` / `destroy` — turns on the audit
  // SDK + per-route audit-record inserts.  Threaded as a flag (like
  // emitProvenance) so a future build-level switch can force emission.
  // Uses the shared IR predicate so the operation ∪ create ∪ destroy gate
  // can't drift back to operations-only (the pre-#1503 bug).
  const emitAudit = contexts.some(contextHasAuditedTarget);

  // Multi-context Hono deployables (e.g. acme's catalogWeb spanning
  // Catalog + CustomerMgmt) need the shared domain files to UNION
  // every context's content rather than overwrite per-context.  The
  // .NET path already merges this way via a synthetic `merged`
  // context; we mirror that here so `domain/ids.ts`,
  // `domain/value-objects.ts`, `domain/events.ts`, `db/schema.ts`,
  // `http/workflows.ts`, `http/views.ts`, and `http/index.ts` all
  // reflect the FULL aggregate / VO / enum / event set.
  // Union the hosted contexts into one synthetic context (ambient enums / VOs
  // deduped by name — see src/ir/util/merge-contexts.ts) so the shared domain /
  // schema modules reflect the FULL set.
  // Broker bindings (channels.md; M-T4.4 slice 2): the redis-bound broadcast
  // channelSources this deployable wires via `channels:`.  Computed up front
  // because they widen the merged vocabulary below — a consumer deployable
  // need not HOST the channel's owning context to react to its events; the
  // wired binding is what carries the routing knowledge across deployables.
  const channelBindings =
    system && system.deployable.persistence !== "mikroorm"
      ? brokerChannelBindings(system.deployable, system.sys)
      : [];
  // Durable broker-bound events (M-T4.4 slice 3): carried by a wired
  // `queue`/`work` (or future `log`) channel — the producer path for these
  // rides the outbox relay (design §5), never the inline tee.
  const durableBrokerEvents = new Set(
    channelBindings
      .filter((b) => b.retention === "work" || b.retention === "log")
      .flatMap((b) => b.events),
  );
  const mergedBase = mergeContexts(contexts);
  const hostedChannelNames = new Set(contexts.flatMap((c) => c.channels).map((ch) => ch.name));
  // Wired-but-foreign channels join the carrier set as minimal ChannelIR
  // stubs carrying the channel's REAL semantics knobs (a foreign `queue`/
  // `work` channel must drive the consumer's idempotency markers), so
  // `deriveEventSubscriptions` routes a hosted reactor off a channel
  // declared in a non-hosted context.
  const wiredForeignChannels = channelBindings
    .filter((b) => !hostedChannelNames.has(b.channelName))
    .map((b) => ({
      name: b.channelName,
      carries: b.events,
      delivery: b.delivery,
      retention: b.retention,
    }));
  const mergedSubscriptions = deriveEventSubscriptions(
    [...contexts.flatMap((c) => c.channels), ...wiredForeignChannels],
    contexts.flatMap((c) => c.workflows),
    contexts.flatMap((c) => c.projections ?? []),
  );
  // Foreign events a hosted workflow consumes through a wired channel join
  // the deployable's event vocabulary: `domain/events.ts` needs the type
  // (the reactor handler references it) and the DomainEvent union carries it.
  const knownEventNames = new Set(mergedBase.events.map((e) => e.name));
  const foreignConsumedEvents = system
    ? [...new Set(mergedSubscriptions.map((s) => s.event))]
        .filter((name) => !knownEventNames.has(name))
        .flatMap((name) => {
          for (const sub of system.sys.subdomains) {
            for (const c of sub.contexts) {
              const ev = c.events.find((e) => e.name === name);
              if (ev) return [ev];
            }
          }
          return [];
        })
    : [];
  const merged: EnrichedBoundedContextIR = {
    ...mergedBase,
    events: [...mergedBase.events, ...foreignConsumedEvents],
    // Re-derive over the merged union so a reactor in one hosted context can
    // route off a channel declared in another — cross-context choreography
    // within a single deployable (in-process dispatch slice), extended by the
    // wired broker channels for the cross-deployable case (M-T4.4).
    eventSubscriptions: mergedSubscriptions,
  };

  // Foreign id brands (M-T4.4): id targets referenced by broker-consumed
  // foreign events (and the correlating workflow state fields) whose owning
  // aggregate this deployable doesn't host.
  const hostedIdNames = new Set(
    merged.aggregates.flatMap((a) => [a.name, ...a.parts.map((p) => p.name)]),
  );
  const foreignIdNames = [
    ...new Set(
      [
        ...foreignConsumedEvents.flatMap((e) => e.fields.map((f) => f.type)),
        ...merged.workflows.flatMap((w) => (w.stateFields ?? []).map((f) => f.type)),
      ]
        .filter((t): t is Extract<TypeIR, { kind: "id" }> => t.kind === "id")
        .map((t) => t.targetName)
        .filter((n) => !hostedIdNames.has(n)),
    ),
  ];
  out.set("domain/ids.ts", renderIds(merged, foreignIdNames));
  out.set("domain/value-objects.ts", renderEnumsAndValueObjects(merged));
  const servicesFile = renderDomainServices(merged);
  if (servicesFile) out.set("domain/services.ts", servicesFile);
  out.set("domain/events.ts", renderEvents(merged));
  // `ConcurrencyError` only when some aggregate in this deployable declares
  // `versioned` OR is event-sourced — mirrors the emitProvenance / emitAudit
  // presence-gating above so a concurrency-free project's errors file stays
  // byte-identical.  An event-sourced aggregate's append site throws
  // `ConcurrencyError` on a `(stream_id, version)` 23505 collision, so it needs
  // the same error class + 409 arm the `versioned` guarded write does.
  const emitConcurrency = aggregatesNeedConcurrency(merged.aggregates);
  out.set("domain/errors.ts", errorsTs(emitConcurrency));
  out.set("http/problem-details.ts", PROBLEM_DETAILS_TS);
  if (emitProvenance) out.set("domain/provenance.ts", PROVENANCE_TS);
  // Per-aggregate dataSource lookup — feeds `pgSchema(...)` /
  // `<schema>.table(...)` / `tablePrefix` routing in `renderSchema`.
  // Returns `undefined` for systems without a matching binding, which
  // falls back to the existing plain `pgTable(...)` shape.
  const resolveDataSource = system
    ? (agg: import("../../../ir/types/loom-ir.js").AggregateIR) => {
        const owningCtx = contexts.find((c) => c.aggregates.some((a) => a.name === agg.name));
        return owningCtx
          ? resolveDataSourceConfig(
              agg as import("../../../ir/types/loom-ir.js").EnrichedAggregateIR,
              owningCtx,
              system.sys,
            )
          : undefined;
      }
    : undefined;
  // Per-workflow saga-table schema — resolved from the workflow's OWNING
  // context (map-back by name, mirroring `resolveDataSource`), so its
  // correlation-state / event-log table lands in the same schema as that
  // context's aggregate tables instead of `public`.
  const resolveWorkflowSchema = system
    ? (wf: import("../../../ir/types/loom-ir.js").WorkflowIR) => {
        const owningCtx = contexts.find((c) => c.workflows.some((w) => w.name === wf.name));
        return owningCtx ? resolveContextSchema(owningCtx, system.sys) : undefined;
      }
    : undefined;
  // Per-projection read-model-table schema — same owning-context map-back.
  const resolveProjectionSchema = system
    ? (proj: import("../../../ir/types/loom-ir.js").ProjectionIR) => {
        const owningCtx = contexts.find((c) => c.projections.some((p) => p.name === proj.name));
        return owningCtx ? resolveContextSchema(owningCtx, system.sys) : undefined;
      }
    : undefined;
  // Per-stream OWNING-context name — maps an event-sourced aggregate / workflow
  // to the context that declares it, so the merged multi-context schema names
  // each `<ctx>_events` log after its owner (matching the per-aggregate
  // repository + migrations), not the merged context name.
  const resolveStreamContext = (streamName: string): string | undefined =>
    contexts.find(
      (c) =>
        c.aggregates.some((a) => a.name === streamName) ||
        c.workflows.some((w) => w.name === streamName),
    )?.name;
  // Persistence selection (D-REALIZATION-AXES `persistence:`): `mikroorm`
  // replaces the drizzle schema + per-aggregate drizzle repositories + drizzle
  // migrations with an EntitySchema persistence model + MikroORM repositories
  // (schema owned by `orm.schema.updateSchema()` at startup).  The validator
  // gates mikroorm to the supported subset, so the drizzle-only branches below
  // stay byte-identical for the default `drizzle`.
  const usingMikro = system?.deployable.persistence === "mikroorm";
  if (usingMikro) {
    out.set(
      "db/entities.ts",
      renderMikroEntities(
        merged.aggregates,
        merged,
        (agg) => effectiveSavingShape(agg, resolveDataSource?.(agg)),
        { audit: emitAudit, provenance: emitProvenance },
      ),
    );
    out.set("mikro-orm.config.ts", renderMikroConfig());
  } else {
    out.set(
      "db/schema.ts",
      renderSchema(merged, {
        audit: emitAudit,
        provenance: emitProvenance,
        resolveDataSource,
        resolveWorkflowSchema,
        resolveProjectionSchema,
        resolveStreamContext,
      }),
    );
  }
  if (
    merged.workflows.length > 0 ||
    (durableBrokerEvents.size > 0 && durableEventTypes(merged).size > 0)
  ) {
    const aggsByName = new Map(merged.aggregates.map((a) => [a.name, a] as const));
    // resourceName → sourceType, so workflow bodies can import their
    // resource-op verb helpers from the right client module (Phase 4).
    const resourceSourceTypes = new Map<string, string>();
    if (system) {
      const storeType = new Map(system.sys.storages.map((s) => [s.name, s.type] as const));
      for (const r of system.sys.dataSources) {
        const st = storeType.get(r.storageName);
        if (st) resourceSourceTypes.set(r.name, st);
      }
    }
    // Only collected when a recorder is actually threaded in — a
    // no-sourcemap run pays no per-statement bookkeeping cost.  Milestone 11:
    // `http/workflows.ts` pools every workflow, so it never gets a
    // whole-file region — only these fragment-only statement regions.
    const workflowOpFragments: OpFragment[] | undefined = sourcemap ? [] : undefined;
    const workflowsContent = buildWorkflowsFile(
      merged,
      aggsByName,
      resourceSourceTypes,
      workflowOpFragments,
      resolveStreamContext,
      usingMikro,
    );
    out.set("http/workflows.ts", workflowsContent);
    if (sourcemap && workflowOpFragments) {
      for (const frag of workflowOpFragments) {
        sourcemap.fragment(
          "http/workflows.ts",
          workflowsContent,
          frag.fragmentText,
          frag.subRegions,
        );
      }
    }
  }
  if (merged.views.length > 0) {
    const aggsByName = new Map(merged.aggregates.map((a) => [a.name, a] as const));
    out.set("http/views.ts", buildViewsRoutesFile(merged, aggsByName, resolveStreamContext));
  }
  if (merged.projections.some(isMaterializedProjection) && !usingMikro) {
    out.set("http/projections.ts", buildProjectionsFile(merged));
  }
  // Query-time projections (read-path-architecture.md rev.13) — the always-
  // current read model that was a `view`'s full form.  Emitted to a distinct
  // file (`http/query-projections.ts`, mounted under `/projections`) since the
  // folded read model owns `http/projections.ts` with a different signature.
  if (merged.projections.some(isQueryTimeProjection) && !usingMikro) {
    out.set("http/query-projections.ts", buildQueryProjectionsFile(merged));
  }
  // Explicit transport layer (unfoldable-api-derivation.md, A2): one router
  // file per served api whose `route <M> <p> -> <Ctx>.<Handler>` list resolves
  // to a hosted commandHandler / queryHandler.  A no-op (byte-identical) when
  // the deployable serves no api with explicit routes.
  const explicitRouters: { fn: string; module: string; mountPath: string }[] = [];
  if (system) {
    for (const apiName of system.deployable.serves) {
      const api = system.sys.apis.find((a) => a.name === apiName);
      if (!api || api.routes.length === 0) continue;
      const content = buildExplicitRoutesFile(api.name, api.routes, contexts);
      if (!content) continue;
      const slug = lowerFirst(api.name);
      out.set(`http/${slug}-routes.ts`, content);
      explicitRouters.push({
        fn: `${slug}Routes`,
        module: `./${slug}-routes`,
        mountPath: API_BASE_PATH,
      });
    }
  }
  // File upload/download wiring (M-T1.2): when this deployable hosts a
  // File-bearing aggregate AND binds an objectStore, `createApp` mounts the
  // global `/files` routes over that store's bytes adapter.  The IR validator
  // (`loom.file-field-needs-object-storage`) guarantees the binding exists, so
  // a missing objectStore here means simply no File field — emit nothing.
  let fileUpload: { resource: string; sourceType: string } | undefined;
  if (system) {
    const hasFileField = contexts.some((ctx) =>
      ctx.aggregates.some((agg) => aggregateHasFileField(agg)),
    );
    if (hasFileField) {
      const wired = new Set(system.deployable.dataSourceNames);
      const storeType = new Map(system.sys.storages.map((s) => [s.name, s.type] as const));
      const objStore = system.sys.dataSources.find(
        (r) => wired.has(r.name) && r.kind === "objectStore",
      );
      const st = objStore ? storeType.get(objStore.storageName) : undefined;
      if (objStore && st) fileUpload = { resource: objStore.name, sourceType: st };
    }
  }
  out.set(
    "http/index.ts",
    renderHttpIndex(merged, {
      authRequired,
      persistence: usingMikro ? "mikroorm" : "drizzle",
      explicitRouters,
      fileUpload,
      // Durable broker-bound events must reach the outbox even from a
      // deployable with no local reactor (M-T4.4 slice 3): the relay
      // publishes them on drain.
      forceOutbox: durableBrokerEvents.size > 0 && durableEventTypes(merged).size > 0,
    }),
  );
  // Realtime SSE wire (channels.md Part I): any `delivery: broadcast`
  // channel makes its carried events UI-observable at GET /realtime/events;
  // createApp's dispatcher tee (see routes emit) copies dispatched events
  // onto the stream.
  if (!usingMikro) {
    const realtimeFile = buildRealtimeFile(merged);
    if (realtimeFile) out.set("http/realtime.ts", realtimeFile);
  }

  // Adapter dispatch context — present only in system-mode emit so
  // routes-file emission can route through the layered StyleAdapter +
  // byLayer LayoutAdapter.  Other per-aggregate emissions (aggregate
  // module, repository, extern handler, tests) still write inline
  // paths; future slices can move them under the persistence adapter +
  // additional layout categories.
  const emitCtx: EmitCtx | undefined = system
    ? {
        deployable: system.deployable,
        contexts,
        sys: system.sys,
        migrations: system.migrations,
        emitTrace,
        styleAdapter: system.styleAdapter,
        layoutAdapter: system.layoutAdapter,
      }
    : undefined;
  // Per-aggregate placement (D-REALIZATION-AXES `directoryLayout:`): every
  // per-aggregate file routes through the deployable's RESOLVED layout adapter,
  // byLayer fallback in the legacy single-context path.  byLayer reproduces the
  // historical inline paths byte-for-byte; byFeature rehomes them under
  // `features/<agg>/`.  Relocated files are recorded in `moved` (byLayer →
  // final) so a single post-emit pass can rewrite their relative imports.
  const layout = emitCtx?.layoutAdapter ?? byLayerLayoutAdapter;
  const moved = new Map<string, string>();
  const placeArtifact = (
    artifact: HonoArtifact,
    origin?: OriginRef,
    construct?: string,
    opFragments?: OpFragment[],
  ): void => {
    const byLayerPath = byLayerLayoutAdapter.pathFor(artifact, emitCtx ?? ({} as EmitCtx));
    const finalPath = layout.pathFor(artifact, emitCtx ?? ({} as EmitCtx));
    if (finalPath !== byLayerPath) moved.set(byLayerPath, finalPath);
    out.set(finalPath, artifact.content);
    sourcemap?.file(finalPath, artifact.content, origin, construct);
    // Statement-granular sub-regions (source-map Milestone 3) — layered onto
    // the whole-file region just recorded above, anchored by exact-text
    // search against this SAME final content, so they land at the right
    // absolute lines regardless of what the layout adapter did to the path.
    if (sourcemap && opFragments) {
      for (const frag of opFragments) {
        sourcemap.fragment(finalPath, artifact.content, frag.fragmentText, frag.subRegions);
      }
    }
  };
  const place = (
    category: HonoArtifactCategory,
    aggregateName: string,
    content: string,
    origin?: OriginRef,
    construct?: string,
    opFragments?: OpFragment[],
  ): void => {
    placeArtifact(
      { name: "", content, category, aggregateName } as HonoArtifact,
      origin,
      construct,
      opFragments,
    );
  };
  // Per-aggregate emission stays per-context — each aggregate file
  // and its repository / routes are emitted in the context that
  // owns the aggregate.
  //
  // Each concrete repository `implements` a domain-side `<Agg>RepositoryPort`
  // (audit S7 — hexagonal ports); the port members are DERIVED from the
  // concrete's own emitted public method headers (so `implements` always
  // type-checks) and pooled into one `domain/repository-ports.ts`.
  const portSpecs: RepoPortSpec[] = [];
  for (const ctx of contexts) {
    // Scaffold-once impl modules for any extern commandHandler / queryHandler.
    // No-op (byte-identical) for a context with none.
    emitExternHandlerImpls(ctx, out);
    for (const agg of ctx.aggregates) {
      // A TPH abstract base owns the shared table (emitted in db/schema.ts)
      // but is never instantiated — no domain module, repository, routes, or
      // tests.  Concrete subtypes carry all of that; their repository targets
      // the shared table filtered by `kind` (see the repository builders).
      if (agg.isAbstract) continue;
      const repo = findRepoFor(ctx, agg.name);
      const construct = `${ctx.name}.${agg.name}`;
      // Only collected when a recorder is actually threaded in — a
      // no-sourcemap run pays no per-statement bookkeeping cost.
      const opFragments: OpFragment[] | undefined = sourcemap ? [] : undefined;
      const aggContent = renderAggregate(agg, ctx, emitProvenance, emitTrace, opFragments);
      // Extern operations (extern-domain-extension-point.md §3a, decision (b)
      // Phase 2): the aggregate is emitted as an abstract `<Agg>Base`
      // (`domain/<agg>.base.ts`, regenerated) plus a scaffold-once concrete
      // `<Agg>` subclass (`domain/<agg>.ts`, user-owned) that implements each
      // op's extension-point hook.  Everyone still imports the concrete `<Agg>`.
      if (agg.operations.some((o) => o.extern)) {
        place("domain-aggregate-base", agg.name, aggContent, agg.origin, construct, opFragments);
        place(
          "domain-aggregate",
          agg.name,
          buildExternSubclassFile(agg, ctx),
          agg.origin,
          construct,
        );
      } else {
        place("domain-aggregate", agg.name, aggContent, agg.origin, construct, opFragments);
      }
      // Persistence routing.  Event-sourced (`persistedAs(eventLog)`) wins
      // over the saving-shape axis — its repository appends to / folds the
      // event stream rather than reading a state table.  Otherwise the
      // saving-shape routing applies: `document` → one jsonb blob + JSON
      // round-trip via `_create`; `embedded` → queryable root columns +
      // containments in jsonb columns; `relational` (default) → the
      // normalised table-per-entity hydrate.
      const shape = effectiveSavingShape(agg, resolveDataSource?.(agg));
      const repoContent = usingMikro
        ? // mikroorm: event-sourced aggregates use the EntityManager event
          // store (appliers, MikroORM edition); `shape(document)` folds the
          // whole tree into one jsonb blob; `shape(embedded)` folds only the
          // containments into jsonb columns.
          agg.persistedAs === "eventLog"
          ? renderMikroEventSourcedRepository(agg, repo, ctx)
          : shape === "document"
            ? renderMikroDocumentRepository(agg, repo, ctx)
            : shape === "embedded"
              ? renderMikroEmbeddedRepository(agg, repo, ctx)
              : renderMikroRepository(agg, repo, ctx)
        : agg.persistedAs === "eventLog"
          ? buildEventSourcedRepositoryFile(agg, repo, ctx, emitTrace)
          : shape === "document"
            ? buildDocumentRepositoryFile(agg, repo, ctx, emitTrace)
            : shape === "embedded"
              ? buildEmbeddedRepositoryFile(agg, repo, ctx, emitTrace)
              : buildRepositoryFile(agg, repo, ctx, emitTrace);
      place("drizzle-repository", agg.name, repoContent, repo?.origin ?? agg.origin, construct);
      // Derive this aggregate's repository PORT from the concrete just emitted
      // (audit S7) — pooled into `domain/repository-ports.ts` below.
      portSpecs.push({ aggName: agg.name, members: portMembersFromSource(repoContent) });
      // Routes file — adapter-dispatched in system mode (the layered
      // StyleAdapter re-derives audit / provenance gates from
      // ctx.contexts so the output matches `buildRoutesFile(...,
      // emitAudit, emitProvenance, emitTrace)` byte-for-byte); direct
      // call in legacy single-context mode.
      if (emitCtx) {
        // Resolved style / layout selection (D-REALIZATION-AXES) when
        // threaded in; sibling default otherwise.  Size-1 menus → same
        // object → byte-identical.
        const style = emitCtx.styleAdapter ?? layeredStyleAdapter;
        const artifacts = style.emitForAggregate?.(agg, emitCtx) ?? [];
        for (const artifact of artifacts) {
          placeArtifact(artifact as HonoArtifact, agg.origin, construct);
        }
      } else {
        const routesPath = `http/${lowerFirst(agg.name)}.routes.ts`;
        const routesContent = buildRoutesFile(
          agg,
          repo,
          ctx,
          emitAudit,
          emitProvenance,
          emitTrace,
          usingMikro,
        );
        out.set(routesPath, routesContent);
        sourcemap?.file(routesPath, routesContent, agg.origin, construct);
      }
      const testsFile = renderTestsFile(agg, ctx);
      if (testsFile) {
        place("domain-test", agg.name, testsFile, agg.origin, construct);
      }
    }
    // TPH (aggregate-inheritance.md): each `sharedTable` base owns the shared
    // table but has no per-concrete repo/routes.  Emit its polymorphic read
    // home — the `<Base>` discriminated union + a read-only `<Base>Repository`
    // (findById / findAll dispatching on `kind`) — so `find all <Base>` and
    // polymorphic `<Base> id` dereferences resolve to a tagged union.
    for (const base of ctx.aggregates) {
      if (!isTphBase(base, ctx.aggregates)) continue;
      const concretes = tphConcretesOf(base, ctx.aggregates) as typeof ctx.aggregates;
      if (concretes.length === 0) continue;
      const baseConstruct = `${ctx.name}.${base.name}`;
      place(
        "domain-aggregate",
        base.name,
        buildBaseUnionFile(base, concretes),
        base.origin,
        baseConstruct,
      );
      place(
        "drizzle-repository",
        base.name,
        usingMikro
          ? renderMikroBaseReader(base, concretes, ctx)
          : buildBaseReaderFile(base, concretes, ctx),
        base.origin,
        baseConstruct,
      );
    }
    // TPC (aggregate-inheritance.md, ownTable): the base owns no table, but is
    // the read home for the polymorphic `find all <Base>`.  Emit the `<Base>`
    // discriminated union + a read-only `<Base>Repository` that delegates to
    // the concrete repositories (findAll = union of each concrete's `all()`;
    // findById tries each).  The concretes are full standalone tables, so this
    // reuses their loaders rather than hand-rolling a column-aligned unionAll.
    for (const base of ctx.aggregates) {
      if (!isTpcBase(base, ctx.aggregates)) continue;
      const concretes = tpcConcretesOf(base, ctx.aggregates) as typeof ctx.aggregates;
      if (concretes.length === 0) continue;
      const baseConstruct = `${ctx.name}.${base.name}`;
      place(
        "domain-aggregate",
        base.name,
        buildBaseUnionFile(base, concretes, "ownTable"),
        base.origin,
        baseConstruct,
      );
      place(
        "drizzle-repository",
        base.name,
        usingMikro
          ? renderMikroTpcBaseReader(base, concretes)
          : buildTpcBaseReaderFile(base, concretes),
        base.origin,
        baseConstruct,
      );
    }
  }

  if (authRequired && system?.sys) {
    emitAuthFiles(system.sys, out);
  }
  emitObservabilityFiles(out);
  // Persist-time audit-stamp helper (node-persist-time-auditing): emitted once
  // per project when any served aggregate carries lifecycle stamps, so the
  // backend `save()` can stamp the audit columns from the ambient request
  // principal.  Adapter-agnostic — both drizzle (`.values(stampInsert(row))` /
  // `set: stampUpdate(row)`) and mikroorm (`em.upsert(row, stampInsert(...))`
  // + `onConflictExcludeFields`) consume it; it imports `requestContext` from
  // `obs/als`, present on every node adapter.
  {
    const audited = merged.aggregates.filter((a) => !a.isAbstract && aggregateIsAudited(a));
    if (audited.length > 0) {
      out.set("db/audit-stamp.ts", renderAuditStampHelper(audited));
    }
  }
  // Per-module Postgres migrations + Drizzle journal — emitted whenever
  // the system orchestrator hands us a migrations slice.  Empty slice
  // (non-system entry points) → no-op.
  // mikroorm owns its schema via `orm.schema.updateSchema()` at startup, so it
  // emits no drizzle migration files and `hasMigrations` stays false (which
  // suppresses the boot-time `migrate(...)` call in index.ts).
  const hasMigrations = !usingMikro && !!(system?.migrations && system.migrations.length > 0);
  if (hasMigrations) {
    emitTypescriptMigrations(system!.migrations!, out);
  }
  // First-boot seed data (database-seeding.md, Phase 2) — emits `db/seed.ts`
  // when the served contexts declare any `seed` block.  Through the domain
  // `create` (D-SEED-PATH), ship-once per dataset (D-SEED-IDEMPOTENCY).  The
  // mikroorm variant threads the same dataset functions through the
  // EntityManager (raw INSERTs + the `__loom_seed` marker via
  // `em.getConnection().execute`); the domain-`create` path is identical.
  if (merged.seeds.length > 0) {
    if (usingMikro) emitMikroSeeds(merged, out);
    else emitTypescriptSeeds(merged, out);
  }
  const hasSeeds = out.has("db/seed.ts");
  // decimal.js is conditional: only depended on when at least one
  // aggregate in any of the served contexts uses a `money` field.
  // Server bundle size matters; client-side React always ships the
  // dep.  Detected by walking the IR rather than scanning the rendered
  // strings.
  // Resource clients (objectStore / queue / api) — boot-time client
  // modules for the new infrastructure kinds the deployable wires
  // (RFC §Phase 2.4 foundation).  Additive + gated: a deployable with
  // no such resources emits nothing, so existing models stay
  // byte-identical.  No call-sites — those land with the workflow-level
  // consumption surface (Phase 4).
  const resourceDeps: Record<string, string> = {};
  const resourceImports: string[] = [];
  if (system) {
    const wired = new Set(system.deployable.dataSourceNames);
    const storeType = new Map(system.sys.storages.map((s) => [s.name, s.type] as const));
    const bySourceType = new Map<string, DataSourceIR[]>();
    for (const r of system.sys.dataSources) {
      if (!wired.has(r.name)) continue;
      if (r.kind !== "objectStore" && r.kind !== "queue" && r.kind !== "api" && r.kind !== "mailer")
        continue;
      const st = storeType.get(r.storageName);
      if (!st) continue;
      const group = bySourceType.get(st);
      if (group) group.push(r);
      else bySourceType.set(st, [r]);
    }
    const resourceCtx: EmitCtx = {
      deployable: system.deployable,
      contexts,
      sys: system.sys,
    };
    for (const [sourceType, group] of bySourceType) {
      const adapter = resourceAdapterFor(sourceType);
      if (!adapter) continue;
      out.set(
        `resources/${sourceType}.ts`,
        `${adapter.emitClientModule(group, system.sys.storages, resourceCtx).join("\n")}\n`,
      );
      Object.assign(resourceDeps, adapter.emitProjectDeps(resourceCtx));
      resourceImports.push(`import "./resources/${sourceType}";`);
    }
  }

  // TimerSource scheduling (scheduling.md, M-T4.1).  A timer's emit owner is
  // DERIVED: the deployable whose subdomain `migrationsOwner` owns the
  // for-event's context (single-fire lock owner == DB owner).  Filter the
  // system's timers to the ones THIS deployable owns; a timer-free deployable
  // stays byte-identical (no scheduler.ts, no import, no dep, no boot block).
  const ownedTimers: TimerSourceIR[] = system
    ? (system.sys.timerSources ?? []).filter((ts) => {
        const sub = system.sys.subdomains.find((s) =>
          s.contexts.some((c) => c.name === ts.context),
        );
        return sub?.migrationsOwner === system.deployable.name;
      })
    : [];
  const hasTimers = ownedTimers.length > 0 && !usingMikro;
  if (hasTimers) {
    const eventByName = new Map<string, EventIR>(merged.events.map((e) => [e.name, e]));
    out.set("scheduler.ts", renderTimerScheduler(ownedTimers, eventByName));
  }

  // Broker transport (channels.md; M-T4.4 slice 2).  A deployable that wires
  // a redis-bound broadcast channelSource via `channels:` gets the transport
  // module (ChannelTransport seam + ioredis driver + producer tee + consumer
  // loop); index.ts composes the tee into the dispatcher chain and starts the
  // consumers.  A deployable with no wired bindings stays byte-identical.
  const hasChannels = channelBindings.length > 0 && !usingMikro;
  if (hasChannels) {
    out.set("http/channels.ts", renderChannelsModule(channelBindings));
  }
  // Consumer side only when a hosted workflow actually subscribes (via a
  // hosted OR wired channel); a pure producer skips the loop and the
  // in-process dispatcher import.
  const hasChannelConsumers = hasChannels && merged.eventSubscriptions.some((s) => !s.projection);

  const projectUsesMoney = contexts.some(contextUsesMoney);
  out.set(
    "package.json",
    projectPackageJson(pins, {
      withMoney: projectUsesMoney,
      withOidc: !!oidcAuth,
      withCronTimers: hasTimers && anyTimerUsesCron(ownedTimers),
      withRedisChannels: hasChannels && channelBindings.some((b) => b.transport === "redis"),
      withRabbitChannels: hasChannels && channelBindings.some((b) => b.transport === "rabbitmq"),
      resourceDeps,
      hasSeeds,
      persistence: usingMikro ? "mikroorm" : "drizzle",
      // M18 phase 8 slice 1 (Node debug wiring): a `debug` script only when
      // `--sourcemap` is on — see the `addTsExtensionsForNodeDebug` call
      // below for why this needs the sibling import rewrite to actually run.
      debugScript: !!sourcemap,
    }),
  );
  // Shared primitive-schema helpers — one home for non-trivial wire
  // shapes (today: `moneySchema`).  Emitted only when something in
  // the project uses money so non-money projects' tsc surface stays
  // identical.
  if (projectUsesMoney) {
    out.set("lib/schemas.ts", LIB_SCHEMAS_MONEY_TS);
  }
  out.set("tsconfig.json", projectTsconfigJson(!!sourcemap));
  out.set("tsup.config.ts", TSUP_CONFIG);
  out.set(
    "index.ts",
    renderProjectIndexTs(
      hasMigrations,
      authRequired ? system?.sys.user : undefined,
      resourceImports,
      hasSeeds,
      usingMikro,
      // Outbox relay (dispatch-delivery-semantics.md): started at boot when
      // any context carries a durable channel AND the in-process dispatcher
      // is wired (subscriptions exist; drizzle persistence).
      !usingMikro &&
        (contexts.some((c) => c.eventSubscriptions.length > 0 && durableEventTypes(c).size > 0) ||
          // A durable-broker producer relays even without local subscribers:
          // the drained rows publish to the broker (M-T4.4 slice 3).
          (durableBrokerEvents.size > 0 && durableEventTypes(merged).size > 0)),
      // Realtime tee: the relay's inner dispatcher rides through it so
      // relayed (durable) events reach the SSE wire too.
      !usingMikro && contexts.some((c) => realtimeEventTypes(c).size > 0),
      // OIDC turnkey auth: register the generated verifier instead of the
      // dev stub.
      !!oidcAuth,
      // Hierarchy (multi-tenancy P2.2): the drizzle table var for the tenant
      // registry when it opts into `tenantRegistry` — boot registers the
      // `orgPath` resolver (`SELECT data_key … WHERE id = <claim>`) that the
      // auth middleware calls per request.  `undefined` for flat tenancy.
      authRequired && system
        ? (() => {
            const reg = hierarchyRegistry(system.sys);
            return reg ? lowerFirst(plural(reg.name)) : undefined;
          })()
        : undefined,
      // Timer scheduler (scheduling.md, M-T4.1): boot wires startTimerScheduler
      // into the same in-process dispatcher the outbox relay uses.
      hasTimers,
      // Broker transport (M-T4.4 slice 2): boot creates the redis transports,
      // wraps the app dispatcher in the publish tee, and starts the consumer
      // loop feeding the in-process dispatcher.
      hasChannels,
      hasChannelConsumers,
    ),
  );
  if (!usingMikro) out.set("drizzle.config.ts", DRIZZLE_CONFIG);
  out.set("Dockerfile", DOCKERFILE_TS);
  out.set(".dockerignore", DOCKERIGNORE_TS);
  out.set("certs/.gitkeep", "");
  // Pooled domain-side repository PORTS (audit S7) — the `<Agg>RepositoryPort`
  // interfaces the concrete repositories `implements` and the domain services
  // depend on (in place of the concrete class).  A raw `out.set` at a fixed
  // `domain/` path (like `domain/ids.ts`); its own aggregate imports are fixed
  // up by the layout post-pass below when byFeature relocates the aggregates.
  const portsFile = renderRepositoryPortsFile(portSpecs, merged);
  if (portsFile) out.set(PORT_POOL_PATH, portsFile);
  // D-REALIZATION-AXES `directoryLayout:` — when the layout relocated any
  // per-aggregate file (byFeature), fix up every relative import across the
  // project so the moved modules still resolve.  No-op (byte-identical) for the
  // byLayer default, where `moved` is empty.
  rewriteRelativeImports(out, moved);
  // M18 phase 8 slice 1 (Node debug wiring, docs/old/plans/dap-node-debug.md):
  // ONLY under `--sourcemap` — suffix every relative import with its real
  // `.ts`/`.tsx` extension so plain `node --enable-source-maps index.ts`
  // (no tsx/tsup loader) can resolve the whole module graph, chaining
  // through the phase-5 `.ts.map` sidecars straight to `.ddd` coordinates.
  // Flag-off keeps today's extensionless (Bundler-style) imports untouched.
  if (sourcemap) addTsExtensionsForNodeDebug(out);
  return out;
}

function findRepoFor(ctx: BoundedContextIR, name: string): RepositoryIR | undefined {
  return ctx.repositories.find((r) => r.aggregateName === name);
}

// The shared TypeScript/Hono emitter is version-agnostic.  Dep pins
// are owned by the active backend
// *package* (`src/platform/hono/<vN>/pins.ts`) and threaded in as a
// parameter; the emitter never imports a package (no shared→package
// edge), so it stays usable by any backend version and a future
// `hono@v5` just passes different pins.
export interface BackendPins {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

function projectPackageJson(
  pins: BackendPins,
  opts: {
    withMoney: boolean;
    withOidc?: boolean;
    /** scheduling.md, M-T4.1 — a `node-cron` dep, added only when an owned
     *  timerSource uses a real `cron:` expression (an `every:`-only deployable
     *  uses a bare setInterval and needs no dep). */
    withCronTimers?: boolean;
    /** M-T4.4 slice 2 — the `ioredis` broker-client dep, added only when the
     *  deployable wires a redis-bound channelSource via `channels:`. */
    withRedisChannels?: boolean;
    /** M-T4.4 slice 3 — the `amqplib` broker-client dep (+ its types), added
     *  only when the deployable wires a rabbitmq-bound channelSource. */
    withRabbitChannels?: boolean;
    resourceDeps?: Record<string, string>;
    hasSeeds?: boolean;
    persistence?: "drizzle" | "mikroorm";
    /** M18 phase 8 slice 1 (Node debug wiring) — a `debug` script that runs
     *  the project under plain Node (no tsx/tsup loader), chaining Node's
     *  own `--enable-source-maps` through the phase-5 `.ts.map` sidecars
     *  straight to `.ddd` coordinates.  Requires the sibling
     *  `addTsExtensionsForNodeDebug` import rewrite (this file's caller) —
     *  both are gated on the SAME `--sourcemap` flag, so they always ship
     *  together.  Targets the docker image's node:24 (unflagged type
     *  stripping); see docs/old/plans/dap-node-debug.md for why
     *  `--experimental-strip-types` is deliberately NOT included. */
    debugScript?: boolean;
  },
): string {
  const mikro = opts.persistence === "mikroorm";
  // mikroorm owns its schema at runtime (no drizzle-kit), so it drops the
  // drizzle dep/devDep + the `db:*` CLI scripts; @mikro-orm packages take their
  // place.  Default `drizzle` keeps the existing shape byte-identical.
  const { "drizzle-orm": _drizzleOrm, ...depsNoDrizzle } = pins.dependencies as Record<
    string,
    string
  >;
  const { "drizzle-kit": _drizzleKit, ...devDepsNoDrizzle } = pins.devDependencies as Record<
    string,
    string
  >;
  const dependencies = mikro
    ? {
        ...depsNoDrizzle,
        "@mikro-orm/core": "^6.4.0",
        "@mikro-orm/postgresql": "^6.4.0",
      }
    : { ...pins.dependencies };
  const devDependencies = {
    ...(mikro ? { ...devDepsNoDrizzle } : { ...pins.devDependencies }),
    // Types for the node-cron scheduler dep (scheduling.md) — devDep so the
    // generated project's `tsc --noEmit` resolves `import cron from "node-cron"`.
    ...(opts.withCronTimers ? { "@types/node-cron": "^3.0.11" } : {}),
    // Types for the amqplib broker dep (M-T4.4 slice 3) — devDep so the
    // generated project's `tsc --noEmit` resolves `import amqp from "amqplib"`.
    ...(opts.withRabbitChannels ? { "@types/amqplib": "^0.10.5" } : {}),
  };
  const dbScripts = mikro
    ? {}
    : {
        // We emit Drizzle-format `meta/_journal.json` + .sql files so
        // both `drizzle-kit migrate` (the CLI) and
        // `drizzle-orm/.../migrator` (called from index.ts at boot)
        // can apply them.  `drizzle-kit generate` is left available
        // for users who want to introspect the schema, but Loom owns
        // the SQL generation end-to-end.
        "db:generate": "drizzle-kit generate",
        "db:migrate": "drizzle-kit migrate",
        "db:push": "drizzle-kit push",
        "db:studio": "drizzle-kit studio",
      };
  return (
    JSON.stringify(
      {
        name: "ddd-generated-app",
        version: "0.0.0",
        type: "module",
        private: true,
        scripts: {
          dev: "tsx index.ts",
          build: "tsup",
          typecheck: "tsc --noEmit",
          test: "vitest run",
          ...dbScripts,
          // First-boot seed runner (database-seeding.md) — emitted only when
          // the model declares a `seed` block, else `db/seed-cli.ts` doesn't
          // exist.  A separate CLI file: the importable db/seed.ts must carry
          // no self-executing entry (a run-directly guard misfires once tsup
          // bundles it into dist/index.js, seeding before migrations).
          ...(opts.hasSeeds ? { "db:seed": "tsx db/seed-cli.ts" } : {}),
          // M18 phase 8 slice 1 (Node debug wiring, --sourcemap only): plain
          // Node, no tsx/tsup loader — see the `debugScript` jsdoc above.
          ...(opts.debugScript ? { debug: "node --enable-source-maps index.ts" } : {}),
        },
        dependencies: {
          ...dependencies,
          ...(opts.withMoney ? { "decimal.js": "^10.4.3" } : {}),
          // OIDC token verification (D-AUTH-OIDC) — jose owns JWKS fetch +
          // signature/claims validation in the generated verifier.
          ...(opts.withOidc ? { jose: "^5.9.0" } : {}),
          // Timer scheduler (scheduling.md) — node-cron parses real cron
          // expressions; an `every:`-only deployable stays on setInterval.
          ...(opts.withCronTimers ? { "node-cron": "^3.0.3" } : {}),
          // Broker transport (M-T4.4 slice 2) — ioredis (MIT, design §6a)
          // speaks RESP to the compose-provisioned Valkey sidecar.
          ...(opts.withRedisChannels ? { ioredis: "^5.4.0" } : {}),
          // Broker transport (M-T4.4 slice 3) — amqplib (MIT, design §6a)
          // speaks AMQP 0-9-1 to the compose-provisioned RabbitMQ sidecar.
          ...(opts.withRabbitChannels ? { amqplib: "^0.10.4" } : {}),
          ...(opts.resourceDeps ?? {}),
        },
        devDependencies,
      },
      null,
      2,
    ) + "\n"
  );
}

const DRIZZLE_CONFIG = `// Auto-generated.  Drizzle Kit configuration — adjust to taste.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
  },
});
`;

// Shared primitive-schema helpers — emitted to `lib/schemas.ts` when
// the project uses money.  Single canonical wire-shape for the
// money primitive: parses a decimal-formatted string, surfaces parse
// failures as typed Zod issues (so bad input becomes a typed 400, not
// an uncaught throw → 500), and exposes the parsed `Decimal`
// instance to route handlers.  Routes reference `moneySchema` rather
// than redeclaring the chain at every field site.
const LIB_SCHEMAS_MONEY_TS = `// Auto-generated.  Do not edit by hand.
import Decimal from "decimal.js";
import { z } from "@hono/zod-openapi";

/**
 * Wire schema for the \`money\` primitive.
 *
 * Inbound JSON: a decimal-formatted string (\`"123.4500"\`).  Parses
 * to a \`decimal.js\` Decimal instance.  Format violations and parse
 * failures both surface as typed Zod issues — invalid input becomes
 * a 400 with the field name attached, not an uncaught throw.
 */
export const moneySchema = z.string().transform((s, ctx) => {
  if (!/^-?\\d+(\\.\\d+)?$/.test(s)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: \`Invalid decimal: \${JSON.stringify(s)}\`,
    });
    return z.NEVER;
  }
  try {
    return new Decimal(s);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: \`Invalid decimal: \${JSON.stringify(s)}\`,
    });
    return z.NEVER;
  }
});
`;

/** `debugImports` — M18 phase 8 slice 1 (Node debug wiring, `--sourcemap`
 *  only): once `addTsExtensionsForNodeDebug` suffixes relative imports with
 *  their real `.ts`/`.tsx` extension, plain `tsc --noEmit` (the project's
 *  own `typecheck` script) rejects them with TS5097 ("An import path can
 *  only end with a '.ts' extension when 'allowImportingTsExtensions' is
 *  enabled") unless that option is set — confirmed empirically, see
 *  docs/old/plans/dap-node-debug.md. `noEmit` (already set below) is the other
 *  half of that flag's precondition. Flag-off keeps this field absent, so
 *  the emitted tsconfig.json is byte-identical to before. */
function projectTsconfigJson(debugImports: boolean): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          // ES2022 is the highest target drizzle-kit's bundled
          // @esbuild-kit/esm-loader accepts; tsup's own `target: "node24"`
          // (in tsup.config.ts) is what governs the prod bundle.
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          // tsup handles emit (single bundled `dist/index.js`); tsc is
          // type-check only via `npm run typecheck`.
          noEmit: true,
          // `Bundler` resolution lets relative imports omit the `.js`
          // extension — esbuild (via tsup at build time, tsx at dev
          // time, vite-node at test time) resolves them.
          ...(debugImports ? { allowImportingTsExtensions: true } : {}),
        },
        include: ["**/*.ts"],
        exclude: ["node_modules", "dist"],
      },
      null,
      2,
    ) + "\n"
  );
}

const TSUP_CONFIG = `// Auto-generated.  tsup bundles index.ts → dist/index.js for
// production.  Externals match runtime deps from package.json so
// pg's native bindings + drizzle's heavy modules stay outside the
// bundle (loaded from node_modules at runtime).
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  splitting: false,
  // \`tsc --noEmit\` (npm run typecheck) is the type-check; tsup is
  // build-only, no .d.ts emit needed.
  dts: false,
});
`;

function renderProjectIndexTs(
  runMigrationsAtBoot: boolean,
  userShape?: UserIR,
  resourceImports: readonly string[] = [],
  runSeedsAtBoot = false,
  usingMikro = false,
  outboxRelay = false,
  hasRealtime = false,
  oidc = false,
  orgPathRegistryTable?: string,
  hasTimers = false,
  hasChannels = false,
  hasChannelConsumers = false,
): string {
  // Side-effect imports for the resource-client modules (objectStore /
  // queue / api) so their clients instantiate at boot.  Empty for
  // deployables with no such resources — byte-identical to before.
  const resourceImportBlock = resourceImports.length > 0 ? `${resourceImports.join("\n")}\n` : "";
  const migImport = runMigrationsAtBoot
    ? `import { migrate } from "drizzle-orm/node-postgres/migrator";\n`
    : "";
  const seedImport = runSeedsAtBoot ? `import { runSeeds } from "./db/seed";\n` : "";
  const seedCall = runSeedsAtBoot
    ? `\n// Apply first-boot seed data after migrations (database-seeding.md).\n// Ship-once per dataset via the __loom_seed marker; idempotent across boots.\nawait runSeeds(db);\n`
    : "";
  const migCall = runMigrationsAtBoot
    ? `\n// Apply pending schema migrations before serving traffic.  Drizzle's\n// runtime migrator reads db/migrations/meta/_journal.json + each\n// referenced .sql file, tracking state in \`__drizzle_migrations\`;\n// idempotent across boots.  Bracketed with the catalog migration\n// lifecycle events (observability.md) — drizzle's migrator runs the\n// whole batch in one opaque call, so there's no per-migration\n// \`migration_applied\` seam (Hono limitation; Python/.NET emit it).\n${renderHonoBaseLogCall("migrationsStarting")}\ntry {\n  await migrate(db, { migrationsFolder: "./db/migrations" });\n  ${renderHonoBaseLogCall("migrationsComplete")}\n} catch (err) {\n  ${renderHonoBaseLogCall("migrationFailed", "error: err instanceof Error ? err.message : String(err)")}\n  throw err;\n}\n`
    : "";
  // createApp() calls assertUserVerifierRegistered() when auth is required.
  // With an `auth { oidc }` block (D-AUTH-OIDC) we register the generated
  // OIDC verifier; otherwise we emit a permissive dev stub so the stack
  // boots out of the box (replace in production with a real verifier).
  // The in-process dispatcher is constructed once and shared by the outbox
  // relay and/or the timer scheduler (scheduling.md, M-T4.1).
  const needsDispatcher = outboxRelay || hasTimers || hasChannels;
  // `createInProcessDispatcher` exists in http/workflows.ts only when the
  // deployable has channel-routed workflow subscriptions.  A pure-producer
  // deployable (wires a broker channel, hosts no reactors) falls back to the
  // always-exported Noop as the tee's inner dispatcher.
  const withInProcess = outboxRelay || hasTimers || hasChannelConsumers;
  const authStubImport = !userShape
    ? ""
    : oidc
      ? `import { registerOidcVerifier } from "./auth/oidc";\n`
      : `import { registerUserVerifier } from "./auth/verifier";\n`;
  const authStubCall = !userShape
    ? ""
    : oidc
      ? `\n// OIDC verifier (D-AUTH-OIDC) — validates the IdP's tokens against its\n// JWKS and maps claims onto the typed User.  Configure the issuer /\n// client via the env vars the \`auth { oidc }\` block referenced.\nregisterOidcVerifier();\nbaseLogger.info({ event: "auth_oidc_verifier_registered" });\n`
      : `\n// Dev-stub verifier — accepts every request as a built-in admin user.\n// Dev-only: the Loom playground (or curl) can override the claims by\n// sending a base64-encoded JSON object in \`x-loom-dev-claims\`; absent the\n// header the built-in identity is used.  REPLACE for production by calling\n// registerUserVerifier(...) with a real JWT-decoding implementation.\nregisterUserVerifier((req) => {\n  const base = ${indentContinuation(renderStubUserLiteral(userShape), "  ")};\n  const injected = req.headers.get("x-loom-dev-claims");\n  if (!injected) return base;\n  try {\n    return { ...base, ...JSON.parse(Buffer.from(injected, "base64").toString("utf8")) };\n  } catch {\n    return base;\n  }\n});\nbaseLogger.warn({ event: "auth_dev_stub_registered" });\n`;
  // Tenant-registry orgPath resolver (multi-tenancy P2.2) — wired only on the
  // drizzle path (mikroorm hierarchy falls back to the claim via the
  // unregistered-resolver path).  The auth middleware calls it per request;
  // here we bind it to the db with a `SELECT data_key … WHERE id = <claim>`.
  const wireOrgPath = !!orgPathRegistryTable && !usingMikro;
  const orgPathImport = wireOrgPath
    ? `import { eq } from "drizzle-orm";\nimport { registerOrgPathResolver } from "./auth/middleware";\n`
    : "";
  const orgPathRegistration = wireOrgPath
    ? `\n// Register the tenant-registry \`orgPath\` resolver (multi-tenancy P2.2):\n// currentUser.orgPath = the caller org's materialized \`data_key\`, memoized\n// per request in the auth middleware; a missing row / dataKey falls back to\n// the claim (root-segment path) — fail-safe, never null/crash.\nregisterOrgPathResolver(async (claim) => {\n  const rows = await db\n    .select({ dataKey: schema.${orgPathRegistryTable}.dataKey })\n    .from(schema.${orgPathRegistryTable})\n    .where(eq(schema.${orgPathRegistryTable}.id, claim))\n    .limit(1);\n  return rows[0]?.dataKey ?? null;\n});\n`
    : "";
  // Persistence wiring (D-REALIZATION-AXES `persistence:`) — drizzle (pg pool +
  // boot-time migrate) vs mikroorm (MikroORM.init + schema:update at startup).
  // The drizzle import header is kept byte-identical to the pre-mikroorm shape.
  const importHeader = usingMikro
    ? `import { serve } from "@hono/node-server";
import { createApp } from "./http/index";
${MIKRO_INDEX_IMPORTS.join("\n")}
${seedImport}${authStubImport}import { baseLogger } from "./obs/log";`
    : `import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { serve } from "@hono/node-server";
import * as schema from "./db/schema";
import { createApp } from "./http/index";
${
  // The in-process dispatcher is shared by the outbox relay and the timer
  // scheduler (scheduling.md) — import it (and the realtime tee) whenever
  // either is wired; the outbox-only helpers stay behind the outbox flag.
  needsDispatcher
    ? `${
        withInProcess
          ? `import { createInProcessDispatcher${
              outboxRelay ? ", createOutboxDispatcher, startOutboxRelay" : ""
            } } from "./http/workflows";\n`
          : `import { NoopDomainEventDispatcher } from "./domain/events";\n${
              // Pure producer of durable broker-bound events (M-T4.4 slice 3):
              // the outbox captures on save; the relay publishes on drain.
              outboxRelay
                ? `import { createOutboxDispatcher, startOutboxRelay } from "./http/workflows";\n`
                : ""
            }`
      }${hasRealtime ? `import { realtimeTee } from "./http/realtime";\n` : ""}${
        hasTimers ? `import { startTimerScheduler } from "./scheduler";\n` : ""
      }${
        hasChannels
          ? `import { channelPublishTee, createChannelTransports${
              hasChannelConsumers ? ", startChannelConsumers" : ", closeChannelTransports"
            } } from "./http/channels";\n`
          : ""
      }`
    : ""
}${migImport}${seedImport}${authStubImport}${orgPathImport}import { baseLogger } from "./obs/log";`;
  const connectionBlock = usingMikro
    ? `// Persistence connection — owned by the mikroorm PersistenceAdapter\n// (MikroORM.init → dev schema bootstrap → EntityManager as \`db\`).\n${mikroConnectionSetup().join("\n")}`
    : `// Persistence connection — owned by the drizzle PersistenceAdapter\n// (DATABASE_URL guard → pg pool → pool-error logging → drizzle db).\n${DRIZZLE_CONNECTION_SETUP.join("\n")}`;
  // mikroorm bootstraps its schema inside the connection block (updateSchema),
  // so it never emits the drizzle boot-time migrate call.
  const effectiveMigCall = usingMikro ? "" : migCall;
  return `// Auto-generated.
${importHeader}
${resourceImportBlock}
${connectionBlock}

const port = Number(process.env.PORT ?? 3000);
baseLogger.info({ event: "server_starting", port, env: process.env.NODE_ENV ?? "development" });
${effectiveMigCall}${seedCall}${authStubCall}${orgPathRegistration}${
  needsDispatcher
    ? `${
        outboxRelay
          ? `// Transactional outbox (dispatch-delivery-semantics.md): durable events
// (channels with retention: log | work) are recorded in __loom_outbox by
// the app's dispatcher; the relay drains them through the in-process
// dispatcher at-least-once.  Consumers must tolerate redelivery.
`
          : `// In-process event dispatcher — shared with the timer scheduler
// (scheduling.md): tick events dispatch through the same routing sagas use.
`
      }const inProcessEvents = ${
        withInProcess
          ? hasRealtime
            ? "realtimeTee(createInProcessDispatcher(db))"
            : "createInProcessDispatcher(db)"
          : hasRealtime
            ? "realtimeTee(NoopDomainEventDispatcher)"
            : "NoopDomainEventDispatcher"
      };
${
  hasChannels
    ? `// Broker transport (channels.md; M-T4.4): one shared redis connection set
// per LOOM_CHANNEL_*_URL.  The publish tee routes broker-bound events to
// the broker (co-located consumers receive them via the subscription, not
// a local shortcut); the consumer loop feeds received envelopes into the
// same in-process dispatcher local reactors use.
const channelTransports = createChannelTransports();
`
    : ""
}const app = ${
        hasChannels
          ? `createApp(db, channelPublishTee(channelTransports, ${
              outboxRelay ? "createOutboxDispatcher(db, inProcessEvents)" : "inProcessEvents"
            }))`
          : outboxRelay
            ? "createApp(db, createOutboxDispatcher(db, inProcessEvents))"
            : "createApp(db)"
      };
${hasChannelConsumers ? "const stopChannelConsumers = startChannelConsumers(channelTransports, inProcessEvents);\n" : ""}${
  outboxRelay
    ? hasChannels
      ? `// The relay's dispatcher rides the publish tee in RELAY mode: drained
// durable events whose channel is broker-bound publish to the broker
// (design §5 — outbox-drain → broker publish); the rest re-enter the
// local chain.
const stopOutboxRelay = startOutboxRelay(db, channelPublishTee(channelTransports, inProcessEvents, { fromRelay: true }));
`
      : "const stopOutboxRelay = startOutboxRelay(db, inProcessEvents);\n"
    : ""
}${
  hasTimers
    ? `// Timer sources (scheduling.md): infrastructure fires tick events on a
// wall-clock cadence, single-fire across replicas via a pg advisory lock.
const stopTimers = startTimerScheduler(db, inProcessEvents);
`
    : ""
}`
    : `const app = createApp(db);
`
}const server = serve({ fetch: app.fetch, port });
baseLogger.info({ event: "server_listening", port });

// Graceful shutdown — close the HTTP server (stops accepting,
// drains in-flight), then close the pg pool.  Without this SIGTERM
// drops in-flight work and leaves pg connections lingering.  Both
// SIGTERM (orchestrator) and SIGINT (Ctrl-C) are handled.
async function shutdown(signal: string): Promise<void> {
  baseLogger.info({ event: "server_shutdown", signal });${
    outboxRelay
      ? `
  stopOutboxRelay();`
      : ""
  }${
    hasTimers
      ? `
  stopTimers();`
      : ""
  }${
    hasChannelConsumers
      ? `
  await stopChannelConsumers();`
      : hasChannels
        ? `
  await closeChannelTransports(channelTransports);`
        : ""
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  baseLogger.info({ event: "server_drained" });
  ${usingMikro ? "await orm.close();" : "await pool.end();"}
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
`;
}

/** Re-indent a multi-line snippet for embedding at a deeper nesting:
 *  every line after the first gets `pad` prepended (blank lines stay
 *  blank).  Keeps an interpolated object literal Biome-clean inside a
 *  nested function body. */
function indentContinuation(s: string, pad: string): string {
  return s
    .split("\n")
    .map((line, i) => (i === 0 || line.length === 0 ? line : pad + line))
    .join("\n");
}

/** Build a TS object literal matching the system's `user {}` shape, with
 *  sensible defaults per primitive type — used as the body of the dev-stub
 *  user verifier so a generated app boots without the caller having to wire
 *  a JWT decoder. */
function renderStubUserLiteral(userShape: UserIR): string {
  const entries = userShape.fields.map((f) => `  ${snakeToCamel(f.name)}: ${stubValueFor(f)}`);
  return `{\n${entries.join(",\n")},\n}`;
}

function stubValueFor(f: FieldIR): string {
  if (f.optional) return "null";
  return stubValueForType(f.type);
}

function stubValueForType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "string":
          return `"admin"`;
        case "int":
        case "long":
          return "0";
        case "decimal":
        case "money":
          return `"0"`;
        case "bool":
          return "false";
        case "datetime":
          return `new Date(0)`;
        case "guid":
          return `"00000000-0000-0000-0000-000000000000"`;
        default:
          return `""`;
      }
    case "id":
      return `"00000000-0000-0000-0000-000000000000"`;
    case "array":
      return "[]";
    default:
      return "null";
  }
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// Multi-stage Dockerfile: build stage installs all deps and compiles
// TypeScript; runtime stage uses a smaller production-only image.
const DOCKERFILE_TS = `# syntax=docker/dockerfile:1
# Auto-generated.

FROM node:24-alpine AS build
WORKDIR /app
# Optional proxy CAs — drop *.crt files into ./certs/ to make npm
# trust them.  The directory always exists (with a .gitkeep), so
# this COPY is a no-op when no CAs are configured.
COPY certs/ /usr/local/share/ca-certificates/
RUN cat /usr/local/share/ca-certificates/*.crt 2>/dev/null >> /etc/ssl/cert.pem || true
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem NPM_CONFIG_CAFILE=/etc/ssl/cert.pem
COPY package.json ./
# Use plain "npm install" rather than "npm ci": the generator emits no
# package-lock.json so npm ci exits with EUSAGE.  --no-audit --no-fund
# keeps the build log clean and skips two registry round-trips.
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Drizzle's runtime migrator reads migration SQL + meta/_journal.json
# from disk; without these the process crashes on boot with
# "Can't find meta/_journal.json file".
COPY --from=build /app/db/migrations ./db/migrations
EXPOSE 3000
CMD ["node", "dist/index.js"]
`;

const DOCKERIGNORE_TS = `# Auto-generated.
node_modules
out
.git
.env
.env.*
*.log
`;
