// Workflow create-declaration well-formedness (workflow-and-applier.md A2-S5f,
// validation rules 21–22).  A workflow may declare several `create` starters,
// one per entry point; these checks keep that set unambiguous so the runtime
// routes a command to exactly one starter and the `params`/`statements` facade
// has a single primary create to project from.
//
// Rules 23–24 (event-triggered overlap / create-vs-on correlation) are deferred
// until event-triggered-create lowering derives `eventRef` and the
// `create(event: E)` binding stops colliding with the `event` keyword.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

function src(members: string): string {
  return `
    system S { subdomain M { context C {
      aggregate Order { total: int }
      repository Orders for Order { }
      workflow Fulfillment {
        ${members}
      }
    }}}`;
}

/** Workflow create-declaration diagnostics (by code) from the IR validator. */
async function diagsFor(members: string): Promise<string[]> {
  const { model } = await parseString(src(members), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => (d.code ?? "").includes("create"))
    .map((d) => d.code ?? "");
}

describe("workflow create-declaration well-formedness", () => {
  it("accepts one canonical create plus a named variant (rule 21/22)", async () => {
    const diags = await diagsFor(`
      create(orderId: Order id) { let o = Orders.getById(orderId) }
      create byImport(orderId: Order id) { let o = Orders.getById(orderId) }
    `);
    expect(diags).toEqual([]);
  });

  it("rejects two unnamed (canonical) creates (rule 21)", async () => {
    const diags = await diagsFor(`
      create(orderId: Order id) { let o = Orders.getById(orderId) }
      create(orderId: Order id) { let o = Orders.getById(orderId) }
    `);
    expect(diags).toContain("loom.canonical-create-duplicate-workflow");
  });

  it("rejects two creates sharing a name (rule 22)", async () => {
    const diags = await diagsFor(`
      create start(orderId: Order id) { let o = Orders.getById(orderId) }
      create start(orderId: Order id) { let o = Orders.getById(orderId) }
    `);
    expect(diags).toContain("loom.create-name-conflict-workflow");
  });

  it("accepts a single canonical create (the common case)", async () => {
    const diags = await diagsFor(`create(orderId: Order id) { let o = Orders.getById(orderId) }`);
    expect(diags).toEqual([]);
  });
});
