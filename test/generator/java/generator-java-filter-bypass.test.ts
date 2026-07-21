// ---------------------------------------------------------------------------
// Java backend — `ignoring <Cap>` / `ignoring *` filter bypass (capability-
// emission-dedup.md §11.6, the "pay for what you use" hybrid).
//
// Hibernate's @SQLRestriction is always-on and unbypassable by design, so a
// capability some read `ignoring`s is PROMOTED off @SQLRestriction to a
// bypassable Hibernate named filter (@FilterDef(autoEnabled, applyToLoadByKey) +
// @Filter); a bypassing read wraps its impl body in
// disableFilter/enableFilter (re-armed in finally) via the Hibernate Session.
// A never-bypassed cap and a bare (capability-less) filter stay in
// @SQLRestriction (zero regression, zero runtime cost).
//
// Boot-verified end-to-end via test/e2e/fixtures/java-build/filter-bypass.ddd
// (`gradle testClasses bootJar` against Spring Boot 4.1 / Hibernate 7.x).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/filter-bypass.ddd", "utf8");
const ROOT = "api/src/main/java/com/loom/api/features/products";

describe("java generator — `ignoring` filter bypass (§11.6 triage)", () => {
  it("(a) a never-bypassed bare filter stays in @SQLRestriction; the promoted cap leaves it", async () => {
    const files = await generateSystemFiles(SRC);
    const entity = files.get(`${ROOT}/Product.java`)!;
    // The bare `filter this.price > 0` is never bypassable → @SQLRestriction.
    expect(entity).toContain('@SQLRestriction("price > 0")');
    // softDeletable is bypassed by `recent`/`allRows` → it does NOT
    // appear in @SQLRestriction.
    expect(entity).not.toMatch(/@SQLRestriction\([^)]*is_deleted/);
  });

  it("(b) a bypassed cap becomes @FilterDef(autoEnabled, applyToLoadByKey) + @Filter", async () => {
    const files = await generateSystemFiles(SRC);
    const entity = files.get(`${ROOT}/Product.java`)!;
    expect(entity).toContain(
      '@FilterDef(name = "softDeletable", autoEnabled = true, applyToLoadByKey = true)',
    );
    expect(entity).toContain('@Filter(name = "softDeletable", condition = "is_deleted = false")');
    expect(entity).toContain("import org.hibernate.annotations.Filter;");
    expect(entity).toContain("import org.hibernate.annotations.FilterDef;");
  });

  it("(c) a bypassing find wraps its impl body with disableFilter/enableFilter", async () => {
    const files = await generateSystemFiles(SRC);
    const impl = files.get(`${ROOT}/ProductRepositoryImpl.java`)!;
    // EntityManager injected to reach the Hibernate Session.
    expect(impl).toContain("@PersistenceContext");
    expect(impl).toContain("private EntityManager em;");
    // `recent` ignores softDeletable → disable/re-arm around the delegate.
    expect(impl).toMatch(
      /public List<Product> recent\(\) \{[\s\S]*em\.unwrap\(org\.hibernate\.Session\.class\)[\s\S]*disableFilter\("softDeletable"\)[\s\S]*var result = jpa\.recent\(\);[\s\S]*return result;[\s\S]*finally[\s\S]*enableFilter\("softDeletable"\)/,
    );
  });

  it("(d) `ignoring *` disables every promoted filter for that read", async () => {
    const files = await generateSystemFiles(SRC);
    const impl = files.get(`${ROOT}/ProductRepositoryImpl.java`)!;
    expect(impl).toMatch(
      /public List<Product> allRows\(\) \{[\s\S]*disableFilter\("softDeletable"\)[\s\S]*var result = jpa\.allRows\(\);[\s\S]*return result;[\s\S]*enableFilter\("softDeletable"\)/,
    );
  });

  it("(e) a non-bypassing find delegates plainly (the @Filter stays armed)", async () => {
    const files = await generateSystemFiles(SRC);
    const impl = files.get(`${ROOT}/ProductRepositoryImpl.java`)!;
    // `normal` has no `ignoring` clause → a bare delegate (capture + log +
    // return), no Session unwrap.
    expect(impl).toMatch(
      /public List<Product> normal\(\) \{\s*var result = jpa\.normal\(\);\s*CatalogLog\.event\("find_executed"[\s\S]*?return result;\s*\}/,
    );
  });
});
