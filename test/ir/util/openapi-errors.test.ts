// The canonical per-operation error-status matrix.  Guardedness adds 403
// (authorization denied) to the `operation` and `workflow` kinds; every
// backend reads this same matrix so the conformance error-response
// dimension stays in lockstep.

import { describe, expect, it } from "vitest";
import { errorStatuses } from "../../../src/ir/util/openapi-errors.js";

describe("errorStatuses — shared error matrix", () => {
  it("declares the route-shape statuses (unguarded)", () => {
    expect(errorStatuses("create")).toEqual([400]);
    expect(errorStatuses("getById")).toEqual([404]);
    expect(errorStatuses("destroy")).toEqual([404, 409]);
    expect(errorStatuses("operation")).toEqual([400, 404]);
    expect(errorStatuses("workflow")).toEqual([400]);
    expect(errorStatuses("findOptional")).toEqual([404]);
    expect(errorStatuses("list")).toEqual([]);
    expect(errorStatuses("view")).toEqual([]);
  });

  it("inserts 403 for a guarded operation / workflow", () => {
    expect(errorStatuses("operation", true)).toEqual([400, 403, 404]);
    expect(errorStatuses("workflow", true)).toEqual([400, 403]);
  });

  it("guarded is inert for kinds that can't carry a `requires` guard", () => {
    expect(errorStatuses("create", true)).toEqual([400]);
    expect(errorStatuses("getById", true)).toEqual([404]);
    expect(errorStatuses("destroy", true)).toEqual([404, 409]);
    expect(errorStatuses("findOptional", true)).toEqual([404]);
    expect(errorStatuses("list", true)).toEqual([]);
  });
});
