import { type AstNode, AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import {
  applyEdits,
  lineDiff,
  nodeEditRange,
  spliceNode,
} from "../../web/src/builder/edit-engine.js";
import { parseDdd } from "../../web/src/builder/parse.js";

// ---------------------------------------------------------------------------
// CST edit-engine acceptance tests (Builders).  Proves the engine
// preserves everything outside the edited span — the guarantee the whole
// text-first/CST-edit approach rests on.
// ---------------------------------------------------------------------------

const SRC = `system Shop {
  // top-of-ui comment
  ui Web {
    // page comment
    page Home {
      route: "/"
      title: "Welcome"
    }
  }
}
`;

function find(text: string, pred: (n: AstNode) => boolean): AstNode {
  const { ast, parserErrors } = parseDdd(text);
  expect(parserErrors).toEqual([]);
  for (const n of AstUtils.streamAst(ast)) if (pred(n)) return n;
  throw new Error("node not found");
}

describe("builder edit-engine", () => {
  it("no-op: applying zero edits is byte-identical", () => {
    expect(applyEdits(SRC, [])).toBe(SRC);
  });

  it("locality: editing one node's value changes only its span", () => {
    const title = find(
      SRC,
      (n) => n.$type === "StringLit" && (n as { value: string }).value === "Welcome",
    );
    const out = spliceNode(SRC, title, '"Hi"');

    expect(out).toBe(SRC.replace('"Welcome"', '"Hi"'));
    // Comments and all surrounding text are untouched.
    expect(out).toContain("// top-of-ui comment");
    expect(out).toContain("// page comment");
    expect(out.replace('"Hi"', '"Welcome"')).toBe(SRC);
  });

  it("delete keeps the leading comment by default", () => {
    const page = find(SRC, (n) => n.$type === "Page");
    const out = spliceNode(SRC, page, "");
    expect(out).toContain("// page comment");
  });

  it("delete with includeLeadingComment removes the leading comment too", () => {
    const page = find(SRC, (n) => n.$type === "Page");
    const range = nodeEditRange(page, { includeLeadingComment: true });
    const plain = nodeEditRange(page);
    expect(range).not.toBeNull();
    expect(range!.offset).toBeLessThan(plain!.offset);

    const out = spliceNode(SRC, page, "", { includeLeadingComment: true });
    expect(out).not.toContain("// page comment");
    // The unrelated ui-level comment is still preserved.
    expect(out).toContain("// top-of-ui comment");
  });
});

describe("lineDiff — preview hunk", () => {
  it("isolates a single changed line as a tight hunk", () => {
    const before = "a\nb\nc\nd";
    const after = "a\nB\nc\nd";
    expect(lineDiff(before, after)).toEqual({ atLine: 1, removed: ["b"], added: ["B"] });
  });

  it("reports an empty hunk for identical sources", () => {
    expect(lineDiff("x\ny", "x\ny")).toEqual({ atLine: 2, removed: [], added: [] });
  });

  it("captures pure insertions and deletions", () => {
    expect(lineDiff("a\nc", "a\nb\nc")).toEqual({ atLine: 1, removed: [], added: ["b"] });
    expect(lineDiff("a\nb\nc", "a\nc")).toEqual({ atLine: 1, removed: ["b"], added: [] });
  });
});
