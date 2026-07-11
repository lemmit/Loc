// Phase 2 of "criterion everywhere — full filter targeting".
//
// A non-principal `filter <expr>` capability (the soft-delete case,
// `filter !this.isDeleted`) must be AND-ed into EVERY root-table read in
// the generated Drizzle repository — unlike EF Core's global
// HasQueryFilter, Drizzle has no automatic filter, so each read site
// (findById, findManyByIds, every find) carries the predicate explicitly.
// Half-applying it would be a soft-delete correctness hole.

import { describe, expect, it } from "vitest";
import { generateHono, generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Doc {
      subject: string
      isDeleted: bool
      filter !this.isDeleted
    }
    repository Docs for Doc {
      find bySubject(s: string): Doc[] where subject == s
    }
  }
`;

describe("typescript generator — capability filter (contextFilters)", () => {
  it("AND-s the non-principal filter into every root read site", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateHono(model);
    const repo = files.get("db/repositories/doc-repository.ts")!;
    expect(repo).toBeDefined();

    // findById: `eq(schema.docs.id, id)` AND-ed with `not(...)`.
    expect(repo).toMatch(
      /findById[\s\S]*?\.where\(and\(eq\(schema\.docs\.id, id\), not\(eq\(schema\.docs\.isDeleted, true\)\)\)\)/,
    );
    // findManyByIds: `inArray(...)` AND-ed with the filter.
    expect(repo).toMatch(
      /findManyByIds[\s\S]*?\.where\(and\(inArray\(schema\.docs\.id, ids\), not\(eq\(schema\.docs\.isDeleted, true\)\)\)\)/,
    );
    // The named find: its own `where` AND-ed with the filter.
    expect(repo).toMatch(
      /bySubject[\s\S]*?\.where\(and\(eq\(schema\.docs\.subject, s\), not\(eq\(schema\.docs\.isDeleted, true\)\)\)\)/,
    );
    // `not` must be imported from drizzle-orm (import narrower keeps it).
    expect(repo).toMatch(/import \{[^}]*\bnot\b[^}]*\} from "drizzle-orm";/);
  });

  it("reifies a filter that is exactly one named criterion (module-level fn)", async () => {
    // reified-criteria.md, the anonymous-`filter` row: `filter NotDeleted`
    // calls the criterion's module-level predicate fn instead of re-inlining
    // its body — deduped with find/retrieval consumers of the same criterion.
    const { model, errors } = await parseString(`
      context Sales {
        criterion NotDeleted of Doc = !this.isDeleted
        aggregate Doc {
          subject: string
          isDeleted: bool
          filter NotDeleted
        }
        repository Docs for Doc {
          find bySubject(s: string): Doc[] where subject == s
        }
      }
    `);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/doc-repository.ts")!;
    // One module-level predicate fn, body = the lowered criterion.
    expect(repo).toContain(
      "const notDeletedCriterion = () => not(eq(schema.docs.isDeleted, true));",
    );
    // Every root read calls the fn (no re-inlined body at the use sites).
    expect(repo).toMatch(
      /findById[\s\S]*?\.where\(and\(eq\(schema\.docs\.id, id\), notDeletedCriterion\(\)\)\)/,
    );
    expect(repo).toMatch(
      /bySubject[\s\S]*?\.where\(and\(eq\(schema\.docs\.subject, s\), notDeletedCriterion\(\)\)\)/,
    );
    // The criterion body appears exactly once (the fn) — use sites call it.
    expect(repo.match(/not\(eq\(schema\.docs\.isDeleted, true\)\)/g)).toHaveLength(1);
  });

  it("AND-s the capability filter into criterion retrievals (run<Name>) — silent-leak regression", async () => {
    // A `retrieval` lowers to a `run<Name>` repo method.  Its own `where`
    // (a distinct criterion) must still carry the always-on capability
    // filter — omitting it leaked soft-deleted / other-tenant rows through
    // every retrieval (the one root read that forgot the predicate).
    const RETRIEVAL_SRC = `
system T {
  subdomain S {
    context Sales {
      criterion InCategory(c: string) of Doc = this.category == c
      aggregate Doc {
        subject: string
        category: string
        isDeleted: bool
        filter !this.isDeleted
      }
      retrieval ByCategory(c: string) of Doc {
        where: InCategory(c)
        sort: [subject asc]
      }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: Sales, kind: state, use: pg }
  deployable d { platform: node, contexts: [Sales], dataSources: [st], serves: A, port: 4000 }
}`;
    const repo = (await generateSystemFiles(RETRIEVAL_SRC)).get(
      "d/db/repositories/doc-repository.ts",
    )!;
    expect(repo).toBeDefined();
    // runByCategory: its criterion `where` AND-ed with the capability filter.
    expect(repo).toMatch(
      /runByCategory[\s\S]*?\.where\(and\(inCategoryCriterion\(c\), not\(eq\(schema\.docs\.isDeleted, true\)\)\)\)/,
    );
  });

  it("leaves a criterion retrieval bare when the aggregate has no filter", async () => {
    const NOFILTER_SRC = `
system T {
  subdomain S {
    context Sales {
      criterion InCategory(c: string) of Doc = this.category == c
      aggregate Doc {
        subject: string
        category: string
      }
      retrieval ByCategory(c: string) of Doc {
        where: InCategory(c)
        sort: [subject asc]
      }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: Sales, kind: state, use: pg }
  deployable d { platform: node, contexts: [Sales], dataSources: [st], serves: A, port: 4000 }
}`;
    const repo = (await generateSystemFiles(NOFILTER_SRC)).get(
      "d/db/repositories/doc-repository.ts",
    )!;
    // No capability filter → the retrieval keeps its bare criterion where.
    expect(repo).toMatch(/runByCategory[\s\S]*?\.where\(inCategoryCriterion\(c\)\)/);
    expect(repo).not.toContain("isDeleted");
  });

  it("emits no capability predicate when the aggregate has no filter", async () => {
    const { model } = await parseString(`
      context Sales {
        aggregate Plain { subject: string }
        repository Plains for Plain {
          find bySubject(s: string): Plain[] where subject == s
        }
      }
    `);
    const files = generateHono(model);
    const repo = files.get("db/repositories/plain-repository.ts")!;
    // Plain findById keeps the bare id predicate (no and-wrapping).
    expect(repo).toMatch(/findById[\s\S]*?\.where\(eq\(schema\.plains\.id, id\)\)/);
  });
});

// ---------------------------------------------------------------------------
// DEBT-01 — principal-referencing (tenancy) filter on the Hono/Drizzle backend.
// `filter this.tenantId == currentUser.tenantId` renders against the ambient
// `requireCurrentUser()` accessor (the analogue of EF Core's HasQueryFilter
// reading RequestContext.Current), so it AND-s into every root read with NO
// `currentUser` parameter threaded onto the read methods.
// ---------------------------------------------------------------------------

const PRINCIPAL_SRC = `
system Bank {
  user { id: string  tenantId: string }
  subdomain Core {
    context Ledger {
      aggregate Account {
        tenantId: string
        balance: int
        filter this.tenantId == currentUser.tenantId
      }
      repository Accounts for Account {
        find rich(min: int): Account[] where balance >= min
      }
    }
  }
  api LedgerApi from Core
  storage pg { type: postgres }
  resource ledgerState { for: Ledger, kind: state, use: pg }
  deployable api { platform: node, contexts: [Ledger], dataSources: [ledgerState], serves: LedgerApi, auth: required, port: 4000 }
}
`;

describe("typescript generator — principal capability filter (DEBT-01)", () => {
  it("AND-s the tenancy predicate (via requireCurrentUser()) into every root read", async () => {
    const repo = (await generateSystemFiles(PRINCIPAL_SRC)).get(
      "api/db/repositories/account-repository.ts",
    )!;
    expect(repo).toBeDefined();

    const tenancy = "eq(schema.accounts.tenantId, requireCurrentUser().tenantId)";
    // findById and findManyByIds both AND the tenancy predicate in.
    expect(repo).toContain(`.where(and(eq(schema.accounts.id, id), ${tenancy}))`);
    expect(repo).toContain(`.where(and(inArray(schema.accounts.id, ids), ${tenancy}))`);
    // The ambient accessor is imported; no read method takes a currentUser param.
    expect(repo).toContain('import { requireCurrentUser } from "../../auth/middleware";');
    expect(repo).toContain("async findById(id: Ids.AccountId): Promise<Account | null>");
  });

  it("does not import requireCurrentUser when the filter is non-principal", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/doc-repository.ts")!;
    expect(repo).not.toContain("requireCurrentUser");
  });
});
