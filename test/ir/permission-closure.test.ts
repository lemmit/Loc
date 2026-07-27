// Permission `implies` transitive-closure computation (authorization.md §6).

import { describe, expect, it } from "vitest";
import {
  computePermissionClosures,
  type PermissionEdge,
} from "../../src/ir/util/permission-closure.js";

const edges = (spec: Record<string, string[]>): PermissionEdge[] =>
  Object.entries(spec).map(([name, implies]) => ({ name, implies }));

describe("computePermissionClosures", () => {
  it("computes forward grants + reverse impliedBy transitively", () => {
    // approve → edit → read
    const c = computePermissionClosures(edges({ read: [], edit: ["read"], approve: ["edit"] }));
    expect(c.get("approve")!.grants).toEqual(["edit", "read"]);
    expect(c.get("edit")!.grants).toEqual(["read"]);
    expect(c.get("read")!.grants).toEqual([]);
    // reverse: read is implied by edit AND approve
    expect(c.get("read")!.impliedBy).toEqual(["approve", "edit"]);
    expect(c.get("edit")!.impliedBy).toEqual(["approve"]);
    expect(c.get("approve")!.impliedBy).toEqual([]);
  });

  it("handles a fan-out (one permission implying several)", () => {
    const c = computePermissionClosures(edges({ read: [], write: [], admin: ["read", "write"] }));
    expect(c.get("admin")!.grants).toEqual(["read", "write"]);
    expect(c.get("read")!.impliedBy).toEqual(["admin"]);
    expect(c.get("write")!.impliedBy).toEqual(["admin"]);
  });

  it("is cycle-safe (mutual implication terminates)", () => {
    const c = computePermissionClosures(edges({ a: ["b"], b: ["a"] }));
    expect(c.get("a")!.grants).toEqual(["b"]);
    expect(c.get("b")!.grants).toEqual(["a"]);
    expect(c.get("a")!.impliedBy).toEqual(["b"]);
  });

  it("drops unknown targets (validator owns rejection)", () => {
    const c = computePermissionClosures(edges({ edit: ["ghost"], read: [] }));
    expect(c.get("edit")!.grants).toEqual([]);
    expect(c.get("read")!.impliedBy).toEqual([]);
  });

  it("returns empty closures when nothing implies anything", () => {
    const c = computePermissionClosures(edges({ a: [], b: [] }));
    expect(c.get("a")!.grants).toEqual([]);
    expect(c.get("a")!.impliedBy).toEqual([]);
  });
});
