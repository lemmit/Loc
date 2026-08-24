// The canonical per-operation error-status matrix.  Guardedness adds 403
// (authorization denied) to every kind that can carry a `requires` guard —
// `operation`, `workflow`, and the READ kinds; every backend reads this same
// matrix so the conformance error-response dimension stays in lockstep.
//
// Phase D of docs/old/proposals/validation-error-extension.md added 422
// (Unprocessable Entity) to every body-bearing kind — `create`,
// `operation`, `workflow` — for the per-field validation envelope
// consumed by the frontend ACL's `applyServerErrors`.
//
// Schemathesis F1 added 415 (Unsupported Media Type) to the same body-bearing
// kinds: a request whose Content-Type is not application/json is refused
// before the handler runs, and the declared set says so.
//
// Schemathesis F6 widened 422 past the body: a `{id}` path parameter is parsed
// too, so `getById` and `destroy` declare it unconditionally.  The three FIND
// kinds do NOT get it here — whether a find parses anything is a fact about its
// route shape (declared params, or a paged return), which `OpErrorKind` cannot
// express; `findValidatesRequest` in `api-surface.ts` decides it and
// `api-surface-statuses.test.ts` pins the result.

import { describe, expect, it } from "vitest";
import { errorStatuses, problemTitle } from "../../../src/ir/util/openapi-errors.js";

describe("errorStatuses — shared error matrix", () => {
  it("declares the route-shape statuses (unguarded)", () => {
    expect(errorStatuses("create")).toEqual([400, 415, 422]);
    expect(errorStatuses("getById")).toEqual([404, 422]);
    expect(errorStatuses("destroy")).toEqual([404, 409, 422]);
    expect(errorStatuses("operation")).toEqual([400, 404, 415, 422]);
    expect(errorStatuses("workflow")).toEqual([400, 415, 422]);
    expect(errorStatuses("findOptional")).toEqual([404]);
    expect(errorStatuses("findList")).toEqual([]);
    // A NON-optional single find declares the not-found rung too (F13).  Its
    // emitted repository method has nowhere to put an empty result set, so it
    // throws the shared not-found carrier and the router answers 404 — the same
    // status the optional arm above RETURNS by design.  Until this arm, exactly
    // one of the two published it.
    expect(errorStatuses("findSingle")).toEqual([404]);
    expect(errorStatuses("list")).toEqual([]);
  });

  it("inserts 403 for a guarded operation / workflow", () => {
    expect(errorStatuses("operation", true)).toEqual([400, 403, 404, 415, 422]);
    expect(errorStatuses("workflow", true)).toEqual([400, 403, 415, 422]);
  });

  it("the workflow not-found rung is a BODY fact, not a route-shape one (F10)", () => {
    // Every other 404 in this table follows from the path carrying an `{id}`.
    // A workflow command route has none: whether it can answer 404 depends on
    // whether its BODY reads an aggregate, which is why the arm takes the fact
    // rather than assuming it either way.  Declaring it unconditionally would
    // be as wrong as omitting it — an unreachable declared status and an
    // undeclared reachable one are both contract lies.
    expect(errorStatuses("workflow", false, undefined, { readsAggregate: false })).toEqual([
      400, 415, 422,
    ]);
    expect(errorStatuses("workflow", false, undefined, { readsAggregate: true })).toEqual([
      400, 404, 415, 422,
    ]);
    expect(errorStatuses("workflow", true, undefined, { readsAggregate: true })).toEqual([
      400, 403, 404, 415, 422,
    ]);
    // …and it rides the `httpStatus NotFound -> N` resolver like every other
    // rung, rather than being pinned to the literal.
    expect(
      errorStatuses("workflow", false, (n) => (n === "NotFound" ? 410 : 422), {
        readsAggregate: true,
      }),
    ).toEqual([400, 410, 415, 422]);
  });

  it("inserts 403 for a guarded READ — `requires` is legal on a find", () => {
    // This case used to sit in the list below, under the title "kinds that
    // can't carry a `requires` guard".  A find CAN carry one: the grammar
    // accepts `find byCode(...): T option requires <expr>`, and every backend
    // has always ENFORCED it (Hono throws `ForbiddenError` → 403; M-T3.13's
    // negative-authz gate asserts the 403 against a booted backend).  Only the
    // declared set omitted it, so all five published `[404]` while answering
    // 403 — a test pinning a premise that was never true.
    expect(errorStatuses("findOptional", true)).toEqual([403, 404]);
    expect(errorStatuses("findList", true)).toEqual([403]);
    expect(errorStatuses("findSingle", true)).toEqual([403, 404]);
  });

  it("the canonical create / destroy carry the gated 403", () => {
    // SETTLED (M-T3.16): the previous shape of this test recorded the open
    // question — the grammar accepted a `requires` in a canonical `create` while
    // no backend rendered it, so it was unclear whether the guard ran in the
    // domain layer or was dropped.  It was DROPPED, leaving the route open;
    // every backend now evaluates it at its own chokepoint (route / command
    // handler / service / context) and denies with 403, so the declared set says
    // so.  `create` keeps 400 + 422; `destroy` keeps 404 + the FK-restrict 409.
    expect(errorStatuses("create", true)).toEqual([400, 403, 415, 422]);
    expect(errorStatuses("destroy", true)).toEqual([403, 404, 409, 422]);
  });

  it("guarded stays inert for the remaining kinds", () => {
    // `list` is the auto-`findAll` — synthesized, so it has no `requires` of
    // its own.  `getById` is a canonical route with no guard clause.
    expect(errorStatuses("getById", true)).toEqual([404, 422]);
    expect(errorStatuses("list", true)).toEqual([]);
  });

  it("422 carries the IANA HTTP status reason phrase", () => {
    // Phase D — title kept identical across backends so descriptions don't
    // drift in the (compared) OpenAPI specs.
    expect(problemTitle(422)).toBe("Unprocessable Entity");
  });
});
