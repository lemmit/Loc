// Canonical per-operation error-response matrix — the single source of
// truth for which RFC 7807 error responses each backend declares on each
// operation.  Every backend (Hono / .NET / Phoenix) renders the SAME
// status set per operation kind so the conformance gate's per-operation
// error-response dimension compares equal.
//
// The body of every declared error response is the shared `ProblemDetails`
// schema (RFC 7807 core: `type`, `title`, `status`, `detail`, `instance`,
// plus the §3.2 `errors[]` extension array on 422 validation responses)
// served as `application/problem+json`.  Trace correlation rides on the
// `x-request-id` response header (not the body), so the body stays
// byte-identical across backends.
//
// The matrix is deterministic from route shape, with one auth-conditional
// dimension: an operation / workflow carrying a `requires` guard also
// declares 403 (it denies with ForbiddenError/Exception/`:forbidden` at
// runtime).  `guarded` is the same predicate on every backend
// (`operationIsGuarded` / `workflowIsGuarded`), so the three emitters stay
// in lockstep.
//   create  (POST /<aggs>)            → 400, 415, [403 if guarded], 422
//   getById (GET  /<aggs>/{id})       → 404, 422
//   destroy (DELETE /<aggs>/{id})     → [403 if guarded], 404, 409, 422
//   operation (POST /<aggs>/{id}/op)  → 400, 415, [403 if guarded], 404, 422
//   find (single return, optional or not) → 404, [422 if it validates a part]
//   workflow (POST /workflows/<wf>)   → 400, 415, [403 if guarded], 422,
//                                       [404 if the body reads an aggregate]
//   list / collection find            → [422 if it validates a request part]
//
// WHERE THE NOT-FOUND RUNG COMES FROM.  The four `404`s above look like a fact
// about the ROUTE SHAPE — the path carries an `{id}`, the handler loads it, an
// absent row is a 404 — and for those four they are.  But the rung's actual
// producer is the READ: every repository read whose declared return type is a
// single non-optional aggregate has nowhere to put an empty result set, so the
// emitted method throws the shared not-found carrier and the router renders it.
// Shape and read agree wherever a path id is what gets read, and DIVERGE in the
// two places a non-optional read happens without one — a non-optional `find`
// route, and a workflow body that loads.  Both answered an undeclared 404 for
// as long as this table keyed the rung on shape alone (F10 + F13 in
// docs/audits/schemathesis-findings-2026-08.md); `findSingle` therefore
// declares it like `findOptional` does, and `workflow` declares it under the
// body predicate `workflowCanAnswerNotFound` (loom-ir.ts) that the five
// backends thread in as `opts.readsAggregate`.
//
// 415 (Unsupported Media Type, RFC 9110 §15.5.16) is declared on exactly the
// BODY-CARRYING kinds — create / operation / workflow.  A request whose
// `Content-Type` is not `application/json` cannot be parsed into the declared
// request schema, and every backend refuses it before the handler runs
// (the node emitter guards it explicitly; ASP.NET, Spring and Plug.Parsers
// answer 415 at the framework layer).  A
// read/delete route carries no body, so it declares none.
//
// 422 (Unprocessable Entity) is the validation-failure code declared per
// docs/old/proposals/validation-error-extension.md — Phase D.  Body carries the
// §3.2 `errors[]` extension array (per-field `{ pointer, message }`)
// consumed by the frontend ACL's `applyServerErrors` (#769).  500 is the
// universal fallback every route can produce; like most specs we don't
// enumerate it per operation (it would be noise on every path).
//
// It is declared by EVERY route that VALIDATES a request part, not only the
// body-carrying ones (schemathesis F6).  A path `{id}` is parsed as a uuid and
// a query parameter is parsed against its declared type, and a failure at
// either answers the same 422 the body tier does — Hono's shared `defaultHook`,
// FastAPI's request validation, and so on.  Until this table said so, `GET
// /<aggs>/{id}` published `[200, 404]`, `DELETE /<aggs>/{id}` published
// `[204, 404, 409]` and the collection GET published `[200]` alone, while all
// three answered 422 for a malformed id / page number: a status every generated
// client was blind to because the contract never mentioned it.  The read/delete
// kinds below always carry a validated `{id}`, so they declare it
// unconditionally; a FIND's request surface depends on its shape, so its arm is
// decided by `findValidatesRequest` in `api-surface.ts` (a param-less,
// un-paged find validates nothing and declares nothing).

/** Media type for every RFC 7807 error body. */
export const PROBLEM_JSON = "application/problem+json";

/** Component-schema name for the shared RFC 7807 body. */
export const PROBLEM_SCHEMA = "ProblemDetails";

/** The media-type refusal every body-carrying route declares (RFC 9110
 *  §15.5.16).  Named rather than spelled inline so the emitters that have to
 *  produce the matching runtime arm (Hono's `requireJsonContentType`) can be
 *  found from this table by grep. */
export const UNSUPPORTED_MEDIA_TYPE = 415;

/** The wire-validation tier every route that PARSES a request part answers on
 *  a parse failure — a malformed `{id}`, an out-of-range `?page=`, a body field
 *  of the wrong type.  Named for the same reason `UNSUPPORTED_MEDIA_TYPE` is:
 *  the emitters that produce the matching runtime arm (Hono's `defaultHook`,
 *  FastAPI's request validation) are findable from this table by grep, and the
 *  read/delete arms below now declare it rather than only the body-carrying
 *  ones.  NOT remappable — like 400 it is a framework tier, not a denial-ladder
 *  rung (the DOMAIN floor that shares the number by default is the separate,
 *  resolvable `DomainError`). */
export const UNPROCESSABLE_ENTITY = 422;

/** Operation kinds that map to a distinct error-status set. */
export type OpErrorKind =
  | "create"
  | "getById"
  | "destroy"
  | "operation"
  | "workflow"
  | "findOptional"
  | "findList"
  | "findSingle"
  | "list";

/** The HTTP error statuses a given operation kind declares, ascending.
 *  `guarded` (a `requires` guard) inserts 403 — the authorization-denied
 *  outcome — for every kind that can carry one.
 *
 *  READS carry a guard too.  `requires` is legal on a `find`, and the emitters
 *  have always ENFORCED it — Hono throws `ForbiddenError` (→ 403 via its
 *  `onError` filter), python raises the same, and the OIDC negative-authz gate
 *  (M-T3.13) asserts a `requires`-gated find 403s an authenticated-but-
 *  unauthorized caller against a booted backend.  Only the DECLARED set was
 *  missing it: this arm branched on `guarded` for `operation`/`workflow` alone,
 *  so all five backends published `[404]` for a gated find and answered 403 at
 *  runtime.  Every generated client therefore had to treat its own callee's
 *  authorization denial as an unexpected throw.
 *
 *  Fixing it HERE rather than per-backend is the point of the table: one arm
 *  moves the five emitters and `deriveContextOperations` together, so the
 *  conformance error-response dimension stays balanced instead of showing four
 *  backends drifting from one. */
export function errorStatuses(
  kind: OpErrorKind,
  guarded = false,
  /** Resolver for the app-global denial-ladder rungs — maps an error name to
   *  its `httpStatus`-overridden status, defaulting to that name's stdlib code.
   *  Covers the structural conflicts (the destroy FK-restrict
   *  `ReferencedInUse`), the `DomainError` domain floor, `Forbidden` and
   *  `NotFound`, so the DECLARED response set moves in lockstep with the
   *  runtime handler arm.  Omitted ⇒ the literal defaults
   *  (409 / 422 / 403 / 404). */
  resolve?: (name: string) => number,
  /** Facts about the ROUTE'S BODY that its `kind` cannot carry.  Today one:
   *  `readsAggregate` — the `workflow` arm's not-found predicate.  See the
   *  "WHERE THE NOT-FOUND RUNG COMES FROM" note above the `notFound` binding
   *  below for why the rung needs a body fact at all. */
  opts?: { readsAggregate?: boolean },
): number[] {
  const referencedInUse = resolve?.("ReferencedInUse") ?? 409;
  // The domain floor (RS-15: a well-formed request the domain refuses on
  // semantic grounds). 422 by default, which is ALSO the wire-validation tier's
  // status — so with no override the two collapse to a single declared 422 and
  // the emitted set is unchanged.
  const domain = resolve?.("DomainError") ?? 422;
  const forbidden = resolve?.("Forbidden") ?? 403;
  // The DOMAIN not-found rung — the aggregate/projection/workflow-instance a
  // request addressed does not exist.  Resolvable here because each backend has
  // exactly ONE producer for it: the exception-handler arm
  // (`AggregateNotFoundError` → Hono's `onError`, `AggregateNotFoundException`
  // → the .NET filter / the Spring advice, `AggregateNotFoundError` → FastAPI's
  // handler).  Read paths route through that same carrier rather than a BARE
  // framework return (`NotFound()` / `ResponseEntity.notFound().build()` / a
  // `None` check), which would publish a status those paths never answer — and
  // would answer an EMPTY-bodied framework 404 instead of a ProblemDetails one.
  // The runtime arms below read the same resolved value.
  //
  // Two 404s are deliberately NOT this rung and stay literal on all five
  // backends (elixir included, so the reference stays the reference):
  //   * the FRAMEWORK routing 404 — `no route for <verb> <path>` — which is
  //     about the URL space, not about a domain record;
  //   * the objectStore blob-absence 404 on a `resource … kind: objectStore`
  //     download route, which addresses a bucket key, not an aggregate id.
  const notFound = resolve?.("NotFound") ?? 404;
  const set = (...statuses: number[]): number[] => [...new Set(statuses)].sort((a, b) => a - b);
  switch (kind) {
    // 400 = a malformed/unparseable body; 422 = the wire-validation tier
    // (`errors[]`); `domain` = the domain floor.  The first two are framework
    // tiers, not remappable rungs, so they stay literal.
    // A `requires` in the canonical `create` gates the POST BEFORE the factory
    // runs (there is no instance to read yet, so the guard sees the principal
    // only — `loom.lifecycle-guard-unreadable` enforces that) → 403 on denial.
    case "create":
      return guarded
        ? set(400, forbidden, UNSUPPORTED_MEDIA_TYPE, 422, domain)
        : set(400, UNSUPPORTED_MEDIA_TYPE, 422, domain);
    // The `{id}` path param is parsed as a uuid, so a malformed one answers the
    // wire-validation 422 exactly as a malformed body field does.  Declared
    // here rather than per-backend: `getById` is also what the history read and
    // the workflow-instance-by-id read declare against, and all three validate
    // the same `{id}`.
    case "getById":
      return set(notFound, UNPROCESSABLE_ENTITY);
    // destroy (DELETE /<aggs>/{id}) → 404 (not found) + 409 (still
    // referenced: cross-aggregate `X id` FK is ON DELETE RESTRICT — the
    // `ReferencedInUse` structural conflict, remappable via `httpStatus`).
    // A `requires` in the canonical `destroy` gates it AFTER the row loads (the
    // guard may read `this`), so the 403 lands between the two: an unreachable
    // id still answers 404, matching the operation routes.
    case "destroy":
      return guarded
        ? set(forbidden, notFound, referencedInUse, UNPROCESSABLE_ENTITY)
        : set(notFound, referencedInUse, UNPROCESSABLE_ENTITY);
    case "operation":
      return guarded
        ? set(400, forbidden, notFound, UNSUPPORTED_MEDIA_TYPE, 422, domain)
        : set(400, notFound, UNSUPPORTED_MEDIA_TYPE, 422, domain);
    // A workflow command route has NO path `{id}`, so — unlike every arm above
    // — the not-found rung is not implied by its shape.  It is implied by its
    // BODY: a body that reads an aggregate throws on an absent row and the
    // route answers `notFound`; a body that touches no repository cannot.
    // `opts.readsAggregate` is that fact, computed once by
    // `workflowCanAnswerNotFound` (loom-ir.ts) and threaded by all five
    // backends, so the conditional rung stays one decision instead of five.
    case "workflow": {
      const wfNotFound = opts?.readsAggregate ? [notFound] : [];
      return guarded
        ? set(400, forbidden, ...wfNotFound, UNSUPPORTED_MEDIA_TYPE, 422, domain)
        : set(400, ...wfNotFound, UNSUPPORTED_MEDIA_TYPE, 422, domain);
    }
    // The gated FIND arms resolve `forbidden` for the same reason `operation`
    // and `workflow` do — and they are here because they did NOT.  M-T5.20
    // converted the two command arms above and left these three as literal
    // `403`s, so `httpStatus Forbidden -> 451` moved a gated OPERATION's
    // declared set and silently not a gated FIND's, inside ONE function that
    // every backend reads (M-T9.25 round 2, probe 1).  Invisible to every
    // existing gate: with no override `forbidden` IS 403, so default emission
    // cannot tell a resolved 403 from a hardcoded one.
    case "findOptional":
      return guarded ? set(forbidden, notFound) : [notFound];
    // A collection find answers `[]` for "no rows" — there is no absent case
    // and so no rung.
    case "findList":
      return guarded ? [forbidden] : [];
    // A NON-optional single find declares the rung for the same reason the
    // optional one does, arrived at from the opposite direction.  The optional
    // find RETURNS its absence (the `none` unit is the stdlib 404); the
    // non-optional one has nowhere to put an empty result set, so every
    // backend's emitted repository method THROWS the shared not-found carrier
    // and the aggregate router renders it as `notFound`.  Same status, same
    // ProblemDetails body, and until this arm it was published by exactly one
    // of the two (F13 in docs/audits/schemathesis-findings-2026-08.md).
    case "findSingle":
      return guarded ? set(forbidden, notFound) : [notFound];
    // `list` is the auto-`findAll`, which carries no `requires` of its own.
    case "list":
      return [];
  }
}

/** Human-readable `title` for an RFC 7807 problem, keyed by status — kept
 *  identical across backends so the (compared) ProblemDetails examples /
 *  descriptions don't drift.  Titles are the IANA HTTP status reason
 *  phrases. */
export function problemTitle(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    // Codes an `httpStatus <Error> -> <Code>` override may retarget a rung to
    // (M-T3.4a / M-T5.20) — kept here so a remapped rung's 7807 title and its
    // OpenAPI `description` stay a real reason phrase, not the generic fallback.
    case 402:
      return "Payment Required";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    // A natural retarget for the `NotFound` rung — `httpStatus NotFound -> 410`
    // is the canonical "this id is gone" remap.  Without an entry here every
    // backend titles it the generic "Error".
    case 410:
      return "Gone";
    // The body-carrying kinds' media-type refusal (see UNSUPPORTED_MEDIA_TYPE).
    case 415:
      return "Unsupported Media Type";
    case 422:
      return "Unprocessable Entity";
    case 423:
      return "Locked";
    case 428:
      return "Precondition Required";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    case 502:
      return "Bad Gateway";
    default:
      return "Error";
  }
}
