// The workflow instance-read gate, at the IR level — the header clause's two
// rules (M-T3.15 §A2).
//
//   loom.workflow-gate-not-current-user
//     The gate runs BEFORE any instance is loaded, so only `currentUser` (and
//     constants) is in scope.  It is lowered in the bare context env precisely
//     so a `this.<state field>` reference cannot silently resolve to the
//     workflow instance; this check turns that into a diagnostic instead of an
//     expression that type-checks and has no value at run time.
//
//   loom.default-deny-ungated (workflow-instances)
//     An observable workflow publishes every instance's correlation id and
//     state on two GETs.  Under `denyByDefault` that needs a gate, for the same
//     reason an ungated find or projection does.  It could not be required
//     before — the routes are compiler-derived and there was no surface to
//     declare a gate on, exactly the folded projection's old situation — and
//     the header clause is what removes that excuse.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const SYSTEM = (opts: { gate?: string; enforcement?: string; stateless?: boolean }): string => `
system Shop {
  user { id: string  role: string }
  ${opts.enforcement ? `auth { enforcement: ${opts.enforcement} }` : ""}
  subdomain Sales {
    context Orders {
      aggregate Order { code: string }
      repository Orders for Order { }
      workflow Fulfilment${opts.gate ?? ""} {
        ${opts.stateless ? "" : "orderId: Order id"}
        stage: string
        create start(order: Order id) {
          requires currentUser.role == "clerk"
          ${opts.stateless ? "" : "orderId := order"}
          stage := "started"
        }
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable d {
    platform: node
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    port: 8080
    auth: required
  }
}
`;

async function diags(src: string, code: string): Promise<string[]> {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === code)
    .map((d) => d.message);
}

describe("workflow instance-read gate — the currentUser-only rule", () => {
  it("accepts a currentUser gate", async () => {
    expect(
      await diags(
        SYSTEM({ gate: ' requires currentUser.role == "supervisor"' }),
        "loom.workflow-gate-not-current-user",
      ),
    ).toEqual([]);
  });

  it("accepts `requires true`", async () => {
    expect(
      await diags(SYSTEM({ gate: " requires true" }), "loom.workflow-gate-not-current-user"),
    ).toEqual([]);
  });

  it("rejects a gate referencing the instance state", async () => {
    // `stage` is a workflow state field.  The gate runs before any instance is
    // bound, so it has no value to read — and the message says where such a
    // check belongs instead.
    const errs = await diags(
      SYSTEM({ gate: ' requires stage == "started"' }),
      "loom.workflow-gate-not-current-user",
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("Fulfilment");
    expect(errs[0]).toContain("currentUser");
  });
});

describe("workflow instance reads under denyByDefault", () => {
  it("demands a gate on an observable workflow", async () => {
    const errs = await diags(
      SYSTEM({ enforcement: "denyByDefault", gate: "" }),
      "loom.default-deny-ungated",
    );
    expect(errs.some((m) => m.includes("workflow 'Fulfilment'"))).toBe(true);
  });

  it("is satisfied by the header gate", async () => {
    const errs = await diags(
      SYSTEM({ enforcement: "denyByDefault", gate: ' requires currentUser.role == "supervisor"' }),
      "loom.default-deny-ungated",
    );
    expect(errs.some((m) => m.includes("instance reads"))).toBe(false);
  });

  it("`requires true` is the intentionally-public escape here too", async () => {
    const errs = await diags(
      SYSTEM({ enforcement: "denyByDefault", gate: " requires true" }),
      "loom.default-deny-ungated",
    );
    expect(errs.some((m) => m.includes("instance reads"))).toBe(false);
  });

  it("does not enforce under `enforcement: opt`", async () => {
    const errs = await diags(SYSTEM({ enforcement: "opt", gate: "" }), "loom.default-deny-ungated");
    expect(errs.some((m) => m.includes("workflow 'Fulfilment'"))).toBe(false);
  });
});
