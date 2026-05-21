import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmptyFileSystem } from "langium";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Aggregate, Model, ValueObject } from "../src/language/generated/ast.js";
import { emitExpr, seedExpr } from "../web/src/builder/system/expr-model.js";
import {
  editExprSlot,
  listDerived,
  listInvariants,
  slotExpr,
  type ExprSlot,
} from "../web/src/builder/system/expr-slots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "examples", "sales.ddd"), "utf8");

const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;
const parse = (t: string): Model => parser.parse(t).value as Model;
function owner<T>(m: Model, type: string, name: string): T {
  for (const n of walk(m)) if (n.$type === type && (n as { name?: string }).name === name) return n as T;
  throw new Error(`no ${type} ${name}`);
}
function* walk(node: { $type: string }): Generator<{ $type: string }> {
  yield node;
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) for (const c of v) if (c && typeof c === "object" && "$type" in c) yield* walk(c);
    else if (v && typeof v === "object" && "$type" in v) yield* walk(v as { $type: string });
  }
}

describe("structured expression editor — model", () => {
  it("decomposes an operator tree and re-emits it", () => {
    const expr = slotExpr(parse(sales), { kind: "invariant", owner: "Money", index: 0 })!;
    const tree = seedExpr(expr);
    expect(tree).toEqual({
      kind: "binary",
      op: ">=",
      left: { kind: "raw", text: "amount" },
      right: { kind: "lit", lit: "int", value: "0" },
    });
    expect(emitExpr(tree)).toBe("amount >= 0");
  });

  it("treats non-operator forms (calls, member access) as raw leaves", () => {
    const expr = slotExpr(parse(sales), { kind: "derived", owner: "Order", name: "total" })!;
    const tree = seedExpr(expr);
    expect(tree.kind).toBe("raw");
    // Round-trips verbatim through the printer.
    expect(emitExpr(tree)).toMatch(/^Money\(/);
  });

  it("lists invariants (by predicate) and derived props (by name)", () => {
    expect(listInvariants(owner<ValueObject>(parse(sales), "ValueObject", "Money"))).toEqual([
      "amount >= 0",
      "currency.length == 3",
    ]);
    expect(listDerived(owner<Aggregate>(parse(sales), "Aggregate", "Order"))).toContain("total");
  });
});

describe("structured expression editor — slot edits", () => {
  const inv0: ExprSlot = { kind: "invariant", owner: "Money", index: 0 };
  const fnBody: ExprSlot = { kind: "function", owner: "Order", name: "isMutable" };

  it("edits an invariant predicate when the result parses", () => {
    const out = editExprSlot(sales, inv0, "amount > 0")!;
    expect(out).toMatch(/invariant amount > 0/);
    // The other invariant is untouched.
    expect(out).toMatch(/invariant currency\.length == 3/);
  });

  it("edits a function body expression", () => {
    expect(editExprSlot(sales, fnBody, "status != Draft")).toMatch(/= status != Draft/);
  });

  it("rejects a syntactically invalid expression", () => {
    expect(editExprSlot(sales, inv0, "amount >=")).toBeNull();
  });

  it("returns null for an unknown slot", () => {
    expect(editExprSlot(sales, { kind: "function", owner: "Order", name: "nope" }, "1")).toBeNull();
  });
});
