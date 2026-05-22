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
  exprSlotOptions,
  listDerived,
  listInvariants,
  repoSlotOptions,
  slotCandidates,
  slotExpr,
  viewSlotOptions,
  workflowSlotOptions,
  type ExprSlot,
} from "../web/src/builder/system/expr-slots.js";
import type { Repository, View, Workflow } from "../src/language/generated/ast.js";

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

  it("structures calls (callee + args), keeping lambdas as raw leaves", () => {
    // derived total = Money(lines.sum(l => l.subtotal.amount), "USD")
    const tree = seedExpr(slotExpr(parse(sales), { kind: "derived", owner: "Order", name: "total" })!);
    if (tree.kind !== "call") throw new Error("expected a call");
    expect(tree.callee).toMatchObject({ kind: "raw", text: "Money" });
    expect(tree.args).toHaveLength(2);
    expect(tree.args[0].value).toMatchObject({ kind: "member", member: "sum", call: true });
    expect(tree.args[1].value).toMatchObject({ kind: "lit", lit: "string", value: "USD" });
    expect(emitExpr(tree)).toBe('Money(lines.sum(l => l.subtotal.amount), "USD")');
  });

  it("structures expression-body lambdas (param + body)", () => {
    // derived total = Money(lines.sum(l => l.subtotal.amount), "USD")
    const tree = seedExpr(slotExpr(parse(sales), { kind: "derived", owner: "Order", name: "total" })!);
    if (tree.kind !== "call") throw new Error("expected a call");
    const sum = tree.args[0].value;
    if (sum.kind !== "member") throw new Error("expected a member call");
    const lam = sum.args[0].value;
    expect(lam).toMatchObject({ kind: "lambda", param: "l" });
    if (lam.kind !== "lambda") throw new Error("expected a lambda");
    expect(lam.body).toMatchObject({ kind: "member", member: "amount" });
    expect(emitExpr(tree)).toBe('Money(lines.sum(l => l.subtotal.amount), "USD")');
  });

  it("structures member access (receiver + member)", () => {
    // find activeForCustomer where this.customerId == forCustomer && this.status == Draft
    const tree = seedExpr(slotExpr(parse(sales), { kind: "findFilter", owner: "Orders", name: "activeForCustomer" })!);
    if (tree.kind !== "binary") throw new Error("expected a binary");
    expect(tree.left).toMatchObject({
      kind: "binary",
      op: "==",
      left: { kind: "member", member: "customerId", call: false, receiver: { kind: "raw", text: "this" } },
    });
    expect(emitExpr(tree)).toBe("this.customerId == forCustomer && this.status == Draft");
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

describe("structured expression editor — view slots", () => {
  it("exposes a view's where filter and bind expressions", () => {
    const opts = viewSlotOptions(owner<View>(parse(sales), "View", "OrderSummary"));
    expect(opts.map((o) => o.value)).toEqual(["filter", "bind:orderId", "bind:status", "bind:lineCount"]);
  });

  it("edits a view's where filter", () => {
    const out = editExprSlot(sales, { kind: "viewFilter", owner: "ActiveOrders" }, "status != Confirmed")!;
    expect(out).toMatch(/view ActiveOrders = Order where status != Confirmed/);
  });

  it("edits a view bind expression", () => {
    const out = editExprSlot(sales, { kind: "viewBind", owner: "OrderSummary", name: "lineCount" }, "lines.count + 1")!;
    expect(out).toMatch(/lineCount = lines\.count \+ 1/);
    // Sibling binds untouched.
    expect(out).toMatch(/orderId = id/);
  });
});

describe("structured expression editor — operation statement slots", () => {
  it("lists precondition / requires / let expressions across operations", () => {
    const opts = exprSlotOptions(owner<Aggregate>(parse(sales), "Aggregate", "Order")).filter((o) => o.value.startsWith("stmt:"));
    // addLine has two preconditions (its `+=` assign and `emit` carry no single expr).
    expect(opts.map((o) => o.value)).toEqual(expect.arrayContaining(["stmt:addLine:0", "stmt:addLine:1"]));
    expect(opts.find((o) => o.value === "stmt:addLine:1")?.label).toBe("addLine: precondition qty > 0");
  });

  it("resolves and edits a statement expression", () => {
    const expr = slotExpr(parse(sales), { kind: "stmtExpr", owner: "Order", op: "addLine", index: 1 })!;
    expect(seedExpr(expr)).toMatchObject({ kind: "binary", op: ">", left: { kind: "raw", text: "qty" } });
    expect(editExprSlot(sales, { kind: "stmtExpr", owner: "Order", op: "addLine", index: 1 }, "qty >= 1")).toMatch(/precondition qty >= 1/);
  });

  it("offers operation params (and the aggregate's names) as candidates", () => {
    const c = slotCandidates(parse(sales), { kind: "stmtExpr", owner: "Order", op: "addLine", index: 1 });
    expect(c).toEqual(expect.arrayContaining(["qty", "productId", "price", "status", "lines"]));
  });
});

describe("structured expression editor — workflow statement slots", () => {
  it("lists a workflow's single-expression statements", () => {
    const opts = workflowSlotOptions(owner<Workflow>(parse(sales), "Workflow", "placeOrder"));
    expect(opts.map((o) => o.value)).toEqual(["wf:0", "wf:1"]);
    expect(opts[0].label).toBe("let customer = Customers.getById(customerId)");
  });

  it("resolves and edits a workflow statement expression", () => {
    const tree = seedExpr(slotExpr(parse(sales), { kind: "wfStmt", owner: "placeOrder", index: 0 })!);
    expect(tree).toMatchObject({ kind: "member", member: "getById", call: true });
    expect(editExprSlot(sales, { kind: "wfStmt", owner: "placeOrder", index: 0 }, "Customers.findOne(customerId)")).toMatch(/let customer = Customers\.findOne\(customerId\)/);
  });

  it("offers workflow params and earlier lets as candidates (no aggregate `this`)", () => {
    const c = slotCandidates(parse(sales), { kind: "wfStmt", owner: "placeOrder", index: 1 });
    expect(c).toEqual(expect.arrayContaining(["customerId", "placedAt", "customer", "Draft"]));
  });
});

describe("structured expression editor — repository find slots", () => {
  it("exposes only finds that declare a where filter", () => {
    // `byCustomer` has no where; `activeForCustomer` does.
    const opts = repoSlotOptions(owner<Repository>(parse(sales), "Repository", "Orders"));
    expect(opts.map((o) => o.value)).toEqual(["find:activeForCustomer"]);
  });

  it("decomposes a compound find filter into an operator tree", () => {
    const tree = seedExpr(slotExpr(parse(sales), { kind: "findFilter", owner: "Orders", name: "activeForCustomer" })!);
    expect(tree.kind).toBe("binary");
    expect(tree).toMatchObject({ kind: "binary", op: "&&" });
  });

  it("edits a find's where filter", () => {
    const out = editExprSlot(sales, { kind: "findFilter", owner: "Orders", name: "activeForCustomer" }, "this.status == Draft")!;
    expect(out).toMatch(/where this\.status == Draft/);
  });
});

describe("structured expression editor — scope-aware name candidates", () => {
  const names = (slot: ExprSlot): string[] => slotCandidates(parse(sales), slot);

  it("offers the owning value object's properties + enum values", () => {
    const c = names({ kind: "invariant", owner: "Money", index: 0 });
    expect(c).toEqual(expect.arrayContaining(["amount", "currency", "Draft", "Confirmed"]));
  });

  it("offers aggregate properties, derived props, helpers and enum values", () => {
    const c = names({ kind: "function", owner: "Order", name: "isMutable" });
    expect(c).toEqual(expect.arrayContaining(["status", "lines", "total", "isMutable", "Draft"]));
  });

  it("offers the view source aggregate's names", () => {
    const c = names({ kind: "viewFilter", owner: "ActiveOrders" });
    expect(c).toEqual(expect.arrayContaining(["status", "Confirmed"]));
  });

  it("offers find params alongside the aggregate's names", () => {
    const c = names({ kind: "findFilter", owner: "Orders", name: "activeForCustomer" });
    expect(c).toEqual(expect.arrayContaining(["forCustomer", "status"]));
  });
});
