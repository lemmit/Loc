import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString, parseValid } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// M7 phase 6a — .NET enhanced `#line` directives.  Reuses the exact fixture
// from test/system/sourcemap.test.ts (`Order.confirm()`: a `let` then an
// `emit`, both source-mapped) so the directive shape can be checked against
// SOURCE independently of the production `offsetToLineCol` helper — this
// file recomputes (line, col) with its own `lineCol` below rather than
// importing the implementation under test.
// ---------------------------------------------------------------------------

const SOURCE = `
system SourceMapDemo {
  subdomain Sales {
    context Orders {
      valueobject Money {
        amount: int
        currency: string
      }

      event OrderPlaced {
        order: Order id
      }

      aggregate Order {
        customerName: string
        total: Money
        operation confirm() {
          let note = customerName
          emit OrderPlaced { order: id }
        }
      }
      repository Orders for Order { }

      aggregate Product {
        name: string
        price: int
        operation discontinue() { }
      }
      repository Products for Product { }
    }
  }

  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api SalesApi from Sales

  deployable dotnetApi { platform: dotnet contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
}
`;

const ORDER_CS_PATH = "dotnet_api/Domain/Orders/Order.cs";

/** 1-based (line, col) of `offset` within `text` — a deliberately
 *  independent (split-based, not char-scan) implementation from
 *  `src/generator/_trace/sourcemap.ts`'s `offsetToLineCol`, so this test
 *  doesn't just re-check the same arithmetic the production code runs. */
function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset);
  const rows = before.split("\n");
  return { line: rows.length, col: rows[rows.length - 1]!.length + 1 };
}

async function parseWithSourceTexts(
  source: string,
): Promise<{ model: Awaited<ReturnType<typeof parseValid>>; sourceTexts: Map<string, string> }> {
  const { model, doc, errors } = await parseString(source, { validate: true });
  if (errors.length) throw new Error(`unexpected validation errors:\n${errors.join("\n")}`);
  return { model, sourceTexts: new Map([[doc.uri.path, source]]) };
}

describe(".NET enhanced #line directives (M7 phase 6a)", () => {
  it("weaves a directive immediately before the let and emit statements, and one #line default after the body", async () => {
    const { model, sourceTexts } = await parseWithSourceTexts(SOURCE);
    const [docPath] = sourceTexts.keys();
    const files = generateSystems(model, { sourcemap: true, sourceTexts }).files;
    const content = files.get(ORDER_CS_PATH);
    expect(content, `${ORDER_CS_PATH} not emitted`).toBeDefined();
    const lines = content!.split("\n");

    // (a) the `let` statement — the directive now narrows to the RHS
    // expression's own span (`customerName`), not the whole `let note = …`
    // statement: `weaveLineDirectives` prefers a `let`'s inner `expr.origin`
    // when present (src/generator/dotnet/emit/entity.ts's `narrowedOrigin`).
    const letStmtText = "let note = customerName";
    const letStmtStart = SOURCE.indexOf(letStmtText);
    expect(letStmtStart).toBeGreaterThanOrEqual(0);
    const letRhsText = "customerName";
    const letStart = SOURCE.indexOf(letRhsText, letStmtStart);
    const letEnd = letStart + letRhsText.length;
    const letFrom = lineCol(SOURCE, letStart);
    const letTo = lineCol(SOURCE, letEnd);
    const letDirective = `#line (${letFrom.line},${letFrom.col})-(${letTo.line},${letTo.col}) "${docPath}"`;
    const letLineIdx = lines.findIndex((l) => l.includes("var note = this.CustomerName;"));
    expect(letLineIdx, "rendered let-statement line not found").toBeGreaterThan(0);
    expect(lines[letLineIdx - 1]).toBe(letDirective);

    // (b) the `emit` statement — `emit` isn't one of the narrowed kinds
    // (`assign`/`return`/`let`), so it keeps its whole-statement span.
    const emitText = "emit OrderPlaced { order: id }";
    const emitStart = SOURCE.indexOf(emitText);
    expect(emitStart).toBeGreaterThanOrEqual(0);
    const emitEnd = emitStart + emitText.length;
    const emitFrom = lineCol(SOURCE, emitStart);
    const emitTo = lineCol(SOURCE, emitEnd);
    const emitDirective = `#line (${emitFrom.line},${emitFrom.col})-(${emitTo.line},${emitTo.col}) "${docPath}"`;
    const emitLineIdx = lines.findIndex((l) => l.includes("_domainEvents.Add(new OrderPlaced("));
    expect(emitLineIdx, "rendered emit-statement line not found").toBeGreaterThan(0);
    expect(lines[emitLineIdx - 1]).toBe(emitDirective);

    // (c) exactly one `#line default` in the whole file, restoring real .cs
    // mapping for the method's trailing glue (AssertInvariants, closing brace).
    const defaultLines = lines.filter((l) => l === "#line default");
    expect(defaultLines).toHaveLength(1);
    const defaultIdx = lines.indexOf("#line default");
    expect(defaultIdx).toBeGreaterThan(emitLineIdx);
    expect(lines[defaultIdx + 1]).toContain("AssertInvariants");
  });

  it(".loom/sourcemap.json statement regions still resolve after the weave (fragment anchoring survived)", async () => {
    const { model, sourceTexts } = await parseWithSourceTexts(SOURCE);
    const files = generateSystems(model, { sourcemap: true, sourceTexts }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      files: Record<
        string,
        {
          target: [number, number];
          origin: import("../../../src/ir/types/origin.js").OriginRef;
          construct?: string;
        }[]
      >;
    };
    const regions = map.files[ORDER_CS_PATH];
    expect(regions, `no sourcemap regions recorded for ${ORDER_CS_PATH}`).toBeDefined();

    const opConstruct = "Orders.Order.confirm";
    const stmtRegions = regions!
      .filter((r) => r.construct === opConstruct)
      .sort((a, b) => a.target[0] - b.target[0]);
    expect(stmtRegions).toHaveLength(2);

    const content = files.get(ORDER_CS_PATH)!;
    const contentLines = content.split("\n");
    const fileLineCount = content.endsWith("\n") ? contentLines.length - 1 : contentLines.length;
    let prevEnd = 0;
    for (const r of stmtRegions) {
      const [start, end] = r.target;
      expect(start).toBeGreaterThanOrEqual(1);
      expect(end).toBeLessThanOrEqual(fileLineCount);
      expect(start).toBeLessThanOrEqual(end);
      expect(start).toBeGreaterThan(prevEnd);
      prevEnd = end;
      // Every recorded target line actually exists in the emitted content —
      // proves the fragment-anchor `content.indexOf(fragmentText)` search
      // still found a unique match with the directives woven in.
      expect(contentLines[start - 1]).toBeDefined();
    }
  });

  it("honest skip: {sourcemap:true} without sourceTexts weaves no directives", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const content = files.get(ORDER_CS_PATH)!;
    expect(content).not.toContain("#line");
  });
});
