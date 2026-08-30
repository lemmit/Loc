// ---------------------------------------------------------------------------
// Java — the deep/global-scope SARGABLE PREFILTER must not leak Spring Data
// SpEL into a raw `EntityManager.createQuery` string (audit 2026-08-24, A8).
//
// `render-jpql.ts` has two parameter modes and the `scope` arm rendered its
// LIKE pattern in only one of them:
//
//   - `@Query` (Spring Data repositories) — SpEL parameters, `:#{…}`.
//   - `principalAccessors` (query-time projection AGGREGATIONS, which build
//     JPQL directly and hand it to `EntityManager.createQuery`) — plain named
//     parameters bound at the call site, because createQuery has NO SpEL layer.
//     `:#{` is not a legal HQL parameter name there: Hibernate throws at parse
//     and EVERY projection read over a deep/global-scoped aggregate 500s — so
//     `scaffold + hierarchical tenancy + java` shipped a dead dashboard.
//
// Every OTHER claim in the same predicate already rendered as a bound
// parameter in that mode; only the prefilter pattern was unconditional.  The
// .NET twin of the same PR got the split right (it gates on `ctx.efQuery`).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system JavaHierarchy {
  user { id: guid  tenantId: string }
  tenancy by user.tenantId of Org

  subdomain S {
    context C {
      aggregate Doc with tenantOwned {
        owner: string
        total: int
      }
      aggregate Org {
        name: string
        implements tenantRegistry
      }
      repository Docs for Doc { }
      repository Orgs for Org { }
      policy { allow deep on Doc }

      projection DocTotals {
        docs: int
        volume: int
        from Doc as d
        select docs = count(), volume = sum(d.total)
      }
    }
  }

  api ShopApi from S
  storage primarySql { type: postgres }
  resource shopState { for: C, kind: state, use: primarySql }
  deployable api1 {
    platform: java
    contexts: [C]
    dataSources: [shopState]
    serves: ShopApi
    port: 8081
    auth: required
  }
}
`;

const VIEWS = "api1/src/main/java/com/loom/api1/application/views/CQueryProjections.java";
const DOC_REPO = "api1/src/main/java/com/loom/api1/features/docs/DocJpaRepository.java";

describe("java query-projection aggregation — deep-scope prefilter parameter mode", () => {
  it("binds the subtree LIKE pattern as a named parameter — no SpEL in createQuery", async () => {
    const files = await generateSystemFiles(SRC);
    const views = files.get(VIEWS)!;
    // The whole point: Hibernate parses this string, and `:#{` is not HQL.
    expect(views).not.toContain(":#{");
    // The prefilter reads a bound parameter beside the plain claim params.
    expect(views).toContain("e.dataKey like :__cuSubtreeOrgPath escape '!'");
    expect(views).toContain('.setParameter("__cuOrgPath", __cu == null ? null : __cu.orgPath())');
    // …whose value is the escape chain, computed in JAVA at the bind site.
    expect(views).toContain(
      '.setParameter("__cuSubtreeOrgPath", __cu == null || __cu.orgPath() == null ? null : ' +
        '__cu.orgPath().replace("!", "!!").replace("%", "!%").replace("_", "!_") + ".%")',
    );
    // Fail-closed on an absent principal, matching the SpEL chain's `?.`: a
    // null pattern makes `like null` UNKNOWN, so no row passes the prefilter.
    expect(views).toContain("__cu == null || __cu.orgPath() == null ? null :");
  });

  it("leaves the Spring Data @Query path on SpEL (that mode DOES have one)", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get(DOC_REPO)!;
    expect(repo).toContain(
      "e.dataKey like :#{@currentUserAccessor.user()?.orgPath()?.replace('!', '!!')" +
        "?.replace('%', '!%')?.replace('_', '!_')?.concat('.%')} escape '!'",
    );
  });
});
