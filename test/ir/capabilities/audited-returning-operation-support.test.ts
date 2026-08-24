// Tier-0 honest-gate guard (audit 2026-08-24, A6).
//
// `operation take(n: int) audited : Item or NotFound` on the Hono (node)
// backend used to generate CLEANLY and emit the VOID handler: the route
// declared 204 only, the tagged result was computed and thrown away, and the
// audit row was written with `status: "ok"` even when the operation returned
// its ERROR variant.  One keyword silently rewrote the HTTP contract, with no
// diagnostic anywhere — the route builder's own comment called the returning +
// audited combination "a later slice" and nothing gated it
// (`src/platform/hono/v4/routes-builder.ts`, the
// `op.returnType && !audit && !prov && !op.extern` dispatch).
//
// Python emits both halves — the audit record AND the tagged result with its
// 7807 translation — so this is a per-BACKEND gap, and the gate is a hosting
// check: the same model is accepted on python and refused on node.  When the
// node returning route folds the audit transaction in, the fix is to drop
// "node" from `AUDITED_RETURNING_UNSUPPORTED` and flip the expectations here.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { parseString } from "../../_helpers/parse.js";

const CODE = "loom.audited-returning-operation-unsupported";

async function gateErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === CODE)
    .map((d) => d.message);
}

function sys(platform: string, op: string): string {
  return `
system Shop {
  subdomain Core {
    context Ordering {
      error NotFound { message: string }
      aggregate Order {
        qty: int
        ${op}
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Ordering, kind: state, use: pg }
  deployable api { platform: ${platform}, contexts: [Ordering], dataSources: [ordersState], port: 4000 }
}
`;
}

const AUDITED_RETURNING = `operation take(n: int) audited : Order or NotFound {
          qty := qty - n
          return this
        }`;

describe("audited × returning operation — the node void-204 fall-through is refused", () => {
  it("refuses the combination on node, naming the operation and the modifier", async () => {
    const errs = await gateErrors(sys("node", AUDITED_RETURNING));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("Order.take");
    expect(errs[0]).toContain("audited");
    expect(errs[0]).toContain("node");
  });

  it("accepts it on python, which emits the returning + audited route today", async () => {
    expect(await gateErrors(sys("python", AUDITED_RETURNING))).toEqual([]);
  });

  it("an audited VOID operation is untouched — the void handler is its real shape", async () => {
    const voidOp = `operation cancel() audited { qty := 0 }`;
    expect(await gateErrors(sys("node", voidOp))).toEqual([]);
  });

  it("a RETURNING operation with no modifier is untouched — it takes the returning route", async () => {
    const plain = AUDITED_RETURNING.replace(" audited ", " ");
    expect(await gateErrors(sys("node", plain))).toEqual([]);
  });

  it("the same shape hosted on node AND python still fires — node is the one that loses it", async () => {
    const both = `
system Shop {
  subdomain Core {
    context Ordering {
      error NotFound { message: string }
      aggregate Order {
        qty: int
        ${AUDITED_RETURNING}
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Ordering, kind: state, use: pg }
  deployable api  { platform: node,   contexts: [Ordering], dataSources: [ordersState], port: 4000 }
  deployable api2 { platform: python, contexts: [Ordering], dataSources: [ordersState], port: 4001 }
}
`;
    expect(await gateErrors(both)).toHaveLength(1);
  });
});

describe("provenanced × returning operation — the same fall-through", () => {
  it("refuses a provenanced returning operation on node", async () => {
    const src = `
system Shop {
  subdomain Core {
    context Ordering {
      error NotFound { message: string }
      aggregate Order {
        total: int provenanced
        operation retotal(n: int): Order or NotFound {
          total := n
          return this
        }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Ordering, kind: state, use: pg }
  deployable api { platform: node, contexts: [Ordering], dataSources: [ordersState], port: 4000 }
}
`;
    const errs = await gateErrors(src);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("provenanced");
  });
});
