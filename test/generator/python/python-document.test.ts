import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — shape: document (F2a).  A document aggregate persists
// as ONE jsonb column (id, data, version); the repo serialises the
// domain getters to a dict and rebuilds through `_rehydrate`, finds run
// in-memory over the rehydrated documents.  Verified live (create →
// addSection → bump → read-back → find popular) and statically by the
// `document.ddd` corpus case (uv + ruff + mypy --strict).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/document.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python shape: document", () => {
  it("schema is the document triple (id, data jsonb, version)", async () => {
    const files = await build();
    const schema = files.get("api/app/db/schema.py")!;
    expect(schema).toContain("class ArticleRow(Base):");
    expect(schema).toContain("data: Mapped[object] = mapped_column(JSONB)");
    expect(schema).toContain("version: Mapped[int] = mapped_column(Integer)");
    // No normalised part table for the contained Section.
    expect(schema).not.toContain("class SectionRow(Base):");
  });

  it("repo round-trips one jsonb blob via to_doc / from_doc + version-bumped upsert", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/article_repository.py")!;
    // Default-on versioning: the version COLUMN is authoritative — load threads
    // `row.version` into `from_doc` (the blob copy lags a write), and the write
    // is the guarded upsert (seed at the aggregate's version, bump on conflict
    // only when the stored version still matches → ConcurrencyError otherwise).
    expect(repo).toContain("return _article_from_doc(row.data, row.version)");
    expect(repo).toContain("data = _article_to_doc(aggregate)");
    expect(repo).toContain(
      "_expected = aggregate.version if expected_version is None else expected_version",
    );
    expect(repo).toContain(".values(id=aggregate.id, data=data, version=aggregate.version)");
    expect(repo).toContain('set_={"data": data, "version": ArticleRow.version + 1},');
    expect(repo).toContain("where=ArticleRow.version == _expected,");
    expect(repo).toContain("if _guarded.first() is None:");
    // Nested part serialisers.
    expect(repo).toContain("def _article_to_doc(a: Article) -> dict[str, object]:");
    expect(repo).toContain("def _section_to_doc(a: Section) -> dict[str, object]:");
    expect(repo).toContain('"sections": [_section_to_doc(e) for e in a.sections]');
    expect(repo).toContain("def _article_from_doc(raw: object, version: int) -> Article:");
    expect(repo).toContain('Article._rehydrate(id=ArticleId(cast(str, d["id"]))');
  });

  it("finds evaluate in-memory over the rehydrated documents", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/article_repository.py")!;
    expect(repo).toContain("async def popular(self, min: int) -> list[Article]:");
    expect(repo).toContain("items = await self.all()");
    expect(repo).toContain("result = [x for x in items if (lambda x: x.view_count >= min)(x)]");
    // find_executed (S5) — rows is the post-filter cardinality.
    expect(repo).toContain(
      'log("debug", "find_executed", aggregate="Article", find="popular", rows=len(result))',
    );
    expect(repo).toContain("        return result");
  });
});

// ---------------------------------------------------------------------------
// Optional single containment (`contains coupon: Coupon?`) on a document
// aggregate.  Regression: the doc (de)serialisers folded a nullable single
// containment through the non-null `_coupon_to_doc(a: Coupon)` /
// `_coupon_from_doc` helpers, so an unset value failed `mypy --strict`
// (passing `Coupon | None` where `Coupon` is required) and dereferenced
// `None` at runtime.  The embedded builder always guarded it; the document
// builder was missed (TS had the same bug — fixed together).
// ---------------------------------------------------------------------------
describe("python document — optional single containment is null-safe", () => {
  const SRC = `
    system S {
      subdomain Core {
        context Shop {
          aggregate Cart shape: document {
            note: string
            contains coupon: Coupon?
            contains items: CartLine[]
            create(note: string) { note := note }
            entity Coupon { code: string }
            entity CartLine { sku: string  qty: int }
          }
          repository Carts for Cart { }
        }
      }
      api ShopApi from Core
      storage pg { type: postgres }
      resource shopState { for: Shop, kind: state, use: pg }
      deployable api { platform: python contexts: [Shop] dataSources: [shopState] serves: ShopApi port: 3000 }
    }
  `;

  it("None-guards the optional containment in _to_doc and _from_doc", async () => {
    const { model, errors } = await parseString(SRC);
    if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
    const files = generateSystems(model).files;
    const repo = files.get("api/app/db/repositories/cart_repository.py")!;
    expect(repo, "cart_repository.py generated").toBeDefined();
    // Serialize: None-guarded, not a bare `_coupon_to_doc(a.coupon)` (which the
    // `Coupon | None` getter fails mypy --strict against).
    expect(repo).toContain('"coupon": (None if a.coupon is None else _coupon_to_doc(a.coupon))');
    // Deserialize: None-guarded.
    expect(repo).toContain(
      'coupon=(None if d["coupon"] is None else _coupon_from_doc(d["coupon"]))',
    );
    // Required collection containment unchanged.
    expect(repo).toContain('"items": [_cart_line_to_doc(e) for e in a.items]');
    // Neither path emits the unguarded single-containment form.
    expect(repo).not.toMatch(/"coupon": _coupon_to_doc\(a\.coupon\)/);
    expect(repo).not.toMatch(/coupon=_coupon_from_doc\(d\["coupon"\]\)/);
  });
});
