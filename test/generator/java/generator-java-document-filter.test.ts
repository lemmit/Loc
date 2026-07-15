import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// DEBT-02 — capability `filter` on a `shape: document` aggregate (java).
// The whole aggregate lives in one `data` jsonb column, so the filter can't be
// a SQL predicate — it's applied in-app over the rehydrated aggregate.  Gating
// findById + filtering findAll covers the custom finds too, since they all read
// through `findAll().stream()`.
// ---------------------------------------------------------------------------

const SRC = readFileSync("test/e2e/fixtures/java-build/document-filter.ddd", "utf8");
const ROOT = "api1/src/main/java/com/loom/api1";

async function repo(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  return files.get(`${ROOT}/features/articles/ArticleRepositoryImpl.java`)!;
}

describe("java document capability filter (DEBT-02)", () => {
  it("gates findById by the in-app predicate (hidden → empty Optional)", async () => {
    const r = await repo();
    expect(r).toContain("var rec = fromJson(rows.get(0));");
    expect(r).toContain("return ((!rec.isDeleted())) ? Optional.of(rec) : Optional.empty();");
  });

  it("filters findAll by the capability predicate", async () => {
    const r = await repo();
    expect(r).toContain("var x = fromJson(data);");
    expect(r).toContain("if ((!x.isDeleted())) out.add(x);");
  });

  it("leaves custom finds reading through the (now filtered) findAll", async () => {
    // The find streams over findAll(), which already hides deleted rows — no
    // separate capability filter is duplicated onto the find.
    const r = await repo();
    expect(r).toContain("findAll().stream().filter(x -> Objects.equals(x.title(), t)).toList();");
    // A string-equality find renders `Objects.equals` — the document store must
    // import it (a pre-existing gap this fixture surfaced).
    expect(r).toContain("import java.util.Objects;");
  });

  it("leaves a filter-free document aggregate's reads byte-identical", async () => {
    const noFilter = SRC.replace("        filter !this.isDeleted\n", "");
    const files = await generateSystemFiles(noFilter);
    const r = files.get(`${ROOT}/features/articles/ArticleRepositoryImpl.java`)!;
    expect(r).toContain(
      "return rows.isEmpty() ? Optional.empty() : Optional.of(fromJson(rows.get(0)));",
    );
    expect(r).toContain("for (var data : rows) out.add(fromJson(data));");
    expect(r).not.toContain("var rec =");
  });
});
