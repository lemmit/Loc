// ---------------------------------------------------------------------------
// `ignoring` filter-bypass on the Python/FastAPI+SQLAlchemy backend
// (named-filter-bypass.md §11).  SQLAlchemy has no global query filter, so each
// root read AND-s the aggregate's capability predicates explicitly
// (`contextFilterPredicate`, src/generator/python/find-predicate.ts).  A read
// carrying `ignoring <Cap>` / `ignoring *` simply OMITS the named capability
// conjunct for that read only — the bypass is baked in statically (no runtime
// param).  A bare (capability-less) `filter` is NEVER bypassable.
//
// The phoenix analogue is test/generator/elixir/phoenix-filter-bypass.test.ts;
// the always-on emission is guarded by context-filter-emit.test.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const REPO = "api/app/db/repositories/doc_repository.py";

async function build(source: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(source);
  if (errors.length) throw new Error(`source has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

/** The body of one repository method (`async def <name>(…):` up to the next
 *  `    async def`/`    def` or EOF). */
function method(repo: string, name: string): string {
  const lines = repo.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^ {4}(async )?def ${name}\\(`).test(l));
  expect(start, `method ${name} not emitted`).toBeGreaterThanOrEqual(0);
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {4}(async )?def /.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out.join("\n");
}

// softDeletable contributes a `not_(... is_deleted)` capability filter; `recent`
// ignores it; `normal` does not; `allRows` ignores * (every capability filter).
// A bare `filter this.total > 0` (undefined origin) is NEVER bypassable.
function sys(repoBody: string, extraFilters = ""): string {
  return `
system Sys {
  capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
  subdomain Sales {
    context Docs {
      aggregate Doc with softDeletable {
        subject: string
        total: int
        ${extraFilters}
      }
      repository Docs for Doc {
        ${repoBody}
      }
    }
  }
  api DocsApi from Sales
  storage primary { type: postgres }
  resource docsState { for: Docs, kind: state, use: primary }
  deployable api {
    platform: python
    contexts: [Docs]
    dataSources: [docsState]
    serves: DocsApi
    port: 8081
  }
}
`;
}

describe("python filter-bypass (ignoring <Cap> / *)", () => {
  it("a bypassing find OMITS the capability predicate; a normal find KEEPS it", async () => {
    const repo = (
      await build(
        sys(`find recent(): Doc[] where this.subject != "" ignoring softDeletable
          find normal(): Doc[] where this.subject != ""`),
      )
    ).get(REPO)!;
    expect(repo).toBeDefined();
    // `recent` drops the softDeletable predicate — no `is_deleted` in its where.
    const recent = method(repo, "recent");
    expect(recent).not.toContain("is_deleted");
    expect(recent).toContain("DocRow.subject !=");
    // `normal` keeps it (the always-on capability predicate is conjoined in).
    const normal = method(repo, "normal");
    expect(normal).toContain("is_deleted");
  });

  it("`ignoring *` omits ALL capability predicates on that read", async () => {
    const repo = (
      await build(
        sys(`find allRows(): Doc[] ignoring *
          find normal(): Doc[] where this.subject != ""`),
      )
    ).get(REPO)!;
    const all = method(repo, "all_rows");
    expect(all).not.toContain("is_deleted");
    // A non-bypassing read still carries the capability predicate.
    expect(method(repo, "normal")).toContain("is_deleted");
  });

  it("the always-on capability predicate still rides find_by_id / all() / find_many_by_ids", async () => {
    const repo = (
      await build(sys(`find recent(): Doc[] where this.subject != "" ignoring softDeletable`))
    ).get(REPO)!;
    // The bypass is per-read: the non-bypassing reads keep the predicate.
    expect(method(repo, "find_by_id")).toContain("is_deleted");
    expect(method(repo, "all")).toContain("is_deleted");
    expect(method(repo, "find_many_by_ids")).toContain("is_deleted");
  });

  it("a bare (non-capability) filter is NEVER dropped, even by `ignoring *`", async () => {
    const repo = (
      await build(sys(`find allRows(): Doc[] ignoring *`, `filter this.total > 0`))
    ).get(REPO)!;
    // softDeletable is dropped, but the bare `filter this.total > 0` stays.
    const all = method(repo, "all_rows");
    expect(all).not.toContain("is_deleted");
    expect(all).toContain("DocRow.total >");
  });
});
