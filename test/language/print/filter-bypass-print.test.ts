// Printer arms for the `ignoring` filter-bypass clause (named-filter-bypass.md
// §11): find (print-structural) and the inline read (print-expr).  Each case
// round-trips through parse → print → re-parse with stable bypass fields,
// guarding `print-completeness` against the grammar attachments.

import { describe, expect, it } from "vitest";
import {
  type BoundedContext,
  isPostfixChain,
  isSubdomain,
  isSystem,
  type Model,
} from "../../../src/language/generated/ast.js";
import { printStructural } from "../../../src/language/print/index.js";
import { parseString } from "../../_helpers/parse.js";

function contexts(model: Model): BoundedContext[] {
  const out: BoundedContext[] = [];
  for (const sys of model.members) {
    if (!isSystem(sys)) continue;
    for (const sm of sys.members) if (isSubdomain(sm)) out.push(...sm.contexts);
  }
  return out;
}

const wrap = (body: string) => `
  system S {
    capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
    subdomain D { context C {
      criterion BigOrders() of Order = this.total > 0
      aggregate Order with softDeletable { total: int }
      ${body}
    }}
  }
`;

/** Print the first System, re-parse, and return the reparsed Model. */
async function printAndReparse(source: string): Promise<{ printed: string; model: Model }> {
  const { model } = await parseString(source, { validate: false });
  const sys = model.members.find(isSystem)!;
  const printed = printStructural(sys);
  const { model: reparsed, errors } = await parseString(printed, { validate: false });
  expect(errors, `re-parse of printed source failed:\n${printed}`).toEqual([]);
  return { printed, model: reparsed };
}

describe("ignoring filter-bypass printer", () => {
  it("find: `ignoring <Cap>` round-trips", async () => {
    const { printed } = await printAndReparse(
      wrap(`repository R for Order {
        find recent(): Order[] where this.total > 0 ignoring softDeletable
      }`),
    );
    expect(printed).toContain("ignoring softDeletable");
  });

  it("find: `ignoring *` round-trips", async () => {
    const { printed } = await printAndReparse(
      wrap(`repository R for Order {
        find allRows(): Order[] ignoring *
      }`),
    );
    expect(printed).toContain("ignoring *");
  });

  it("inline read: `Repo.findAll(...) ignoring <Cap>` round-trips", async () => {
    const { printed, model } = await printAndReparse(
      wrap(`repository R for Order { }
        workflow Sweep {
          create(x: int) {
            let xs = R.findAll(BigOrders()) ignoring softDeletable
            for o in xs { }
          }
        }`),
    );
    expect(printed).toContain("ignoring softDeletable");
    let bypass: string[] | undefined;
    for (const c of contexts(model))
      for (const member of c.members)
        if (member.$type === "Workflow")
          for (const wm of member.members)
            if (wm.$type === "WorkflowCreateDecl")
              for (const stmt of wm.body)
                if (stmt.$type === "LetStmt" && isPostfixChain(stmt.expr))
                  bypass = stmt.expr.bypass;
    expect(bypass).toEqual(["softDeletable"]);
  });
});
