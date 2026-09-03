import { describe, expect, it } from "vitest";

import {
  diffGenerated,
  generatedChangesOf,
  groupByDeployable,
} from "../../web/src/build/output-diff.js";
import type { VirtualFile } from "../../web/src/build/protocol.js";

// ---------------------------------------------------------------------------
// "What changed in the output" (M-T8.20 slice 2) — the pure half.
//
// Two rules carry the whole feature and both are easy to get subtly wrong:
//   1. the FIRST generate has no baseline, so it must report nothing (marking
//      a hundred files "added" the moment the page loads is noise, not news);
//   2. the diff must key off the worker's per-file hash where it exists and
//      fall back to content where it does not — the main-thread workspace
//      merge builds `VirtualFile`s with no hash.
// ---------------------------------------------------------------------------

function file(path: string, content: string, hash?: string): VirtualFile {
  return { path, content, size: content.length, ...(hash ? { hash } : {}) };
}

describe("diffGenerated", () => {
  it("reports nothing when there is no previous generate", () => {
    const diff = diffGenerated([file("api/index.ts", "a", "1")], null);
    expect(diff.any).toBe(false);
    expect(diff.byPath.size).toBe(0);
    expect([diff.added, diff.changed, diff.removed]).toEqual([0, 0, 0]);
  });

  it("classifies added, changed and removed against the previous tree", () => {
    const before = [
      file("api/index.ts", "a", "aaa"),
      file("api/gone.ts", "g", "ggg"),
      file("web/App.tsx", "same", "sss"),
    ];
    const after = [
      file("api/index.ts", "a2", "bbb"),
      file("api/new.ts", "n", "nnn"),
      file("web/App.tsx", "same", "sss"),
    ];
    const diff = diffGenerated(after, before);

    expect(diff.byPath.get("api/index.ts")).toBe("changed");
    expect(diff.byPath.get("api/new.ts")).toBe("added");
    expect(diff.byPath.get("api/gone.ts")).toBe("removed");
    // An untouched file is ABSENT from the map, not stored as "unchanged" —
    // the map is a change list, and the common case is nothing.
    expect(diff.byPath.has("web/App.tsx")).toBe(false);
    expect([diff.added, diff.changed, diff.removed]).toEqual([1, 1, 1]);
    expect(diff.any).toBe(true);
  });

  it("compares hashes when both sides have one", () => {
    // Same content, different hash: an impossible pair in practice, used here
    // to prove the hash is what is consulted rather than the bytes.
    const diff = diffGenerated([file("a.ts", "x", "111")], [file("a.ts", "x", "222")]);
    expect(diff.byPath.get("a.ts")).toBe("changed");
  });

  it("falls back to content when either side carries no hash", () => {
    expect(diffGenerated([file("a.ts", "x")], [file("a.ts", "x", "222")]).any).toBe(false);
    expect(diffGenerated([file("a.ts", "y")], [file("a.ts", "x")]).byPath.get("a.ts")).toBe(
      "changed",
    );
  });
});

describe("groupByDeployable", () => {
  it("folds by the first path segment, root last", () => {
    const groups = groupByDeployable([
      { path: "docker-compose.yml", status: "changed" },
      { path: "web_app/src/App.tsx", status: "added" },
      { path: "api/index.ts", status: "changed" },
      { path: "api/db/schema.ts", status: "changed" },
    ]);
    expect(groups.map((g) => g.name)).toEqual(["api", "web_app", ""]);
    expect(groups[0]!.changes.map((c) => c.path)).toEqual(["api/db/schema.ts", "api/index.ts"]);
  });

  it("is empty for an empty change list", () => {
    expect(groupByDeployable([])).toEqual([]);
  });
});

describe("generatedChangesOf", () => {
  it("keeps only the generated subtree and re-bases its paths", () => {
    const changes = generatedChangesOf([
      { path: "/workspace/main.ddd", status: "modified" },
      { path: "/workspace/generated/api/index.ts", status: "modified" },
      { path: "/workspace/generated/web_app/src/App.tsx", status: "added" },
      { path: "/workspace/design/pack.json", status: "added" },
    ]);
    expect(changes).toEqual([
      { path: "api/index.ts", status: "changed" },
      { path: "web_app/src/App.tsx", status: "added" },
    ]);
  });

  it("returns nothing for a source-only commit", () => {
    expect(generatedChangesOf([{ path: "/workspace/main.ddd", status: "modified" }])).toEqual([]);
  });
});
