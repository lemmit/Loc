import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  Aggregate,
  EventDecl,
  Model,
  Property,
  ValueObject,
} from "../../../src/language/generated/ast.js";
import {
  addField,
  availableTypes,
  deleteField,
  listFields,
  type PrimitiveName,
  retypeField,
  type TypeSpec,
} from "../../../web/src/builder/system/fields.js";
import { parseRaw as parse } from "../../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "..", "..", "examples", "sales.ddd"), "utf8");

const find = <T>(m: Model, type: string, name: string): T => {
  for (const n of [...walk(m)])
    if (n.$type === type && (n as { name?: string }).name === name) return n as T;
  throw new Error(`not found: ${type} ${name}`);
};
function* walk(node: { $type: string }): Generator<{ $type: string }> {
  yield node;
  for (const v of Object.values(node)) {
    if (Array.isArray(v))
      for (const c of v)
        if (c && typeof c === "object" && "$type" in c) yield* walk(c);
        else if (v && typeof v === "object" && "$type" in v) yield* walk(v as { $type: string });
  }
}

const prim = (name: PrimitiveName): TypeSpec => ({
  base: { kind: "primitive", name },
  array: false,
  optional: false,
});

describe("System builder — inline field editing", () => {
  it("adds a primitive / array / optional field to an aggregate", () => {
    let src = sales;
    src = addField(src, "aggregate", "Order", "qty", {
      base: { kind: "primitive", name: "int" },
      array: false,
      optional: false,
    })!;
    src = addField(src, "aggregate", "Order", "tags", {
      base: { kind: "primitive", name: "string" },
      array: true,
      optional: false,
    })!;
    src = addField(src, "aggregate", "Order", "note", {
      base: { kind: "primitive", name: "string" },
      array: false,
      optional: true,
    })!;
    expect(src).not.toBeNull();

    const order = find<Aggregate>(parse(src), "Aggregate", "Order");
    const props = Object.fromEntries(
      (order.members.filter((m) => m.$type === "Property") as Property[]).map((p) => [
        p.name,
        p.type,
      ]),
    );
    expect(props.qty.base.$type).toBe("PrimitiveType");
    expect(props.qty.array).toBe(false);
    expect(props.tags.array).toBe(true);
    expect(props.note.optional).toBe(true);
  });

  it("retypes a field to an Id<> reference and a value-object array", () => {
    const order = find<Aggregate>(parse(sales), "Aggregate", "Order");
    const fields = listFields(order);
    const idx = fields.findIndex((f) => f.name === "customerId");
    expect(idx).toBeGreaterThanOrEqual(0);

    const id: TypeSpec = { base: { kind: "id", target: "Product" }, array: false, optional: false };
    let src = retypeField(sales, "aggregate", "Order", idx, id)!;
    expect(src).toMatch(/customerId: Product id/);

    const vo: TypeSpec = { base: { kind: "named", target: "Money" }, array: true, optional: false };
    src = retypeField(sales, "aggregate", "Order", idx, vo)!;
    expect(src).toMatch(/customerId: Money\[\]/);
    // Other members (operations, invariants) survive the reprint.
    expect(src).toMatch(/aggregate Order/);
  });

  it("deletes a field, leaving the rest intact", () => {
    const money = find<ValueObject>(parse(sales), "ValueObject", "Money");
    const before = listFields(money);
    const idx = before.findIndex((f) => f.name === "currency");
    const src = deleteField(sales, "valueobject", "Money", idx)!;
    const after = listFields(find<ValueObject>(parse(src), "ValueObject", "Money"));
    expect(after.map((f) => f.name)).toEqual(
      before.filter((f) => f.name !== "currency").map((f) => f.name),
    );
    expect(src).toMatch(/amount: decimal/);
  });

  it("edits an event's fields too", () => {
    const src = addField(sales, "event", "OrderConfirmed", "at", {
      base: { kind: "primitive", name: "datetime" },
      array: false,
      optional: false,
    })!;
    const ev = find<EventDecl>(parse(src), "EventDecl", "OrderConfirmed");
    expect(ev.fields.some((f) => f.name === "at" && f.type.base.$type === "PrimitiveType")).toBe(
      true,
    );
  });

  it("offers primitives plus Id<aggregate> and named value-object/enum options", () => {
    const opts = availableTypes(parse(sales));
    const labels = opts.map((o) => o.label);
    expect(labels).toContain("string");
    expect(labels).toContain("Order id");
    expect(labels).toContain("Money");
  });

  it("returns null for an unknown construct or out-of-range index", () => {
    expect(addField(sales, "aggregate", "Nope", "x", prim("int"))).toBeNull();
    expect(deleteField(sales, "aggregate", "Order", 999)).toBeNull();
    expect(retypeField(sales, "aggregate", "Order", 999, prim("int"))).toBeNull();
  });
});
