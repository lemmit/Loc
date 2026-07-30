// ICU `,format` suffix on an interpolation hole (i18n, M-T1.11 slice 1) —
// parse-level coverage.  A hole is now `TemplateHole { value, format? }`: the
// `, number, ::currency/USD` tail of `{order.total, number, ::currency/USD}`
// is captured RAW (leading comma + spaces preserved) by the paren/brace-aware
// custom lexer.  The single most important new mechanism is that a comma at
// hole-paren-depth 0 starts the format while a call-argument comma
// (`{max(a, b), number}`) stays inside the value — so this suite pins both.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import {
  type Expression,
  isTemplateStr,
  type TemplateStr,
} from "../../../src/language/generated/ast.js";
import { printExpr } from "../../../src/language/print/index.js";
import { parseString } from "../../_helpers/parse.js";

async function firstTemplate(exprSource: string): Promise<TemplateStr> {
  const src = `
    context C {
      aggregate Order {
        a: int
        b: int
        total: money
        quantity: int
        derived v: string = ${exprSource}
      }
      repository Orders for Order { }
    }
  `;
  const { model } = await parseString(src, { validate: false });
  for (const n of AstUtils.streamAllContents(model)) if (isTemplateStr(n)) return n;
  throw new Error("no TemplateStr parsed");
}

describe("parsing — ICU template-hole format suffix", () => {
  it("captures the raw `, number, ::currency/USD` suffix into hole.format", async () => {
    const t = await firstTemplate("`Total: {total, number, ::currency/USD}`");
    expect(t.holes).toHaveLength(1);
    const hole = t.holes[0]!;
    // The value is the bare expression (the format comma is NOT part of it).
    expect(printExpr(hole.value as Expression)).toBe("total");
    // The suffix is captured verbatim — leading comma + spacing preserved.
    expect(hole.format).toBe(", number, ::currency/USD");
  });

  it("keeps a call-argument comma inside value — only the depth-0 comma is the format", async () => {
    // The paren-aware lexer: `max(a, b)` has an INNER comma at paren-depth 1
    // (part of the call), and a depth-0 comma that begins `, number`.  A naive
    // greedy terminal would swallow the inner comma into the format.
    const t = await firstTemplate("`Max: {max(a, b), number}`");
    expect(t.holes).toHaveLength(1);
    const hole = t.holes[0]!;
    // Inner comma preserved: the value is the full two-arg call.
    expect(printExpr(hole.value as Expression)).toBe("max(a, b)");
    // Only the depth-0 comma started the format.
    expect(hole.format).toBe(", number");
  });

  it("a format-less hole still parses with no format (byte-identical to before)", async () => {
    const t = await firstTemplate("`Q {quantity}`");
    expect(t.holes).toHaveLength(1);
    expect(t.holes[0]!.format).toBeUndefined();
    expect(printExpr(t.holes[0]!.value as Expression)).toBe("quantity");
  });

  it("a date/time skeleton suffix is captured raw", async () => {
    const t = await firstTemplate("`Due {total, date, ::yMMMd}`");
    expect(t.holes[0]!.format).toBe(", date, ::yMMMd");
  });
});
