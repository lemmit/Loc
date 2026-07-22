// Pin the shared line-wrapping helpers (`wrapArgList`/`wrapBraced`) that
// every call-arg / builder-entry / object-field / emit-field printer in
// print-expr.ts and print-stmt.ts delegates to. A deeply nested expression
// tree (e.g. a scaffolded UI page body — Stack/Toolbar/QueryView/Table/
// Column widget calls) used to collapse onto one illegible line because
// these printers joined args with a bare `", "` and never wrapped; this
// file locks the wrapping contract directly rather than through a specific
// AST shape, since every call site (`printCall`, `printBuilderCall`,
// `ObjectLit`, `print-stmt.ts`'s `printLValue`/`EmitStmt`) shares it.

import { describe, expect, it } from "vitest";
import { wrapArgList, wrapBraced } from "../../../src/language/print/print-expr.js";

describe("wrapArgList", () => {
  it("stays on one line when short", () => {
    expect(wrapArgList("Foo", "(", ")", ["a", "b"])).toBe("Foo(a, b)");
  });

  it("prints `prefix<open><close>` for an empty item list", () => {
    expect(wrapArgList("Foo", "(", ")", [])).toBe("Foo()");
  });

  it("wraps onto indented, comma-joined lines once the one-line form exceeds the width budget", () => {
    const items = [
      "veryLongArgumentNameOne: someExpression",
      "veryLongArgumentNameTwo: anotherExpression",
      "veryLongArgumentNameThree: yetAnotherExpression",
    ];
    const printed = wrapArgList("QueryView", "(", ")", items);
    expect(printed).toBe(
      "QueryView(\n  veryLongArgumentNameOne: someExpression,\n" +
        "  veryLongArgumentNameTwo: anotherExpression,\n" +
        "  veryLongArgumentNameThree: yetAnotherExpression\n)",
    );
    // No trailing comma after the last item (matches print-structural.ts's
    // `commaBlock` convention).
    expect(printed).not.toMatch(/,\n\)$/);
  });

  it("wraps when any item already spans multiple lines, regardless of one-line length", () => {
    const printed = wrapArgList("Outer", "(", ")", ["a", "Inner(\n  x,\n  y\n)"]);
    expect(printed).toBe("Outer(\n  a,\n  Inner(\n    x,\n    y\n  )\n)");
  });
});

describe("wrapBraced", () => {
  it("stays on one line when short: `prefix{ items }`", () => {
    expect(wrapBraced("Stack ", ["a", "b"])).toBe("Stack { a, b }");
  });

  it("prints `prefix{}` for an empty item list", () => {
    expect(wrapBraced("Stack ", [])).toBe("Stack {}");
    // No prefix (ObjectLit's case) still closes cleanly.
    expect(wrapBraced("", [])).toBe("{}");
  });

  it("wraps onto indented, comma-joined lines once the one-line form exceeds the width budget", () => {
    const items = [
      "reallyLongFieldNameHere: cmd.reallyLongFieldNameHere",
      "anotherReallyLongFieldName: cmd.anotherReallyLongFieldName",
    ];
    const printed = wrapBraced("", items);
    expect(printed).toBe(
      "{\n  reallyLongFieldNameHere: cmd.reallyLongFieldNameHere,\n" +
        "  anotherReallyLongFieldName: cmd.anotherReallyLongFieldName\n}",
    );
  });
});
