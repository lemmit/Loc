// Operation / find HEADER editing for the visual builder.
//
// `body.ts` owns everything inside an operation's braces; `op-surface.ts` owns
// everything before them — the parameter list, the return type, the `requires`
// / `when` gates, the `private` / `extern` / `audited` modifiers, and a find's
// `requires` gate + `ignoring` clause.
//
// The invariant every mutator keeps: an edit is a narrow CST splice guarded by
// an output re-parse, so everything outside the edited span — the operation's
// whole body, the comments beside it, the rest of the file — is byte-preserved.
// Assertions go through `lineDiff` (the builder's own hunk differ): asserting
// the exact removed/added lines proves nothing else moved.

import { describe, expect, it } from "vitest";
import { lineDiff } from "../../../web/src/builder/edit-engine.js";
import type { PrimitiveName, TypeSpec } from "../../../web/src/builder/system/fields.js";
import {
  addOpParam,
  deleteOpParam,
  findSurface,
  freshOpParamName,
  opSurface,
  renameOpParam,
  retypeOpParam,
  setFindGate,
  setFindIgnoring,
  setOpGate,
  setOpModifier,
  setOpReturnType,
} from "../../../web/src/builder/system/op-surface.js";
import { parseRaw as parse } from "../../_helpers/index.js";

const prim = (name: PrimitiveName): TypeSpec => ({
  base: { kind: "primitive", name },
  array: false,
  optional: false,
});

// One fixture carrying every header shape the grammar allows, littered with
// the comments a reprint would destroy.
const SRC = `system Shop {

  context Sales {

    aggregate Order {
      status: string
      total: decimal = 0

      // the canonical confirm command
      operation confirm(n: int, note: string) {
        // domain validity
        precondition n > 0
        status := "confirmed"
      }

      /* fully decorated: every header clause at once */
      private operation settle(amount: decimal) extern audited: decimal requires currentUser.isAdmin when status == "confirmed" {
        total += amount
        return total
      }

      operation touch() {
        status := "touched"
      }

      operation scale(factor: int) {
        for line in lines {
          total += factor
        }
        return factor
      }
    }

    // Reads over the order book.
    repository Orders for Order {
      // one customer's own orders
      find byCustomer(customerId: Customer id): Order[]
      find drafts(forCustomer: Customer id): Order[]
        where this.customerId == forCustomer
      find secured(): Order[] requires currentUser.isAdmin where this.total > 0 ignoring tenantOwned
      find everything(): Order[] ignoring *
    }
  }
}`;

/** Every comment in the fixture — none of them may ever disappear. */
const COMMENTS = [
  "// the canonical confirm command",
  "// domain validity",
  "/* fully decorated: every header clause at once */",
  "// Reads over the order book.",
  "// one customer's own orders",
];

const expectCommentsIntact = (out: string | null): void => {
  expect(out).not.toBeNull();
  for (const c of COMMENTS) expect(out).toContain(c);
};

/** Assert the edit is exactly this hunk — nothing else in the file moved. */
const expectHunk = (
  before: string,
  after: string | null,
  removed: string[],
  added: string[],
): void => {
  expect(after).not.toBeNull();
  const hunk = lineDiff(before, after as string);
  expect({ removed: hunk.removed, added: hunk.added }).toEqual({ removed, added });
};

// A source the parser rejects — every mutator must refuse it rather than splice
// at offsets the error-recovery parser invented.
const BROKEN = SRC.replace("aggregate Order {", "aggregate Order {{");

const CONFIRM = "      operation confirm(n: int, note: string) {";
const SETTLE =
  '      private operation settle(amount: decimal) extern audited: decimal requires currentUser.isAdmin when status == "confirmed" {';

describe("operation surface — the read surface", () => {
  it("reports params / return / gates / modifiers of a decorated operation", () => {
    expect(opSurface(parse(SRC), "Order", "settle")).toEqual({
      name: "settle",
      params: [
        {
          name: "amount",
          base: { kind: "primitive", name: "decimal" },
          baseLabel: "decimal",
          array: false,
          optional: false,
        },
      ],
      returnType: { base: { kind: "primitive", name: "decimal" }, array: false, optional: false },
      returnTypeText: "decimal",
      requires: "currentUser.isAdmin",
      when: 'status == "confirmed"',
      private: true,
      extern: true,
      audited: true,
    });
  });

  it("reports the bare operation as all-absent, all-false", () => {
    const s = opSurface(parse(SRC), "Order", "confirm");
    expect(s?.params.map((p) => `${p.name}: ${p.baseLabel}`)).toEqual(["n: int", "note: string"]);
    expect([s?.returnType, s?.returnTypeText, s?.requires, s?.when]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect([s?.private, s?.extern, s?.audited]).toEqual([false, false, false]);
  });

  it("reports a find's params / return / gate / filter / ignoring", () => {
    expect(findSurface(parse(SRC), "Orders", "secured")).toEqual({
      name: "secured",
      params: [],
      returnType: { base: { kind: "named", target: "Order" }, array: true, optional: false },
      returnTypeText: "Order[]",
      requires: "currentUser.isAdmin",
      where: "this.total > 0",
      ignoring: ["tenantOwned"],
    });
    expect(findSurface(parse(SRC), "Orders", "everything")?.ignoring).toBe("*");
    expect(findSurface(parse(SRC), "Orders", "byCustomer")?.ignoring).toBeNull();
    expect(findSurface(parse(SRC), "Orders", "drafts")?.where).toBe(
      "this.customerId == forCustomer",
    );
  });

  it("returns null for an unknown aggregate / operation / repository / find", () => {
    expect(opSurface(parse(SRC), "Nope", "confirm")).toBeNull();
    expect(opSurface(parse(SRC), "Order", "nope")).toBeNull();
    expect(findSurface(parse(SRC), "Nope", "byCustomer")).toBeNull();
    expect(findSurface(parse(SRC), "Orders", "nope")).toBeNull();
  });

  it("freshOpParamName skips the names the operation already binds", () => {
    expect(freshOpParamName(parse(SRC), "Order", "touch")).toBe("param1");
    const one = addOpParam(SRC, "Order", "touch", "param1", prim("int")) as string;
    expect(freshOpParamName(parse(one), "Order", "touch")).toBe("param2");
  });
});

describe("operation surface — parameters", () => {
  it("addOpParam extends the param list in place", () => {
    expectHunk(
      SRC,
      addOpParam(SRC, "Order", "confirm", "at", prim("datetime")),
      [CONFIRM],
      ["      operation confirm(n: int, note: string, at: datetime) {"],
    );
    expectCommentsIntact(addOpParam(SRC, "Order", "confirm", "at", prim("datetime")));
  });

  it("addOpParam fills an empty param list", () => {
    expectHunk(
      SRC,
      addOpParam(SRC, "Order", "touch", "by", prim("string")),
      ["      operation touch() {"],
      ["      operation touch(by: string) {"],
    );
  });

  it("addOpParam keeps the decorated header's clauses in place", () => {
    expectHunk(
      SRC,
      addOpParam(SRC, "Order", "settle", "at", prim("datetime")),
      [SETTLE],
      [
        '      private operation settle(amount: decimal, at: datetime) extern audited: decimal requires currentUser.isAdmin when status == "confirmed" {',
      ],
    );
  });

  it("addOpParam accepts a raw type text as well as a TypeSpec", () => {
    expect(addOpParam(SRC, "Order", "touch", "who", "Customer id")).toContain(
      "operation touch(who: Customer id) {",
    );
  });

  it("deleteOpParam takes the separating comma with it", () => {
    expectHunk(
      SRC,
      deleteOpParam(SRC, "Order", "confirm", 0),
      [CONFIRM],
      ["      operation confirm(note: string) {"],
    );
    expectHunk(
      SRC,
      deleteOpParam(SRC, "Order", "confirm", 1),
      [CONFIRM],
      ["      operation confirm(n: int) {"],
    );
  });

  it("deleteOpParam empties a sole-param list to `()`", () => {
    expectHunk(
      SRC,
      deleteOpParam(SRC, "Order", "settle", 0),
      [SETTLE],
      [
        '      private operation settle() extern audited: decimal requires currentUser.isAdmin when status == "confirmed" {',
      ],
    );
  });

  it("retypeOpParam rewrites only that param's TypeRef", () => {
    expectHunk(
      SRC,
      retypeOpParam(SRC, "Order", "confirm", 1, prim("int")),
      [CONFIRM],
      ["      operation confirm(n: int, note: int) {"],
    );
    expectCommentsIntact(retypeOpParam(SRC, "Order", "confirm", 0, prim("decimal")));
  });

  it("renameOpParam rewrites the token and its uses inside the body", () => {
    expectHunk(
      SRC,
      renameOpParam(SRC, "Order", "confirm", 0, "count"),
      [CONFIRM, "        // domain validity", "        precondition n > 0"],
      [
        "      operation confirm(count: int, note: string) {",
        "        // domain validity",
        "        precondition count > 0",
      ],
    );
    expectCommentsIntact(renameOpParam(SRC, "Order", "confirm", 0, "count"));
  });

  it("renameOpParam reaches uses nested inside a `for` body", () => {
    expectHunk(
      SRC,
      renameOpParam(SRC, "Order", "scale", 0, "mult"),
      [
        "      operation scale(factor: int) {",
        "        for line in lines {",
        "          total += factor",
        "        }",
        "        return factor",
      ],
      [
        "      operation scale(mult: int) {",
        "        for line in lines {",
        "          total += mult",
        "        }",
        "        return mult",
      ],
    );
  });

  it("renameOpParam rewrites uses in the `requires` / `when` gates too", () => {
    const src = SRC.replace(
      "      operation touch() {",
      '      operation touch(who: string) requires who == "root" when who != "" {',
    );
    expectHunk(
      src,
      renameOpParam(src, "Order", "touch", 0, "actor"),
      ['      operation touch(who: string) requires who == "root" when who != "" {'],
      ['      operation touch(actor: string) requires actor == "root" when actor != "" {'],
    );
  });

  it("renameOpParam refuses a duplicate name, a bad identifier and a shadowing let", () => {
    expect(renameOpParam(SRC, "Order", "confirm", 0, "note")).toBeNull();
    expect(renameOpParam(SRC, "Order", "confirm", 0, "2bad")).toBeNull();
    const shadowed = SRC.replace(
      "        precondition n > 0",
      "        precondition n > 0\n        let x = 1",
    );
    expect(renameOpParam(shadowed, "Order", "confirm", 0, "x")).toBeNull();
  });

  it("returns null on a broken source / an unknown target / a bad index", () => {
    expect(addOpParam(BROKEN, "Order", "confirm", "at", prim("int"))).toBeNull();
    expect(deleteOpParam(BROKEN, "Order", "confirm", 0)).toBeNull();
    expect(retypeOpParam(BROKEN, "Order", "confirm", 0, prim("int"))).toBeNull();
    expect(renameOpParam(BROKEN, "Order", "confirm", 0, "x")).toBeNull();
    expect(addOpParam(SRC, "Order", "nope", "at", prim("int"))).toBeNull();
    expect(addOpParam(SRC, "Nope", "confirm", "at", prim("int"))).toBeNull();
    expect(deleteOpParam(SRC, "Order", "confirm", 9)).toBeNull();
    expect(retypeOpParam(SRC, "Order", "confirm", 9, prim("int"))).toBeNull();
    expect(renameOpParam(SRC, "Order", "confirm", 9, "x")).toBeNull();
  });
});

describe("operation surface — return type", () => {
  it("adds a return type after the parameter list", () => {
    expectHunk(
      SRC,
      setOpReturnType(SRC, "Order", "confirm", prim("string")),
      [CONFIRM],
      ["      operation confirm(n: int, note: string): string {"],
    );
    expectCommentsIntact(setOpReturnType(SRC, "Order", "confirm", prim("string")));
  });

  it("adds it AFTER `extern` / `audited`, in grammar order", () => {
    const src = SRC.replace(
      "      operation touch() {",
      "      operation touch() extern audited {",
    );
    expectHunk(
      src,
      setOpReturnType(src, "Order", "touch", prim("int")),
      ["      operation touch() extern audited {"],
      ["      operation touch() extern audited: int {"],
    );
  });

  it("replaces an existing return type without touching the gates", () => {
    expectHunk(
      SRC,
      setOpReturnType(SRC, "Order", "settle", { ...prim("money"), optional: true }),
      [SETTLE],
      [
        '      private operation settle(amount: decimal) extern audited: money? requires currentUser.isAdmin when status == "confirmed" {',
      ],
    );
  });

  it("removes the clause, taking its separator with it", () => {
    expectHunk(
      SRC,
      setOpReturnType(SRC, "Order", "settle", null),
      [SETTLE],
      [
        '      private operation settle(amount: decimal) extern audited requires currentUser.isAdmin when status == "confirmed" {',
      ],
    );
    // Removing an absent clause is a no-op, not a failure.
    expect(setOpReturnType(SRC, "Order", "confirm", null)).toBe(SRC);
  });

  it("returns null on a broken source / unknown op / empty type text", () => {
    expect(setOpReturnType(BROKEN, "Order", "confirm", prim("int"))).toBeNull();
    expect(setOpReturnType(SRC, "Order", "nope", prim("int"))).toBeNull();
    expect(setOpReturnType(SRC, "Order", "confirm", "  ")).toBeNull();
  });
});

describe("operation surface — requires / when gates", () => {
  it("adds `requires` after the params and `when` after it", () => {
    const gated = setOpGate(SRC, "Order", "confirm", "requires", "currentUser.isAdmin");
    expectHunk(
      SRC,
      gated,
      [CONFIRM],
      ["      operation confirm(n: int, note: string) requires currentUser.isAdmin {"],
    );
    expectHunk(
      gated as string,
      setOpGate(gated as string, "Order", "confirm", "when", 'status == "draft"'),
      ["      operation confirm(n: int, note: string) requires currentUser.isAdmin {"],
      [
        '      operation confirm(n: int, note: string) requires currentUser.isAdmin when status == "draft" {',
      ],
    );
    expectCommentsIntact(gated);
  });

  it("adds `requires` BEFORE an existing `when`", () => {
    const src = SRC.replace(
      "      operation touch() {",
      '      operation touch() when status == "draft" {',
    );
    expectHunk(
      src,
      setOpGate(src, "Order", "touch", "requires", "currentUser.isAdmin"),
      ['      operation touch() when status == "draft" {'],
      ['      operation touch() requires currentUser.isAdmin when status == "draft" {'],
    );
  });

  it("adds a gate after the return type", () => {
    const src = SRC.replace("      operation touch() {", "      operation touch(): int {");
    expectHunk(
      src,
      setOpGate(src, "Order", "touch", "requires", "currentUser.isAdmin"),
      ["      operation touch(): int {"],
      ["      operation touch(): int requires currentUser.isAdmin {"],
    );
  });

  it("replaces each gate in place, leaving the other one alone", () => {
    expectHunk(
      SRC,
      setOpGate(SRC, "Order", "settle", "requires", "currentUser.isOwner"),
      [SETTLE],
      [
        '      private operation settle(amount: decimal) extern audited: decimal requires currentUser.isOwner when status == "confirmed" {',
      ],
    );
    expectHunk(
      SRC,
      setOpGate(SRC, "Order", "settle", "when", 'status == "placed"'),
      [SETTLE],
      [
        '      private operation settle(amount: decimal) extern audited: decimal requires currentUser.isAdmin when status == "placed" {',
      ],
    );
  });

  it("removes each gate independently", () => {
    expectHunk(
      SRC,
      setOpGate(SRC, "Order", "settle", "requires", null),
      [SETTLE],
      [
        '      private operation settle(amount: decimal) extern audited: decimal when status == "confirmed" {',
      ],
    );
    expectHunk(
      SRC,
      setOpGate(SRC, "Order", "settle", "when", null),
      [SETTLE],
      [
        "      private operation settle(amount: decimal) extern audited: decimal requires currentUser.isAdmin {",
      ],
    );
    expect(setOpGate(SRC, "Order", "confirm", "when", null)).toBe(SRC);
  });

  it("returns null on a broken source / unknown op / unparseable expression", () => {
    expect(setOpGate(BROKEN, "Order", "confirm", "requires", "x")).toBeNull();
    expect(setOpGate(SRC, "Order", "nope", "requires", "x")).toBeNull();
    expect(setOpGate(SRC, "Order", "confirm", "requires", "  ")).toBeNull();
    expect(setOpGate(SRC, "Order", "confirm", "when", "status ==")).toBeNull();
  });
});

describe("operation surface — modifiers", () => {
  it("toggles `private` on before the `operation` keyword", () => {
    expectHunk(
      SRC,
      setOpModifier(SRC, "Order", "confirm", "private", true),
      [CONFIRM],
      ["      private operation confirm(n: int, note: string) {"],
    );
    expectCommentsIntact(setOpModifier(SRC, "Order", "confirm", "private", true));
  });

  it("toggles `extern` / `audited` on after the parameter list", () => {
    const ext = setOpModifier(SRC, "Order", "confirm", "extern", true);
    expectHunk(SRC, ext, [CONFIRM], ["      operation confirm(n: int, note: string) extern {"]);
    // `audited` lands after `extern`, in grammar order.
    expectHunk(
      ext as string,
      setOpModifier(ext as string, "Order", "confirm", "audited", true),
      ["      operation confirm(n: int, note: string) extern {"],
      ["      operation confirm(n: int, note: string) extern audited {"],
    );
    expectHunk(
      SRC,
      setOpModifier(SRC, "Order", "confirm", "audited", true),
      [CONFIRM],
      ["      operation confirm(n: int, note: string) audited {"],
    );
  });

  it("keeps a modifier insertion clear of the return type and gates", () => {
    const src = SRC.replace(
      "      operation touch() {",
      '      operation touch(): int requires currentUser.isAdmin when status == "draft" {',
    );
    expectHunk(
      src,
      setOpModifier(src, "Order", "touch", "audited", true),
      ['      operation touch(): int requires currentUser.isAdmin when status == "draft" {'],
      [
        '      operation touch() audited: int requires currentUser.isAdmin when status == "draft" {',
      ],
    );
  });

  it("toggles each modifier off, taking its separator with it", () => {
    expectHunk(
      SRC,
      setOpModifier(SRC, "Order", "settle", "private", false),
      [SETTLE],
      [
        '      operation settle(amount: decimal) extern audited: decimal requires currentUser.isAdmin when status == "confirmed" {',
      ],
    );
    expectHunk(
      SRC,
      setOpModifier(SRC, "Order", "settle", "extern", false),
      [SETTLE],
      [
        '      private operation settle(amount: decimal) audited: decimal requires currentUser.isAdmin when status == "confirmed" {',
      ],
    );
    expectHunk(
      SRC,
      setOpModifier(SRC, "Order", "settle", "audited", false),
      [SETTLE],
      [
        '      private operation settle(amount: decimal) extern: decimal requires currentUser.isAdmin when status == "confirmed" {',
      ],
    );
  });

  it("is a no-op when the modifier already has the requested state", () => {
    expect(setOpModifier(SRC, "Order", "settle", "private", true)).toBe(SRC);
    expect(setOpModifier(SRC, "Order", "confirm", "extern", false)).toBe(SRC);
  });

  it("returns null on a broken source / unknown op", () => {
    expect(setOpModifier(BROKEN, "Order", "confirm", "private", true)).toBeNull();
    expect(setOpModifier(SRC, "Order", "nope", "private", true)).toBeNull();
  });
});

describe("find surface — requires gate", () => {
  it("adds the gate between the return type and the `where` filter", () => {
    expectHunk(
      SRC,
      setFindGate(SRC, "Orders", "drafts", "currentUser.isAdmin"),
      ["      find drafts(forCustomer: Customer id): Order[]"],
      ["      find drafts(forCustomer: Customer id): Order[] requires currentUser.isAdmin"],
    );
    expectCommentsIntact(setFindGate(SRC, "Orders", "drafts", "currentUser.isAdmin"));
  });

  it("replaces / removes an existing gate, filter and ignoring untouched", () => {
    expectHunk(
      SRC,
      setFindGate(SRC, "Orders", "secured", "currentUser.isOwner"),
      [
        "      find secured(): Order[] requires currentUser.isAdmin where this.total > 0 ignoring tenantOwned",
      ],
      [
        "      find secured(): Order[] requires currentUser.isOwner where this.total > 0 ignoring tenantOwned",
      ],
    );
    expectHunk(
      SRC,
      setFindGate(SRC, "Orders", "secured", null),
      [
        "      find secured(): Order[] requires currentUser.isAdmin where this.total > 0 ignoring tenantOwned",
      ],
      ["      find secured(): Order[] where this.total > 0 ignoring tenantOwned"],
    );
    expect(setFindGate(SRC, "Orders", "byCustomer", null)).toBe(SRC);
  });

  it("returns null on a broken source / unknown find / unparseable expression", () => {
    expect(setFindGate(BROKEN, "Orders", "drafts", "x")).toBeNull();
    expect(setFindGate(SRC, "Orders", "nope", "x")).toBeNull();
    expect(setFindGate(SRC, "Nope", "drafts", "x")).toBeNull();
    expect(setFindGate(SRC, "Orders", "drafts", "  ")).toBeNull();
    expect(setFindGate(SRC, "Orders", "drafts", "a ==")).toBeNull();
  });
});

describe("find surface — ignoring clause", () => {
  it("appends a name list after the filter", () => {
    expectHunk(
      SRC,
      setFindIgnoring(SRC, "Orders", "drafts", ["tenantOwned", "softDeletable"]),
      ["        where this.customerId == forCustomer"],
      ["        where this.customerId == forCustomer ignoring tenantOwned, softDeletable"],
    );
    expectCommentsIntact(setFindIgnoring(SRC, "Orders", "drafts", ["tenantOwned"]));
  });

  it("appends after the return type when there is no filter or gate", () => {
    expectHunk(
      SRC,
      setFindIgnoring(SRC, "Orders", "byCustomer", "*"),
      ["      find byCustomer(customerId: Customer id): Order[]"],
      ["      find byCustomer(customerId: Customer id): Order[] ignoring *"],
    );
  });

  it("replaces an existing clause in both directions", () => {
    expectHunk(
      SRC,
      setFindIgnoring(SRC, "Orders", "secured", "*"),
      [
        "      find secured(): Order[] requires currentUser.isAdmin where this.total > 0 ignoring tenantOwned",
      ],
      [
        "      find secured(): Order[] requires currentUser.isAdmin where this.total > 0 ignoring *",
      ],
    );
    expectHunk(
      SRC,
      setFindIgnoring(SRC, "Orders", "everything", ["tenantOwned"]),
      ["      find everything(): Order[] ignoring *"],
      ["      find everything(): Order[] ignoring tenantOwned"],
    );
  });

  it("removes the clause on null / an empty list", () => {
    expectHunk(
      SRC,
      setFindIgnoring(SRC, "Orders", "everything", null),
      ["      find everything(): Order[] ignoring *"],
      ["      find everything(): Order[]"],
    );
    expectHunk(
      SRC,
      setFindIgnoring(SRC, "Orders", "secured", []),
      [
        "      find secured(): Order[] requires currentUser.isAdmin where this.total > 0 ignoring tenantOwned",
      ],
      ["      find secured(): Order[] requires currentUser.isAdmin where this.total > 0"],
    );
    expect(setFindIgnoring(SRC, "Orders", "byCustomer", null)).toBe(SRC);
  });

  it("returns null on a broken source / unknown find / a bad capability name", () => {
    expect(setFindIgnoring(BROKEN, "Orders", "drafts", "*")).toBeNull();
    expect(setFindIgnoring(SRC, "Orders", "nope", "*")).toBeNull();
    expect(setFindIgnoring(SRC, "Orders", "drafts", ["not an id"])).toBeNull();
  });
});

describe("operation surface — the body is never touched", () => {
  it("every header edit leaves the operation bodies byte-identical", () => {
    const bodies = [
      '        precondition n > 0\n        status := "confirmed"',
      "        total += amount\n        return total",
    ];
    const edits = [
      addOpParam(SRC, "Order", "confirm", "at", prim("datetime")),
      deleteOpParam(SRC, "Order", "confirm", 0),
      retypeOpParam(SRC, "Order", "confirm", 0, prim("decimal")),
      setOpReturnType(SRC, "Order", "confirm", prim("string")),
      setOpGate(SRC, "Order", "settle", "requires", "currentUser.isOwner"),
      setOpGate(SRC, "Order", "settle", "when", null),
      setOpModifier(SRC, "Order", "settle", "extern", false),
      setOpModifier(SRC, "Order", "confirm", "audited", true),
    ];
    for (const out of edits) {
      expect(out).not.toBeNull();
      for (const body of bodies) expect(out).toContain(body);
    }
  });
});
