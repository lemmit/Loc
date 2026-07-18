// Flutter Track B — `flutterTarget: WalkerTarget` seams + the `DART_LEAVES`
// expression table.  Walking-skeleton scope: the read/display (List/Detail)
// path.  These are string-assertion tests calling the seam functions directly —
// they pin the Dart SHAPE we emit (the "is the Dart real / analyzes" question is
// the CI-only `generated-flutter-build.yml` gate, no local Flutter SDK).

import { describe, expect, it } from "vitest";
import type { ApiCallSite, StateRef } from "../../../src/generator/_walker/target.js";
import {
  DART_LEAVES,
  dartString,
  dartZeroValue,
} from "../../../src/generator/flutter/dart-expr.js";
import { flutterTarget } from "../../../src/generator/flutter/flutter-target.js";
import type { StateFieldIR, TypeIR } from "../../../src/ir/types/loom-ir.js";

const prim = (name: string): TypeIR => ({ kind: "primitive", name: name as never });
function stateRef(name: string, type: TypeIR = prim("string")): StateRef {
  const field: StateFieldIR = { name, type };
  return { field, name };
}

describe("DART_LEAVES — Dart expression leaf table", () => {
  it("literals: string is single-quoted, bool/null verbatim, numbers raw", () => {
    expect(DART_LEAVES.literal("string", "hi")).toBe("'hi'");
    expect(DART_LEAVES.literal("bool", "true")).toBe("true");
    expect(DART_LEAVES.literal("null", "")).toBe("null");
    expect(DART_LEAVES.literal("int", "42")).toBe("42");
  });

  it("dartString escapes the quote, backslash and `$` interpolation sigil", () => {
    expect(dartString("a'b")).toBe("'a\\'b'");
    expect(dartString("$x")).toBe("'\\$x'");
  });

  it("binary keeps Dart operator spelling (== not ===/=)", () => {
    expect(DART_LEAVES.binary("a", "b", "==")).toBe("(a == b)");
    expect(DART_LEAVES.binary("a", "b", "&&")).toBe("(a && b)");
  });

  it("unary and ternary", () => {
    expect(DART_LEAVES.unary("!", "x")).toBe("(!x)");
    expect(DART_LEAVES.ternary("c", "t", "e")).toBe("(c ? t : e)");
  });

  it("convert: string→toString, string→int via int.parse, num→toDouble", () => {
    expect(DART_LEAVES.convert("x", "string", undefined)).toBe("x.toString()");
    expect(DART_LEAVES.convert("x", "int", "string")).toBe("int.parse(x)");
    expect(DART_LEAVES.convert("x", "int", "decimal")).toBe("(x).toInt()");
    expect(DART_LEAVES.convert("x", "decimal", undefined)).toBe("(x).toDouble()");
  });

  it("list is a Dart list literal, object a Dart map literal", () => {
    expect(DART_LEAVES.list(["a", "b"])).toBe("[a, b]");
    expect(DART_LEAVES.object([{ name: "n", value: "v" }])).toBe("{'n': v}");
  });

  it("dartZeroValue: primitive/array/optional Dart defaults", () => {
    expect(dartZeroValue(prim("int"))).toBe("0");
    expect(dartZeroValue(prim("decimal"))).toBe("0.0");
    expect(dartZeroValue(prim("bool"))).toBe("false");
    expect(dartZeroValue(prim("string"))).toBe("''");
    expect(dartZeroValue({ kind: "array", element: prim("string") })).toBe("const []");
    expect(dartZeroValue({ kind: "optional", inner: prim("string") })).toBe("null");
  });
});

describe("flutterTarget — state seam", () => {
  it("reads dereference the projected state record", () => {
    expect(flutterTarget.renderStateRead(stateRef("step"), "template")).toBe("state.step");
  });

  it("writes call a Notifier setter with the pinned TODO marker", () => {
    const w = flutterTarget.renderStateWrite(stateRef("step"), "3");
    expect(w).toBe("notifier.setStep(3) /* TODO(flutter): notifier */");
  });

  it("nested writes call the root-field setter and note the path", () => {
    const w = flutterTarget.renderNestedStateWrite(["order", "shipping", "zip"], "v");
    expect(w).toContain("notifier.setOrder(v)");
    expect(w).toContain("order.shipping.zip");
  });

  it("defaultInitFor forwards to dartZeroValue", () => {
    expect(flutterTarget.defaultInitFor(prim("int"))).toBe("0");
    expect(flutterTarget.defaultInitFor(prim("bool"))).toBe("false");
  });
});

describe("flutterTarget — api seam", () => {
  it("buildHookUse names a provider-local var and renders args through the callback", () => {
    const use = flutterTarget.buildHookUse(
      { aggregateName: "Customer", operation: "byId", args: [{} as never], kind: "aggregate" },
      () => "id",
    );
    expect(use.varName).toBe("customerById");
    expect(use.importFrom).toBe("../providers/customer");
    expect(use.argsRendered).toEqual(["id"]);
  });

  it("renderApiCall emits the resolved provider var", () => {
    const call: ApiCallSite = {
      apiHandle: "Sales",
      aggregateName: "Customer",
      operation: "all",
      kind: "query",
      args: [],
    };
    expect(flutterTarget.renderApiCall(call, "")).toBe("customerAll");
    expect(flutterTarget.renderApiCall({ ...call, varName: "activeOrdersView" }, "")).toBe(
      "activeOrdersView",
    );
  });

  it("renderApiHoisting emits one deduped ref.watch(<var>Provider) per distinct read", () => {
    const call: ApiCallSite = {
      apiHandle: "Sales",
      aggregateName: "Customer",
      operation: "all",
      kind: "query",
      args: [],
    };
    const lines = flutterTarget.renderApiHoisting([call, call]);
    expect(lines).toHaveLength(1);
    // A real AsyncValue binding the QueryView `.when` consumes (no TODO stub).
    expect(lines[0]).toBe("    final customerAll = ref.watch(customerAllProvider);");
    expect(lines[0]).not.toContain("TODO");
  });

  it("renderApiHoisting passes a byId read's args to the .family provider", () => {
    const byId: ApiCallSite = {
      apiHandle: "Sales",
      aggregateName: "Customer",
      operation: "byId",
      kind: "query",
      args: [],
      varName: "customerById",
      argsRendered: ["id"],
    };
    const lines = flutterTarget.renderApiHoisting([byId]);
    expect(lines[0]).toBe("    final customerById = ref.watch(customerByIdProvider(id));");
  });

  it("renderRouteId binds the route `id` local", () => {
    expect(flutterTarget.renderRouteId?.()).toBe("id");
  });
});

describe("flutterTarget — match / control-flow seams", () => {
  it("renderMatch builds a guarded Dart-3 switch expression", () => {
    const s = flutterTarget.renderMatch([{ predicate: "x > 0", value: "'pos'" }], "'other'");
    expect(s).toBe("switch (0) { _ when x > 0 => 'pos', _ => 'other' }");
  });

  it("renderMatchChild with no else falls back to SizedBox.shrink()", () => {
    const s = flutterTarget.renderMatchChild([{ predicate: "ok", value: "A()" }], undefined, 0);
    expect(s).toBe("switch (0) { _ when ok => A(), _ => const SizedBox.shrink() }");
  });

  it("renderConditionalChild is a widget ternary", () => {
    expect(flutterTarget.renderConditionalChild("c", "A()", "B()", 0)).toBe("(c ? A() : B())");
  });
});

describe("flutterTarget — list-comprehension seam", () => {
  it("renderForEach spreads a `.map` into the children list", () => {
    const s = flutterTarget.renderForEach("items", "x", "i", "x.id", "Tile(x)", 0, undefined);
    expect(s).toBe("...items.map((x) => Tile(x))");
  });

  it("uses the indexed form only when the index is referenced", () => {
    const s = flutterTarget.renderForEach("items", "x", "i", "i", "Tile(x, i)", 0, undefined);
    expect(s).toContain("items.asMap().entries.map");
    expect(s).toContain("final i = entry.key");
  });

  it("an empty: arm folds into a collection-if", () => {
    const s = flutterTarget.renderForEach("items", "x", "i", "x.id", "Tile(x)", 0, "Empty()");
    expect(s).toBe("if (items.isEmpty) Empty() else ...items.map((x) => Tile(x))");
  });
});

describe("flutterTarget — navigation seam", () => {
  it("renderNavigate interpolates :param segments into a Dart route string", () => {
    const s = flutterTarget.renderNavigate("/products/:id", [{ name: "id", value: "p.id" }]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal Dart string interpolation
    expect(s).toBe("Navigator.pushNamed(context, '/products/${p.id}')");
  });

  it("extra args ride along as a Navigator arguments map", () => {
    const s = flutterTarget.renderNavigate("/orders", [{ name: "ref", value: "o.id" }]);
    expect(s).toBe("Navigator.pushNamed(context, '/orders', arguments: {'ref': o.id})");
  });

  it("renderNavigateExpr wraps a pre-rendered destination", () => {
    expect(flutterTarget.renderNavigateExpr?.("'/products'")).toBe(
      "Navigator.pushNamed(context, '/products')",
    );
  });
});

describe("flutterTarget — markup seams", () => {
  it("renderInterpolation coerces non-string, passes string straight", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal Dart string interpolation
    expect(flutterTarget.renderInterpolation("count")).toBe("Text('${count}')");
    expect(flutterTarget.renderInterpolation("name", prim("string"))).toBe("Text(name)");
  });

  it("renderComment is a Dart block comment; renderStyleAttr is empty", () => {
    expect(flutterTarget.renderComment("todo")).toBe("/* todo */");
    expect(flutterTarget.renderStyleAttr([])).toBe("");
  });

  it("renderAttrBinding is a leading-space camelCased named arg", () => {
    expect(flutterTarget.renderAttrBinding("data-testid", "'x'")).toBe(" dataTestid: 'x'");
  });

  it("escapeText escapes the quote and the `$` interpolation sigil", () => {
    expect(flutterTarget.escapeText("a'b$c")).toBe("a\\'b\\$c");
  });
});

describe("flutterTarget — handler seams (Dart closures, no JS arrow-block)", () => {
  it("expression handler is an arrow; block handler a brace body", () => {
    expect(flutterTarget.renderEventHandler?.(undefined, "doThing()")).toBe("() => doThing()");
    expect(flutterTarget.renderEventHandler?.(["a();", "b();"], undefined)).toBe(
      "() { a(); b(); }",
    );
  });

  it("named handler declares a Dart void method", () => {
    const h = flutterTarget.renderNamedHandler?.("inc", undefined, ["n();"]);
    expect(h).toContain("void inc() { n(); }");
  });
});

describe("flutterTarget — expression leaves forward to DART_LEAVES", () => {
  it("no JS-isms leak (=== / String())", () => {
    expect(flutterTarget.exprBinary("a", "b", "==")).toBe("(a == b)");
    expect(flutterTarget.exprConvert("x", "string", undefined)).toBe("x.toString()");
    expect(flutterTarget.exprList(["a"])).toBe("[a]");
  });
});
