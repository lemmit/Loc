// C1 (full-review-remediation §C): aggregate emit and workflow emit both lower
// their field values through the SAME `lowerEmitFields` helper, promoting a
// bare numeric literal against the event field's declared type — so `emit
// Priced { amount: 5 }` into a money field lowers to a typed money literal on
// BOTH levels, not a raw int the backends then mis-render.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allAggregates, allContexts, type ExprIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";

async function lower(src: string) {
  const { model } = await parseString(src, { validate: false });
  return lowerModel(model);
}

const asLiteral = (e: ExprIR) => e as Extract<ExprIR, { kind: "literal" }>;

describe("C1 — emit field literal promotion", () => {
  it("aggregate emit promotes a bare int literal to a money literal", async () => {
    const loom = await lower(`
      context T {
        event Priced { amount: money }
        aggregate A {
          x: int
          operation price() { emit Priced { amount: 5 } }
        }
        repository As for A { }
      }
    `);
    const a = allAggregates(loom).find((agg) => agg.name === "A")!;
    const op = a.operations.find((o) => o.name === "price")!;
    const emit = op.statements.find((s) => s.kind === "emit") as Extract<
      (typeof op.statements)[number],
      { kind: "emit" }
    >;
    const field = emit.fields.find((f) => f.name === "amount")!;
    const litv = asLiteral(field.value);
    expect(litv.kind).toBe("literal");
    expect(litv.lit).toBe("money");
    expect(litv.value).toBe("5");
  });

  it("workflow reactor emit promotes identically", async () => {
    const loom = await lower(`
      system S { subdomain M { context C {
        event MoneyEvent { amount: money }
        event Trigger { x: int }
        workflow W {
          on(t: Trigger) { emit MoneyEvent { amount: 5 } }
        }
      }}}
    `);
    const wf = allContexts(loom)[0]!.workflows[0]!;
    const emit = wf.subscriptions![0]!.statements.find((s) => s.kind === "emit") as Extract<
      NonNullable<typeof wf.subscriptions>[number]["statements"][number],
      { kind: "emit" }
    >;
    const field = emit.fields.find((f) => f.name === "amount")!;
    const litv = asLiteral(field.value);
    expect(litv.lit).toBe("money");
    expect(litv.value).toBe("5");
  });
});
