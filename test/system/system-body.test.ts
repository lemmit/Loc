import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmptyFileSystem } from "langium";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Aggregate, Model } from "../../src/language/generated/ast.js";
import {
  addStatement,
  type BodyLocator,
  deleteStatement,
  editFunctionBody,
  editStatement,
  functionBody,
  listFunctions,
  listOperations,
  listStatements,
  listStatementViews,
  moveStatement,
} from "../../web/src/builder/system/body.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "..", "examples", "sales.ddd"), "utf8");

const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;
const parse = (t: string): Model => parser.parse(t).value as Model;
function aggregate(m: Model, name: string): Aggregate {
  for (const n of walk(m))
    if (n.$type === "Aggregate" && (n as Aggregate).name === name) return n as Aggregate;
  throw new Error(`no aggregate ${name}`);
}
function* walk(node: { $type: string }): Generator<{ $type: string }> {
  yield node;
  for (const v of Object.values(node)) {
    if (Array.isArray(v))
      for (const c of v)
        if (c && typeof c === "object" && "$type" in c) yield* walk(c);
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

  it("structures an assignment into target / op / value, others verbatim", () => {
    const views = listStatementViews(parse(sales), confirm)!;
    expect(views[0]).toEqual({ kind: "other", src: "precondition isMutable()" });
    expect(views[2]).toEqual({ kind: "assign", target: "status", op: ":=", value: "Confirmed" });
    expect(views[3]).toMatchObject({ kind: "other" });
    // A bare-call workflow statement stays verbatim (no assignment op).
    const wf = listStatementViews(parse(sales), placeOrder)!;
    expect(wf[0].kind).toBe("other");
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

  it("reorders statements by swapping them in place", () => {
    const out = moveStatement(sales, confirm, 2, -1)!;
    expect(listStatements(parse(out), confirm)).toEqual([
      "precondition isMutable()",
      "status := Confirmed",
      "precondition lines.count > 0",
      "emit OrderConfirmed { order: id, at: now() }",
    ]);
    // Can't move past the ends.
    expect(moveStatement(sales, confirm, 0, -1)).toBeNull();
  });

  it("lists and edits a function's single-expression body", () => {
    expect(listFunctions(aggregate(parse(sales), "Order"))).toContain("isMutable");
    expect(functionBody(parse(sales), "Order", "isMutable")).toBe("status == Draft");
    const out = editFunctionBody(sales, "Order", "isMutable", "status != Draft")!;
    expect(functionBody(parse(out), "Order", "isMutable")).toBe("status != Draft");
    // Invalid expression rejected.
    expect(editFunctionBody(sales, "Order", "isMutable", "status ==")).toBeNull();
  });

  it("returns null for unknown owners / out-of-range indexes", () => {
    expect(
      listStatements(parse(sales), { kind: "operation", aggregate: "Order", op: "nope" }),
    ).toBeNull();
    expect(editStatement(sales, confirm, 99, "status := Draft")).toBeNull();
    expect(addStatement(sales, { kind: "workflow", name: "nope" }, "let x = 1")).toBeNull();
  });
});
