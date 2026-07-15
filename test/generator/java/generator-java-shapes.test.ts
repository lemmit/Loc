// ---------------------------------------------------------------------------
// Java backend — non-relational saving shapes (D-DOCUMENT-AXIS; java's
// PLATFORM_SAVING_SHAPES now lists relational + embedded + document).
//
//   - `shape: document`: the whole aggregate (parts inline) round-trips
//     ONE jsonb column — plain domain class (no JPA bindings), a
//     JdbcTemplate repository with a field-visibility Jackson mapper
//     (package-private fields, transient _domainEvents excluded),
//     version-bumping upserts, in-memory find folds.
//   - `shape: embedded`: the root stays a queryable @Entity (scalar
//     columns + JPQL finds) but containments fold into jsonb columns
//     via Hibernate's JSON FormatMapper, swapped for a field-visibility
//     Jackson mapper (LoomJsonFormatMapperConfig) so the
//     package-private part classes serialize.  Reference collections
//     on embedded aggregates stay gated
//     (loom.java-embedded-refcoll-unsupported — Hibernate's
//     structured-JSON path bypasses the FormatMapper for @Embeddable
//     ids).
//
// Both boot-verified end-to-end against Postgres via
// test/e2e/fixtures/java-build/document.ddd / embedded.ddd.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const DOC = readFileSync("test/e2e/fixtures/java-build/document.ddd", "utf8");
const EMB = readFileSync("test/e2e/fixtures/java-build/embedded.ddd", "utf8");

describe("java generator — shape: document", () => {
  it("entity is a plain domain class; the impl round-trips one jsonb column", async () => {
    const files = await generateSystemFiles(DOC);
    const root = "doc_api/src/main/java/com/loom/docapi";
    const entity = files.get(`${root}/features/articles/Article.java`)!;
    expect(entity).not.toContain("@Table(");
    expect(entity).not.toContain("@EmbeddedId");
    expect(files.has(`${root}/features/articles/ArticleJpaRepository.java`)).toBe(false);
    const impl = files.get(`${root}/features/articles/ArticleRepositoryImpl.java`)!;
    expect(impl).toContain(".visibility(PropertyAccessor.FIELD, JsonAutoDetect.Visibility.ANY)");
    expect(impl).toContain(
      '"insert into cms.articles (id, data, version) values (?, ?::jsonb, 1) "',
    );
    expect(impl).toContain(
      '+ "on conflict (id) do update set data = excluded.data, version = articles.version + 1"',
    );
    expect(impl).toContain("return JSON.readValue(data, Article.class);");
  });

  it("finds fold rehydrated documents in memory (accessor-rendered filters)", async () => {
    const files = await generateSystemFiles(DOC);
    const impl = files.get(
      "doc_api/src/main/java/com/loom/docapi/features/articles/ArticleRepositoryImpl.java",
    )!;
    expect(impl).toContain(
      "var result = findAll().stream().filter(x -> x.viewCount() >= min).toList();",
    );
    expect(impl).toContain(
      'CatalogLog.event("find_executed", "debug", "aggregate", "Article", "find", "popular", "rows", result.size());',
    );
  });
});

describe("java generator — shape: embedded", () => {
  it("root stays a queryable @Entity; containments fold into jsonb columns", async () => {
    const files = await generateSystemFiles(EMB);
    const root = "emb_api/src/main/java/com/loom/embapi";
    const entity = files.get(`${root}/features/orders/Order.java`)!;
    expect(entity).toContain('@Table(name = "orders", schema = "shop")');
    expect(entity).toContain("    @JdbcTypeCode(SqlTypes.JSON)");
    expect(entity).toContain('    @Column(name = "items", nullable = false)');
    expect(entity).not.toContain("@OneToMany");
    // The part is a plain class (no part table).
    const part = files.get(`${root}/features/orders/Item.java`)!;
    expect(part).not.toContain("@Table(");
    // The standard Spring Data path stays (JPQL finds over scalar columns).
    expect(files.has(`${root}/features/orders/OrderJpaRepository.java`)).toBe(true);
    // The field-visibility FormatMapper is installed once.
    const cfg = files.get(`${root}/config/LoomJsonFormatMapperConfig.java`)!;
    expect(cfg).toContain(
      "props.put(AvailableSettings.JSON_FORMAT_MAPPER, new Jackson3JsonFormatMapper(mapper));",
    );
  });

  it("gates reference collections on embedded aggregates fail-fast", async () => {
    const withRefColl = EMB.replace(
      "        code: string\n",
      "        code: string\n        tagIds: Tag id[]\n",
    ).replace(
      "      repository Orders for Order {",
      "      aggregate Tag with crudish { label: string }\n      repository Tags for Tag { }\n      repository Orders for Order {",
    );
    const loom = await buildLoomModel(withRefColl);
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.java-embedded-refcoll-unsupported",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("tagIds");
  });
});
