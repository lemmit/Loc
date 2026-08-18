// The `deep`/`global` subtree scope is an ANCHORED PREFIX, not a LIKE pattern.
//
// The anchor is a principal CLAIM (`orgPath` / `rootOrg`), so it is DATA, and
// `_` / `%` inside it are LIKE wildcards.  Every SQL backend used to build the
// descendant test as `<col> LIKE <anchor> || '.%'`, which means an org named
// `acme_corp` produced the pattern `acme_corp.%` — and `_` matches any single
// character, so it also matched `acmeXcorp.…`.  That is a cross-tenant read
// with no attacker involved: just an underscore in an organisation name.
//
// Parameter binding does not help.  Every backend already bound the value
// (Drizzle's `like`, Ecto's `^`, SQLAlchemy's `startswith`, JPQL's `:param`),
// which stops INJECTION but not WILDCARD SEMANTICS — the value is interpolated
// into a pattern, and a pattern is a language.
//
// The fix is the form the repo already chose for `string.startsWith` when it
// became queryable (M-T3.6): an anchored position test, which has no pattern
// language at all and therefore needs no ESCAPE discipline.  This test pins
// BOTH directions per backend — the anchored form is present AND the wildcard
// form is gone — because only asserting the former would pass on a backend that
// emitted both.
//
// Note SQLAlchemy specifically: `Column.startswith(v)` does NOT auto-escape by
// default (that needs `autoescape=True`, which rewrites to `'a/_c.' … ESCAPE
// '/'`).  The Python emitter's comment claimed it did, which is why the hole
// survived review there.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";
import { corpusSource } from "../fixtures/corpus/harness.js";

/** The shipped hierarchical-tenancy fixture, specialised per backend. */
async function emitFor(platform: string): Promise<string> {
  const files = await generateSystemFiles(
    corpusSource("tenancy-hierarchy").replaceAll("__PLATFORM__", platform),
  );
  return [...files]
    .filter(([p]) => /repositor|JpaRepository|_repository/i.test(p))
    .map(([, c]) => c)
    .join("\n");
}

describe("hierarchical tenancy — the subtree test is anchored, not a LIKE pattern", () => {
  it.each([
    // [platform, the anchored form it must emit, the wildcard form it must not]
    [
      "node",
      'strpos(${schema.accounts.dataKey}, ${requireCurrentUser().orgPath + "."}) = 1',
      "like(",
    ],
    [
      "python",
      'func.strpos(AccountRow.data_key, require_current_user().org_path + ".") == 1',
      ".startswith(",
    ],
    [
      "java",
      "locate(concat(:#{@currentUserAccessor.user()?.orgPath()}, '.'), e.dataKey) = 1",
      " like ",
    ],
    ["elixir", "strpos(?, ? || '.') = 1", "LIKE ? || '.%'"],
    // The SECOND node persistence adapter.  MikroORM's FilterQuery operators
    // have no prefix test, so the predicate is a `raw()` SQL fragment used as a
    // FilterQuery key — a different renderer with the same trap available to it,
    // which is exactly why it needs its own cell here rather than riding the
    // `node` row above.
    ["node { persistence: mikroorm }", "starts_with(data_key, ?)", " like "],
  ])("%s emits the anchored prefix and no wildcard pattern", async (platform, anchored, wildcard) => {
    const src = await emitFor(platform);
    expect(src).toContain(anchored);
    // The wildcard spelling must be gone entirely: a backend emitting both
    // would still leak on whichever read used the LIKE arm.
    expect(src).not.toContain(wildcard);
  });

  // The `%` half of the same bug — a claim containing `%` matched EVERYTHING
  // under the tenant root.  No emitted pattern may end in the `.%` suffix that
  // made the anchor a pattern in the first place.
  it("emits no `.%` pattern suffix on any SQL backend", async () => {
    for (const platform of ["node", "node { persistence: mikroorm }", "python", "java", "elixir"]) {
      expect(await emitFor(platform), platform).not.toContain(".%");
    }
  });

  // Java has a SECOND renderer for the same sentinel.  The `@Query` JPQL above
  // scopes the repository's own reads; a REIFIED retrieval reads through
  // `JpaSpecificationExecutor.findAll(spec)`, which bypasses those, so the
  // scope is re-rendered as a `tenantScope(User)` Criteria factory
  // (`render-criteria.ts`).  It had the identical wildcard bug and is reached
  // only when the context declares a criterion, which the corpus fixture does
  // not — so it needs its own case or the fix goes unpinned on that path.
  it("java's Criteria tenantScope factory is anchored too", async () => {
    const files = await generateSystemFiles(`
system TenantCriteria {
  user { id: guid  tenantId: string  orgPath: string }
  tenancy by user.tenantId of Org
  subdomain Core {
    context Books {
      aggregate Account with tenantOwned, crudish {
        label: string
        balance: int
      }
      aggregate Org with crudish {
        name: string
        implements tenantRegistry
      }
      criterion RichAccount of Account = this.balance > 100
      repository Accounts for Account { }
      repository Orgs for Org { }
      retrieval TopAccounts of Account { where: RichAccount }
      policy { allow deep on Account }
    }
  }
  api BooksApi from Core
  storage primary { type: postgres }
  resource st { for: Books, kind: state, use: primary }
  auth { oidc { issuer: "https://i", clientId: "c" } }
  deployable d {
    platform: java
    contexts: [Books]
    dataSources: [st]
    serves: BooksApi
    port: 4000
    auth: required
  }
}
`);
    const criteria = [...files]
      .filter(([p]) => /domain\/criteria\/.*\.java$/.test(p))
      .map(([, c]) => c)
      .join("\n");
    expect(criteria).toContain("tenantScope(User currentUser)");
    expect(criteria).toContain("cb.locate(");
    expect(criteria).not.toContain("cb.like(");
    expect(criteria).not.toContain(".%");
  });
});
