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
// CONSUMERS.  The in-system typed service-to-service client (M-T4.8) is the
// first; the natural follow-ons are the per-backend route builders themselves
// (which would then render a shared derivation instead of five parallel ones)
// and the `.loom/` artifact bundle.
//
// FIDELITY.  The derivation mirrors the SHIPPED Hono surface, which the
// conformance-parity gate already holds the other four backends to.  A
// disagreement between this module and a backend is therefore catchable by an
// existing gate rather than only at runtime.  `api-surface.test.ts` pins it
// against the routes Hono actually emits.
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
import { plural, snake } from "../../util/naming.js";
import { emitsRestCreate } from "../enrich/wire-projection.js";
import type {
  AggregateIR,
  BoundedContextIR,
  FindIR,
  OperationIR,
  RepositoryIR,
  TypeIR,
} from "../types/loom-ir.js";
import {
  camelId,
  type OpIdTokens,
  opCreate,
  opDestroy,
  opFind,
  opGetById,
  opOperation,
} from "./openapi-ids.js";

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
   *  its failure union instead of collapsing every error into a throw. */
  readonly errorStatuses: readonly number[];
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

function entityType(aggName: string): TypeIR {
  return { kind: "entity", name: aggName };
}

/** Derive every lifted HTTP operation one aggregate exposes.
 *
 *  Ordering mirrors the backends' registration order (static find paths
 *  before `/{id}`), so a consumer that renders this list in order produces a
 *  correctly-shadowing router. */
export function deriveAggregateOperations(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
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
      `${base}/`,
      createBodyParams(agg),
      entityType(agg.name),
      [400, 409],
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
      [403],
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
    [404],
  );

  // DELETE /api/<aggs>/{id} — only when the aggregate has a canonical destroy.
  if (agg.canonicalDestroy) {
    push(
      "destroy",
      opDestroy(agg.name),
      "delete",
      `${base}/{id}`,
      [idParam()],
      undefined,
      [404, 409],
    );
  }

  // POST /api/<aggs>/{id}/<op> plus its GET …/can_<op> gate probe.
  for (const op of agg.operations ?? []) {
    if (isCanonical(op)) continue; // create/destroy already emitted above
    const slug = snake(op.routeSlug ?? op.name);
    push(
      "operation",
      opOperation(agg.name, op.name),
      "post",
      `${base}/{id}/${slug}`,
      [idParam(), ...operationBodyParams(op)],
      op.returnType ?? entityType(agg.name),
      [400, 403, 404, 409],
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
        [404],
      );
    }
  }

  // GET /api/<aggs>/ — the auto `all` find, registered last (root path, so it
  // cannot be shadowed by `/{id}`).
  const all = repo?.finds.find((f) => f.name === "all");
  if (all) {
    push(
      "find",
      opFind(agg.name, "all"),
      "get",
      `${base}/`,
      findParams(all),
      all.returnType,
      [403],
    );
  }

  return out;
}

/** Every lifted operation across a context, aggregate by aggregate. */
export function deriveContextOperations(ctx: BoundedContextIR): ApiOperationIR[] {
  const out: ApiOperationIR[] = [];
  for (const agg of ctx.aggregates) {
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    out.push(...deriveAggregateOperations(agg, repo));
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
