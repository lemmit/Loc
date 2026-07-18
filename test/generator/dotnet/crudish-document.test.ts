// B12 (docs/audits/behavioral-parity-bugs-2026-07.md): `with crudish` on a
// `shape: document` aggregate adds a canonical `destroy`, so `I<Agg>Repository`
// declares `DeleteAsync`.  The document-shape repository IMPL must emit a
// matching `DeleteAsync` body — otherwise the generated project fails CS0535
// ("does not implement interface member ...DeleteAsync").  The relational impl
// already emits it (gated on `canonicalDestroy`); this pins the same on the
// document path (load the `<Agg>Document` row by id and `Remove` it).

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Cms {
    aggregate Article shape: document, with crudish {
      title: string
      contains sections: Section[]
      entity Section { heading: string  body: string }
    }
    repository Articles for Article { }
  }
`;

describe("dotnet generator — crudish on a shape: document aggregate (B12)", () => {
  it("document repo impl emits DeleteAsync, matching the interface's declaration", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateDotnet(model);

    // The interface declares DeleteAsync (crudish → canonical destroy).
    const iface = files.get("Domain/Articles/IArticleRepository.cs")!;
    expect(iface).toContain(
      "Task DeleteAsync(Article aggregate, CancellationToken cancellationToken = default);",
    );

    // The document-shape impl must provide it — load the document row by id and
    // Remove it (not the bare `_db.Set.Remove(aggregate)` the relational path
    // uses, since the DbSet holds `<Agg>Document` rows, not the aggregate).
    const impl = files.get("Infrastructure/Repositories/ArticleRepository.cs")!;
    // Confirm we're on the document path (Data column serialization), not relational.
    expect(impl).toContain("aggregate.ToSnapshot()");
    expect(impl).toContain(
      "public async Task DeleteAsync(Article aggregate, CancellationToken cancellationToken = default)",
    );
    expect(impl).toContain(
      "var __existing = await _db.Articles.FirstOrDefaultAsync(x => x.Id == aggregate.Id.Value, cancellationToken);",
    );
    expect(impl).toContain("_db.Articles.Remove(__existing);");
  });
});
