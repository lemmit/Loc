// A5 temporal — the one claim about duration arithmetic that a BEHAVIOURAL
// test structurally cannot make: what the compiler REFUSES to lower.
//
// `test/fixtures/corpus/temporal.ddd` proves the arithmetic that DOES lower —
// on every backend, by running it (M-T9.42).  It cannot prove a rejection: a
// program the compiler rejects never reaches a backend to be executed.  So the
// five per-backend `temporal.test.ts` files it replaced are gone, and this is
// what survives them, deduplicated from the two copies (TS and .NET) that
// asserted the same platform-neutral phase-⑦ gate.
//
// The gate matters because it is what keeps the lowering HONEST: only a DIRECT
// duration-constructor operand becomes a SQL interval, so a composite the
// renderers cannot express must be refused at compile time rather than
// silently mis-lowered.  `firstNonQueryableNode` and the per-backend interval
// renderers have to admit exactly the same set.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { toLoomModel } from "../_helpers/ir.js";
import { parseString } from "../_helpers/parse.js";

/** A `find … where` over a datetime column, with `pred` as the predicate. */
const sys = (pred: string) => `
  context Billing {
    aggregate Invoice { dueDate: datetime }
    repository Invoices for Invoice {
      find w(q: datetime): Invoice[] where ${pred}
    }
  }
`;

async function errorsFor(pred: string): Promise<string[]> {
  const { model, errors } = await parseString(sys(pred));
  expect(errors).toEqual([]);
  return validateLoomModel(toLoomModel(model))
    .filter((d) => d.severity === "error")
    .map((d) => d.message);
}

describe("A5 temporal — the queryable gate (phase ⑦, platform-neutral)", () => {
  it("rejects a non-constructor duration composite in where-position", async () => {
    // `days(1) + hours(2)` is a duration EXPRESSION, not a constructor, and no
    // backend's interval renderer has an arm for it — so it is refused rather
    // than mis-lowered.
    const msgs = await errorsFor("this.dueDate + (days(1) + hours(2)) < q");
    expect(msgs.some((m) => m.includes("arithmetic"))).toBe(true);
  });

  it("admits the direct-constructor form the renderers do lower (control)", async () => {
    // The control the deleted tests never had: without it, a gate that
    // rejected EVERYTHING would pass the assertion above.
    expect(await errorsFor("this.dueDate + days(30) < q")).toEqual([]);
    expect(await errorsFor("this.dueDate < q + days(30)")).toEqual([]);
  });
});
