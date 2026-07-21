import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renameConstruct, renameMember } from "../../../web/src/builder/system/rename.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "..", "..", "examples", "sales.ddd"), "utf8");

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

    // `Customer id` part-type references followed; the field decl + find
    // params now point at the renamed aggregate.
    expect(src).toMatch(/customerId: Client id/);
    expect(src).toMatch(/find byCustomer\(customerId: Client id\)/);

    // No real reference to the old name survives in code (comments, which can
    // mirror the field syntax verbatim, are not references and stay intact).
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/Customer id/);
    expect(code).not.toMatch(/aggregate Customer\b/);
  });

  it("leaves unrelated same-spelled tokens untouched and stays parseable", async () => {
    const out = await renameConstruct(sales, "aggregate", "Product", "Item");
    expect(out).not.toBeNull();
    const src = out!;
    expect(src).toMatch(/aggregate Item\b/);
    expect(src).toMatch(/Item id/);
    // The `productId:` field name is not the reference and must be preserved.
    expect(src).toMatch(/productId: Item id/);
  });

  it("returns null for a construct that does not exist", async () => {
    expect(await renameConstruct(sales, "aggregate", "Nope", "X")).toBeNull();
  });
});

describe("System builder — field (member) rename", () => {
  it("renames a field and every usage by type, not text", async () => {
    // Order.status is used in an invariant guard, a function body, and an
    // assignment target (`status := Confirmed`).
    const out = (await renameMember(sales, "aggregate", "Order", "status", "orderStatus"))!;
    expect(out).toMatch(/orderStatus: OrderStatus/); // declaration
    expect(out).toMatch(/when orderStatus == Confirmed/); // invariant guard (this-member)
    expect(out).toMatch(/= orderStatus == Draft/); // function body
    expect(out).toMatch(/orderStatus := Confirmed/); // assignment target (LValue)
  });

  it("renames a derived prop used through X id follow paths", async () => {
    const out = (await renameMember(sales, "aggregate", "Order", "total", "grandTotal"))!;
    expect(out).toMatch(/derived grandTotal: Money/);
  });

  it("refuses unknown fields, non-entity kinds, and bad targets", async () => {
    expect(await renameMember(sales, "aggregate", "Order", "nope", "x")).toBeNull();
    expect(await renameMember(sales, "event", "OrderConfirmed", "order", "x")).toBeNull();
    expect(await renameMember(sales, "aggregate", "Nope", "status", "x")).toBeNull();
  });
});
