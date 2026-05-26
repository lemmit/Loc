import { describe, expect, it } from "vitest";
import { findNodeAtPath, pathOfNode } from "../../web/src/builder/page/live-sync.js";

// A craft `SerializedNodes` shape with `ROOT` → body → Stack(Heading, Text).
// The actual craft `SerializedNodes` carries more fields; the helpers only
// read `nodes` + `parent`, so a minimal fixture is enough.
function buildSeed(): Record<string, { nodes?: string[]; parent?: string | null }> {
  return {
    ROOT: { nodes: ["body"], parent: null },
    body: { nodes: ["s"], parent: "ROOT" },
    s: { nodes: ["h", "t"], parent: "body" },
    h: { nodes: [], parent: "s" },
    t: { nodes: [], parent: "s" },
  };
}

describe("page-builder live-sync — findNodeAtPath", () => {
  const seed = buildSeed();

  it("resolves the root for an empty path", () => {
    expect(findNodeAtPath(seed, [])).toBe("ROOT");
  });

  it("walks one level", () => {
    expect(findNodeAtPath(seed, [0])).toBe("body");
  });

  it("walks multiple levels to a nested child", () => {
    // ROOT → body[0] → s[0] → h.  The Heading inside Stack inside body.
    expect(findNodeAtPath(seed, [0, 0, 0])).toBe("h");
    // ROOT → body[0] → s[1] → t.  Sibling Text.
    expect(findNodeAtPath(seed, [0, 0, 1])).toBe("t");
  });

  it("returns null when an index is out of range", () => {
    // Stack only has two children; index 2 runs off the end.
    expect(findNodeAtPath(seed, [0, 0, 2])).toBeNull();
  });

  it("returns null when the path descends past a leaf", () => {
    // h is a leaf — no children to walk into.
    expect(findNodeAtPath(seed, [0, 0, 0, 0])).toBeNull();
  });

  it("returns null for negative indices", () => {
    expect(findNodeAtPath(seed, [-1])).toBeNull();
  });
});

describe("page-builder live-sync — pathOfNode", () => {
  const seed = buildSeed();

  it("returns an empty path for ROOT", () => {
    expect(pathOfNode(seed, "ROOT")).toEqual([]);
  });

  it("walks back up to ROOT through parents", () => {
    expect(pathOfNode(seed, "body")).toEqual([0]);
    expect(pathOfNode(seed, "s")).toEqual([0, 0]);
    expect(pathOfNode(seed, "h")).toEqual([0, 0, 0]);
    expect(pathOfNode(seed, "t")).toEqual([0, 0, 1]);
  });

  it("returns null for an id that isn't in the seed", () => {
    expect(pathOfNode(seed, "ghost")).toBeNull();
  });

  it("round-trips path ↔ id for every node", () => {
    for (const id of Object.keys(seed)) {
      const path = pathOfNode(seed, id);
      expect(path).not.toBeNull();
      expect(findNodeAtPath(seed, path!)).toBe(id);
    }
  });

  it("path survives a structural re-seed when the node's position is unchanged", () => {
    // A common live-sync case: text inside `h` changes but the tree shape
    // is identical, so the recorded path resolves to the same role in
    // the new seed (its id will differ, but its path won't).
    const before = buildSeed();
    const after: typeof before = {
      ROOT: { nodes: ["b2"], parent: null },
      b2: { nodes: ["s2"], parent: "ROOT" },
      s2: { nodes: ["h2", "t2"], parent: "b2" },
      h2: { nodes: [], parent: "s2" },
      t2: { nodes: [], parent: "s2" },
    };
    const path = pathOfNode(before, "h")!;
    expect(findNodeAtPath(after, path)).toBe("h2");
  });
});
