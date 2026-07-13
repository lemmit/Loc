// The canonical per-operation error-status matrix.  Guardedness adds 403
// (authorization denied) to the `operation` and `workflow` kinds; every
// backend reads this same matrix so the conformance error-response
// dimension stays in lockstep.
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
    expect(errorStatuses("list")).toEqual([]);
    expect(errorStatuses("view")).toEqual([]);
  });

  it("inserts 403 for a guarded operation / workflow", () => {
    expect(errorStatuses("operation", true)).toEqual([400, 403, 404, 422]);
    expect(errorStatuses("workflow", true)).toEqual([400, 403, 422]);
  });

  it("guarded is inert for kinds that can't carry a `requires` guard", () => {
    expect(errorStatuses("create", true)).toEqual([400, 422]);
    expect(errorStatuses("getById", true)).toEqual([404]);
    expect(errorStatuses("destroy", true)).toEqual([404, 409]);
    expect(errorStatuses("findOptional", true)).toEqual([404]);
    expect(errorStatuses("list", true)).toEqual([]);
  });

  it("422 carries the IANA HTTP status reason phrase", () => {
    // Phase D — title kept identical across backends so descriptions don't
    // drift in the (compared) OpenAPI specs.
    expect(problemTitle(422)).toBe("Unprocessable Entity");
  });
});
