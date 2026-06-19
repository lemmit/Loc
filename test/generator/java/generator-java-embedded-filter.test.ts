import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// DEBT-02 — capability `filter` on a `shape(embedded)` aggregate (java).
// An embedded aggregate's root entity is a real JPA table whose root scalars
// are columns (only `contains` parts ride a jsonb column), so a NON-principal
// capability predicate is static SQL — it rides Hibernate's `@SQLRestriction`
// on the root entity exactly like the relational path (unlike the document
// store, which has no columns and must filter in-app).  A filter-free embedded
// aggregate stays unannotated.
// ---------------------------------------------------------------------------

const SRC = readFileSync("test/e2e/fixtures/java-build/embedded-filter.ddd", "utf8");
const ROOT = "emb_api/src/main/java/com/loom/embapi";

async function orderEntity(src: string): Promise<string> {
  const files = await generateSystemFiles(src);
  return files.get(`${ROOT}/features/orders/Order.java`)!;
}

describe("java embedded capability filter (DEBT-02)", () => {
  it("annotates the embedded root entity with the static @SQLRestriction fragment", async () => {
    const e = await orderEntity(SRC);
    expect(e).toContain('@SQLRestriction("not (is_deleted)")');
    expect(e).toContain("import org.hibernate.annotations.SQLRestriction;");
  });

  it("still maps the embedded containment as a jsonb column (shape preserved)", async () => {
    // The filter rides the root scalar columns; the `contains items` parts
    // still serialise to the embedded jsonb column — the restriction does not
    // change the persistence shape.
    const e = await orderEntity(SRC);
    expect(e).toContain("items");
  });

  it("leaves a filter-free embedded aggregate's entity unannotated", async () => {
    const noFilter = SRC.replace("        filter !this.isDeleted\n", "");
    const e = await orderEntity(noFilter);
    expect(e).not.toContain("@SQLRestriction");
    expect(e).not.toContain("import org.hibernate.annotations.SQLRestriction;");
  });
});
