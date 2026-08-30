// node/Hono — a PER-ROW query-time projection over a `shape: document` source
// reads through the aggregate's repository, so the DOCUMENT repository must
// synthesise that read too.
//
// A query-time projection sourced from an aggregate emits a route that calls
// `repo.<projName>()` BY NAME.  The relational (drizzle) and MikroORM
// repository builders each synthesised the matching parameterless find; the
// drizzle DOCUMENT builder did not — so `projection … from <shape: document
// aggregate>` emitted `http/query-projections.ts` against a method the
// repository never declared.  Nothing said so at generate time: `tsc` inside
// the GENERATED project is what fails ("Property 'articleTitles' does not exist
// on type 'ArticleRepository'"), which this toolchain's own build cannot see.
//
// WHY A STRING TEST.  The corpus `tsc` leg proves the project compiles, but it
// only runs on the fixtures it has; what is pinned here is the INVARIANT that
// the name the projection route calls is the name the repository declares — for
// BOTH node persistence adapters, on the document shape — plus that the
// synthesised read still carries the projection's own `where` and the source
// aggregate's capability filter (the read is in-app over the rehydrated blob,
// so a dropped conjunct compiles perfectly and returns hidden rows).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = (platform: string) => `
  system S {
    subdomain D {
      context C {
        aggregate Article shape: document, with crudish, softDeletable {
          title: string
          viewCount: int
        }
        repository Articles for Article { }

        // PER-ROW arm: names declared fields, so it must read through the
        // repository (which hydrates the jsonb blob), never the table.
        projection ArticleTitles {
          heading: string
          seen: int
          from Article as a
          where a.viewCount > 10
          select heading = a.title, seen = a.viewCount
        }
      }
    }
    api Api from D
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable d {
      platform: ${platform}
      contexts: [C]
      dataSources: [cState]
      serves: Api
      port: 3000
    }
  }
`;

const cache = new Map<string, Map<string, string>>();
async function files(platform: string): Promise<Map<string, string>> {
  let f = cache.get(platform);
  if (!f) {
    f = await generateSystemFiles(SRC(platform));
    cache.set(platform, f);
  }
  return f;
}

async function file(platform: string, suffix: string): Promise<string> {
  const f = await files(platform);
  const k = [...f.keys()].find((key) => key.endsWith(suffix));
  expect(k, `${suffix} not emitted`).toBeDefined();
  return f.get(k!)!;
}

const DRIZZLE = "node";
const MIKROORM = "node { persistence: mikroorm }";

describe("node — query-time projection over a `shape: document` source", () => {
  it("the projection route calls `repo.articleTitles()`", async () => {
    const routes = await file(DRIZZLE, "http/query-projections.ts");
    expect(routes).toContain("const rows = await repo.articleTitles();");
  });

  it("the DRIZZLE document repository declares the method that route calls", async () => {
    const repo = await file(DRIZZLE, "repositories/article-repository.ts");
    expect(repo).toContain("async articleTitles(): Promise<Article[]> {");
    // Hydrate-then-filter over the rehydrated blob — the document read shape.
    expect(repo).toContain(
      "const all = rows.map((r) => articleFromDoc(r.data as ArticleDoc, r.version));",
    );
  });

  it("the synthesised read carries the projection `where` AND the capability filter", async () => {
    const repo = await file(DRIZZLE, "repositories/article-repository.ts");
    // `softDeletable` narrows first (as on every other document read), then the
    // projection's own predicate.  A missing conjunct would still compile.
    expect(repo).toContain(
      "const result = all.filter((x) => (!x.isDeleted)).filter((x) => x.viewCount > 10);",
    );
  });

  it("the MIKROORM document repository declares it too", async () => {
    const repo = await file(MIKROORM, "repositories/article-repository.ts");
    expect(repo).toContain("async articleTitles(): Promise<Article[]> {");
    expect(repo).toContain(
      "const result = all.filter((x) => (!x.isDeleted)).filter((x) => x.viewCount > 10);",
    );
  });

  it("the derived repository PORT carries it, so `implements` still type-checks", async () => {
    const ports = await file(DRIZZLE, "domain/repository-ports.ts");
    expect(ports).toContain("articleTitles(): Promise<Article[]>;");
  });
});
