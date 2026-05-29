import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { beforeAll, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateTypeScript } from "../../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS as HONO_V4_PINS } from "../../../src/platform/hono/v4/pins.js";

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

  it("repository round-trips through toDoc/fromDoc + _create", () => {
    const repo = files.get("db/repositories/cart-repository.ts")!;
    expect(repo).toContain("const data = cartToDoc(aggregate);");
    expect(repo).toContain("return cartFromDoc(row.data as CartDoc);");
    // fromDoc rebuilds through the same _create factory the normalised
    // hydrate uses, rehydrating contained parts.
    expect(repo).toContain("function cartFromDoc(d: CartDoc): Cart {");
    expect(repo).toContain("Cart._create({");
    expect(repo).toContain("items: (d.items ?? []).map((x) => cartItemFromDoc(x))");
    expect(repo).toContain(
      "unitPrice: new Money(Number(d.unitPrice.amount), d.unitPrice.currency)",
    );
    // version is bumped on update.
    expect(repo).toContain("version: existing[0]!.version + 1");
  });

  it("finds evaluate in-memory over rehydrated documents", () => {
    const repo = files.get("db/repositories/cart-repository.ts")!;
    expect(repo).toContain("const all = rows.map((r) => cartFromDoc(r.data as CartDoc));");
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
});
