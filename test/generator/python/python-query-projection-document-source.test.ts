// Python/FastAPI — a PER-ROW query-time projection over a `shape: document`
// source reads through the aggregate's repository, so the DOCUMENT repository
// must synthesise that read too.
//
// `queryProjectionViews` + `viewFindMethod` gave the RELATIONAL repository a
// parameterless `repo.<snake(projName)>()` per query-time projection; the
// document repository never consumed them, so `app/http/query_projections_routes.py`
// called `await repo.article_titles()` on a repository that declares no such
// method — an `AttributeError` on the first request to the projection endpoint,
// with nothing said at generate time.  Python has no compile step to catch it
// (`ruff`/`mypy` see an attribute on an untyped call chain), so the emitted
// string IS the gate.
//
// Pinned here: the route's call name and the repository's method name are the
// same string, and the synthesised read still carries the projection's own
// `where` AND the source aggregate's capability filter — the read runs in-app
// over the rehydrated blob, so a dropped conjunct silently returns hidden rows.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
  system S {
    subdomain D {
      context C {
        aggregate Article shape: document, with crudish, softDeletable {
          title: string
          viewCount: int
        }
        repository Articles for Article { }

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
      platform: python
      contexts: [C]
      dataSources: [cState]
      serves: Api
      port: 3000
    }
  }
`;

let cached: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  cached ??= await generateSystemFiles(SRC);
  return cached;
}

async function file(suffix: string): Promise<string> {
  const f = await files();
  const k = [...f.keys()].find((key) => key.endsWith(suffix));
  expect(k, `${suffix} not emitted`).toBeDefined();
  return f.get(k!)!;
}

describe("python — query-time projection over a `shape: document` source", () => {
  it("the projection route calls `repo.article_titles()`", async () => {
    const routes = await file("http/query_projections_routes.py");
    expect(routes).toContain("rows = await repo.article_titles()");
  });

  it("the document repository declares the method that route calls", async () => {
    const repo = await file("repositories/article_repository.py");
    expect(repo).toContain("    async def article_titles(self) -> list[Article]:");
    // Hydrate-then-filter over the rehydrated blob — the document read shape.
    expect(repo).toContain("        items = [_article_from_doc(r.data, r.version) for r in rows]");
  });

  it("the synthesised read carries the capability filter AND the projection `where`", async () => {
    const repo = await file("repositories/article_repository.py");
    expect(repo).toContain(
      "        result = [x for x in items if ((not x.is_deleted)) and (x.view_count > 10)]",
    );
  });

  it("logs the read under the projection's own name, like the relational view find", async () => {
    const repo = await file("repositories/article_repository.py");
    expect(repo).toContain(
      '        log("debug", "find_executed", aggregate="Article", find="ArticleTitles", rows=len(result))',
    );
  });
});
