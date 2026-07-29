// Block-layout contract for the `.ddd` printers — the shape `unfold` writes
// back into a user's source.
//
// The corpus round-trip gates (`print-roundtrip` / `print-structural-roundtrip`)
// only cover constructs the examples happen to contain, so three layout bugs
// survived in the constructs that dominate UI page bodies (2026-07 unfold
// review, `docs/audits/unfold-printer-layout-review-2026-07.md`):
//
//   1. a multi-statement `match` arm printed with `;` separators the statement
//      grammar has no token for — the ejected source did not re-parse;
//   2. lambda block bodies (`onClick: e => { … }`) printed with no indentation;
//   3. `for` / `if let` / `match` indenting only each child's FIRST line, so a
//      nested block's continuation lines and closing brace landed at the
//      parent's depth.
//
// These cases are hand-written rather than corpus-derived precisely because the
// corpus does not exercise them.

import { describe, expect, it } from "vitest";
import type { Aggregate, Model, Page } from "../../../src/language/generated/ast.js";
import { printStructural } from "../../../src/language/print/index.js";
import { parseRawResult } from "../../_helpers/parse.js";

/** Parse a whole model, asserting it is syntactically clean. */
function parseOk(text: string): Model {
  const r = parseRawResult(text);
  expect(r.parserErrors.map((e) => e.message)).toEqual([]);
  return r.value as Model;
}

/** Print `node`, then re-parse the printed text as a standalone fragment
 *  wrapped back into a host, asserting the printer's output is legal source. */
function expectReparses(printed: string, wrap: (s: string) => string): void {
  const r = parseRawResult(wrap(printed));
  expect(r.parserErrors.map((e) => e.message)).toEqual([]);
}

const inSystem = (s: string): string => `system D {\n${s}\n}`;

function firstAggregate(model: Model): Aggregate {
  const sys = model.members[0] as never as { members: { $type: string; members?: unknown[] }[] };
  const ctx = sys.members.find((m) => m.$type === "BoundedContext")!;
  return (ctx.members as Aggregate[]).find((m) => m.$type === "Aggregate")!;
}

function firstPage(model: Model): Page {
  const sys = model.members[0] as never as { members: { $type: string; members?: unknown[] }[] };
  const ui = sys.members.find((m) => m.$type === "Ui")!;
  return (ui.members as Page[]).find((m) => m.$type === "Page")!;
}

// ---------------------------------------------------------------------------
// 1. `match` statement arms
// ---------------------------------------------------------------------------

describe("printStmt — match statement arms", () => {
  const SRC = `system D {
  context C {
    payload R = int | string
    aggregate A {
      n: int
      operation go() {
        match await self.calc() {
          int v => {
            let a = v
            let b = v
          }
          else => { let c = 1 }
        }
      }
    }
    repository As for A { }
  }
}
`;

  it("prints a multi-statement arm as an indented block, not `;`-separated", () => {
    const printed = printStructural(firstAggregate(parseOk(SRC)));
    // The statement grammar has no `;` separator — its presence is the bug.
    expect(printed).not.toContain(";");
    expect(printed).toContain("int v => {\n");
  });

  it("re-parses (the `;` form did not)", () => {
    const printed = printStructural(firstAggregate(parseOk(SRC)));
    expectReparses(printed, (s) =>
      inSystem(
        `  context C {\n    payload R = int | string\n${s}\n    repository As for A { }\n  }`,
      ),
    );
  });

  it("keeps a single-statement arm on one line", () => {
    const printed = printStructural(firstAggregate(parseOk(SRC)));
    expect(printed).toContain("else => { let c = 1 }");
  });
});

// ---------------------------------------------------------------------------
// 2. Lambda block bodies  +  3. nested statement blocks
// ---------------------------------------------------------------------------

describe("printExpr — lambda block bodies", () => {
  const SRC = `system D {
  ui U {
    page P {
      route: "/p"
      state { count: int = 0 }
      body: Button("Go", onClick: e => {
        count := count + 1
        let t = count
      })
    }
  }
}
`;

  it("indents every statement of the block one level under the arrow", () => {
    const printed = printStructural(firstPage(parseOk(SRC)));
    expect(printed).toBe(
      [
        "page P {",
        '  route: "/p"',
        "  state {",
        "    count: int = 0",
        "  }",
        "  body: Button(",
        '    "Go",',
        "    onClick: e => {",
        "      count := count + 1",
        "      let t = count",
        "    }",
        "  )",
        "}",
      ].join("\n"),
    );
  });
});

describe("printStmt — nested blocks", () => {
  const SRC = `system D {
  context C {
    aggregate A {
      n: int
      contains lines: L[]
      entity L { q: int }
      operation bump() {
        for x in lines {
          for y in lines {
            let z = x.q + y.q
            if let q = z {
              let w = q
            } else {
              let w = 0
            }
          }
        }
      }
    }
    repository As for A { }
  }
}
`;

  it("indents a nested block's continuation lines and closing brace, not just its head", () => {
    const printed = printStructural(firstAggregate(parseOk(SRC)));
    const body = printed.slice(printed.indexOf("  operation bump()"));
    expect(body).toBe(
      [
        "  operation bump() {",
        "    for x in lines {",
        "      for y in lines {",
        "        let z = x.q + y.q",
        "        if let q = z {",
        "          let w = q",
        "        } else {",
        "          let w = 0",
        "        }",
        "      }",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("round-trips through a re-parse", () => {
    const printed = printStructural(firstAggregate(parseOk(SRC)));
    expectReparses(printed, (s) =>
      inSystem(`  context C {\n${s}\n    repository As for A { }\n  }`),
    );
  });
});
