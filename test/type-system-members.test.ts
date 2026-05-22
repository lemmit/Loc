import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { AstUtils, EmptyFileSystem, URI } from "langium";
import { createDddServices } from "../src/language/ddd-module.js";
import type {
  Aggregate,
  EntityPart,
  EnumDecl,
  Model,
  ValueObject,
} from "../src/language/generated/ast.js";
import { membersOfType, type DddType } from "../src/language/type-system.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "examples", "sales.ddd"), "utf8");

// `membersOfType` resolves the AST node behind each type, so it needs a *linked*
// document (cross-references resolved), not the bare parser.
async function linkedModel(src: string): Promise<Model> {
  const services = createDddServices(EmptyFileSystem).Ddd;
  const shared = services.shared;
  const uri = URI.parse("memory:///members-test.ddd");
  const docs = shared.workspace.LangiumDocuments;
  if (docs.hasDocument(uri)) await docs.deleteDocument(uri);
  const doc = shared.workspace.LangiumDocumentFactory.fromString(src, uri);
  docs.addDocument(doc);
  await shared.workspace.DocumentBuilder.build([doc], { validation: false });
  return doc.parseResult.value as Model;
}

describe("type-system — membersOfType (single source for member completion)", () => {
  let model: Model;
  function find<T>(type: string, name: string): T {
    for (const n of AstUtils.streamAst(model)) {
      if (n.$type === type && (n as { name?: string }).name === name) return n as T;
    }
    throw new Error(`no ${type} ${name}`);
  }
  const names = (t: DddType): string[] => membersOfType(t).map((m) => m.name);

  beforeAll(async () => {
    model = await linkedModel(sales);
  });

  it("aggregate → id + properties / containments / derived / helpers", () => {
    const order = find<Aggregate>("Aggregate", "Order");
    expect(names({ kind: "aggregate", ref: order })).toEqual(
      expect.arrayContaining(["id", "customerId", "status", "placedAt", "lines", "total", "isMutable"]),
    );
  });

  it("value object → properties only (no id)", () => {
    const money = find<ValueObject>("ValueObject", "Money");
    expect(names({ kind: "valueobject", ref: money })).toEqual(["amount", "currency"]);
  });

  it("array → the collection ops", () => {
    const money = find<ValueObject>("ValueObject", "Money");
    expect(names({ kind: "array", element: { kind: "valueobject", ref: money } })).toEqual([
      "count", "sum", "all", "any", "where", "first", "firstOrNull", "contains",
    ]);
  });

  it("string → length; other primitives → none", () => {
    expect(names({ kind: "primitive", name: "string" })).toEqual(["length"]);
    expect(names({ kind: "primitive", name: "int" })).toEqual([]);
  });

  it("enum → its values", () => {
    const status = find<EnumDecl>("EnumDecl", "OrderStatus");
    expect(names({ kind: "enum", ref: status })).toEqual(["Draft", "Confirmed", "Shipped", "Cancelled"]);
  });

  it("Id<X> → unwraps to the target's members (closes the LSP gap)", () => {
    const customer = find<Aggregate>("Aggregate", "Customer");
    expect(names({ kind: "id", target: customer })).toEqual(
      expect.arrayContaining(["id", "name", "email"]),
    );
  });

  it("optional → unwraps the inner type", () => {
    const money = find<ValueObject>("ValueObject", "Money");
    expect(names({ kind: "optional", inner: { kind: "valueobject", ref: money } })).toEqual(["amount", "currency"]);
  });

  it("entity part → its members", () => {
    const line = find<EntityPart>("EntityPart", "OrderLine");
    expect(names({ kind: "entity", ref: line })).toEqual(
      expect.arrayContaining(["id", "productId", "quantity", "unitPrice", "subtotal"]),
    );
  });
});
