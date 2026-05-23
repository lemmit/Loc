import { describe, expect, it } from "vitest";
import { lines } from "../../src/util/code-builder.js";

describe("code-builder — lines", () => {
  it("joins string parts with newlines", () => {
    expect(lines("a", "b", "c")).toBe("a\nb\nc");
  });

  it("drops null / undefined / false entries", () => {
    expect(lines("a", null, "b", undefined, false, "c")).toBe("a\nb\nc");
  });

  it("flattens nested arrays recursively", () => {
    expect(lines("a", ["b", ["c", "d"]], "e")).toBe("a\nb\nc\nd\ne");
  });

  it("flattens-then-drops nullish inside arrays", () => {
    expect(lines(["a", null, ["b", false]], "c")).toBe("a\nb\nc");
  });

  it("returns empty string when everything is nullish", () => {
    expect(lines(null, undefined, false)).toBe("");
  });
});
