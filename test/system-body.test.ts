import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmptyFileSystem } from "langium";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Aggregate, Model } from "../src/language/generated/ast.js";
import {
  addStatement,
  deleteStatement,
  editStatement,
  listOperations,
  listStatements,
  type BodyLocator,
} from "../web/src/builder/system/body.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "examples", "sales.ddd"), "utf8");

const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;
const parse = (t: string): Model => parser.parse(t).value as Model;
function aggregate(m: Model, name: string): Aggregate {
  for (const n of walk(m)) if (n.$type === "Aggregate" && (n as Aggregate).name === name) return n as Aggregate;
  throw new Error(`no aggregate ${name}`);
}
function* walk(node: { $type: string }): Generator<{ $type: string }> {
  yield node;
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) for (const c of v) if (c && typeof c === "object" && "$type" in c) yield* walk(c);
    else if (v && typeof v === "object" && "$type" in v) yield* walk(v as { $type: string });
  }
}

const confirm: BodyLocator = { kind: "operation", aggregate: "Order", op: "confirm" };
const placeOrder: BodyLocator = { kind: "workflow", name: "placeOrder" };

describe("System builder — operation/workflow body editing", () => {
  it("lists an aggregate's operations", () => {
    const ops = listOperations(aggregate(parse(sales), "Order"));
    expect(ops).toEqual(expect.arrayContaining(["addLine", "confirm"]));
  });

  it("lists a body's statements verbatim", () => {
    const stmts = listStatements(parse(sales), confirm)!;
    expect(stmts).toEqual([
      "precondition isMutable()",
      "precondition lines.count > 0",
      "status := Confirmed",
      "emit OrderConfirmed { order: id, at: now() }",
    ]);
    // Workflow body, including a multi-line statement, comes through verbatim.
    const wf = listStatements(parse(sales), placeOrder)!;
    expect(wf).toHaveLength(2);
    expect(wf[0]).toBe("let customer = Customers.getById(customerId)");
    expect(wf[1]).toMatch(/^let order = Order\.create\(\{/);
  });

  it("edits a statement in place when the result still parses", () => {
    const out = editStatement(sales, confirm, 2, "status := Draft")!;
    expect(out).toMatch(/status := Draft/);
    expect(listStatements(parse(out), confirm)![2]).toBe("status := Draft");
    // Other statements untouched.
    expect(out).toMatch(/emit OrderConfirmed \{ order: id, at: now\(\) \}/);
  });

  it("rejects a syntactically invalid statement edit", () => {
    expect(editStatement(sales, confirm, 2, "status :=")).toBeNull();
  });

  it("adds a statement to an operation and a workflow", () => {
    const op = addStatement(sales, confirm, "precondition true")!;
    expect(listStatements(parse(op), confirm)).toHaveLength(5);

    const wf = addStatement(sales, placeOrder, "let extra = customer")!;
    expect(listStatements(parse(wf), placeOrder)).toHaveLength(3);
  });

  it("deletes a statement", () => {
    const out = deleteStatement(sales, confirm, 0)!;
    const stmts = listStatements(parse(out), confirm)!;
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toBe("precondition lines.count > 0");
  });

  it("returns null for unknown owners / out-of-range indexes", () => {
    expect(listStatements(parse(sales), { kind: "operation", aggregate: "Order", op: "nope" })).toBeNull();
    expect(editStatement(sales, confirm, 99, "status := Draft")).toBeNull();
    expect(addStatement(sales, { kind: "workflow", name: "nope" }, "let x = 1")).toBeNull();
  });
});
