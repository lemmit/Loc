import { describe, expect, it } from "vitest";
import { examples } from "../../web/src/examples/index.js";
import { exampleKeepPaths, filesDroppedByExample } from "../../web/src/workspace/example-import.js";

// ---------------------------------------------------------------------------
// Example-switch destructive diff (defect #19 of the 2026-07 review): picking
// an example overwrites the workspace with the example's file set and DELETES
// everything else — previously with no confirmation.  App.tsx now prompts, but
// only when this diff is non-empty, so the "which files would be lost" rule is
// the part worth pinning: over-reporting nags on harmless switches,
// under-reporting silently eats hand-authored files.
// ---------------------------------------------------------------------------

describe("exampleKeepPaths", () => {
  it("always keeps main.ddd, and normalises companion keys", () => {
    expect([...exampleKeepPaths()]).toEqual(["/workspace/main.ddd"]);
    const keep = exampleKeepPaths({
      "shared/money.ddd": "",
      "/leading.ddd": "",
      "notes.md": "", // non-.ddd companions are not workspace sources
    });
    expect([...keep].sort()).toEqual([
      "/workspace/leading.ddd",
      "/workspace/main.ddd",
      "/workspace/shared/money.ddd",
    ]);
  });
});

describe("filesDroppedByExample", () => {
  it("is empty for a single-file workspace ↔ single-file example (no nag)", () => {
    expect(filesDroppedByExample(["/workspace/main.ddd"])).toEqual([]);
  });

  it("is empty when the example owns every file present", () => {
    const files = { "shared/money.ddd": "", "orders.ddd": "" };
    const existing = [
      "/workspace/main.ddd",
      "/workspace/shared/money.ddd",
      "/workspace/orders.ddd",
    ];
    expect(filesDroppedByExample(existing, files)).toEqual([]);
  });

  it("lists the user-added files the example would delete, sorted", () => {
    const existing = [
      "/workspace/main.ddd",
      "/workspace/my-notes.ddd",
      "/workspace/a/deep.ddd",
      "/workspace/shared/money.ddd",
    ];
    expect(filesDroppedByExample(existing, { "shared/money.ddd": "" })).toEqual([
      "/workspace/a/deep.ddd",
      "/workspace/my-notes.ddd",
    ]);
  });

  it("drops a real multi-file example's companions when switching to a bare one", () => {
    const multi = examples.find((e) => e.files && Object.keys(e.files).length > 0);
    expect(multi).toBeDefined();
    const existing = [...exampleKeepPaths(multi?.files)];
    expect(existing.length).toBeGreaterThan(1);
    const dropped = filesDroppedByExample(existing, undefined);
    // Every companion is lost; main.ddd is overwritten, never deleted.
    expect(dropped).not.toContain("/workspace/main.ddd");
    expect(dropped).toHaveLength(existing.length - 1);
  });
});
