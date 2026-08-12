// The api's operation set, as IR data — the single source of truth for what
// an `api` actually exposes over HTTP.
//
// WHY THIS EXISTS.  Until this module, the auto-CRUD route surface was not IR
// data: every backend re-derived it inside its own route builder (Hono's
// `routes-builder.ts` alone is ~2k lines, with independent .NET / Java /
// Python / Elixir siblings), and `.loom/wire-spec.json` carried types but no
// routes.  Nothing in the pipeline could answer "what operations does
// `api SalesApi` expose, at which method and path, with which request and
// response types" — so nothing could type a CALL to it.
//
// The identity half was already centralized: `openapi-ids.ts` owns the
// canonical operationId token arrays every backend renders, and its doc
// comments already state each operation's canonical method + path
// (`POST /<aggs>`, `GET /<aggs>/{id}`, …).  This module promotes that
// documented shape into returned DATA and pairs it with the request/response
// `TypeIR`, so a consumer gets the whole operation rather than just its name.
//
// CONSUMERS.  The in-system typed service-to-service client (M-T4.8) was the
// first; since the route-builder unification, ALL FIVE backend route builders
// render from this derivation — route-set membership, paths, and declared
// error statuses come from here (Hono `routes-builder.ts`, .NET
// `cqrs/controller.ts`+`emit/api.ts`, python `routes-builder.ts`, java
// `emit/api.ts`+`openapi-customizer.ts`, elixir `vanilla/api-emit.ts`+
// `openapi-emit.ts`) — plus the five api-CLIENT emitters and the `.loom/`
// artifact bundle.
//
// FIDELITY.  The derivation was modelled on the SHIPPED Hono surface, and
// until the unification four independent re-derivations were held against it
// (`api-surface-parity.test.ts`, since retired).  Now that the builders
// render FROM it, fidelity means the RENDERING: `api-surface.test.ts` scrapes
// Hono's emitted bytes against this list, and each backend has a
// `test/generator/<backend>/api-surface-render.test.ts` sibling.
//
// SCOPE (honest partial).  This slice lifts the AGGREGATE surface: create,
// getById, destroy, domain operations + their gate probes, and repository
// finds.  Workflow, explicit-handler, projection and `prepare` routes are NOT
// yet lifted — see `apiSurfaceCoverage` below, which names them so a consumer
// can tell "no such operation" from "not yet derived" instead of silently
// treating the set as complete.
//
// `prepare` is deliberately excluded rather than forgotten: whether an
// aggregate emits `GET /<aggs>/prepare` is decided by
// `serverSourcedDefaultFields`, which sits in `generator/_frontend/` because
// it depends on `renderDefaultSeed`'s client-evaluable-subset RENDERER.  An
// `ir/util/` module importing it would be a backward edge across the
// `ir → generator` boundary (`pipeline-layering.test.ts` fails on exactly
// that).  Lifting `prepare` therefore means first splitting that predicate
// from its renderer — a separate, self-contained piece of work — and the
// typed service-to-service client does not need it (it is a UI form-seeding
// endpoint).

import { API_BASE_PATH } from "../../util/api-base.js";
import { resolveErrorStatus } from "../../util/error-defaults.js";
import { plural, snake } from "../../util/naming.js";
import { emitsRestCreate, emitsRestDestroy } from "../enrich/wire-projection.js";
import {
  type AggregateIR,
  type BoundedContextIR,
  type FindIR,
  type OperationIR,
  operationIsGuarded,
  type RepositoryIR,
  type TypeIR,
} from "../types/loom-ir.js";
import { errorStatuses } from "./openapi-errors.js";
import {
  camelId,
  type OpIdTokens,
  opCreate,
  opDestroy,
  opFind,
  opGetById,
  opOperation,
} from "./openapi-ids.js";
import { aggregateIsVersioned } from "./versioned-capability.js";

/** HTTP method, lowercase — the form every backend's route table uses. */
export type ApiMethod = "get" | "post" | "put" | "patch" | "delete";

/** What a caller sends in the request body / path / query. */
export interface ApiOperationParamIR {
  readonly name: string;
  readonly type: TypeIR;
  /** Where the value rides: a `{…}` path placeholder, a `?a=b` query
   *  parameter, or the JSON request body. */
  readonly location: "path" | "query" | "body";
}

/** One HTTP operation an `api` exposes.
 *
 *  `path` is ABSOLUTE and includes `API_BASE_PATH` plus the aggregate segment
 *  — i.e. exactly what a caller puts on the wire (`/api/orders/{id}`), not the
 *  router-relative fragment the backend emitters use (`/{id}`).  A client
 *  emitter must not have to know how the callee mounts its sub-routers. */
export interface ApiOperationIR {
  /** Canonical operationId tokens — rendered per backend idiom by
   *  `camelId` / `snakeId`.  The cross-backend identity of this operation. */
  readonly idTokens: OpIdTokens;
  /** `camelId(idTokens)` — the stable handle a caller writes
   *  (`orders.getOrderById(...)`). */
  readonly id: string;
  readonly method: ApiMethod;
  readonly path: string;
  /** Aggregate this operation belongs to, for grouping + tags. */
  readonly aggregate: string;
  /** Which shipped route emitted it — lets a consumer reason about the
   *  operation class without re-parsing the path. */
  readonly kind: "create" | "getById" | "destroy" | "operation" | "gateProbe" | "find";
  readonly params: readonly ApiOperationParamIR[];
  /** Success (2xx) response type.  Absent for a 204 (destroy). */
  readonly responseType?: TypeIR;
  /** Non-2xx statuses this operation can answer with, so a client can type
   *  its failure union instead of collapsing every error into a throw.
   *  Resolved through the context's `httpStatus` maps when the derivation is
   *  given them (see `ApiStatusContext`) — i.e. these are the statuses the
   *  backend actually answers, not the unremapped defaults. */
  readonly errorStatuses: readonly number[];
  /** The `FindIR` a `kind: "find"` operation was derived from — so a route
   *  builder rendering this list can hand its existing find emitter the
   *  underlying IR node instead of re-locating it by name. */
  readonly find?: FindIR;
  /** The `OperationIR` behind a `kind: "operation"` or `"gateProbe"` entry —
   *  same purpose as `find`. */
  readonly operation?: OperationIR;
}

/** The per-context `httpStatus` override maps the derivation resolves error
 *  statuses through — the same two maps every backend's route emitter reads
 *  (`BoundedContextIR.errorStatusOverrides` for user `error` payloads,
 *  `.structuralErrorStatuses` for the structural-conflict built-ins).
 *  `deriveContextOperations` threads them automatically; passing nothing keeps
 *  the stdlib defaults, which is correct for single-context (no-api) lowering
 *  where the maps are undefined anyway. */
export interface ApiStatusContext {
  readonly errorStatusOverrides?: Readonly<Record<string, number>>;
  readonly structuralErrorStatuses?: Readonly<Record<string, number>>;
  /** Names of the context's `error`-kind payloads — how a union RETURN's error
   *  arms are told apart from its success arms (both are `entity` variants in
   *  `TypeIR`; only the payload catalogue knows which is which, the same
   *  `ctx.payloads.some(p => p.name === v.name && p.kind === "error")` read
   *  the .NET `buildReturnUnionSpec` performs). */
  readonly errorPayloadNames?: ReadonlySet<string>;
}

/** The `httpStatus` map the DOMAIN FLOOR (`DomainError`) and `Forbidden` rungs
 *  resolve against (M-T5.20) — the same merge `denialOverrides` performs for
 *  the elixir backend: `errorStatusOverrides` (per-subdomain, carries every
 *  declared name) with `structuralErrorStatuses` (the app-wide fold) layered
 *  on top. Neither rung has a per-context tag of its own — both surface in
 *  app-global handlers — so this merge is what lets `httpStatus DomainError ->
 *  400` reach the declared response set here, matching the resolved status
 *  each backend's own runtime handler answers with. */
function denialOverridesFor(statuses: ApiStatusContext | undefined): Record<string, number> {
  return { ...statuses?.errorStatusOverrides, ...statuses?.structuralErrorStatuses };
}

/** Route classes NOT yet lifted into `ApiOperationIR`.  Exported so a
 *  consumer can surface an honest "not derived yet" rather than treating the
 *  operation set as exhaustive. */
export const apiSurfaceCoverage = {
  lifted: ["create", "getById", "destroy", "operation", "gateProbe", "find"] as const,
  notLifted: [
    "prepare",
    "workflow",
    "workflowInstances",
    "explicitHandler",
    "projectionQuery",
    // GET /<aggs>/{id}/history — the audit-history read.  Driven by the
    // SYNTHESIZED history find (`find.synthesized`, skipped below), so it was
    // never lifted; named here so the omission is a documented decision rather
    // than a hole discovered by diffing routers against this list.
    "history",
  ] as const,
} as const;

/** The URL segment an aggregate's routes mount under — `Order` → `orders`.
 *  Matches every backend's `snake(plural(agg.name))`. */
export function aggregateSegment(aggName: string): string {
  return snake(plural(aggName));
}

/** Absolute mount prefix for an aggregate's routes (`/api/orders`). */
function aggregateBase(aggName: string): string {
  return `${API_BASE_PATH}/${aggregateSegment(aggName)}`;
}

function idParam(): ApiOperationParamIR {
  return { name: "id", type: { kind: "primitive", name: "guid" }, location: "path" };
}

/** The success aggregate of an ABSENCE union (`Order option` / `Order or
 *  NotFound`), or undefined when the type is not one.
 *
 *  This is the one union shape a client has to treat specially, and the reason
 *  is on the wire, not in the type: a union find answers the success body
 *  DIRECTLY at 200 and rides the absent variant on its own status — there is no
 *  `type` discriminator (payloads.md §"Union finds — the untagged exception").
 *  So a client returns `T | null`, matching what a local union find binds and
 *  what a variant-`match` narrows against.
 *
 *  Shared rather than re-derived per backend: five client emitters need the
 *  same answer, and five copies of a rule is how this feature already shipped
 *  the same defect five times over. */
export function absenceUnionSuccess(t: TypeIR | undefined): string | undefined {
  if (t?.kind !== "union" || t.variants.length !== 2) return undefined;
  const entity = t.variants.find((v) => v.kind === "entity");
  const absent = t.variants.find((v) => v.kind !== "entity");
  return entity?.kind === "entity" && absent ? entity.name : undefined;
}

/** The aggregate a COLLECTION-returning operation answers with, plus the
 *  carrier it rides in.
 *
 *  Two carriers reach the wire.  The auto-`findAll` returns `paged`, whose body
 *  is the envelope `{ items, page, pageSize, total, totalPages }`; a declared
 *  find returning `T[]` answers with a bare JSON array.  A client that ignores
 *  the distinction either loses the pagination fields or tries to read `.items`
 *  off an array.
 *
 *  Shared for the same reason as `absenceUnionSuccess` above: five emitters
 *  need one answer, and this feature has already shipped the same defect five
 *  times over from five copies of a rule. */
export function collectionSuccess(
  t: TypeIR | undefined,
): { readonly agg: string; readonly carrier: "paged" | "array" } | undefined {
  if (!t) return undefined;
  if (t.kind === "genericInstance" && t.ctor === "paged" && t.arg.kind === "entity") {
    return { agg: t.arg.name, carrier: "paged" };
  }
  if (t.kind === "array" && t.element.kind === "entity") {
    return { agg: t.element.name, carrier: "array" };
  }
  return undefined;
}

/** The ABSENT variant of an absence union returned by a find on `aggName`'s
 *  repository: the `none` unit, or the error payload it rides out on.
 *
 *  Distinct from `absenceUnionSuccess` because the two shapes are NOT the same
 *  in `TypeIR`: `Order or NotFound`'s absent arm is `kind: "none"`, but an
 *  error-payload union (`Order or OrderMissing`) carries the payload as a
 *  second `kind: "entity"` variant — only the aggregate name tells the success
 *  arm from the absent one, which is why this takes `aggName` (mirroring
 *  `findUnionSpec`'s discrimination in `generator/_payload/union-wire.ts`).
 *  `absenceUnionSuccess` misses that shape entirely (both variants are
 *  entities), which silently classified error-payload union finds as
 *  `findSingle` and declared NO error status while every backend declares the
 *  payload's resolved one. */
export function absenceUnionAbsent(
  t: TypeIR | undefined,
  aggName: string,
): { readonly kind: "none" } | { readonly kind: "error"; readonly tag: string } | undefined {
  if (t?.kind !== "union" || t.variants.length !== 2) return undefined;
  const success = t.variants.find((v) => v.kind === "entity" && v.name === aggName);
  const absent = t.variants.find((v) => v !== success);
  if (!success || !absent) return undefined;
  if (absent.kind === "none") return { kind: "none" };
  if (absent.kind === "entity") return { kind: "error", tag: absent.name };
  return undefined;
}

/**
 * The error statuses a find declares, keyed the same way every backend keys
 * them: an ABSENCE-returning find (`T option` / `T or NotFound`) can 404 — or
 * the absent payload's `httpStatus`-resolved status when the union rides an
 * error payload — while a collection or single-valued find declares nothing.
 *
 * `guarded` is passed through but is INERT TODAY: `errorStatuses` branches on
 * it only for `operation`/`workflow`, so every find declares the same set gated
 * or not.  That is a real gap — a `requires`-gated read DOES answer 403 at
 * runtime, and the negative-authz half of M-T3.13 asserts exactly that against
 * a booted backend — but it is a gap in all five backends equally, not in this
 * derivation.  Threading the flag here rather than hardcoding `false` is the
 * point of having one table: when the shared arm learns about guarded finds,
 * every backend AND this derivation gain the 403 together, instead of this
 * module declaring a status no backend publishes and recreating the two-truths
 * problem it exists to remove.
 */
function findErrorStatuses(
  find: FindIR,
  guarded: boolean,
  aggName: string,
  statuses: ApiStatusContext | undefined,
): number[] {
  // The SAME resolver `operationErrorStatuses` below already threads.  It was
  // missing from all three find arms (M-T9.25 round 2, probe 1): `errorStatuses`
  // takes `resolve` as an OPTIONAL parameter, so omitting it reads exactly like
  // "nothing declared" — no type error, and with no override the resolved value
  // IS the literal, so default emission cannot tell the two apart.  Result:
  // `httpStatus Forbidden -> 451` moved a gated OPERATION's declared response
  // set on all five backends and silently not a gated FIND's.  Same shape as the
  // `mergeContexts` bug that opened this mission — an optional field whose
  // absence is indistinguishable from its default.
  const resolve = (name: string): number => resolveErrorStatus(name, denialOverridesFor(statuses));
  const absent = absenceUnionAbsent(find.returnType, aggName);
  if (absent) {
    // The `none` unit is the stdlib 404; an error payload answers its
    // `httpStatus`-resolved status — the same
    // `errorStatusOverrides?.[tag] ?? defaultErrorStatus(tag)` read every
    // backend's union-find arm performs at its own emit site today.  A
    // `requires` gate keeps its 403 on BOTH absence shapes (#2363's rung —
    // python's union arm declares it by hand; dropping it here would re-open
    // the exact "patched one arm, not the other" split that PR fixed).
    if (absent.kind === "none") return errorStatuses("findOptional", guarded, resolve);
    const set = new Set(guarded ? [resolve("Forbidden")] : []);
    set.add(resolveErrorStatus(absent.tag, statuses?.errorStatusOverrides));
    return [...set].sort((a, b) => a - b);
  }
  if (find.returnType?.kind === "optional") {
    return errorStatuses("findOptional", guarded, resolve);
  }
  return errorStatuses(
    collectionSuccess(find.returnType) ? "findList" : "findSingle",
    guarded,
    resolve,
  );
}

/**
 * The error statuses a domain operation declares.
 *
 * The base set comes from the shared table; the two CONFLICT statuses are
 * per-operation facts the table cannot know, and each backend adds them at its
 * own call site: a `when` state gate can answer `Disallowed` (409), and a
 * versioned aggregate's `update` can answer `ConcurrencyConflict` (409) on a
 * stale `If-Match`.  Both resolve through the context's `httpStatus` map
 * (`structuralErrorStatuses`) exactly as the emitters resolve them, so a
 * remapped conflict reaches this derivation too; with no override both
 * collapse to one 409.
 */
function operationErrorStatuses(
  agg: AggregateIR,
  op: OperationIR,
  statuses: ApiStatusContext | undefined,
): number[] {
  const out = new Set(
    errorStatuses("operation", operationIsGuarded(op), (name) =>
      resolveErrorStatus(name, denialOverridesFor(statuses)),
    ),
  );
  if (op.when) out.add(resolveErrorStatus("Disallowed", statuses?.structuralErrorStatuses));
  if (op.name === "update" && aggregateIsVersioned(agg)) {
    out.add(resolveErrorStatus("ConcurrencyConflict", statuses?.structuralErrorStatuses));
  }
  // A union RETURN's error arms (`operation reserve(): Order or OutOfStock`)
  // each declare their resolved status — every backend's returning-operation
  // emitter derives exactly this set from the variants whose name is an
  // `error`-kind payload.
  if (op.returnType?.kind === "union") {
    for (const v of op.returnType.variants) {
      if (v.kind === "entity" && statuses?.errorPayloadNames?.has(v.name)) {
        out.add(resolveErrorStatus(v.name, statuses?.errorStatusOverrides));
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

function entityType(aggName: string): TypeIR {
  return { kind: "entity", name: aggName };
}

/** The router-relative fragment of an operation's absolute `path` — what a
 *  backend mounts under its aggregate base: `""` for the collection root
 *  (create / auto-`all`), `"/{id}"`, `"/{id}/<op>"`, `"/<find>"`.  The inverse
 *  of the `aggregateBase` composition, exported so route builders rendering
 *  from this derivation don't each re-split the absolute path (backends that
 *  spell a param `:id` rewrite the braces on top of this). */
export function relativeOpPath(op: ApiOperationIR): string {
  const base = aggregateBase(op.aggregate);
  return op.path === base ? "" : op.path.slice(base.length);
}

/** The success status of a lifted operation — the ladder every backend's
 *  route arm encodes today: create answers `201 {id}`, an operation with no
 *  declared `: T` (and destroy) answers a bodiless `204`, everything else
 *  `200`. */
export function successStatus(op: ApiOperationIR): 200 | 201 | 204 {
  if (op.kind === "create") return 201;
  return op.responseType ? 200 : 204;
}

/** True for the auto-`all` find — the collection-root GET, which several
 *  backends emit through a different arm (paged envelope, no path segment)
 *  than a declared find. */
export function isAllFind(op: ApiOperationIR): boolean {
  return op.kind === "find" && op.find?.name === "all";
}

/** Derive every lifted HTTP operation one aggregate exposes.
 *
 *  Ordering mirrors the backends' registration order (static find paths
 *  before `/{id}`), so a consumer that renders this list in order produces a
 *  correctly-shadowing router. */
export function deriveAggregateOperations(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  statuses?: ApiStatusContext,
): ApiOperationIR[] {
  const base = aggregateBase(agg.name);
  const out: ApiOperationIR[] = [];

  const push = (
    kind: ApiOperationIR["kind"],
    idTokens: OpIdTokens,
    method: ApiMethod,
    path: string,
    params: readonly ApiOperationParamIR[],
    responseType: TypeIR | undefined,
    errorStatuses: readonly number[],
    source?: { readonly find?: FindIR; readonly operation?: OperationIR },
  ): void => {
    out.push({
      idTokens,
      id: camelId(idTokens),
      method,
      path,
      aggregate: agg.name,
      kind,
      params,
      ...(responseType ? { responseType } : {}),
      errorStatuses,
      ...(source?.find ? { find: source.find } : {}),
      ...(source?.operation ? { operation: source.operation } : {}),
    });
  };

  // POST /api/<aggs>/ — create.  Gated exactly as the route emitters gate it:
  // a non-constructible aggregate (no create, or create-by-parent only) has
  // no REST create route.
  if (emitsRestCreate(agg)) {
    push(
      "create",
      opCreate(agg.name),
      "post",
      // NO trailing slash.  The callee mounts its sub-router at `/api/<aggs>`
      // with a `"/"` route inside, which Hono composes to `/api/<aggs>` — and
      // `/api/<aggs>/` 404s against it.  A client asking for the slashed form
      // fails at RUNTIME while compiling perfectly, which is exactly the defect
      // this derivation exists to prevent.  Verified by booting both services:
      // `POST /api/orders/` answered 404, `POST /api/orders` answered 201.
      base,
      createBodyParams(agg),
      // NOTE — the declared type is the aggregate, but the SHIPPED Hono create
      // route answers `201 { id }` only (`CreateOrderResponse`), not the whole
      // entity.  Consumers that PARSE the body must use the id envelope, which
      // is why every client emitter special-cases `kind === "create"`.  The
      // declared type is left as the entity because the caller's binding is
      // typed from it and narrowing it to an id is a wire-visible retype of
      // every existing call site — a separate, deliberate change.
      entityType(agg.name),
      errorStatuses("create", false, (name) =>
        resolveErrorStatus(name, denialOverridesFor(statuses)),
      ),
    );
  }

  // Static find paths register BEFORE `/{id}` — a static segment registered
  // after the param route is shadowed by it (the comment in Hono's
  // routes-builder documents the 422 this caused).  Order is load-bearing.
  for (const find of repo?.finds ?? []) {
    if (find.name === "all" || find.synthesized) continue;
    push(
      "find",
      opFind(agg.name, find.name),
      "get",
      `${base}/${snake(find.name)}`,
      findParams(find),
      find.returnType,
      findErrorStatuses(find, find.requires !== undefined, agg.name, statuses),
      { find },
    );
  }

  // GET /api/<aggs>/{id}
  push(
    "getById",
    opGetById(agg.name),
    "get",
    `${base}/{id}`,
    [idParam()],
    entityType(agg.name),
    errorStatuses("getById"),
  );

  // DELETE /api/<aggs>/{id} — only when the aggregate exposes a REST destroy
  // (the shared predicate next to `emitsRestCreate`).  `ReferencedInUse`
  // resolves through the context's `httpStatus` map, matching the emitters'
  // `resolveErrorStatus("ReferencedInUse", ctx.structuralErrorStatuses)`.
  if (emitsRestDestroy(agg)) {
    push(
      "destroy",
      opDestroy(agg.name),
      "delete",
      `${base}/{id}`,
      [idParam()],
      undefined,
      errorStatuses("destroy", false, (name) =>
        resolveErrorStatus(name, statuses?.structuralErrorStatuses),
      ),
    );
  }

  // POST /api/<aggs>/{id}/<op> plus its GET …/can_<op> gate probe.
  for (const op of agg.operations ?? []) {
    if (isCanonical(op)) continue; // create/destroy already emitted above
    // A `private` operation has no HTTP surface — every backend's route
    // emitter filters on `visibility === "public"`, so lifting a private op
    // here would type a call to a route that does not exist.
    if (op.visibility !== "public") continue;
    const slug = snake(op.routeSlug ?? op.name);
    push(
      "operation",
      opOperation(agg.name, op.name),
      "post",
      `${base}/{id}/${slug}`,
      [idParam(), ...operationBodyParams(op)],
      // NO entity fallback.  A domain operation that declares no `: T` answers
      // `204` with NO BODY — that is what the Hono route emits, and what every
      // other backend mirrors.  Typing it as the aggregate made each client
      // declare `Promise<Order>` and run `OrderResponse.parse(await res.json())`
      // against an empty body: a RUNTIME throw on all five backends, from code
      // that compiles perfectly on both sides.  Caught by the success-body-shape
      // gate in `api-surface.test.ts`; `updateOrder` was live when it landed.
      op.returnType,
      operationErrorStatuses(agg, op, statuses),
      { operation: op },
    );
    // The `GET /{id}/can_<op>` companion exists ONLY for a `when`-gated
    // operation — it is the canCommand probe for that gate, so an ungated
    // operation has nothing to probe.  Mirrors `emitCanOpRoute`'s `if
    // (!op.when) return []`.
    //
    // `responseType` is the value the caller cares about; the wire body is the
    // fixed `{ allowed: <bool> }` envelope, which a client emitter unwraps the
    // same way it unwraps ProblemDetails on the error side.
    if (op.when) {
      push(
        "gateProbe",
        [`can`, op.name, agg.name],
        "get",
        `${base}/{id}/can_${slug}`,
        [idParam()],
        { kind: "primitive", name: "bool" },
        errorStatuses("getById"),
        { operation: op },
      );
    }
  }

  // GET /api/<aggs> — the auto `all` find, registered last (root path, so it
  // cannot be shadowed by `/{id}`).
  const all = repo?.finds.find((f) => f.name === "all");
  if (all) {
    push(
      "find",
      opFind(agg.name, "all"),
      "get",
      // NO trailing slash — see the create arm above.  `GET /api/orders/` 404s.
      base,
      findParams(all),
      all.returnType,
      findErrorStatuses(all, all.requires !== undefined, agg.name, statuses),
      { find: all },
    );
  }

  return out;
}

/** Every lifted operation across a context, aggregate by aggregate.  Threads
 *  the context's `httpStatus` maps so each operation's `errorStatuses` are the
 *  RESOLVED statuses the backend answers, not the unremapped defaults. */
/** The status-resolution inputs read off a context — for a backend that
 *  derives per aggregate (`deriveAggregateOperations`) rather than through
 *  `deriveContextOperations`. */
export function apiStatusContext(ctx: BoundedContextIR): ApiStatusContext {
  return {
    errorStatusOverrides: ctx.errorStatusOverrides,
    structuralErrorStatuses: ctx.structuralErrorStatuses,
    errorPayloadNames: new Set(ctx.payloads.filter((p) => p.kind === "error").map((p) => p.name)),
  };
}

export function deriveContextOperations(ctx: BoundedContextIR): ApiOperationIR[] {
  const statuses = apiStatusContext(ctx);
  const out: ApiOperationIR[] = [];
  for (const agg of ctx.aggregates) {
    // An abstract inheritance base owns the shared table but no HTTP surface —
    // Hono, python and the java contract all skip it wholesale (e.g.
    // `typescript/emit/routes.ts` filters `!a.isAbstract` before mounting), so
    // deriving routes for it would type calls nothing serves.
    if (agg.isAbstract) continue;
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    out.push(...deriveAggregateOperations(agg, repo, statuses));
  }
  return out;
}

function createBodyParams(agg: AggregateIR): ApiOperationParamIR[] {
  // The create body is the aggregate's createInput projection; the caller
  // sends it as one JSON object, so it is a single body param carrying the
  // entity's create shape rather than one param per field.
  return [{ name: "body", type: entityType(agg.name), location: "body" }];
}

/** True when the operation is the unnamed canonical `create`/`destroy` — those
 *  are emitted by their own route arms above, never as `POST /{id}/<op>`. */
function isCanonical(op: OperationIR): boolean {
  return op.canonical === true;
}

function operationBodyParams(op: OperationIR): ApiOperationParamIR[] {
  return op.params.map((p) => ({ name: p.name, type: p.type, location: "body" as const }));
}

function findParams(find: FindIR): ApiOperationParamIR[] {
  return find.params.map((p) => ({ name: p.name, type: p.type, location: "query" as const }));
}
