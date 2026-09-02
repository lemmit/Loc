import { describe, expect, it } from "vitest";
import { matchRepoRead, runCriterionMatcher } from "../../../src/ir/lower/repo-read.js";
import {
  type BoundedContext,
  type Expression,
  isBoundedContext,
  isDomainService,
  isRepository,
  isSubdomain,
  isSystem,
  type Repository,
} from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

// `repo-read.ts` is the single source of truth for "is this expression a
// repository READ", consumed by BOTH the workflow lowerer and the
// domain-service lowerer.  A miss lowers a read to a generic expression (the
// criterion is silently dropped and the query returns EVERY row — the
// data-exposure the `criterionName` field's own comment names); a false hit
// lowers a write as a read, past the purity gate.  377 lines of pattern
// matching, and no test imported it.  M-T9.17 slice 2.
//
// FIXTURES ARE PARSED, NOT HAND-BUILT.  The mission asks for an
// `EnrichedAggregateIR` builder, but this module is the one target that does
// NOT take IR — it matches over the raw Langium AST (`Expression`,
// `Repository`, `PostfixChain`).  Hand-assembling those nodes would encode my
// reading of the grammar rather than the grammar, and would keep passing after
// a grammar change that broke the real matcher.  So each case parses real
// `.ddd` and pulls the expression out of a domain-service body.

/** Parse `body` as the single statement of a `reading` domain service and hand
 *  back the expression it returns, plus the context's repositories. */
async function exprOf(
  bodyExpr: string,
  extraMembers = "",
): Promise<{ expr: Expression; repos: Map<string, Repository>; ctx: BoundedContext }> {
  const src = `
system S {
  subdomain Sub {
    context C {
      aggregate Order with crudish { code: string  archived: bool }
      criterion Active of Order = !this.archived
      retrieval ActiveOrders() of Order { where: Active  sort: [code asc] }
      repository Orders for Order {
        find byCode(code: string): Order[] where this.code == code
      }
${extraMembers}
      domainService Probe reading {
        operation peek(): int {
          let x = ${bodyExpr}
          return 1
        }
      }
    }
  }
}`;
  const { model } = await parseString(src);
  let ctx: BoundedContext | undefined;
  for (const sm of model.members ?? []) {
    if (!isSystem(sm)) continue;
    for (const m of sm.members ?? []) {
      if (!isSubdomain(m)) continue;
      for (const c of m.contexts ?? []) if (isBoundedContext(c)) ctx = c;
    }
  }
  if (!ctx) throw new Error("context not found");

  const repos = new Map<string, Repository>();
  for (const m of ctx.members) if (isRepository(m)) repos.set(m.name, m);

  const svc = ctx.members.find(isDomainService);
  if (!svc) throw new Error("domain service not found");
  // The `let x = <expr>` initialiser of the operation's first statement.
  const stmt = (svc.operations?.[0]?.stmts ?? [])[0] as { expr?: Expression } | undefined;
  const expr = stmt?.expr;
  if (!expr) throw new Error(`no let-initialiser parsed for: ${bodyExpr}`);
  return { expr, repos, ctx };
}

describe("matchRepoRead — the four read shapes", () => {
  it("recognises a NAMED find and carries its args", async () => {
    const { expr, repos } = await exprOf(`Orders.byCode("A1")`);
    const m = matchRepoRead(expr, repos);
    expect(m?.kind).toBe("named");
    expect(m?.method).toBe("byCode");
    expect(m?.args).toHaveLength(1);
  });

  it("recognises `getById` as a named read", async () => {
    const { expr, repos } = await exprOf(`Orders.getById("id")`);
    expect(matchRepoRead(expr, repos)?.kind).toBe("named");
  });

  it("recognises `find(<Criterion>)` and CARRIES the criterion name", async () => {
    // The load-bearing assertion: dropping `criterionName` is not a crash, it
    // is a read that silently returns every row.
    const { expr, repos } = await exprOf(`Orders.find(Active)`);
    const m = matchRepoRead(expr, repos);
    expect(m?.kind).toBe("find");
    expect(m?.criterionName).toBe("Active");
  });

  it("recognises `findAll(<Criterion>)` and carries the criterion name", async () => {
    const { expr, repos } = await exprOf(`Orders.findAll(Active)`);
    const m = matchRepoRead(expr, repos);
    expect(m?.kind).toBe("findAll");
    expect(m?.criterionName).toBe("Active");
  });

  it("recognises `run(<Retrieval>())` and carries the retrieval name", async () => {
    const { expr, repos } = await exprOf(`Orders.run(ActiveOrders())`);
    const m = matchRepoRead(expr, repos);
    expect(m?.kind).toBe("run");
    expect(m?.retrievalName).toBe("ActiveOrders");
    expect(m?.criterionName).toBeUndefined();
  });

  it("returns undefined for a WRITE — the purity gate depends on this", async () => {
    // `save` must NOT match: a read-classified write would pass the
    // `reading` domain-service gate.
    const { expr, repos } = await exprOf(`Orders.save(1)`);
    expect(matchRepoRead(expr, repos)).toBeUndefined();
  });

  it("returns undefined for a call on something that is not a repository", async () => {
    const { expr, repos } = await exprOf(`Nope.find(Active)`);
    expect(matchRepoRead(expr, repos)).toBeUndefined();
  });

  it("returns undefined for a non-call expression, and for undefined", async () => {
    const { expr, repos } = await exprOf(`1 + 1`);
    expect(matchRepoRead(expr, repos)).toBeUndefined();
    expect(matchRepoRead(undefined, repos)).toBeUndefined();
  });
});

describe("runCriterionMatcher — `run` over a criterion vs a retrieval", () => {
  it("says a plain criterion IS a criterion-run", async () => {
    const { ctx } = await exprOf(`1`);
    // `Active` is a criterion and not a retrieval.
    expect(runCriterionMatcher(ctx)("Active")).toBe(true);
  });

  it("gives RETRIEVAL precedence for a name that is both", async () => {
    // The documented back-compat rule: a declared retrieval keeps its meaning,
    // so `run` only re-routes a name that is a criterion and NOT a retrieval.
    const { ctx } = await exprOf(
      `1`,
      `      criterion Dual of Order = !this.archived
      retrieval Dual() of Order { where: Active  sort: [code asc] }`,
    );
    expect(runCriterionMatcher(ctx)("Dual")).toBe(false);
  });

  it("says an unknown name is not a criterion-run", async () => {
    const { ctx } = await exprOf(`1`);
    expect(runCriterionMatcher(ctx)("Ghost")).toBe(false);
    expect(runCriterionMatcher(ctx)("ActiveOrders")).toBe(false);
  });

  it("an UNDEFINED context never matches — the system-level `test e2e` case", () => {
    // Documented in the function's own comment: no enclosing context means
    // `run` keeps its retrieval-only meaning.
    expect(runCriterionMatcher(undefined)("Active")).toBe(false);
  });

  it("re-routes a criterion `run` to the findAllBy<Criterion> shape", async () => {
    const { expr, repos, ctx } = await exprOf(`Orders.run(Active)`);
    const m = matchRepoRead(expr, repos, runCriterionMatcher(ctx));
    expect(m?.kind).toBe("run");
    // The criterion rides as `criterionName`, not `retrievalName` — that is
    // what makes the backend synthesise `findAllByActive` instead of looking
    // for a retrieval that does not exist.
    expect(m?.criterionName).toBe("Active");
    expect(m?.retrievalName).toBeUndefined();
  });

  it("WITHOUT the predicate, the same `run(Active)` is not a criterion run", async () => {
    // Proves the predicate is load-bearing rather than decorative: the same
    // source parsed the same way answers differently when it is omitted.
    const { expr, repos } = await exprOf(`Orders.run(Active)`);
    const m = matchRepoRead(expr, repos);
    expect(m?.criterionName).toBeUndefined();
  });
});
