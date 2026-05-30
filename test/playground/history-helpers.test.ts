import { describe, expect, it } from "vitest";
import {
  classifyCommit,
  formatRelativeTime,
  shortOid,
} from "../../web/src/layout/history-format.js";

describe("history-format helpers", () => {
  it("classifyCommit splits autosaves from milestones", () => {
    expect(classifyCommit("autosave workspace")).toBe("autosave");
    expect(classifyCommit("Autosave Workspace")).toBe("autosave");
    expect(classifyCommit("regenerate")).toBe("milestone");
    expect(classifyCommit("import legacy workspace")).toBe("milestone");
    expect(classifyCommit("anything else")).toBe("milestone");
  });

  it("formatRelativeTime renders coarse buckets from epoch seconds", () => {
    const now = 1_000_000 * 1000; // ms
    const sec = 1_000_000; // now in seconds
    expect(formatRelativeTime(sec, now)).toBe("just now");
    expect(formatRelativeTime(sec - 30, now)).toBe("30s ago");
    expect(formatRelativeTime(sec - 120, now)).toBe("2m ago");
    expect(formatRelativeTime(sec - 3 * 3600, now)).toBe("3h ago");
    expect(formatRelativeTime(sec - 2 * 86400, now)).toBe("2d ago");
    expect(formatRelativeTime(sec - 21 * 86400, now)).toBe("3w ago");
    // future / clock skew clamps to "just now" rather than going negative
    expect(formatRelativeTime(sec + 100, now)).toBe("just now");
  });

  it("shortOid takes the conventional 7-char prefix", () => {
    expect(shortOid("0123456789abcdef")).toBe("0123456");
  });
});
