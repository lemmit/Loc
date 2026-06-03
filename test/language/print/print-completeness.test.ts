// Completeness guard for the `.ddd` source printers.
//
// `printStructural` / `printExpr` / `printStmt` (src/language/print/) each
// dispatch on `node.$type` and `throw` on an unhandled type.  Their only
// real-world coverage gate is the example corpus exercised by
// `print-structural-roundtrip.test.ts` — so a freshly-added grammar member
// stays invisible until someone happens to write an example that uses it.
// That is exactly how the abstract/extends/persistedAs aggregate modifiers,
// the `platform { … }` realization block, and the payload/channel members
// silently fell behind the grammar (caught only when an example landed).
//
// This test closes that gap mechanically: for every CONCRETE node type the
// grammar admits under a printable union (structural members, expressions,
// statements), assert the matching printer has a `case` for it — i.e. it does
// not throw its `unhandled node <type>` error.  The node types come from
// Langium reflection (the generated AST), so the day a new member/expr/stmt
// rule lands without a printer arm, this fails in CI instead of waiting for
// an example to trip it.
//
// We probe with a bare `{ $type }` stub and only fail on the specific
// `unhandled node` throw; any other error (a real printer reaching for a
// field the stub lacks) means the case EXISTS, which is all we assert here.

import { describe, expect, it } from "vitest";
import { reflection } from "../../../src/language/generated/ast.js";
import { printExpr, printStmt, printStructural } from "../../../src/language/print/index.js";

/** Concrete (instantiable) leaf types reachable under an abstract union —
 *  a type is a leaf iff it has no proper subtypes of its own.  This drops
 *  the union itself and any intermediate sub-unions, leaving only the
 *  `$type`s a parsed node can actually carry. */
function concreteLeaves(union: string): string[] {
  return reflection
    .getAllSubTypes(union)
    .filter((t) => reflection.getAllSubTypes(t).length === 1)
    .sort();
}

/** True iff `print` throws its own `unhandled node` error for a node of
 *  this `$type` (i.e. the dispatch switch has no arm for it).  Any other
 *  throw counts as "handled" — the arm exists, it just wanted real fields. */
function isUnhandled(print: (node: never) => string, type: string): boolean {
  try {
    print({ $type: type } as never);
    return false;
  } catch (err) {
    return err instanceof Error && err.message.includes(`unhandled node ${type}`);
  }
}

const STRUCTURAL_UNIONS = [
  "ModelMember",
  "SystemMember",
  "ContextMember",
  "AggregateMember",
  "UiMember",
];

describe("`.ddd` printer completeness vs the grammar", () => {
  const structuralTypes = [...new Set(STRUCTURAL_UNIONS.flatMap(concreteLeaves))].sort();

  it("covers every printable structural member union", () => {
    // sanity: reflection actually produced a meaningful set
    expect(structuralTypes.length).toBeGreaterThan(20);
  });

  for (const type of structuralTypes) {
    it(`printStructural handles ${type}`, () => {
      expect(
        isUnhandled(printStructural, type),
        `printStructural throws "unhandled node ${type}" — add a case in print-structural.ts`,
      ).toBe(false);
    });
  }

  for (const type of concreteLeaves("Expression")) {
    it(`printExpr handles ${type}`, () => {
      expect(
        isUnhandled(printExpr, type),
        `printExpr throws "unhandled node ${type}" — add a case in print-expr.ts`,
      ).toBe(false);
    });
  }

  for (const type of concreteLeaves("Statement")) {
    it(`printStmt handles ${type}`, () => {
      expect(
        isUnhandled(printStmt, type),
        `printStmt throws "unhandled node ${type}" — add a case in print-stmt.ts`,
      ).toBe(false);
    });
  }
});
