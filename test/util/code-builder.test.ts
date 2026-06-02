import { describe, expect, it } from "vitest";
import { indent, lines } from "../../src/util/code-builder.js";

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

describe("code-builder — indent", () => {
  it("prefixes each line with the requested number of spaces", () => {
    expect(indent(2, "a", "b")).toEqual(["  a", "  b"]);
  });

  it("flattens arrays and skips nullish/false like lines", () => {
    expect(indent(2, ["a", null, ["b", false]], undefined, "c")).toEqual(["  a", "  b", "  c"]);
  });

  it("splits multiline strings so a nested block indents uniformly", () => {
    expect(indent(2, "a\nb")).toEqual(["  a", "  b"]);
  });

  it("leaves blank lines blank (no trailing whitespace)", () => {
    expect(indent(4, "a", "", "b")).toEqual(["    a", "", "    b"]);
  });

  it("drops straight into lines(...) to nest a pre-built body", () => {
    const body = ["const x = 1;", "return x;"];
    expect(lines("function f() {", ...indent(2, body), "}")).toBe(
      "function f() {\n  const x = 1;\n  return x;\n}",
    );
  });
});
