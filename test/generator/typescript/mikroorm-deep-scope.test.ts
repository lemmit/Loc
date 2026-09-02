// `persistence: mikroorm` renders hierarchical (deep/global) tenancy — the
// `loom.mikroorm-unsupported` subtree boundary, drained.
//
// The `deep`/`global` read level lowers to the materialized-path `authz-filter`
// SENTINEL.  MikroORM's FilterQuery OPERATORS genuinely cannot express a prefix
// test — but a FilterQuery key may be a `raw()` SQL fragment, and the predicate
// is ordinary SQL.  The old arm threw, `mikroContextFilters` CAUGHT that throw
// and left the filter unapplied, and the validator refused the whole feature to
// stop the silent cross-tenant read that resulted.
//
// Three things have to agree, and none of them is visible to `tsc --noEmit`:
//   (1) the SQL text (a sargable escaped-LIKE prefilter ANDed with the
//       anchored prefix RECHECK that actually decides the row — M-T3.17),
//   (2) the `?` binding ARITY and order (a raw fragment binds positionally),
//   (3) the `raw` IMPORT in every repository file that emits one.
// (3) is a compile error, but only in the generated project — and (1)/(2) are
// runtime-only.  Runtime agreement (subtree reads, the delimiter trap, the
// WILDCARD trap, the NULL-dataKey floor) is gated by
// `test/e2e/tenancy-hierarchy-mikroorm.test.ts`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** The shape of `test/fixtures/corpus/tenancy-hierarchy.ddd`: a `deep`
 *  aggregate, a `global` one, a `local` (default) one, and the registry. */
const SRC = `
  system S {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain D {
      context C {
        aggregate Account with tenantOwned, crudish { label: string }
        aggregate Entry with tenantOwned, crudish { label: string }
        aggregate Memo with tenantOwned, crudish { label: string }
        aggregate Org with crudish { name: string  implements tenantRegistry }
        repository Accounts for Account { }
        repository Entries for Entry { }
        repository Memos for Memo { }
        repository Orgs for Org { }
        policy {
          allow deep on Account
          allow global on Entry
          allow local on Memo
        }
      }
    }
    api A from D
    storage primary { type: postgres }
    resource s1 { for: C, kind: state, use: primary }
    deployable api {
      platform: node { persistence: mikroorm }
      contexts: [C]
      dataSources: [s1]
      serves: A
      port: 3000
      auth: required
    }
  }
`;

let cache: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  cache ??= await generateSystemFiles(SRC);
  return cache;
}

async function repo(agg: string): Promise<string> {
  const all = await files();
  const key = [...all.keys()].find((k) => k.endsWith(`db/repositories/${agg}-repository.ts`));
  expect(key, `${agg}-repository.ts not emitted`).toBeDefined();
  return all.get(key!)!;
}

/** Split a `raw()` binding list on its TOP-LEVEL commas — commas nested inside
 *  parens/brackets/braces belong to one binding expression, not to the list. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out;
}

async function indexTs(): Promise<string> {
  const all = await files();
  const key = [...all.keys()].find((k) => k.endsWith("api/index.ts"));
  expect(key, "api/index.ts not emitted").toBeDefined();
  return all.get(key!)!;
}

describe("the deep/global subtree sentinel renders as a raw() FilterQuery key", () => {
  it("`allow deep` anchors at orgPath, descendant-or-self, with the tenant floor", async () => {
    const src = await repo("account");
    expect(src).toContain(
      'raw("((data_key is not null and (data_key = ? ' +
        "or (data_key like ? escape '!' and strpos(data_key, ?) = 1))) " +
        'or (data_key is null and tenant_id = ?))"',
    );
    expect(src).toContain(
      "[requireCurrentUser().orgPath, " +
        '(requireCurrentUser().orgPath).replace(/[!%_]/g, "!$&") + ".%", ' +
        'requireCurrentUser().orgPath + ".", requireCurrentUser().tenantId]',
    );
  });

  it("`allow global` anchors at rootOrg instead — the ROOT-subtree widening", async () => {
    const src = await repo("entry");
    expect(src).toContain('requireCurrentUser().rootOrg + "."');
    expect(src).not.toContain("requireCurrentUser().orgPath");
  });

  it("the LIKE is only a prefilter — the anchored `strpos` recheck decides the row", async () => {
    // The wildcard trap (`orgXa.leak` readable from `org_a`, because `_` is a
    // LIKE metacharacter) is a CROSS-TENANT LEAK driven by a token value.  A
    // `raw()` fragment BINDS its `?` params, which stops injection — not
    // pattern semantics.  So the LIKE added for sargability (M-T3.17) is never
    // allowed to stand ALONE: it must be ANDed with `strpos(...) = 1`, which has
    // no metacharacters at all.  Every `like` in the fragment carries both the
    // `escape` clause and the recheck beside it.
    for (const agg of ["account", "entry"]) {
      const src = await repo(agg);
      for (const [, sql] of src.matchAll(/raw\("([^"]*)"/g)) {
        if (!/\blike\b/i.test(sql!)) continue;
        expect(sql, `${agg}: a LIKE without its ESCAPE clause`).toContain("escape '!'");
        expect(sql, `${agg}: a LIKE without the anchored recheck beside it`).toMatch(
          /like \? escape '!' and strpos\(data_key, \?\) = 1/,
        );
      }
    }
  });

  it("the default (`local`) level stays the flat tenant floor — no subtree, no raw()", async () => {
    const src = await repo("memo");
    expect(src).toContain("tenantId: requireCurrentUser().tenantId");
    expect(src).not.toContain("strpos(");
    // …and therefore no `raw` import: a repository that emits no fragment keeps
    // a byte-identical import list.
    expect(src).not.toContain('from "@mikro-orm/core"');
  });
});

describe("every raw() fragment is importable and binds what it names", () => {
  it("a repository that emits a fragment imports `raw`", async () => {
    for (const agg of ["account", "entry"]) {
      const src = await repo(agg);
      expect(src, `${agg}: raw() is used but not imported`).toContain(
        'import { raw } from "@mikro-orm/core";',
      );
    }
  });

  it("`?` placeholder count matches the bound-param count, per fragment", async () => {
    // A raw fragment binds POSITIONALLY: one `?` too many or too few is a
    // runtime knex error ("Expected N bindings, saw M"), invisible to `tsc`.
    for (const agg of ["account", "entry"]) {
      const src = await repo(agg);
      const frags = [...src.matchAll(/raw\("([^"]*)",\s*\[(.*?)\]\)/g)];
      expect(frags.length, `${agg}: no raw() fragment emitted`).toBeGreaterThan(0);
      for (const [, sql, params] of frags) {
        const holes = (sql!.match(/\?/g) ?? []).length;
        // The params are host expressions; only TOP-LEVEL commas separate them
        // (`.replace(/[!%_]/g, "!$&")` carries a comma of its own inside its
        // parens, so a naive split over-counts and the check silently passes on
        // a fragment it never really measured).
        const bound = splitTopLevel(params!).filter((p) => p.trim().length > 0).length;
        expect(bound, `${agg}: "${sql}" has ${holes} '?' but ${bound} bindings`).toBe(holes);
      }
    }
  });

  it("each fragment is built INSIDE its own statement, never hoisted to a shared const", async () => {
    // A `RawQueryFragment`'s cache key is consumed on first use.  The paged find
    // runs `em.count(...)` and `em.find(...)` over the same predicate; if the
    // emitter hoisted one fragment into a `const` and spliced it twice, the
    // second statement would look up a key that has already been evicted and
    // silently treat it as a plain column name.  Two literal `raw(` call sites
    // is what keeps them two fragments.
    const src = await repo("account");
    const countLine = src.split("\n").find((l) => l.includes("const total = await em.count("));
    const findLine = src.split("\n").find((l) => l.includes("limit: pageSize"));
    expect(countLine, "paged count not emitted").toBeDefined();
    expect(findLine, "paged find not emitted").toBeDefined();
    expect(countLine!, "the paged COUNT must build its own raw() fragment").toContain("raw(");
    expect(findLine!, "the paged PAGE query must build its own raw() fragment").toContain("raw(");
  });
});

describe("the tenant-registry orgPath resolver is registered on this adapter too", () => {
  // Without it the middleware falls back to the bare CLAIM, so `orgPath` is an
  // org id rather than a materialized path: every caller reads as its own root
  // and the whole ladder collapses to the flat floor — a silent wrong answer,
  // not a crash.  It was drizzle-only (`&& !usingMikro`) for as long as the
  // adapter refused hierarchical tenancy outright.
  it("boot reads the registry Row's dataKey through the EntityManager", async () => {
    const src = await indexTs();
    expect(src).toContain("registerOrgPathResolver(async (claim) => {");
    expect(src).toContain("db.fork().findOne(OrgRow, { id: claim })");
    expect(src).toContain("return row?.dataKey ?? null;");
    // …and it imports both halves (a missing import is a generated-project
    // TS2304, which only the tsc tier would catch).
    expect(src).toContain('import { registerOrgPathResolver } from "./auth/middleware";');
    expect(src).toContain('import { OrgRow } from "./db/entities";');
    // The drizzle spelling must NOT leak onto this adapter.
    expect(src).not.toContain('import { eq } from "drizzle-orm";');
  });
});
