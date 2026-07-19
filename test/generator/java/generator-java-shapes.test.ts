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
//     (`X id[]`) fold into a jsonb id-array column via a per-target
//     `AttributeConverter` (`<Target>IdJsonListConverter`) that unwraps
//     the `List<XId>` to a plain `List<String>` so the FormatMapper
//     serialises `["v1","v2"]` — the cross-backend id-array shape
//     (M-T6.19; the @Embeddable-id structured-JSON path that bypassed
//     the FormatMapper is sidestepped).
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

  it("maps embedded reference collections through a jsonb id-array converter (M-T6.19)", async () => {
    const withRefColl = EMB.replace(
      "        code: string\n",
      "        code: string\n        tagIds: Tag id[]\n",
    ).replace(
      "      repository Orders for Order {",
      "      aggregate Tag with crudish { label: string }\n      repository Tags for Tag { }\n      repository Orders for Order {",
    );
    // No longer gated — it generates and validates clean.
    const loom = await buildLoomModel(withRefColl);
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.java-embedded-refcoll-unsupported",
    );
    expect(errors).toEqual([]);

    const files = await generateSystemFiles(withRefColl);
    const root = "emb_api/src/main/java/com/loom/embapi";
    // The `List<TagId>` field rides @Convert + @JdbcTypeCode(JSON) so the
    // FormatMapper serialises the bare id `value`s into the jsonb column.
    const entity = files.get(`${root}/features/orders/Order.java`)!;
    expect(entity).toContain("@Convert(converter = TagIdJsonListConverter.class)");
    expect(entity).toContain("@JdbcTypeCode(SqlTypes.JSON)");
    expect(entity).toContain('@Column(name = "tag_ids", nullable = false)');
    // The per-target converter unwraps `List<TagId>` to a plain `List<String>`
    // (the JSON FormatMapper erases the element type on read, so String is the
    // relational element type) and re-types each id on the way back in.
    const conv = files.get(`${root}/domain/ids/TagIdJsonListConverter.java`)!;
    expect(conv).toContain(
      "public class TagIdJsonListConverter implements AttributeConverter<List<TagId>, List<String>>",
    );
    expect(conv).toContain("for (TagId __e : attribute) out.add(String.valueOf(__e.value()));");
    expect(conv).toContain("out.add(new TagId(UUID.fromString(__v)));");
  });
});
