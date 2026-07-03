// `loom.unknown-name` — a bare identifier (`NameRef` head) in an executable
// domain expression that resolves to nothing in scope is an error.
//
// Finding 1 of docs/audits/full-code-review-2026-07.md: `NameRef` is not a
// cross-reference, so an unresolvable head types as `T.unknown` and every
// downstream gate suppresses on it (assuming an upstream reporter that never
// existed).  `checkUnknownMemberAccess` closes the hole for member suffixes
// (`order.totl`); this closes it for the *head* (`total := amout`, previously
// zero diagnostics → emitted `this._total = amout;`).
//
// The check is conservative: it fires only inside the executable domain
// zones (operation / create / destroy / function / derived / invariant /
// property / workflow bodies) and only for a name that is declared / bound
// *nowhere* — so params, lets, this-props, enum values, `currentUser`, loop
// vars, and constructor names never trip it.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const wrap = (members: string) => `system S { subdomain M { context C {
  ${members}
}}}`;

const errs = async (members: string): Promise<string[]> =>
  (await parseString(wrap(members), { validate: true })).errors;

const unknownName = (e: string[]) => e.filter((s) => /Unknown name/.test(s));

describe("loom.unknown-name — unresolved bare identifier", () => {
  // --- negative: a typo'd head is flagged in every expression position ---

  it("flags a typo'd head on the RHS of `:=`", async () => {
    const e = await errs(`aggregate Order { total: int
      operation reprice(amount: int) { total := amout } }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(1);
    expect(e.join("\n")).toMatch(/Unknown name 'amout' — did you mean 'amount'\?/);
  });

  it("flags a typo'd head in a `let` initializer", async () => {
    const e = await errs(`aggregate Order { total: int
      operation reprice(amount: int) { let x = amout + 1 } }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(1);
    expect(e.join("\n")).toMatch(/Unknown name 'amout'/);
  });

  it("flags a typo'd head in an emit argument (exactly once, no double report)", async () => {
    const e = await errs(`aggregate Order { total: int }
      event Repriced { amount: int }
      aggregate A { total: int
        operation reprice(amount: int) { emit Repriced { amount: amout } } }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(1);
    // A2.2: `checkEmit` now suppresses on `unknown`, so there is no second
    // "Field 'amount' expects 'int' but got 'unknown'" error.
    expect(
      e.filter((s) => /expects 'int' but got/.test(s)),
      e.join("\n"),
    ).toHaveLength(0);
  });

  it("flags a typo'd head in a `requires` / invariant predicate", async () => {
    const e = await errs(`aggregate Order { total: int
      invariant totl > 0 }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(1);
    expect(e.join("\n")).toMatch(/Unknown name 'totl' — did you mean 'total'\?/);
  });

  it("flags a typo'd head in a `requires` statement", async () => {
    const e = await errs(`aggregate Order { total: int
      operation f(limit: int) { requires limt > 0 } }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(1);
    expect(e.join("\n")).toMatch(/Unknown name 'limt'/);
  });

  it("flags a typo'd head inside a lambda body", async () => {
    const e = await errs(`aggregate Order { total: int
      lines: Line id[]
      operation f() { requires lines.all(l => amout > 0) } }
      aggregate Line { qty: int }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(1);
    expect(e.join("\n")).toMatch(/Unknown name 'amout'/);
  });

  it("flags a typo'd head inside a workflow body", async () => {
    const e = await errs(`aggregate Order { total: int }
      repository Orders for Order { }
      event Paid { amount: int }
      workflow W { seen: int
        create(paid: Paid) by paid.amount { seen := amout } }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(1);
    expect(e.join("\n")).toMatch(/Unknown name 'amout' — did you mean 'amount'\?/);
  });

  // --- positive: legitimate names must NOT be flagged ---

  it("accepts a parameter, a let-binding, and a this-property", async () => {
    const e = await errs(`aggregate Order { total: int
      operation reprice(amount: int) {
        let bump = amount + 1
        total := total + bump
      } }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(0);
  });

  it("accepts an enum value referenced bare", async () => {
    const e = await errs(`enum Status { Draft, Active }
      aggregate Order { status: Status
        operation activate() { status := Active } }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(0);
  });

  it("accepts the magic `currentUser`", async () => {
    const e = await errs(`user { id: string, role: string }
      aggregate Order { owner: string
        operation claim() { owner := currentUser.id } }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(0);
  });

  it("accepts a `for` loop variable and an `if let` binding", async () => {
    const e = await errs(`aggregate Order { total: int }
      repository Orders for Order { }
      event Tick { at: datetime }
      workflow W { sum: int
        create(t: Tick) by t.at {
          for o in Orders.findAll() { sum := sum + o.total }
        } }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(0);
  });

  it("accepts a value-object constructor (builder) call and a derived reference", async () => {
    const e = await errs(`valueobject Money { amount: int, currency: string }
      aggregate Order { price: Money
        derived doubled: int = price.amount
        operation reprice(a: int) { price := Money { amount: a, currency: "USD" } } }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(0);
  });

  it("accepts a repository / factory head and a helper-function call", async () => {
    const e = await errs(`aggregate Order { total: int
      function half(): int { total / 2 }
      operation f() { let h = half() total := h } }
      repository Orders for Order { }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(0);
  });

  it("does not fire in a `ui` page body (allowlisted zone)", async () => {
    const e = await errs(`aggregate Order { total: int }
      repository Orders for Order { }
      api SalesApi from M
      ui Web { serves: SalesApi
        page Home { route: "/" body: Stack { Heading { "Hi" } } } }`);
    expect(unknownName(e), e.join("\n")).toHaveLength(0);
  });
});
