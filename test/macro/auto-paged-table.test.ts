// A hand-written `Table` over a PAGED read is auto-upgraded to server paging.
//
// `.all` is paged-by-default (M-T2.6).  The simplest thing an author can write
// used to emit no pager and send no `page` param, so it rendered the backend's
// default first page — 20 rows, with rows 21+ unreachable and nothing on screen
// saying so.  Same class as the Phoenix slice-8 defect ("hard-capped at the
// first 10 rows … rows 11+ unreachable"), and the last live consequence of the
// paged-by-default flip.
//
// The rewrite converges on the shape the SCAFFOLD already emits, so "a working
// paged table" has one definition rather than two.  It runs at the macro layer
// (AST→AST) because page `state` is a structural declaration the page shell
// consumes — the walker cannot add it — and because macros emit final AST, so
// `unfold` ejects real source the author can edit.
//
// The opt-out is TAKING CONTROL: a `QueryView` that declares `paged:`, a read
// that already passes arguments, or a `Table` that already binds `page:` /
// `serverPaged:` is left exactly as written.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const sys = (pageBody: string, repoBody = ""): string => `
system S {
  subdomain D {
    context C {
      aggregate Task with crudish { title: string  rank: int }
      repository Tasks for Task { ${repoBody} }
    }
  }
  api Api from D
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  ui Web {
    api T: Api
    page TaskList { route: "/tasks"  body: ${pageBody} }
  }
  deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
  deployable web { platform: static, targets: api, ui: Web { T: api }, port: 3001 }
}
`;

const pageTsx = async (pageBody: string, repoBody = ""): Promise<string> => {
  const files = await generateSystemFiles(sys(pageBody, repoBody));
  return files.get("web/src/pages/task_list.tsx") ?? "";
};

/** The bare spelling — the thing an author actually writes. */
const BARE = `QueryView {
  of: T.Task.all,
  data: rows => Table { rows: rows, Column { "Title", o => Text { o.title } } }
}`;

describe("auto-paged table", () => {
  it("threads page/sort state into the read, so the pager can navigate", async () => {
    const tsx = await pageTsx(BARE);
    // Page state the rewrite synthesised…
    expect(tsx).toContain("const [pageNum, setPageNum] = useState<number>(1);");
    expect(tsx).toContain('const [sortKey, setSortKey] = useState<string>("");');
    expect(tsx).toContain('const [sortDir, setSortDir] = useState<string>("asc");');
    // …fed back into the request, which is what makes the pager REAL rather
    // than a control that writes state nothing reads.
    expect(tsx).toContain(
      "useAllTasks({ page: pageNum, pageSize: 20, sort: sortKey, dir: sortDir })",
    );
  });

  it("renders a pager off the envelope's true page count", async () => {
    const tsx = await pageTsx(BARE);
    expect(tsx).toContain('data-testid="pager"');
    // The count comes from the SERVER's `totalPages`, not from the length of
    // the rows in hand — the whole point, since the rows in hand are one page.
    expect(tsx).toContain("taskAll.data.totalPages");
    expect(tsx).not.toMatch(/Math\.ceil\(.*\.length \/ /);
  });

  it("iterates the envelope's rows, and is single-rooted so it fits a conditional slot", async () => {
    const tsx = await pageTsx(BARE);
    expect(tsx).toContain("taskAll.data.items.map((row) =>");
    // The table and the pager are adjacent siblings; JSX rejects that in a
    // `{cond && ( … )}` slot (TS2657), so the pair is fragment-wrapped.
    // (the table itself now opens with its own horizontal-scroll container —
    // the cross-pack table rule in docs/design-packs.md)
    expect(tsx).toMatch(
      /<><div className="loom-table-scroll"[\s\S]*<Table[\s\S]*data-testid="pager"[\s\S]*<\/>/,
    );
  });

  it("makes simple columns sortable, and leaves computed ones alone", async () => {
    const tsx = await pageTsx(`QueryView {
      of: T.Task.all,
      data: rows => Table { rows: rows,
        Column { "Title", o => Text { o.title } },
        Column { "Both", o => Text { o.title + o.rank } }
      }
    }`);
    // `o => Text { o.title }` names exactly one column, so the server can order
    // by it.
    expect(tsx).toContain('setSortKey("title")');
    // A COMPUTED column has no aggregate field behind it, and the backend's
    // `sort` parameter is whitelisted per field — so leaving it unsortable is
    // the correct answer, not a degradation.
    expect(tsx).not.toContain('setSortKey("both")');
  });

  // ---- the opt-outs ------------------------------------------------------
  it("leaves a QueryView that already declares `paged:` alone", async () => {
    const tsx = await pageTsx(`QueryView {
      of: T.Task.all,
      paged: true,
      data: rows => Table { rows: rows.items, Column { "Title", o => Text { o.title } } }
    }`);
    expect(tsx).not.toContain("pageNum");
    expect(tsx).toContain("useAllTasks()");
  });

  it("leaves a Table that already binds `page:` alone", async () => {
    const tsx = await pageTsx(`QueryView {
      of: T.Task.all,
      data: rows => Table { rows: rows, page: pageNum, pageSize: 5, Column { "Title", o => Text { o.title } } }
    }`);
    // The author is driving the pager themselves — the read stays paramless.
    expect(tsx).toContain("useAllTasks()");
  });

  it("leaves a read that already passes arguments alone", async () => {
    const tsx = await pageTsx(`QueryView {
      of: T.Task.all(1, 5, "title", "asc"),
      paged: true,
      data: rows => Table { rows: rows.items, Column { "Title", o => Text { o.title } } }
    }`);
    expect(tsx).not.toContain("pageNum");
  });

  it("leaves a table over a NON-paged find alone", async () => {
    const tsx = await pageTsx(
      `QueryView {
        of: T.Task.ranked(1),
        data: rows => Table { rows: rows, Column { "Title", o => Text { o.title } } }
      }`,
      "find ranked(min: int): Task[] where rank > min",
    );
    // A plain array find is complete in one response — nothing to page.
    expect(tsx).not.toContain("pageNum");
    expect(tsx).not.toContain('data-testid="pager"');
  });

  it("leaves a body that is not a bare Table over the binding alone", async () => {
    const tsx = await pageTsx(`QueryView {
      of: T.Task.all,
      data: rows => Stack { Text { rows.total } }
    }`);
    // No Table bound to the rows ⇒ nothing to upgrade; the metadata read still
    // resolves (M-T1.3 Defect B), it just isn't a paged table.
    expect(tsx).not.toContain("pageNum");
    expect(tsx).toContain("taskAll.data.total");
  });

  // -------------------------------------------------------------------------
  // F2-CFE-4 — the rewrite flips the binding from the ROW ARRAY to the
  // ENVELOPE, so every SIBLING reader in the same lambda has to hop through
  // `.items` too.  Rewriting only the Table's own `rows:` left a `For { each:
  // rows }` next to it iterating `{ items, page, pageSize, total, totalPages }`
  // — a TypeScript error plus a render-time crash, with no diagnostic.  The
  // author never wrote the rewrite that broke it.
  // -------------------------------------------------------------------------

  it("re-points a SIBLING For at the envelope's items, not the envelope", async () => {
    const tsx = await pageTsx(`QueryView {
      of: T.Task.all,
      data: rows => Stack {
        For { each: rows, r => Text { r.title } },
        Table { rows: rows, Column { "Title", o => Text { o.title } } }
      }
    }`);
    // The rewrite fired…
    expect(tsx).toContain("const [pageNum, setPageNum] = useState<number>(1);");
    // …and BOTH readers iterate the row array.
    expect(tsx).toContain("taskAll.data.items.map((r, rIdx)");
    expect(tsx).toContain("taskAll.data.items.map((row)");
    // The envelope is never iterated directly.
    expect(tsx).not.toMatch(/taskAll\.data\.map\(/);
  });

  it("leaves the envelope members the pager reads exactly as written", async () => {
    const tsx = await pageTsx(`QueryView {
      of: T.Task.all,
      data: rows => Stack {
        Text { rows.total },
        Table { rows: rows, Column { "Title", o => Text { o.title } } }
      }
    }`);
    // `total` is an envelope field — a `.items` hop would be wrong here.
    expect(tsx).toContain("taskAll.data.total");
    expect(tsx).not.toContain("taskAll.data.items.total");
    // …while the table still reads the rows.
    expect(tsx).toContain("taskAll.data.items.map((row)");
  });

  it("re-points a CHAINED read off the binding (`rows.count()`) through .items", async () => {
    const tsx = await pageTsx(`QueryView {
      of: T.Task.all,
      data: rows => Stack {
        Text { rows.count() },
        Table { rows: rows, Column { "Title", o => Text { o.title } } }
      }
    }`);
    expect(tsx).toContain("taskAll.data.items.length");
    expect(tsx).not.toMatch(/taskAll\.data\.length/);
  });
});
