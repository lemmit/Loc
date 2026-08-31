import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { beforeAll, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateTypeScript } from "../../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS as HONO_V4_PINS } from "../../../src/platform/hono/v4/pins.js";
import { dddSourceOf } from "../../_helpers/ddd-corpus.js";
import { generateSystemFiles } from "../../_helpers/index.js";
import { parseValid } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Hono/Drizzle document-persistence emission (`normalised(false)`).
//
// The TS counterpart of the .NET document emit: a document aggregate
// persists as one jsonb column `(id, data, version)`; the repository
// serialises the aggregate's getters into a plain object and rebuilds
// it through `_create({...})` — no normalised table-per-entity tree.
// `examples/document.ddd` pairs a document `Cart` (root + CartItem parts
// + Money VO + enum + Customer ref) with a normalised `Customer`.  The
// `tsc + tsup` gate lives in test/e2e/generated-build.test.ts.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

describe("Hono/Drizzle document-persistence emission (normalised(false))", () => {
  let files: Map<string, string>;
  beforeAll(async () => {
    files = generateTypeScript(await buildModel("examples/document.ddd"), HONO_V4_PINS);
  });

  it("emits a single jsonb document table (no part/join tables) for the document aggregate", () => {
    const schema = files.get("db/schema.ts")!;
    expect(schema).toContain('export const carts = pgTable("carts", {');
    expect(schema).toContain('data: jsonb("data").notNull(),');
    expect(schema).toContain('version: integer("version").notNull(),');
    // No normalised cart_items part table.
    expect(schema).not.toContain('pgTable("cart_items"');
    // Sibling normalised aggregate keeps its column-per-field table.
    expect(schema).toContain('export const customers = pgTable("customers", {');
  });

  it("repository round-trips through toDoc/fromDoc + _rehydrate", () => {
    const repo = files.get("db/repositories/cart-repository.ts")!;
    expect(repo).toContain("const data = cartToDoc(aggregate);");
    // Versioned root: fromDoc takes the authoritative `version` COLUMN, not the
    // stale blob copy — so `aggregate.version` is correct after a load and the
    // CAS save doesn't 409 on the next update.
    expect(repo).toContain("return cartFromDoc(row.data as CartDoc, row.version);");
    expect(repo).toContain("function cartFromDoc(d: CartDoc, version: number): Cart {");
    expect(repo).toContain("version: version");
    expect(repo).toContain("Cart._rehydrate({");
    expect(repo).toContain("items: (d.items ?? []).map((x) => cartItemFromDoc(x))");
    expect(repo).toContain(
      "unitPrice: new Money(Number(d.unitPrice.amount), d.unitPrice.currency)",
    );
    // version is CAS-bumped on update (versioned is default-on): the guarded
    // UPDATE conditions on the expected version and a lost race (0 rows) raises
    // ConcurrencyError — matching the relational repo, so `repo.save(agg,
    // expectedVersion)` from the versioned `update` route type-checks.
    expect(repo).toContain("async save(aggregate: Cart, expectedVersion?: number)");
    expect(repo).toContain("const expected = expectedVersion ?? aggregate.version;");
    expect(repo).toContain("version: expected + 1");
    expect(repo).toContain('throw new ConcurrencyError("Cart", aggregate.id as string)');
  });

  it("finds evaluate in-memory over rehydrated documents", () => {
    const repo = files.get("db/repositories/cart-repository.ts")!;
    expect(repo).toContain(
      "const all = rows.map((r) => cartFromDoc(r.data as CartDoc, r.version));",
    );
    expect(repo).toContain("const result = all.filter((x) => x.customerId === customerId);");
    // No Drizzle column predicate against the document table for the find.
    expect(repo).not.toContain("schema.carts.customerId");
  });

  it("reuses the unchanged toWire (wire contract independent of saving shape)", () => {
    const repo = files.get("db/repositories/cart-repository.ts")!;
    expect(repo).toContain("toWire(root: Cart): unknown {");
    expect(repo).toContain("total: { amount: root.total.amount, currency: root.total.currency }");
  });

  it("leaves the sibling normalised aggregate on the table-tree path", () => {
    const repo = files.get("db/repositories/customer-repository.ts")!;
    // Normalised repo hydrates from rows, not a jsonb document.
    expect(repo).not.toContain("FromDoc");
    expect(repo).not.toContain("as CustomerDoc");
  });

  // shape: embedded: queryable root columns + containment folded into a
  // jsonb column.  Unlike document, finds are REAL SQL on the root.
  it("embedded: root columns + one jsonb containment column, no part table", () => {
    const schema = files.get("db/schema.ts")!;
    expect(schema).toContain('export const wishlists = pgTable("wishlists", {');
    // `customerId: Customer id` (guid) → uuid, in lockstep with the migration.
    expect(schema).toContain('customerId: uuid("customer_id").notNull(),');
    expect(schema).toContain('items: jsonb("items").notNull(),');
    expect(schema).not.toContain('pgTable("wish_items"');
  });

  it("embedded: root via columns, containment via jsonb; finds are real SQL", () => {
    const repo = files.get("db/repositories/wishlist-repository.ts")!;
    // Root hydrated from columns + items rebuilt from the jsonb column.
    expect(repo).toContain(
      "const items = ((row.items ?? []) as WishItemDoc[]).map((x) => wishItemFromDoc(x));",
    );
    expect(repo).toContain("Wishlist._rehydrate({ id: Ids.WishlistId(row.id)");
    // Save writes root columns + items jsonb, CAS-guarded on the expected
    // version (versioned is default-on) — a lost race raises ConcurrencyError,
    // so the crudish `update` route's `repo.save(agg, expectedVersion)` type-checks.
    expect(repo).toContain("async save(aggregate: Wishlist, expectedVersion?: number)");
    expect(repo).toContain("items: aggregate.items.map((e) => wishItemToDoc(e))");
    expect(repo).toContain(
      ".where(and(eq(schema.wishlists.id, aggregate.id), eq(schema.wishlists.version, expected)))",
    );
    expect(repo).toContain('throw new ConcurrencyError("Wishlist", aggregate.id as string)');
    // byCustomer is a real indexed SQL WHERE on the root column — NOT in-memory.
    expect(repo).toContain(".where(eq(schema.wishlists.customerId, customerId))");
    expect(repo).not.toContain("FromDoc(row.data");
  });
});

// ---------------------------------------------------------------------------
// Optional single containment (`contains coupon: Coupon?`) on a document
// aggregate.  Regression for the document-builder null-safety bug: the
// `toDoc`/`fromDoc` helpers and the `Doc` type alias handled a collection
// containment and a required single containment, but a nullable single
// containment was serialised/deserialised through the non-null `partToDoc`/
// `partFromDoc` helpers and typed as a non-null `PartDoc`, so an unset value
// TS2345'd under `tsc --noEmit` (and dereferenced `null` at runtime).  The
// embedded builder always handled this; the document builder was missed.
// ---------------------------------------------------------------------------
describe("Hono/Drizzle document — optional single containment is null-safe", () => {
  const SRC = `
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
  `;

  it("guards the optional containment in the Doc type + toDoc + fromDoc", async () => {
    const model = await parseValid(SRC);
    const files = generateTypeScript(model, HONO_V4_PINS);
    const repo = files.get("db/repositories/cart-repository.ts")!;
    expect(repo, "cart-repository.ts generated").toBeDefined();
    // Type alias: nullable single containment is `PartDoc | null`.
    expect(repo).toContain("coupon: CouponDoc | null");
    // Serialize: null-guarded, not a bare `couponToDoc(a.coupon)` (which the
    // `Coupon | null` getter would fail to type-check against).
    expect(repo).toContain("coupon: a.coupon == null ? null : couponToDoc(a.coupon)");
    expect(repo).not.toMatch(/coupon: couponToDoc\(a\.coupon\)/);
    // Deserialize: null-guarded, not a bare `couponFromDoc(d.coupon)`.
    expect(repo).toContain("coupon: d.coupon == null ? null : couponFromDoc(d.coupon)");
    expect(repo).not.toMatch(/coupon: couponFromDoc\(d\.coupon\)/);
    // The required collection containment is unchanged.
    expect(repo).toContain("items: a.items.map((e) => cartLineToDoc(e))");
  });
});

// ---------------------------------------------------------------------------
// The `onCreate` lifecycle stamps on the DOCUMENT write path.
//
// `tenantOwned` (and `auditable`, and a hand-written `stamp onCreate`) declare
// stamps the create must apply.  On the RELATIONAL path node lands them in
// `db/audit-stamp.ts` — `.values(stampInsert(row))`.  The document repository
// never imported it, so a tenant-owned document row was written with an EMPTY
// `tenantId` and became invisible to every principal INCLUDING ITS CREATOR: the
// read filter is correct, `"" === currentUser.tenantId` is false, and a 201
// create was followed by 404 on every read, update and destroy — silently.
//
// The compile tier could not see it (the emission type-checks either way) and
// `policy-document-inapp.test.ts` could not either (it runs the predicate over
// FABRICATED rows, which already carry a tenant).  Only a real write through
// the real create path exposes it, which is why the runtime half lives in
// `test/fixtures/corpus/policy-document.ddd`'s `test e2e`.  This is the
// unit-tier witness for the same defect.
// ---------------------------------------------------------------------------

describe("document save() applies the onCreate stamps", () => {
  let stamped: Map<string, string>;
  /** `examples/document.ddd`'s `Cart` — a document aggregate with NO lifecycle
   *  stamps.  The control that keeps this gate from passing by stamping
   *  everything.  Built here rather than reused from the sibling describe, whose
   *  `files` is scoped to it. */
  let unstamped: Map<string, string>;
  beforeAll(async () => {
    unstamped = generateTypeScript(await buildModel("examples/document.ddd"), HONO_V4_PINS);
    // The corpus fixture is a `__PLATFORM__`-tokenized TEMPLATE, not a source —
    // `dddSourceOf` substitutes a backend the way every census and runner does.
    // It is a multi-context SYSTEM, so it goes through the system generator
    // (the legacy single-context `generateTypeScript` emits no repositories for
    // it, which is how this assertion first passed vacuously).
    stamped = await generateSystemFiles(dddSourceOf("test/fixtures/corpus/policy-document.ddd"));
  });

  const thingRepo = (): string => {
    const key = [...stamped.keys()].find((k) => /repositories\/thing-repository\.ts$/.test(k));
    expect(key, "the document repository file was not emitted").toBeDefined();
    return stamped.get(key as string) as string;
  };

  it("stamps the doc payload on the INSERT branch", () => {
    const src = thingRepo();
    expect(src).toContain('import { stampInsert } from "../audit-stamp";');
    // The insert carries the stamped payload…
    expect(src).toMatch(/\.insert\(schema\.things\)\.values\(\{[^}]*data: stampInsert\(data\)/);
  });

  it("does NOT stamp the UPDATE branch — it writes the whole blob", () => {
    // `stampUpdate` STRIPS the create-only fields so a relational partial `set`
    // cannot overwrite them.  A document update replaces the entire jsonb, so
    // stripping `tenantId`/`dataKey` would DELETE them from the row.  The
    // rehydrated aggregate already carries both, so the update is correct
    // writing `data` unchanged.
    const src = thingRepo();
    expect(src).not.toContain("stampUpdate");
    expect(src).toMatch(/\.update\(schema\.things\)\.set\(\{ data,/);
  });

  it("emits the helper it imports", () => {
    const key = [...stamped.keys()].find((k) => /(^|\/)db\/audit-stamp\.ts$/.test(k));
    expect(key, "the stamp helper the repository imports was not emitted").toBeDefined();
  });

  it("leaves an UNSTAMPED document aggregate alone", async () => {
    // `examples/document.ddd`'s `Cart` carries no lifecycle stamps, so its
    // repository must neither import the helper nor call it — the gate would
    // otherwise pass by stamping everything.
    const src = unstamped.get("db/repositories/cart-repository.ts") as string;
    expect(src, "the unstamped control repository was not emitted").toBeDefined();
    expect(src).not.toContain("stampInsert");
    expect(src).toMatch(/\.insert\(schema\.carts\)\.values\(\{[^}]*data,/);
  });
});
