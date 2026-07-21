// `ignoring` filter-bypass clause (named-filter-bypass.md §11) parses at both
// read sites: a repository `find` and an inline
// `Repo.findAll(...)`/`Repo.run(...)` call.  Both the `*` wildcard and a
// comma-separated capability list are admitted.  `ignoring` is a soft keyword,
// so a field / parameter named `ignoring` keeps parsing.

import { describe, expect, it } from "vitest";
import {
  type BoundedContext,
  type FindDecl,
  isFindDecl,
  isPostfixChain,
  isSubdomain,
  isSystem,
  type Model,
} from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

/** Every bounded context in a parsed Model. */
function contexts(model: Model): BoundedContext[] {
  const out: BoundedContext[] = [];
  for (const sys of model.members) {
    if (!isSystem(sys)) continue;
    for (const sm of sys.members) {
      if (isSubdomain(sm)) out.push(...sm.contexts);
    }
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

async function findDecl(name: string, source: string): Promise<FindDecl> {
  const { model } = await parseString(source, { validate: false });
  for (const c of contexts(model)) {
    for (const member of c.members) {
      if (member.$type === "Repository") {
        for (const f of member.finds) if (isFindDecl(f) && f.name === name) return f;
      }
    }
  }
  throw new Error(`find ${name} not found`);
}

describe("ignoring filter-bypass clause parses", () => {
  it("find: `ignoring <Cap>` populates bypass and parses cleanly", async () => {
    const { errors } = await parseString(
      wrap(`repository R for Order {
        find recent(): Order[] where this.total > 0 ignoring softDeletable
      }`),
      { validate: false },
    );
    expect(errors).toEqual([]);
    const f = await findDecl(
      "recent",
      wrap(`repository R for Order {
        find recent(): Order[] where this.total > 0 ignoring softDeletable
      }`),
    );
    expect(f.bypass).toEqual(["softDeletable"]);
    expect(f.bypassAll).toBe(false);
  });

  it("find: `ignoring *` sets bypassAll", async () => {
    const f = await findDecl(
      "allRows",
      wrap(`repository R for Order {
        find allRows(): Order[] ignoring *
      }`),
    );
    expect(f.bypassAll).toBe(true);
    expect(f.bypass).toEqual([]);
  });

  it("find: comma-separated capability list", async () => {
    const f = await findDecl(
      "multi",
      wrap(`repository R for Order {
        find multi(): Order[] where this.total > 0 ignoring softDeletable, auditable
      }`),
    );
    expect(f.bypass).toEqual(["softDeletable", "auditable"]);
  });

  it("inline read: `Repo.findAll(...) ignoring <Cap>` is a PostfixChain bypass", async () => {
    const source = wrap(`repository R for Order { }
      workflow Sweep {
        create(x: int) {
          let xs = R.findAll(BigOrders()) ignoring softDeletable
          for o in xs { }
        }
      }`);
    const { model, errors } = await parseString(source, { validate: false });
    expect(errors).toEqual([]);
    // Locate the let-bound PostfixChain.
    let found = false;
    for (const c of contexts(model))
      for (const member of c.members)
        if (member.$type === "Workflow")
          for (const wm of member.members)
            if (wm.$type === "WorkflowCreateDecl")
              for (const stmt of wm.body)
                if (stmt.$type === "LetStmt" && isPostfixChain(stmt.expr)) {
                  expect(stmt.expr.bypass).toEqual(["softDeletable"]);
                  found = true;
                }
    expect(found).toBe(true);
  });

  it("inline read: `Repo.findAll(...) ignoring *` sets bypassAll on the chain", async () => {
    const source = wrap(`repository R for Order { }
      workflow Sweep {
        create(x: int) {
          let ys = R.findAll(BigOrders()) ignoring *
          for o in ys { }
        }
      }`);
    const { model } = await parseString(source, { validate: false });
    let bypassAll = false;
    for (const c of contexts(model))
      for (const member of c.members)
        if (member.$type === "Workflow")
          for (const wm of member.members)
            if (wm.$type === "WorkflowCreateDecl")
              for (const stmt of wm.body)
                if (stmt.$type === "LetStmt" && isPostfixChain(stmt.expr))
                  bypassAll = stmt.expr.bypassAll;
    expect(bypassAll).toBe(true);
  });

  it("`ignoring` stays a soft keyword — a field named `ignoring` still parses", async () => {
    const { errors } = await parseString(
      `system S { subdomain D { context C {
        aggregate Order { ignoring: bool }
      }}}`,
      { validate: false },
    );
    expect(errors).toEqual([]);
  });
});
