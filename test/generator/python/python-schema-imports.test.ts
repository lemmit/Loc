// Python schema emitter — import narrowing (`app/db/schema.py`).
//
// The emitter adds a SQLAlchemy name to the import line when the emitted module
// references it, scanned by word boundary.  That is exact for the CLASS names
// (capitalized, and a Loom field lowers to a snake_case attribute, so
// `\bInteger\b` cannot match a column) but NOT for `text`, the one lowercase
// helper in the list: an aggregate with a field named `text` emits
// `text: Mapped[str] = mapped_column(Text)`, which `\btext\b` matched — so the
// import was added, nothing invoked it, and `ruff` failed the ENTIRE python
// build on `F401 imported but unused`.  A one-word field name, a dead build.
//
// `text` is only ever used as a call (`server_default=text("now()")`), so the
// scan matches that form.  Both directions are pinned below: absent when only a
// COLUMN carries the name, present when something actually invokes it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const system = (field: string) => `
  system Notes {
    subdomain S {
      context C {
        aggregate Note { ${field}: string }
        repository Notes for Note { }
      }
    }
    api NotesApi from S
    storage primary { type: postgres }
    resource st { for: C, kind: state, use: primary }
    deployable d {
      platform: python
      contexts: [C]
      dataSources: [st]
      serves: NotesApi
      port: 4000
    }
  }
`;

async function schemaPy(field: string): Promise<string> {
  return (await generateSystemFiles(system(field))).get("d/app/db/schema.py")!;
}

/** The `from sqlalchemy import …` line, or "" when the module has none. */
function saImportLine(src: string): string {
  return src.split("\n").find((l) => l.startsWith("from sqlalchemy import ")) ?? "";
}

describe("python schema — import narrowing", () => {
  it("does NOT import `text` when only a COLUMN is named `text` (ruff F401)", async () => {
    const src = await schemaPy("text");
    // The column is emitted…
    expect(src).toContain("text: Mapped[str]");
    // …and nothing invokes the helper…
    expect(src).not.toContain("text(");
    // …so it must not be imported.  Matched on the import LINE, since the
    // column name itself contains the substring.
    expect(saImportLine(src)).not.toMatch(/\btext\b/);
  });

  it("still imports `text` when something IS invoking it", async () => {
    // The negative assertion alone is satisfied by a narrowing bug that drops
    // the import unconditionally, so pin the positive direction on a real
    // emission: the `outbox` corpus fixture's relay table carries
    // `server_default=text(...)`.
    const src = readFileSync("test/fixtures/corpus/outbox.ddd", "utf8").replace(
      "__PLATFORM__",
      "python",
    );
    const schema = (await generateSystemFiles(src)).get("d/app/db/schema.py")!;
    expect(schema).toContain("text(");
    expect(saImportLine(schema)).toMatch(/\btext\b/);
  });
});
