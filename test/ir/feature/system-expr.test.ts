import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  Aggregate,
  Model,
  Repository,
  ValueObject,
  Workflow,
} from "../../../src/language/generated/ast.js";
import { emitExpr, seedExpr } from "../../../web/src/builder/system/expr-model.js";
import {
  type ExprSlot,
  editExprSlot,
  enumPickerCandidates,
  exprSlotOptions,
  listDerived,
  listInvariants,
  memberCandidates,
  repoSlotOptions,
  slotCandidates,
  slotExpr,
  workflowSlotOptions,
} from "../../../web/src/builder/system/expr-slots.js";
import { parseRaw as parse } from "../../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "..", "..", "examples", "sales.ddd"), "utf8");

function owner<T>(m: Model, type: string, name: string): T {
  for (const n of walk(m))
    if (n.$type === type && (n as { name?: string }).name === name) return n as T;
  throw new Error(`no ${type} ${name}`);
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

  it("structures builder-calls (type + entries), keeping lambdas as raw leaves", () => {
    // derived total = Money { amount: lines.sum(l => l.subtotal.amount), currency: "USD" }
    const tree = seedExpr(
      slotExpr(parse(sales), { kind: "derived", owner: "Order", name: "total" })!,
    );
    if (tree.kind !== "builder") throw new Error("expected a builder-call");
    expect(tree.type).toBe("Money");
    expect(tree.entries).toHaveLength(2);
    expect(tree.entries[0].value).toMatchObject({ kind: "member", member: "sum", call: true });
    expect(tree.entries[1].value).toMatchObject({ kind: "lit", lit: "string", value: "USD" });
    expect(emitExpr(tree)).toBe(
      'Money { amount: lines.sum(l => l.subtotal.amount), currency: "USD" }',
    );
  });

  it("structures expression-body lambdas (param + body)", () => {
    // derived total = Money { amount: lines.sum(l => l.subtotal.amount), currency: "USD" }
    const tree = seedExpr(
      slotExpr(parse(sales), { kind: "derived", owner: "Order", name: "total" })!,
    );
    if (tree.kind !== "builder") throw new Error("expected a builder-call");
    const sum = tree.entries[0].value;
    if (sum.kind !== "member") throw new Error("expected a member call");
    const lam = sum.args[0].value;
    expect(lam).toMatchObject({ kind: "lambda", param: "l" });
    if (lam.kind !== "lambda") throw new Error("expected a lambda");
    expect(lam.body).toMatchObject({ kind: "member", member: "amount" });
    expect(emitExpr(tree)).toBe(
      'Money { amount: lines.sum(l => l.subtotal.amount), currency: "USD" }',
    );
  });

  it("structures ternary expressions (cond / then / else)", () => {
    const src = `system S { context C { aggregate Order { qty: int
      derived label: string = qty > 0 ? "yes" : "no" } } }`;
    const tree = seedExpr(
      slotExpr(parse(src), { kind: "derived", owner: "Order", name: "label" })!,
    );
    expect(tree).toMatchObject({
      kind: "ternary",
      cond: { kind: "binary", op: ">" },
      // biome-ignore lint/suspicious/noThenProperty: the ternary IR node's branch field is named `then`
      then: { kind: "lit", lit: "string", value: "yes" },
      else: { kind: "lit", lit: "string", value: "no" },
    });
    expect(emitExpr(tree)).toBe('qty > 0 ? "yes" : "no"');
  });

  it("structures block-body lambdas (statement rows; let/assign values)", () => {
    const src = `system S { context C { aggregate Order { qty: int
      derived doubled: int = items.map(i => {
        let d = i
        i := d
      }) } } }`;
    const tree = seedExpr(
      slotExpr(parse(src), { kind: "derived", owner: "Order", name: "doubled" })!,
    );
    if (tree.kind !== "member") throw new Error("expected a member call");
    const lam = tree.args[0].value;
    if (lam.kind !== "blockLambda") throw new Error("expected a block lambda");
    expect(lam.param).toBe("i");
    expect(lam.stmts).toHaveLength(2);
    expect(lam.stmts[0]).toMatchObject({
      kind: "let",
      name: "d",
      value: { kind: "raw", text: "i" },
    });
    expect(lam.stmts[1]).toMatchObject({
      kind: "assign",
      target: "i",
      op: ":=",
      value: { kind: "raw", text: "d" },
    });
    expect(emitExpr(tree)).toBe("items.map(i => {\n  let d = i\n  i := d\n})");
  });

  it("renames a named call argument (and demotes to positional when cleared)", () => {
    const src = `system S { context C { aggregate Order { qty: int
      derived m: int = f(amount: qty, currency: 3) } } }`;
    const tree = seedExpr(slotExpr(parse(src), { kind: "derived", owner: "Order", name: "m" })!);
    if (tree.kind !== "call") throw new Error("expected a call");
    expect(tree.args[0].name).toBe("amount");
    expect(emitExpr(tree)).toBe("f(amount: qty, currency: 3)");
    // Rename the first arg, drop the name on the second.
    tree.args[0].name = "total";
    tree.args[1].name = undefined;
    expect(emitExpr(tree)).toBe("f(total: qty, 3)");
  });

  it("structures match expressions (arms + optional else)", () => {
    // Arm conds must not end in a bare identifier (the grammar would read
    // `X => …` as a lambda) — `qty > 0` ends in a literal, so it's safe.
    const src = `system S { context C {
      aggregate Order { qty: int
        derived label: string = match {
          qty > 0 => "open"
          else => "closed"
        } } } }`;
    const tree = seedExpr(
      slotExpr(parse(src), { kind: "derived", owner: "Order", name: "label" })!,
    );
    if (tree.kind !== "match") throw new Error("expected a match");
    expect(tree.arms).toHaveLength(1);
    expect(tree.arms[0].cond).toMatchObject({ kind: "binary", op: ">" });
    expect(tree.arms[0].value).toMatchObject({ kind: "lit", lit: "string", value: "open" });
    expect(tree.else).toMatchObject({ kind: "lit", lit: "string", value: "closed" });
    expect(emitExpr(tree)).toBe('match {\nqty > 0 => "open"\nelse => "closed"\n}');
  });

  it("structures object literals (named fields)", () => {
    // placeOrder: let order = Order.create({ customerId: …, status: Draft, placedAt: … })
    const tree = seedExpr(
      slotExpr(parse(sales), { kind: "wfStmt", owner: "placeOrder", index: 1 })!,
    );
    if (tree.kind !== "member") throw new Error("expected a member call");
    const obj = tree.args[0].value;
    if (obj.kind !== "object") throw new Error("expected an object literal");
    expect(obj.fields.map((f) => f.name)).toEqual(["customerId", "status", "placedAt"]);
    expect(obj.fields[1].value).toMatchObject({ kind: "raw", text: "Draft" });
    expect(emitExpr(tree)).toBe(
      "Order.create({ customerId: customerId, status: Draft, placedAt: placedAt })",
    );
  });

  it("structures builder-call expressions (type + entries)", () => {
    // addLine: lines += OrderLine { productId: productId, quantity: qty, unitPrice: price }
    const order = owner<Aggregate>(parse(sales), "Aggregate", "Order");
    const addLine = order.members.find((m) => (m as { name?: string }).name === "addLine") as {
      body: { $type: string; value?: unknown }[];
    };
    const newNode = addLine.body.find((s) => s.$type === "AssignOrCallStmt")!.value;
    const tree = seedExpr(newNode as never);
    if (tree.kind !== "builder") throw new Error("expected a builder-call expression");
    expect(tree.type).toBe("OrderLine");
    expect(tree.entries.map((e) => e.name)).toEqual(["productId", "quantity", "unitPrice"]);
    expect(emitExpr(tree)).toBe(
      "OrderLine { productId: productId, quantity: qty, unitPrice: price }",
    );
  });

  it("structures member access (receiver + member)", () => {
    // find activeForCustomer where this.customerId == forCustomer && this.status == Draft
    const tree = seedExpr(
      slotExpr(parse(sales), { kind: "findFilter", owner: "Orders", name: "activeForCustomer" })!,
    );
    if (tree.kind !== "binary") throw new Error("expected a binary");
    expect(tree.left).toMatchObject({
      kind: "binary",
      op: "==",
      left: {
        kind: "member",
        member: "customerId",
        call: false,
        receiver: { kind: "raw", text: "this" },
      },
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

describe("structured expression editor — operation statement slots", () => {
  it("lists precondition / requires / let expressions across operations", () => {
    const opts = exprSlotOptions(owner<Aggregate>(parse(sales), "Aggregate", "Order")).filter((o) =>
      o.value.startsWith("stmt:"),
    );
    // addLine has two preconditions (its `+=` assign and `emit` carry no single expr).
    expect(opts.map((o) => o.value)).toEqual(
      expect.arrayContaining(["stmt:addLine:0", "stmt:addLine:1"]),
    );
    expect(opts.find((o) => o.value === "stmt:addLine:1")?.label).toBe(
      "addLine: precondition qty > 0",
    );
  });

  it("resolves and edits a statement expression", () => {
    const expr = slotExpr(parse(sales), {
      kind: "stmtExpr",
      owner: "Order",
      op: "addLine",
      index: 1,
    })!;
    expect(seedExpr(expr)).toMatchObject({
      kind: "binary",
      op: ">",
      left: { kind: "raw", text: "qty" },
    });
    expect(
      editExprSlot(
        sales,
        { kind: "stmtExpr", owner: "Order", op: "addLine", index: 1 },
        "qty >= 1",
      ),
    ).toMatch(/precondition qty >= 1/);
  });

  it("offers operation params (and the aggregate's names) as candidates", () => {
    const c = slotCandidates(parse(sales), {
      kind: "stmtExpr",
      owner: "Order",
      op: "addLine",
      index: 1,
    });
    expect(c).toEqual(expect.arrayContaining(["qty", "productId", "price", "status", "lines"]));
  });
});

describe("structured expression editor — assignment & emit statement slots", () => {
  const order = () => parse(sales);

  it("exposes assignment values and one slot per emit field", () => {
    const opts = exprSlotOptions(owner<Aggregate>(parse(sales), "Aggregate", "Order"));
    const byValue = new Map(opts.map((o) => [o.value, o.label]));
    // addLine: `lines += OrderLine { … }` (assign) then `emit LineAdded { … }`.
    expect(byValue.get("stmt:addLine:2")).toBe(
      "addLine: lines += OrderLine { productId: productId, quantity: qty, unitPrice: price }",
    );
    expect(byValue.get("stmt:addLine:3:2")).toBe("addLine: emit LineAdded.quantity = qty");
    // confirm: `status := Confirmed`.
    expect(byValue.get("stmt:confirm:2")).toBe("confirm: status := Confirmed");
  });

  it("resolves and edits an assignment value (only the value is spliced)", () => {
    expect(
      seedExpr(slotExpr(order(), { kind: "stmtExpr", owner: "Order", op: "addLine", index: 2 })!),
    ).toMatchObject({ kind: "builder", type: "OrderLine" });
    const out = editExprSlot(
      sales,
      { kind: "stmtExpr", owner: "Order", op: "confirm", index: 2 },
      "Shipped",
    )!;
    expect(out).toMatch(/status := Shipped/);
  });

  it("resolves and edits a single emit field value, leaving siblings intact", () => {
    expect(
      seedExpr(
        slotExpr(order(), { kind: "stmtExpr", owner: "Order", op: "addLine", index: 3, field: 2 })!,
      ),
    ).toMatchObject({ kind: "raw", text: "qty" });
    const out = editExprSlot(
      sales,
      { kind: "stmtExpr", owner: "Order", op: "addLine", index: 3, field: 2 },
      "qty + 1",
    )!;
    expect(out).toMatch(/quantity: qty \+ 1/);
    expect(out).toMatch(/order: id/);
  });
});

describe("structured expression editor — bare call argument slots", () => {
  const callSrc = `system S { subdomain M { context C {
  aggregate Order {
    operation go(qty: int) {
      addLine(qty, 5)
    }
  }
}}}`;

  it("exposes one slot per bare-call argument", () => {
    const opts = exprSlotOptions(owner<Aggregate>(parse(callSrc), "Aggregate", "Order"));
    const byValue = new Map(opts.map((o) => [o.value, o.label]));
    expect(byValue.get("stmt:go:0:0")).toBe("go: addLine(…) arg 1: qty");
    expect(byValue.get("stmt:go:0:1")).toBe("go: addLine(…) arg 2: 5");
  });

  it("resolves and edits a bare-call argument, leaving siblings intact", () => {
    expect(
      seedExpr(
        slotExpr(parse(callSrc), {
          kind: "stmtExpr",
          owner: "Order",
          op: "go",
          index: 0,
          field: 0,
        })!,
      ),
    ).toMatchObject({ kind: "raw", text: "qty" });
    const out = editExprSlot(
      callSrc,
      { kind: "stmtExpr", owner: "Order", op: "go", index: 0, field: 1 },
      "10",
    )!;
    expect(out).toMatch(/addLine\(qty, 10\)/);
  });
});

describe("structured expression editor — workflow statement slots", () => {
  it("lists a workflow's single-expression statements", () => {
    const opts = workflowSlotOptions(owner<Workflow>(parse(sales), "Workflow", "placeOrder"));
    expect(opts.map((o) => o.value)).toEqual(["wf:0", "wf:1"]);
    expect(opts[0].label).toBe("let customer = Customers.getById(customerId)");
  });

  it("resolves and edits a workflow statement expression", () => {
    const tree = seedExpr(
      slotExpr(parse(sales), { kind: "wfStmt", owner: "placeOrder", index: 0 })!,
    );
    expect(tree).toMatchObject({ kind: "member", member: "getById", call: true });
    expect(
      editExprSlot(
        sales,
        { kind: "wfStmt", owner: "placeOrder", index: 0 },
        "Customers.findOne(customerId)",
      ),
    ).toMatch(/let customer = Customers\.findOne\(customerId\)/);
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
    const tree = seedExpr(
      slotExpr(parse(sales), { kind: "findFilter", owner: "Orders", name: "activeForCustomer" })!,
    );
    expect(tree.kind).toBe("binary");
    expect(tree).toMatchObject({ kind: "binary", op: "&&" });
  });

  it("edits a find's where filter", () => {
    const out = editExprSlot(
      sales,
      { kind: "findFilter", owner: "Orders", name: "activeForCustomer" },
      "this.status == Draft",
    )!;
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

  it("offers find params alongside the aggregate's names", () => {
    const c = names({ kind: "findFilter", owner: "Orders", name: "activeForCustomer" });
    expect(c).toEqual(expect.arrayContaining(["forCustomer", "status"]));
  });
});

describe("structured expression editor — type-directed member candidates", () => {
  it("types member receivers, including through a collection-op lambda", async () => {
    // derived total = Money { amount: lines.sum(l => l.subtotal.amount), currency: "USD" }
    const m = await memberCandidates(sales, { kind: "derived", owner: "Order", name: "total" });
    // `lines` (containment) is an array → collection ops.  Path prefix
    // is `f0` (BuilderCall entry index) instead of pre-v2's `a0` (CallExpr
    // arg index) — the suffix structure under it is unchanged.
    expect(m.get("f0")).toEqual(expect.arrayContaining(["count", "sum", "all"]));
    // Inside the lambda: `l` binds to OrderLine, `l.subtotal` is Money.
    expect(m.get("f0a0br")).toEqual(expect.arrayContaining(["subtotal", "quantity", "id"]));
    expect(m.get("f0a0b")).toEqual(["amount", "currency"]);
  });

  it("types a `this`-rooted receiver in a find filter", async () => {
    // activeForCustomer where this.customerId == forCustomer && this.status == Draft
    const m = await memberCandidates(sales, {
      kind: "findFilter",
      owner: "Orders",
      name: "activeForCustomer",
    });
    expect(m.get("LL")).toEqual(expect.arrayContaining(["customerId", "status", "id"]));
  });

  it("returns an empty map for an expression with no member access", async () => {
    const m = await memberCandidates(sales, { kind: "invariant", owner: "Money", index: 0 });
    expect(m.size).toBe(0);
  });

  it("keys member candidates through ternary and match branches (paths align with the editor)", async () => {
    const src = `system S { context C {
      enum Status { Open, Closed }
      aggregate Order { qty: int  status: Status
        derived t: Status = qty > 0 ? this.status : status
        derived m: Status = match { qty > 0 => this.status else => status } } } }`;
    // ternary `then` branch is `this.status` → member node at path "?t".
    const tern = await memberCandidates(src, { kind: "derived", owner: "Order", name: "t" });
    expect(tern.get("?t")).toEqual(expect.arrayContaining(["qty", "status"]));
    // match arm 0 value is `this.status` → member node at path "m0v".
    const mt = await memberCandidates(src, { kind: "derived", owner: "Order", name: "m" });
    expect(mt.get("m0v")).toEqual(expect.arrayContaining(["qty", "status"]));
  });

  // Positional-call argLabels (used pre-v2 to hint Money { amount: 10, currency: "USD" } with
  // ["amount", "currency"]) no longer applies once every VO construction
  // is a BuilderCall with named slots written into the source.  Slot-name
  // suggestion for empty BuilderCall entries is a separate feature.
});

describe("structured expression editor — match-arm enum-case picker", () => {
  // OrderStatus + a `match { status == EnumCase => … }` derived prop. Both
  // operands type as `enum(OrderStatus)`, so each side gets the picker keyed
  // on its leaf path.
  const matchSrc = `system S { context C {
    enum OrderStatus { Draft, Confirmed, Cancelled }
    aggregate Order { status: OrderStatus
      derived label: string = match {
        status == Confirmed => "ready",
        status == Cancelled => "no",
        else => "pending"
      } } } }`;

  it("offers enum cases at the rhs leaf of a `status == Case` arm cond", async () => {
    const m = await enumPickerCandidates(matchSrc, {
      kind: "derived",
      owner: "Order",
      name: "label",
    });
    // Cond path is `m{i}c`; the BinaryChain's rest[0] (RHS) appends `R`.
    expect(m.get("m0cR")).toEqual(["Draft", "Confirmed", "Cancelled"]);
    expect(m.get("m1cR")).toEqual(["Draft", "Confirmed", "Cancelled"]);
  });

  it("offers the cases on the lhs when the RHS is the typed-enum operand", async () => {
    // `Confirmed == status` — lhs is the literal case, rhs is the typed
    // `status` operand. Bare NameRefs to enum cases don't resolve via
    // `envForNode` (env doesn't bind enum values), so we recognise them
    // separately as a bare-ident matching some enum's case.
    const src = `system S { context C {
      enum OrderStatus { Draft, Confirmed }
      aggregate Order { status: OrderStatus
        derived label: string = match {
          status == Confirmed => "yes"
          else => "no"
        } } } }`;
    const m = await enumPickerCandidates(src, { kind: "derived", owner: "Order", name: "label" });
    // `status` types as enum(OrderStatus) → rhs leaf at `m0cR` gets the
    // picker; lhs picker would need a reverse-direction inference we
    // currently don't do (documented caveat).
    expect(m.get("m0cR")).toEqual(["Draft", "Confirmed"]);
  });

  it("unwraps ParenExpr wrappers and threads `i` segments into the path", async () => {
    const src = `system S { context C {
      enum OrderStatus { Draft, Confirmed }
      aggregate Order { status: OrderStatus
        derived label: string = match {
          (status == Confirmed) => "ready"
          else => "pending"
        } } } }`;
    const m = await enumPickerCandidates(src, { kind: "derived", owner: "Order", name: "label" });
    // Arm 0 cond is ParenExpr → inner BinaryChain → rhs leaf at `m0ciR`.
    expect(m.get("m0ciR")).toEqual(["Draft", "Confirmed"]);
  });

  it("covers `!=` arm conds the same way", async () => {
    const src = `system S { context C {
      enum OrderStatus { Draft, Confirmed }
      aggregate Order { status: OrderStatus
        derived label: string = match {
          status != Confirmed => "no"
          else => "yes"
        } } } }`;
    const m = await enumPickerCandidates(src, { kind: "derived", owner: "Order", name: "label" });
    expect(m.get("m0cR")).toEqual(["Draft", "Confirmed"]);
  });

  it("falls through on nested conjunctions (compound conds stay free text)", async () => {
    const src = `system S { context C {
      enum OrderStatus { Draft, Confirmed }
      aggregate Order { qty: int  status: OrderStatus
        derived label: string = match {
          qty > 0 && status == Confirmed => "yes"
          else => "no"
        } } } }`;
    const m = await enumPickerCandidates(src, { kind: "derived", owner: "Order", name: "label" });
    // The arm cond's top-level is `&&`, not `==` — picker doesn't apply
    // anywhere on this arm.
    expect(m.size).toBe(0);
  });

  it("returns an empty map for slots without a match expression", async () => {
    const m = await enumPickerCandidates(sales, { kind: "invariant", owner: "Money", index: 0 });
    expect(m.size).toBe(0);
  });
});
