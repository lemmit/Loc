// A5 temporal — lowering pins: the duration ExprIR node shape, the
// user-declaration shadowing rule (a user `function days` lowers as a
// plain call, never a duration node), and the binary type stamps
// (`leftType` / `resultType`) the backends' temporal dispatch reads.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allAggregates, type ExprIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";

async function lower(src: string) {
  const { model } = await parseString(src, { validate: false });
  return lowerModel(model);
}

type DurationExpr = Extract<ExprIR, { kind: "duration" }>;
type BinaryExpr = Extract<ExprIR, { kind: "binary" }>;

const SRC = `
  context Billing {
    aggregate Invoice {
      createdAt: datetime
      dueDate: datetime
      deliveredAt: datetime
      orderedAt: datetime
      gracePeriod: int
      derived due: datetime = createdAt + days(30)
      operation slack(): bool {
        let span = deliveredAt - orderedAt
        let window = days(gracePeriod) + hours(2)
        let doubled = days(1) * 2
        return span < window
      }
    }
    repository Invoices for Invoice { }
  }
`;

describe("A5 — duration lowering", () => {
  it("days(30) lowers to a duration node with an int-literal amount", async () => {
    const loom = await lower(SRC);
    const inv = allAggregates(loom).find((a) => a.name === "Invoice")!;
    const due = inv.derived.find((d) => d.name === "due")!;
    const bin = due.expr as BinaryExpr;
    expect(bin.kind).toBe("binary");
    expect(bin.op).toBe("+");
    const dur = bin.right as DurationExpr;
    expect(dur.kind).toBe("duration");
    expect(dur.unit).toBe("days");
    expect(dur.amount).toMatchObject({ kind: "literal", lit: "int", value: "30" });
    // Type stamps drive the backends' temporal dispatch — pin them.
    expect(bin.leftType).toMatchObject({ kind: "primitive", name: "datetime" });
    expect(bin.resultType).toMatchObject({ kind: "primitive", name: "datetime" });
  });

  it("datetime - datetime stamps resultType duration; duration algebra stamps flow", async () => {
    const loom = await lower(SRC);
    const inv = allAggregates(loom).find((a) => a.name === "Invoice")!;
    const op = inv.operations.find((o) => o.name === "slack")!;
    const lets = op.statements.filter((s) => s.kind === "let") as Extract<
      (typeof op.statements)[number],
      { kind: "let" }
    >[];
    const span = lets.find((l) => l.name === "span")!.expr as BinaryExpr;
    expect(span.op).toBe("-");
    expect(span.leftType).toMatchObject({ kind: "primitive", name: "datetime" });
    expect(span.resultType).toMatchObject({ kind: "primitive", name: "duration" });
    const window = lets.find((l) => l.name === "window")!.expr as BinaryExpr;
    expect(window.resultType).toMatchObject({ kind: "primitive", name: "duration" });
    expect((window.left as DurationExpr).unit).toBe("days");
    // `days(gracePeriod)` — a field amount lowers as the ref, not a literal.
    expect((window.left as DurationExpr).amount.kind).toBe("ref");
    const doubled = lets.find((l) => l.name === "doubled")!.expr as BinaryExpr;
    expect(doubled.op).toBe("*");
    expect(doubled.resultType).toMatchObject({ kind: "primitive", name: "duration" });
  });

  it("a user function named days SHADOWS the builtin — plain call, no duration node", async () => {
    const loom = await lower(`
      context C {
        aggregate A {
          x: int
          function days(n: int): int = n * 2
          derived d: int = days(3)
        }
        repository As for A { }
      }
    `);
    const a = allAggregates(loom).find((agg) => agg.name === "A")!;
    const d = a.derived.find((x) => x.name === "d")!;
    expect(d.expr).toMatchObject({ kind: "call", callKind: "function", name: "days" });
  });

  it("wrong-arity days(1, 2) stays a plain free call (validator territory, not lowering)", async () => {
    const loom = await lower(`
      context C {
        aggregate A {
          x: int
          operation f() { let d = days(1, 2) }
        }
        repository As for A { }
      }
    `);
    const a = allAggregates(loom).find((agg) => agg.name === "A")!;
    const op = a.operations.find((o) => o.name === "f")!;
    const letStmt = op.statements.find((s) => s.kind === "let") as Extract<
      (typeof op.statements)[number],
      { kind: "let" }
    >;
    expect(letStmt.expr).toMatchObject({ kind: "call", callKind: "free", name: "days" });
  });
});
