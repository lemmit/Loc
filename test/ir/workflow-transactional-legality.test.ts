// Transactional legality (workflow-and-applier.md A2-S5e): a `transactional`
// workflow is one DB transaction and cannot carry continuation handlers
// (`on(...)` / `handle`), which run in their own later transactions.

import { describe, expect, it } from "vitest";
import { parseString } from "../_helpers/index.js";

const ctx = (wf: string) =>
  `system S { subdomain M { context C {
    aggregate Order { total: int }
    event PaymentReceived { order: Order id, amount: int }
    ${wf}
  }}}`;

describe("workflow transactional legality (A2-S5e)", () => {
  it("accepts a transactional workflow with no continuations", async () => {
    const { errors } = await parseString(ctx(`workflow Place(x: int) transactional { let y = x }`));
    expect(errors).toEqual([]);
  });

  it("rejects a transactional workflow with an on(...) reactor", async () => {
    const { errors } = await parseString(
      ctx(`workflow Bad() transactional {
        orderId: Order id
        on(paid: PaymentReceived) by paid.order { let z = paid.amount }
      }`),
    );
    expect(errors.some((e) => /transactional.*continuation|continuation handler/.test(e))).toBe(
      true,
    );
  });

  it("rejects a transactional workflow with a handle member", async () => {
    const { errors } = await parseString(
      ctx(`workflow Bad() transactional { handle go(n: int) { let z = n } }`),
    );
    expect(errors.some((e) => /continuation handler/.test(e))).toBe(true);
  });
});
