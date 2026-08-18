import { describe, expect, it } from "vitest";
import { fixHintCodeActions, validate } from "../../src/api/index.js";
import {
  type EditorRange,
  type EditorTextEdit,
  loomQuickFixes,
  overlapsLines,
  quickFixesAt,
  toEditorRange,
  toQuickFixes,
} from "../../web/src/editor/fix-hint-actions.js";

// ---------------------------------------------------------------------------
// Playground quick fixes (web/src/editor/fix-hint-actions.ts).
//
// The toolkit has produced applyable quick fixes for hinted diagnostics all
// along (`fixHintCodeActions`, tested in test/api/lsp.test.ts) — the playground
// editor just never asked for them.  What is new, and what can silently corrupt
// a user's source, is the coordinate hop: LSP ranges are 0-based, Monaco's are
// 1-based.  These tests pin that conversion by APPLYING the converted edit with
// a Monaco-shaped (1-based) applier and asserting the resulting text, so an
// off-by-one fails on content, not on a shape check that would still pass.
// ---------------------------------------------------------------------------

const BARE = `context Sales {
  aggregate Order { customer: Customer }
  aggregate Customer { name: string }
}
`;

/** Two system-scope `ui { … }` blocks and a frontend deployable that binds
 *  neither — `missingUiFix`'s multi-option path, the only `choose`-kind hint
 *  that ships today. */
const TWO_UIS = `system Shop {
  context Orders {
    aggregate Order { name: string }
    repository Orders for Order { }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api ShopApi from Orders
  ui Admin {
    area Back {
      page AdminBoard {
        route: "/admin"
        body: Text { "admin" }
      }
    }
  }
  ui Storefront {
    area Front {
      page Shelf {
        route: "/shelf"
        body: Text { "shelf" }
      }
    }
  }
  deployable honoApi { platform: node contexts: [Orders] dataSources: [ordersState] serves: ShopApi port: 3000 }
  deployable webApp { platform: react targets: honoApi port: 3001 }
}
`;

/** Apply Monaco-shaped edits (1-based line AND column) to a source.
 *
 *  Positions are clamped rather than trusted: a broken conversion must produce
 *  WRONG TEXT (a readable assertion failure), not an index crash that could be
 *  mistaken for an unrelated error. */
function applyEditorEdits(source: string, edits: readonly EditorTextEdit[]): string {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const offset = (line: number, column: number): number => {
    const start = lineStarts[Math.min(Math.max(line - 1, 0), lineStarts.length - 1)]!;
    return Math.min(Math.max(start + column - 1, 0), source.length);
  };
  let text = source;
  const ordered = [...edits].sort(
    (a, b) =>
      offset(b.range.startLineNumber, b.range.startColumn) -
      offset(a.range.startLineNumber, a.range.startColumn),
  );
  for (const e of ordered) {
    const from = offset(e.range.startLineNumber, e.range.startColumn);
    const to = offset(e.range.endLineNumber, e.range.endColumn);
    text = text.slice(0, from) + e.text + text.slice(Math.max(from, to));
  }
  return text;
}

const range = (
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
): EditorRange => ({ startLineNumber, startColumn, endLineNumber, endColumn });

describe("playground fix-hint quick fixes", () => {
  it("toEditorRange shifts both coordinates from 0-based LSP to 1-based Monaco", () => {
    expect(
      toEditorRange({ start: { line: 0, character: 0 }, end: { line: 2, character: 7 } }),
    ).toEqual(range(1, 1, 3, 8));
  });

  it("converts the real validate → fixHintCodeActions output into an applyable fix", async () => {
    const uri = "inmemory:///workspace/main.ddd";
    const fixes = await loomQuickFixes(BARE, uri);

    const fix = fixes.find((f) => f.title.includes("aggregate by id"));
    expect(fix).toBeDefined();
    expect(fix?.edits.length).toBe(1);
    expect(fix?.edits[0]?.text).toBe("customer: Customer id");

    // The payoff: applying the CONVERTED edit through a 1-based applier repairs
    // exactly the offending member and leaves every other byte alone.  Asserted
    // as WHOLE-DOCUMENT equality on purpose — a `toContain("customer: Customer
    // id")` would still pass with the line offset dropped, because the inserted
    // text contains the needle wherever it lands (CLAUDE.md: a check that never
    // reaches the thing it names).
    const fixed = applyEditorEdits(BARE, fix?.edits ?? []);
    expect(fixed).toBe(`context Sales {
  aggregate Order { customer: Customer id }
  aggregate Customer { name: string }
}
`);
    expect((await validate(fixed)).ok).toBe(true);

    // The bare reference lives on line 2 of BARE — 1-based, as Monaco counts.
    expect(fix?.anchor.startLineNumber).toBe(2);
    expect(fix?.edits[0]?.range.startLineNumber).toBe(2);
  });

  it("maps every action it is handed, whatever the count or change bucket", () => {
    const lsp = (line: number) => ({
      start: { line, character: 4 },
      end: { line, character: 9 },
    });
    const fixes = toQuickFixes([
      {
        title: "one",
        edit: { changes: { "a.ddd": [{ range: lsp(0), newText: "x" }] } },
      } as never,
      {
        title: "two",
        edit: {
          changes: {
            "a.ddd": [{ range: lsp(1), newText: "y" }],
            "b.ddd": [{ range: lsp(2), newText: "z" }],
          },
        },
      } as never,
      { title: "no-edit" } as never,
    ]);
    expect(fixes.map((f) => f.title)).toEqual(["one", "two"]);
    expect(fixes[1]?.edits.map((e) => e.range.startLineNumber)).toEqual([2, 3]);
  });

  it("falls back to the first edit's range as the anchor when the action has no diagnostic", () => {
    const [fix] = toQuickFixes([
      {
        title: "anchorless",
        edit: {
          changes: {
            "a.ddd": [
              {
                range: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } },
                newText: "q",
              },
            ],
          },
        },
      } as never,
    ]);
    expect(fix?.anchor).toEqual(range(6, 1, 6, 4));
  });

  it("offers a fix only for a request that touches its line", () => {
    const fix = { title: "t", edits: [], anchor: range(4, 3, 4, 9) };
    expect(quickFixesAt([fix], range(4, 1, 4, 1))).toHaveLength(1);
    expect(quickFixesAt([fix], range(3, 1, 5, 1))).toHaveLength(1);
    expect(quickFixesAt([fix], range(5, 1, 5, 1))).toHaveLength(0);
    expect(overlapsLines(range(1, 1, 2, 1), range(2, 4, 9, 1))).toBe(true);
    expect(overlapsLines(range(1, 1, 1, 9), range(2, 1, 2, 9))).toBe(false);
  });

  // The `preferred` flag is the one field the editor turns into BEHAVIOUR: a
  // preferred action is one Monaco may apply on its own (auto-fix).  A
  // `choose`-kind hint fans out one action per option precisely because there
  // is no single right answer, so carrying a hardcoded `true` through would let
  // the editor pick an arbitrary one for the user.
  it("carries `preferred` from the action — a fanned-out choice is never preferred", async () => {
    const single = toQuickFixes(
      await fixHintCodeActions(await validate(BARE), BARE, "file:///m.ddd"),
    );
    expect(single.length).toBeGreaterThan(0);
    expect(
      single.every((f) => f.preferred),
      "one unambiguous repair — the editor may apply it",
    ).toBe(true);

    const multi = toQuickFixes(
      await fixHintCodeActions(await validate(TWO_UIS), TWO_UIS, "file:///m.ddd"),
    );
    const choices = multi.filter((f) => f.title.startsWith("ui: "));
    expect(choices.length, "two declared ui blocks → two options").toBe(2);
    expect(
      choices.some((f) => f.preferred),
      "a fanned-out choice must not be auto-applyable",
    ).toBe(false);
  });

  it("carries the diagnostic's own range as the anchor (so the lightbulb lands on the squiggle)", async () => {
    const uri = "inmemory:///workspace/main.ddd";
    const report = await validate(BARE);
    const actions = await fixHintCodeActions(report, BARE, uri);
    const [fix] = toQuickFixes(actions);
    const diag = actions[0]?.diagnostics?.[0]?.range;
    expect(diag).toBeDefined();
    expect(fix?.anchor).toEqual(toEditorRange(diag!));
  });
});
