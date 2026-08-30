// Elixir/Phoenix (vanilla) — a PER-ROW query-time projection over a
// `shape: document` source reads the jsonb blob IN-APP, not as Ecto columns.
//
// The other four backends run this arm through the source aggregate's
// REPOSITORY, which hydrates the document and filters over the rehydrated
// instance.  Elixir's query-time projection module reads the source itself, and
// it rendered every reference as a COLUMN — `from(record in D.C.Article, where:
// record.view_count > 10)`, `record.title`, and the capability filter's
// `record.is_deleted`.  A document schema is `(id, data, version)` with an
// `embeds_one :data`, so none of those columns exist: `mix compile` fails, and
// nothing gated it at generate time (the corpus-elixir cell for
// `projection-document-aggregation` is where it surfaced).
//
// The fix mirrors the in-app document read the vanilla repository already
// emits: load the rows, bind `record = row.data`, and evaluate the projection
// `where` + the capability filter over that embed (`row.id` / `row.version`
// stay on the root row).  Pinned here as an emitted string because the failure
// mode on the other side of a regression is either a compile error in a
// language this toolchain does not compile in `npm test`, or — for the
// capability conjunct — a silent read of soft-deleted rows.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
  system S {
    subdomain D {
      context C {
        // DOCUMENT source — declared fields live inside the jsonb blob.
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

        // SHORTHAND over the same document source — the row is the aggregate's
        // own wire shape, so its serializer must be doc-rooted too.
        projection ArticleAll {
          from Article as a
        }

        // RELATIONAL control — must stay byte-identical to the Ecto form.
        aggregate Note with crudish {
          body: string
          stars: int
        }
        repository Notes for Note { }
        projection NoteLines {
          line: string
          from Note as n
          where n.stars > 1
          select line = n.body
        }
      }
    }
    api Api from D
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable d {
      platform: elixir
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

describe("elixir — query-time projection over a `shape: document` source", () => {
  it("loads the rows and narrows IN-APP over the rehydrated embed", async () => {
    const mod = await file("query_projections/article_titles.ex");
    expect(mod).toContain(
      [
        "    rows =",
        "      D.C.Article",
        "      |> Repo.all()",
        "      |> Enum.filter(fn row ->",
        "        record = row.data",
        "        (record.view_count > 10) and (not record.is_deleted)",
        "      end)",
      ].join("\n"),
    );
  });

  it("never names a blob field as an Ecto column", async () => {
    const mod = await file("query_projections/article_titles.ex");
    // The whole failure was `from(record in <DocSchema>, where: …)` over a
    // table that has no such columns.
    expect(mod).not.toContain("from(record in D.C.Article");
    expect(mod).not.toContain("where: record.view_count");
  });

  it("projects each select off the embed", async () => {
    const mod = await file("query_projections/article_titles.ex");
    expect(mod).toContain(
      [
        "    Enum.map(rows, fn row ->",
        "      record = row.data",
        "      %{",
        "        heading: record.title,",
        "        seen: record.view_count",
        "      }",
        "    end)",
      ].join("\n"),
    );
  });

  it("drops `import Ecto.Query` when the in-app read builds no query", async () => {
    const mod = await file("query_projections/article_titles.ex");
    // An unused import is a warning, and the corpus compile runs
    // `mix compile --warnings-as-errors`.
    expect(mod).not.toContain("import Ecto.Query");
    expect(mod).toContain("  alias D.Repo");
  });

  it("roots the SHORTHAND serializer at the embed, with id/version on the row", async () => {
    const mod = await file("query_projections/article_all.ex");
    expect(mod).toContain(
      [
        "  defp serialize(row) do",
        "    record = row.data",
        "    %{",
        '      "id" => row.id,',
        '      "title" => record.title,',
        '      "viewCount" => record.view_count,',
        '      "deletedAt" => record.deleted_at,',
        '      "version" => row.version',
        "    }",
        "  end",
      ].join("\n"),
    );
  });

  it("leaves a RELATIONAL source on the Ecto column form", async () => {
    const mod = await file("query_projections/note_lines.ex");
    expect(mod).toContain("  import Ecto.Query");
    expect(mod).toContain(
      [
        "    rows =",
        "      from(record in D.C.Note, where: record.stars > 1)",
        "      |> Repo.all()",
        "    Enum.map(rows, fn record ->",
        "      %{",
        "        line: record.body",
        "      }",
        "    end)",
      ].join("\n"),
    );
  });
});
