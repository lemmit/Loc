// B10 (full-review-remediation §B10, audit finding 3): a `domainService`
// `reading`-tier body that runs a criterion / retrieval read
// (`Accounts.findAll(<Criterion>)` / `Repo.run(<Retrieval>)`) must CARRY the
// criterion through the lowered `repo-read` and materialise the backing
// retrieval — otherwise the criterion is silently dropped (the read returns
// every row, data-exposure-grade) AND the emitted call hits a nonexistent /
// whole-table method.
//
// Before the fix `richOnes(): Account[] { return Accounts.findAll(Rich) }`
// generated `accounts.findAll()` — criterion gone.  These pin the lowering
// marker, the domain-service-body retrieval synthesis, and the Hono output.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, type ExprIR, type StmtIR } from "../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const SYS = (op: string, extra = ""): string => `
system S {
  subdomain Banking {
    context Accounts {
      aggregate Account { holder: string  balance: int }
      repository AccountsRepo for Account { }
      criterion Rich of Account = balance > 1000
      criterion Above(n: int) of Account = balance > n
      ${extra}
      domainService Pricing {
        ${op}
      }
    }
  }
  api A from Banking
  storage pg { type: postgres }
  resource s { for: Accounts, kind: state, use: pg }
  deployable d { platform: node  contexts: [Accounts]  dataSources: [s]  serves: A  port: 3000 }
}`;

async function enriched(op: string, extra = "") {
  const { model } = await parseString(SYS(op, extra), { validate: false });
  return enrichLoomModel(lowerModel(model));
}

/** The lowered body of the first domain-service operation. */
function opBody(m: Awaited<ReturnType<typeof enriched>>): StmtIR[] {
  return allContexts(m)[0]!.domainServices[0]!.operations[0]!.body;
}

/** The `repo-read` Call inside a `return <expr>` body statement. */
function repoReadCall(body: StmtIR[]): Extract<ExprIR, { kind: "call" }> {
  const ret = body.find((s) => s.kind === "return") as Extract<StmtIR, { kind: "return" }>;
  expect(ret, "return statement").toBeDefined();
  const call = ret.value as Extract<ExprIR, { kind: "call" }>;
  expect(call.kind).toBe("call");
  return call;
}

describe("B10 — domain-service criterion read carries the criterion", () => {
  it("lowers findAll(<Criterion>) to a repo-read marked synthCriterion + retrievalName", async () => {
    const m = await enriched(
      `operation richOnes(): Account[] { return AccountsRepo.findAll(Rich) }`,
    );
    const call = repoReadCall(opBody(m));
    expect(call.callKind).toBe("repo-read");
    expect(call.repoRead?.readKind).toBe("findAll");
    expect(call.repoRead?.synthCriterion).toEqual({ name: "Rich" });
    expect(call.repoRead?.retrievalName).toBe("findAllByRich");
    expect(call.repoRead?.aggregate).toBe("Account");
  });

  it("materialises the synthetic retrieval from a domain-service body (not just workflows)", async () => {
    const m = await enriched(
      `operation richOnes(): Account[] { return AccountsRepo.findAll(Rich) }`,
    );
    const ret = allContexts(m)[0]!.retrievals.find((r) => r.name === "findAllByRich");
    expect(ret, "findAllByRich retrieval materialised").toBeDefined();
    expect(ret?.targetType).toEqual({ kind: "entity", name: "Account" });
    expect(ret?.criterionRef?.name).toBe("Rich");
  });

  it("carries a parameterised criterion's args through the read", async () => {
    const m = await enriched(
      `operation richerThan(n: int): Account[] { return AccountsRepo.findAll(Above(n)) }`,
    );
    const call = repoReadCall(opBody(m));
    expect(call.repoRead?.retrievalName).toBe("findAllByAbove");
    // The criterion argument (`n`) is carried as the call's positional arg — not
    // dropped, so the emitted retrieval call passes it.
    expect(call.args.map((a) => (a.kind === "ref" ? a.name : "?"))).toEqual(["n"]);
  });

  it("lowers Repo.run(<Retrieval>) to a repo-read against the named retrieval", async () => {
    const m = await enriched(
      `operation recent(): Account[] { return AccountsRepo.run(Recent) }`,
      `retrieval Recent of Account = Rich`,
    );
    const call = repoReadCall(opBody(m));
    expect(call.repoRead?.readKind).toBe("run");
    expect(call.repoRead?.retrievalName).toBe("Recent");
  });

  it("emits a Hono service that calls the retrieval method (criterion applied, not dropped)", async () => {
    const files = await generateSystemFiles(
      SYS(`operation richOnes(): Account[] { return AccountsRepo.findAll(Rich) }`),
    );
    const services = [...files.entries()].find(([k]) => k.endsWith("domain/services.ts"))?.[1];
    expect(services, "domain/services.ts").toBeDefined();
    // The read renders against the synthesized retrieval method — so the query
    // actually applies `Rich` — instead of the whole-table `findAll()`.
    expect(services).toContain("runFindAllByRich(");
    expect(services).not.toMatch(/\.findAll\(\)/);
    // The generated repository actually exposes that method.
    const repo = [...files.entries()].find(([k]) => /account-repository\.ts$/.test(k))?.[1];
    expect(repo, "account-repository.ts").toBeDefined();
    expect(repo).toContain("runFindAllByRich");
  });
});
