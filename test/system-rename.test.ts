import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renameConstruct } from "../web/src/builder/system/rename.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "examples", "sales.ddd"), "utf8");

describe("System builder — rename with reference updates", () => {
  it("renames an aggregate and every reference to it", async () => {
    const out = await renameConstruct(sales, "aggregate", "Customer", "Client");
    expect(out).not.toBeNull();
    const src = out!;

    // Declaration renamed.
    expect(src).toMatch(/aggregate Client\b/);
    expect(src).not.toMatch(/aggregate Customer\b/);

    // Repository `for` reference followed (the repository's own name, which
    // merely starts with "Customer", is left alone).
    expect(src).toMatch(/repository Customers for Client\b/);

    // `Id<Customer>` part-type references followed; the field decl + find
    // params now point at the renamed aggregate.
    expect(src).toMatch(/customerId: Id<Client>/);
    expect(src).toMatch(/find byCustomer\(customerId: Id<Client>\)/);

    // No real reference to the old name survives in code (comments, which can
    // mirror the field syntax verbatim, are not references and stay intact).
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/Id<Customer>/);
    expect(code).not.toMatch(/aggregate Customer\b/);
  });

  it("leaves unrelated same-spelled tokens untouched and stays parseable", async () => {
    const out = await renameConstruct(sales, "aggregate", "Product", "Item");
    expect(out).not.toBeNull();
    const src = out!;
    expect(src).toMatch(/aggregate Item\b/);
    expect(src).toMatch(/Id<Item>/);
    // The `productId:` field name is not the reference and must be preserved.
    expect(src).toMatch(/productId: Id<Item>/);
  });

  it("returns null for a construct that does not exist", async () => {
    expect(await renameConstruct(sales, "aggregate", "Nope", "X")).toBeNull();
  });
});
