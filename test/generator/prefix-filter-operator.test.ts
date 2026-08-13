// The `startsWith` PREFIX-MATCH filter operator, per backend
// (`docs/old/proposals/tenancy-authorization-final-surface.md` decision 2 — the
// one genuinely-new operator the reconciled tenancy surface asks for; catalogue
// row in `src/util/intrinsics.ts`).
//
// Two things are pinned here that the intrinsic-completeness gate cannot see:
//
//  1. **Predicate position resolves.** `startsWith` is the first `queryable`
//     intrinsic that RETURNS BOOL, so it stands alone as a whole predicate.
//     Every other queryable row only ever appears as a comparison operand, so
//     each backend's query lowerer reached its intrinsic table exclusively from
//     the value/column-position renderer — Drizzle returned `null` (→ an
//     internal "should have been caught by the validator" throw) and the JPA
//     Criteria renderer threw `unsupported` until they learned this shape.
//     A completeness gate over the snippet TABLES is blind to that: the row is
//     present, the dispatch never reaches it.
//
//  2. **The lowering is anchored, not `LIKE`.** `col LIKE $p || '%'` would make
//     a `%`/`_` inside the VALUE behave as a wildcard, silently over-matching.
//     Each assertion below names the anchored form its backend emits, so a
//     future "simplification" to `LIKE` fails here as well as in the runtime
//     fixture (`test/fixtures/corpus/prefix-filter.ddd`, which asserts the
//     resulting ROWS on all five backends).
//
// Both queryable positions are covered per backend: an inline `find … where`
// (find/JPQL/Drizzle path) and a reusable `criterion` installed as a capability
// `filter` (Specification / `@SQLRestriction` / static path).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const src = (platform: string, extra = ""): string => `
system Tree {
  subdomain Core {
    context Docs {
      criterion UnderRoot of Doc = this.path.startsWith("root")
      aggregate Doc {
        path: string
        filter UnderRoot
      }
      repository Docs for Doc {
        find under(prefix: string): Doc[] where this.path.startsWith(prefix)
      }
    }
  }
  api DocsApi from Core
  storage primary { type: postgres }
  resource docsState { for: Docs, kind: state, use: primary }
  deployable d {
    platform: ${platform}${extra}
    contexts: [Docs]
    dataSources: [docsState]
    serves: DocsApi
    port: 4000
  }
}
`;

/** Every emitted file's text joined — these assertions are about the SQL/
 *  predicate shape, not about which file it landed in (that differs per
 *  backend and is pinned by each backend's own emitter tests). */
async function emitAll(platform: string, extra = ""): Promise<string> {
  const files = await generateSystemFiles(src(platform, extra));
  return [...files.values()].join("\n");
}

describe("startsWith — the queryable prefix-match operator", () => {
  it("is accepted in both queryable positions (no `not-queryable` diagnostic)", async () => {
    const { errors } = await parseString(src("node"));
    expect(errors).toEqual([]);
  });

  it("node/drizzle emits an anchored strpos, never a LIKE", async () => {
    const out = await emitAll("node");
    // The find's bound parameter and the criterion's literal, both anchored.
    expect(out).toContain("strpos(${schema.docs.path}, ${prefix}) = 1");
    expect(out).toContain('strpos(${schema.docs.path}, ${"root"}) = 1');
    expect(out).not.toMatch(/like\(schema\.docs\.path/);
  });

  it("python/sqlalchemy emits func.strpos == 1", async () => {
    const out = await emitAll("python");
    expect(out).toContain("func.strpos(DocRow.path, prefix) == 1");
    expect(out).toContain('func.strpos(DocRow.path, "root") == 1');
    expect(out).not.toContain("DocRow.path.startswith(");
  });

  it("elixir/ecto emits a strpos fragment", async () => {
    const out = await emitAll("elixir");
    expect(out).toContain('fragment("strpos(?, ?) = 1", record.path, ^prefix)');
    expect(out).toContain('fragment("strpos(?, ?) = 1", record.path, "root")');
    expect(out).not.toMatch(/like\(record\.path/);
  });

  it("java emits JPQL locate() in the find and cb.locate() in the Specification", async () => {
    const out = await emitAll("java");
    expect(out).toContain("locate(:prefix, e.path) = 1");
    expect(out).toContain('cb.equal(cb.locate(root.<String>get("path"), "root"), 1)');
    // The capability filter's static face — Hibernate's @SQLRestriction, which
    // renders raw Postgres text and threw `unsupported` on any method-call
    // before this operator landed.
    expect(out).toContain("@SQLRestriction(\"strpos(path, 'root') = 1\")");
  });

  it("dotnet/efcore emits the ONE-argument StartsWith (the only EF-translatable overload)", async () => {
    const out = await emitAll("dotnet");
    expect(out).toContain("Path.StartsWith(prefix)");
    expect(out).toContain('Path.StartsWith("root")');
    // The StringComparison overload — correct for an in-memory domain body — is
    // NOT translatable by EF Core, so it must not reach a query position.
    expect(out).not.toMatch(/Path\.StartsWith\([^)]*StringComparison/);
  });

  it("dotnet/dapper emits raw-SQL strpos (the adapter that writes its own SQL)", async () => {
    const out = await emitAll("dotnet", " { persistence: dapper }");
    expect(out).toContain("strpos(path, 'root') = 1");
  });
});

describe("queryable intrinsics on the Dapper adapter (the crash this operator surfaced)", () => {
  // `DAPPER_SUBSET` in `src/ir/util/find-predicate-capability.ts` declares the
  // Dapper adapter fully-lowerable over the queryable subset, but `whereToSql`
  // carried no intrinsic arm at all — so ANY queryable intrinsic in a find or
  // capability filter aborted codegen with a bare `Error` (never a `loom.*`
  // diagnostic), the same shape as the `policy { deny }`-on-dapper crash of
  // #2492.  Pinned with `trim`, not `startsWith`, so the regression is caught
  // even if the prefix operator is later reworked.
  const trimSrc = `
system Trimmed {
  subdomain Core {
    context Docs {
      criterion Trimmed of Doc = this.path.trim() == "root"
      aggregate Doc {
        path: string
        filter Trimmed
      }
    }
  }
  api DocsApi from Core
  storage primary { type: postgres }
  resource docsState { for: Docs, kind: state, use: primary }
  deployable d {
    platform: dotnet { persistence: dapper }
    contexts: [Docs]
    dataSources: [docsState]
    serves: DocsApi
    port: 4000
  }
}
`;

  it("generates instead of crashing, and emits the Postgres form", async () => {
    const files = await generateSystemFiles(trimSrc);
    expect([...files.values()].join("\n")).toContain("btrim(path) = 'root'");
  });
});
