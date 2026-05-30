import { describe, expect, it } from "vitest";
import { CONFLICT_MARKER, hasConflictMarkers } from "../../web/src/layout/generated-conflicts.js";

// The detector keys off the exact head marker the generated-tree merge
// writes (generated-tree.ts → conflictMarkers).
describe("hasConflictMarkers", () => {
  it("detects the generated-merge conflict head marker", () => {
    const conflicted = `${CONFLICT_MARKER}\nmine\n=======\ntheirs\n>>>>>>> regenerated\n`;
    expect(hasConflictMarkers(conflicted)).toBe(true);
  });

  it("is false for ordinary content, incl. lone angle brackets", () => {
    expect(hasConflictMarkers("export const x = 1;\n")).toBe(false);
    expect(hasConflictMarkers("if (a >>> b) {}\n")).toBe(false);
    expect(hasConflictMarkers("")).toBe(false);
  });

  it("matches the marker the generated-tree merge actually emits", () => {
    // Guard against drift: this string must stay in lock-step with
    // generated-tree.ts:conflictMarkers.
    expect(CONFLICT_MARKER).toBe("<<<<<<< your edits");
  });
});
