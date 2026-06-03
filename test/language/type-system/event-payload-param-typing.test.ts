// Field-level type-checking of transport (`event` / `payload`) parameters.
//
// A workflow command parameter (`create(e: PaymentReceived) by …`,
// `handle h(c: SettleOrder)`) and the `on`/`apply` event bindings carry a
// transport record.  The AST type system types these as `{ kind: "payload" }`
// so member access (`e.amount`) resolves the field's type — without it the
// binding cascades to `unknown` and *every* downstream type check (comparison,
// arithmetic, logical) is silently suppressed.  These tests pin that the
// existing operand validators now fire on event/payload param fields.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const wrap = (members: string) => `system S { subdomain M { context C {
  aggregate Order { total: int }
  repository Orders for Order { }
  event PaymentReceived { order: Order id, amount: int }
  command SettleOrder { order: Order id, note: string }
  ${members}
}}}`;

const errs = async (members: string): Promise<string[]> =>
  (await parseString(wrap(members), { validate: true })).errors;

describe("transport-param field typing — type checks no longer suppressed", () => {
  it("flags `&&` on an int event field (create)", async () => {
    const e = await errs(
      `workflow W { count: int  create(paid: PaymentReceived) by paid.order { let x = paid.amount && true } }`,
    );
    expect(
      e.some((s) => /requires boolean operands/.test(s)),
      e.join("\n"),
    ).toBe(true);
  });

  it("flags comparing an int event field with a string (create)", async () => {
    const e = await errs(
      `workflow W { count: int  create(paid: PaymentReceived) by paid.order { let x = paid.amount == "no" } }`,
    );
    expect(
      e.some((s) => /cannot compare 'int' with 'string'/.test(s)),
      e.join("\n"),
    ).toBe(true);
  });

  it("accepts a well-typed comparison on an event field (create)", async () => {
    const e = await errs(
      `workflow W { count: int  create(paid: PaymentReceived) by paid.order { let x = paid.amount == 5 } }`,
    );
    expect(e, e.join("\n")).toEqual([]);
  });

  it("flags `&&` on a string payload field (handle)", async () => {
    const e = await errs(`workflow W { handle settle(c: SettleOrder) { let x = c.note && true } }`);
    expect(
      e.some((s) => /requires boolean operands/.test(s)),
      e.join("\n"),
    ).toBe(true);
  });

  it("flags comparing an int event field with a string (on reactor)", async () => {
    const e = await errs(
      `workflow W { count: int  on(paid: PaymentReceived) by paid.order { let x = paid.amount == "no" } }`,
    );
    expect(
      e.some((s) => /cannot compare 'int' with 'string'/.test(s)),
      e.join("\n"),
    ).toBe(true);
  });

  it("accepts a well-typed payload field comparison (handle)", async () => {
    const e = await errs(`workflow W { handle settle(c: SettleOrder) { let x = c.note == "ok" } }`);
    expect(e, e.join("\n")).toEqual([]);
  });
});
