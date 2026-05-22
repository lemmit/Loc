import { describe, expect, it } from "vitest";
import { Block, lines } from "../../src/util/code-builder.js";

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

describe("code-builder — Block", () => {
  it("tracks indentation depth across indent/dedent", () => {
    const b = new Block();
    b.line("a").indent().line("b").dedent().line("c");
    expect(b.toString()).toBe("a\n    b\nc\n");
  });

  it("openBrace / closeBrace indents the body and appends a suffix", () => {
    const b = new Block();
    b.openBrace("class Foo").line("x = 1").closeBrace(";");
    expect(b.toString()).toBe("class Foo {\n    x = 1\n};\n");
  });

  it("honours a custom indent unit", () => {
    const b = new Block({ indent: "  " });
    b.openBrace("if (x)").line("y").closeBrace();
    expect(b.toString()).toBe("if (x) {\n  y\n}\n");
  });

  it("blank() emits an unindented empty line", () => {
    const b = new Block();
    b.indent().line("a").blank().line("b");
    expect(b.toString()).toBe("    a\n\n    b\n");
  });

  it("raw() pushes verbatim with no indent prefix", () => {
    const b = new Block();
    b.indent().raw("verbatim").line("indented");
    expect(b.toString()).toBe("verbatim\n    indented\n");
  });

  it("dedent below zero is a no-op", () => {
    const b = new Block();
    b.dedent().line("a");
    expect(b.toString()).toBe("a\n");
  });
});
