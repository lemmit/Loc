// ---------------------------------------------------------------------------
// Java backend — criterion-body boolean-field predicate.  Inside a criterion
// body a bare boolean field (`this.archived`) lowers to a `member` ExprIR
// (receiver `this`, member `archived`) — not a `this-prop` ref — so the
// criteria renderer must resolve it via the same candidate-path machinery the
// comparison arms use and emit `cb.isTrue(...)`.  `!this.archived` then wraps it
// in `cb.not(...)`.  Semantic parity with the node backend, whose
// `activeCriterion = () => not(eq(schema.orders.archived, true))` reads a bare
// boolean field as truthy and negates it.  Closes the java×criterion-filter
// corpus gap.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Crit {
  subdomain Sales {
    context Orders {
      criterion Active of Order = !this.archived
      aggregate Order {
        code: string
        archived: bool
        filter Active
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable d {
    platform: java
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

const CRITERIA = "d/src/main/java/com/loom/d/domain/criteria/OrderCriteria.java";

describe("java generator — criterion-body boolean-member predicate", () => {
  it("renders `!this.archived` as cb.not(cb.isTrue(...)) over the candidate path", async () => {
    const files = await generateSystemFiles(SRC);
    const criteria = files.get(CRITERIA);
    expect(criteria).toBeDefined();
    expect(criteria!).toContain("cb.isTrue(");
    expect(criteria!).toContain("cb.not(");
    // The boolean field is read off the candidate root with a Boolean witness.
    expect(criteria!).toContain('cb.not(cb.isTrue(root.<Boolean>get("archived")))');
  });
});
