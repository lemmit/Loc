// The canonical per-operation error-status matrix.  Guardedness adds 403
// (authorization denied) to every kind that can carry a `requires` guard —
// `operation`, `workflow`, and the READ kinds; every backend reads this same
// matrix so the conformance error-response dimension stays in lockstep.
//
// Phase D of docs/old/proposals/validation-error-extension.md added 422
// (Unprocessable Entity) to every body-bearing kind — `create`,
// `operation`, `workflow` — for the per-field validation envelope
// consumed by the frontend ACL's `applyServerErrors`.

import { describe, expect, it } from "vitest";
import { errorStatuses, problemTitle } from "../../../src/ir/util/openapi-errors.js";

describe("errorStatuses — shared error matrix", () => {
  it("declares the route-shape statuses (unguarded)", () => {
    expect(errorStatuses("create")).toEqual([400, 422]);
    expect(errorStatuses("getById")).toEqual([404]);
    expect(errorStatuses("destroy")).toEqual([404, 409]);
    expect(errorStatuses("operation")).toEqual([400, 404, 422]);
    expect(errorStatuses("workflow")).toEqual([400, 422]);
    expect(errorStatuses("findOptional")).toEqual([404]);
    expect(errorStatuses("findList")).toEqual([]);
    expect(errorStatuses("findSingle")).toEqual([]);
    expect(errorStatuses("list")).toEqual([]);
  });

  it("inserts 403 for a guarded operation / workflow", () => {
    expect(errorStatuses("operation", true)).toEqual([400, 403, 404, 422]);
    expect(errorStatuses("workflow", true)).toEqual([400, 403, 422]);
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
    expect(errorStatuses("findSingle", true)).toEqual([403]);
  });

  it("guarded stays inert for the remaining kinds", () => {
    // `list` is the auto-`findAll` — synthesized, so it has no `requires` of
    // its own.  `getById` is a canonical route with no guard clause.
    //
    // `create` / `destroy` are NOT settled.  The grammar accepts a `requires`
    // STATEMENT inside a canonical `create(...)` body (it parses), but the
    // emitted create route neither renders the guard nor declares 403 — so
    // either the guard is enforced in the domain layer (making this the same
    // under-declaration the find kinds just had) or it is silently dropped
    // (worse).  Not investigated here, and deliberately not asserted as
    // "can't carry a guard": that phrasing is what let the find case sit in
    // this list for so long.  Whoever settles it changes THIS assertion.
    expect(errorStatuses("create", true)).toEqual([400, 422]);
    expect(errorStatuses("getById", true)).toEqual([404]);
    expect(errorStatuses("destroy", true)).toEqual([404, 409]);
    expect(errorStatuses("list", true)).toEqual([]);
  });

  it("422 carries the IANA HTTP status reason phrase", () => {
    // Phase D — title kept identical across backends so descriptions don't
    // drift in the (compared) OpenAPI specs.
    expect(problemTitle(422)).toBe("Unprocessable Entity");
  });
});
