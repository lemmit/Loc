// The `deep`/`global` subtree scope is decided by an ANCHORED PREFIX, and any
// LIKE beside it is an ESCAPED prefilter — never the thing that admits the row.
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
// #2562 fixed it with an anchored position test, which has no pattern language
// at all.  M-T3.17 then had to put a LIKE BACK — `strpos`/`locate` is a function
// of the column, so no index can serve it and every deep read seq-scanned — but
// as a PREFILTER only: `<col> LIKE <escaped-anchor>.% ESCAPE '!' AND <anchored
// test>`.  The anchored test still decides the row, so a slip in the escaping
// can only cost selectivity, never widen the result.
//
// So this file pins the invariant in the shape it now has, per backend:
//   (a) the anchored test is PRESENT (it is what excludes `acmeXcorp.…`), and
//   (b) every LIKE that reaches SQL carries an ESCAPE clause, and
//   (c) no pattern is ever built from a RAW, unescaped anchor.
// (b) and (c) together are the negative half the old "no LIKE anywhere" check
// used to give: a backend that emitted a bare `LIKE anchor || '.%'` alongside
// the anchored test would fail both.
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

/** Every spelling of "this LIKE has an escape character bound to it".  A LIKE
 *  on a line matching none of these is running the raw claim as a pattern. */
const ESCAPED_LIKE = [
  "escape '!'", // raw SQL (MikroORM raw(), Ecto fragment, JPQL) — lower/upper
  'escape="!"', // SQLAlchemy Column.like(pattern, escape="!")
  ', "!")', // EF Core: EF.Functions.Like(col, pattern, "!")
  ", '!')", // JPA Criteria: cb.like(path, pattern, '!')
];

function unescapedLikeLines(src: string): string[] {
  return src.split("\n").filter((line) => {
    if (!/\blike\b/i.test(line)) return false;
    const lower = line.toLowerCase();
    return !ESCAPED_LIKE.some((tok) => lower.includes(tok.toLowerCase()));
  });
}

describe("hierarchical tenancy — the subtree test is anchored; any LIKE is an escaped prefilter", () => {
  it.each([
    // [platform, the anchored form it must emit, a RAW-anchor pattern it must not]
    [
      "node",
      'strpos(${schema.accounts.dataKey}, ${requireCurrentUser().orgPath + "."}) = 1',
      'requireCurrentUser().orgPath + ".%"',
    ],
    [
      "python",
      'func.strpos(AccountRow.data_key, require_current_user().org_path + ".") == 1',
      ".startswith(",
    ],
    [
      "java",
      "locate(concat(:#{@currentUserAccessor.user()?.orgPath()}, '.'), e.dataKey) = 1",
      "concat(:#{@currentUserAccessor.user()?.orgPath()}, '.%')",
    ],
    ["elixir", "strpos(?, ? || '.') = 1", "LIKE ? || '.%'"],
    // The SECOND node persistence adapter.  MikroORM's FilterQuery operators
    // have no prefix test, so the predicate is a `raw()` SQL fragment used as a
    // FilterQuery key — a different renderer with the same trap available to it,
    // which is exactly why it needs its own cell here rather than riding the
    // `node` row above.
    [
      "node { persistence: mikroorm }",
      "strpos(data_key, ?) = 1",
      'requireCurrentUser().orgPath + ".%"',
    ],
  ])("%s emits the anchored prefix and never a raw-anchor pattern", async (platform, anchored, rawPattern) => {
    const src = await emitFor(platform);
    expect(src, `${platform}: the anchored test that DECIDES the row is missing`).toContain(
      anchored,
    );
    // A backend emitting the raw-anchor spelling would leak on whichever read
    // used it, whether or not the anchored test is also present.
    expect(src, `${platform}: a LIKE pattern built from the raw claim`).not.toContain(rawPattern);
  });

  it("no SQL backend emits an unescaped LIKE", async () => {
    for (const platform of ["node", "node { persistence: mikroorm }", "python", "java", "elixir"]) {
      const offenders = unescapedLikeLines(await emitFor(platform));
      expect(
        offenders,
        `${platform}: LIKE without an ESCAPE clause:\n${offenders.join("\n")}`,
      ).toHaveLength(0);
    }
  });

  it("every `.%` pattern suffix is produced by the escape chain", async () => {
    // The `%` half of the original bug — a claim containing `%` matched
    // EVERYTHING under the tenant root.  The suffix is allowed back only as the
    // tail of an escaped pattern, so each backend that emits `.%` must also
    // emit its escape chain.
    const chains: ReadonlyArray<readonly [string, string]> = [
      ["node", '.replace(/[!%_]/g, "!$&")'],
      ["node { persistence: mikroorm }", '.replace(/[!%_]/g, "!$&")'],
      ["python", '.replace("!", "!!").replace("%", "!%").replace("_", "!_")'],
      ["java", "?.replace('!', '!!')?.replace('%', '!%')?.replace('_', '!_')"],
      ["elixir", 'String.replace("!", "!!")'],
    ];
    for (const [platform, chain] of chains) {
      const src = await emitFor(platform);
      if (!src.includes(".%")) continue;
      expect(src, `${platform}: a \`.%\` pattern with no escape chain in front of it`).toContain(
        chain,
      );
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
    // The anchored test that decides the row…
    expect(criteria).toContain("cb.locate(");
    // …and the prefilter beside it carries the escape character AND an escaped
    // pattern — never `currentUser.orgPath() + ".%"` raw.
    expect(criteria).toContain(
      'currentUser.orgPath().replace("!", "!!").replace("%", "!%").replace("_", "!_") + ".%"',
    );
    expect(criteria).not.toContain('currentUser.orgPath() + ".%"');
    expect(unescapedLikeLines(criteria)).toHaveLength(0);
  });
});
