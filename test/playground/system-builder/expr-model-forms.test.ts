// Structured coverage for the five literal-ish expression forms the visual
// builder's expression editor used to drop to a `raw` text leaf: list
// literals, backtick templates, `money("…")`, `now()` and the primitive
// conversions (`string(x)` / `long(x)` / `decimal(x)` / `money(x)`).
//
// The shape of every case is the same round-trip the editor performs on each
// commit: parse → `seedExpr` (must structure, NOT fall to `raw`) → `emitExpr`
// → byte-identical source.  `emitExpr` is a hand-mirror of
// `src/language/print/print-expr.ts`, so a drift in either direction shows up
// here as a changed byte.  The edit cases then mutate the structured tree the
// way the UI does (retype a hole, add an element) and re-parse the result, so
// a mutation can never emit unparseable source.

import { describe, expect, it } from "vitest";
import {
  addTemplateHole,
  blankExpr,
  type EExpr,
  emitExpr,
  NEW_EXPR_FORMS,
  removeTemplateHole,
  seedExpr,
} from "../../../web/src/builder/system/expr-model.js";
import { slotExpr } from "../../../web/src/builder/system/expr-slots.js";
import { parseRaw, parseRawOk } from "../../_helpers/index.js";

/** Wrap an expression as the value of a `derived` property — the slot the
 *  builder's expression editor binds to. */
const wrap = (expr: string): string =>
  `system S { context C { aggregate Order { qty: int\n  derived e: string = ${expr} } } }`;

/** Parse `expr` in a derived slot and decompose it the way the editor does. */
function seed(expr: string): EExpr {
  const node = slotExpr(parseRaw(wrap(expr)), { kind: "derived", owner: "Order", name: "e" });
  if (!node) throw new Error(`no derived slot for: ${expr}`);
  return seedExpr(node);
}

/** True when the expression is syntactically valid in a derived slot. */
const parses = (expr: string): boolean => parseRawOk(wrap(expr));

/** seed → emit must return the original source byte-for-byte. */
function roundTrips(expr: string, kind: EExpr["kind"]): EExpr {
  const tree = seed(expr);
  expect(tree.kind).toBe(kind);
  expect(emitExpr(tree)).toBe(expr);
  return tree;
}

describe("expression editor — list literals", () => {
  it("structures elements and round-trips", () => {
    const tree = roundTrips("[3, 2, 1]", "list");
    if (tree.kind !== "list") throw new Error("expected a list");
    expect(tree.elements).toHaveLength(3);
    expect(tree.elements[0]).toEqual({ kind: "lit", lit: "int", value: "3" });
  });

  it("structures nested calls and member chains as element slots", () => {
    const tree = roundTrips("[f(a), order.total.amount]", "list");
    if (tree.kind !== "list") throw new Error("expected a list");
    expect(tree.elements[0]).toMatchObject({ kind: "call" });
    expect(tree.elements[1]).toMatchObject({ kind: "member", member: "amount", call: false });
  });

  it("emits the spaced `[ ]` form for an empty list (a bare `[]` lexes as the array marker)", () => {
    const tree = roundTrips("[ ]", "list");
    if (tree.kind !== "list") throw new Error("expected a list");
    expect(tree.elements).toEqual([]);
  });

  it("keeps the source parseable after adding, reordering and removing elements", () => {
    const tree = seed("[3, 2]");
    if (tree.kind !== "list") throw new Error("expected a list");
    const added: EExpr = { ...tree, elements: [...tree.elements, { kind: "raw", text: "qty" }] };
    expect(emitExpr(added)).toBe("[3, 2, qty]");
    expect(parses(emitExpr(added))).toBe(true);
    const reordered: EExpr = { ...tree, elements: [...tree.elements].reverse() };
    expect(emitExpr(reordered)).toBe("[2, 3]");
    const removed: EExpr = { ...tree, elements: tree.elements.slice(1) };
    expect(emitExpr(removed)).toBe("[2]");
    expect(parses(emitExpr(removed))).toBe(true);
  });
});

describe("expression editor — template strings", () => {
  it("structures a no-hole template as one literal segment (TEMPLATE_FULL)", () => {
    const tree = roundTrips("`hello world`", "template");
    if (tree.kind !== "template") throw new Error("expected a template");
    expect(tree.segments).toEqual(["hello world"]);
    expect(tree.holes).toEqual([]);
  });

  it("structures a one-hole template as segment / hole / segment (START + END)", () => {
    const tree = roundTrips("`Order {qty} placed`", "template");
    if (tree.kind !== "template") throw new Error("expected a template");
    expect(tree.segments).toEqual(["Order ", " placed"]);
    expect(tree.holes).toEqual([{ kind: "raw", text: "qty" }]);
  });

  it("structures a multi-hole template (START + MIDDLE + END), N+1 segments for N holes", () => {
    const tree = roundTrips("`a{qty}b{other}c`", "template");
    if (tree.kind !== "template") throw new Error("expected a template");
    expect(tree.segments).toEqual(["a", "b", "c"]);
    expect(tree.holes).toHaveLength(2);
    expect(tree.segments.length).toBe(tree.holes.length + 1);
  });

  it("re-escapes literal braces and backticks in the text segments", () => {
    const tree = roundTrips("`a \\{b\\} c \\` d`", "template");
    if (tree.kind !== "template") throw new Error("expected a template");
    // Segments are held UNESCAPED (the TEMPLATE_* value converter resolves
    // `\.`); the escape is re-applied on emit.
    expect(tree.segments).toEqual(["a {b} c ` d"]);
  });

  it("structures a nested expression inside a hole", () => {
    const tree = roundTrips("`total {order.total.amount + 1}`", "template");
    if (tree.kind !== "template") throw new Error("expected a template");
    expect(tree.holes[0]).toMatchObject({ kind: "binary", op: "+" });
  });

  it("nests a template inside a hole (the lexer's interpolation mode)", () => {
    roundTrips("`outer {`inner {qty}`}`", "template");
  });

  it("adds a trailing hole and keeps the source parseable", () => {
    const tree = seed("`Order `");
    if (tree.kind !== "template") throw new Error("expected a template");
    const next = addTemplateHole(tree, { kind: "raw", text: "qty" });
    if (next.kind !== "template") throw new Error("expected a template");
    expect(next.segments).toEqual(["Order ", ""]);
    expect(emitExpr(next)).toBe("`Order {qty}`");
    expect(parses(emitExpr(next))).toBe(true);
  });

  it("removes a hole by splicing its surrounding segments back together", () => {
    const tree = seed("`a{qty}b{other}c`");
    if (tree.kind !== "template") throw new Error("expected a template");
    const next = removeTemplateHole(tree, 0);
    if (next.kind !== "template") throw new Error("expected a template");
    expect(next.segments).toEqual(["ab", "c"]);
    expect(emitExpr(next)).toBe("`ab{other}c`");
    expect(parses(emitExpr(next))).toBe(true);
  });

  it("re-typing a hole emits parseable source", () => {
    const tree = seed("`Order {qty} placed`");
    if (tree.kind !== "template") throw new Error("expected a template");
    const edited: EExpr = {
      ...tree,
      holes: [
        {
          kind: "member",
          receiver: { kind: "raw", text: "order" },
          member: "id",
          call: false,
          args: [],
        },
      ],
    };
    expect(emitExpr(edited)).toBe("`Order {order.id} placed`");
    expect(parses(emitExpr(edited))).toBe(true);
  });

  it("editing a text segment emits parseable, re-escaped source", () => {
    const tree = seed("`Order {qty}!`");
    if (tree.kind !== "template") throw new Error("expected a template");
    const edited: EExpr = { ...tree, segments: ["Order #", " {done}"] };
    expect(emitExpr(edited)).toBe("`Order #{qty} \\{done\\}`");
    expect(parses(emitExpr(edited))).toBe(true);
    // …and the edit survives a re-parse unchanged.
    expect(seed(emitExpr(edited))).toEqual(edited);
  });
});

describe("expression editor — money literals", () => {
  it("structures the string amount and round-trips", () => {
    const tree = roundTrips('money("10.50")', "money");
    if (tree.kind !== "money") throw new Error("expected a money literal");
    expect(tree.amount).toBe("10.50");
  });

  it("re-quotes an edited amount", () => {
    const tree = seed('money("10.50")');
    if (tree.kind !== "money") throw new Error("expected a money literal");
    const edited: EExpr = { ...tree, amount: "0.01" };
    expect(emitExpr(edited)).toBe('money("0.01")');
    expect(parses(emitExpr(edited))).toBe(true);
  });
});

describe("expression editor — now()", () => {
  it("structures as a leaf chip and round-trips", () => {
    expect(roundTrips("now()", "now")).toEqual({ kind: "now" });
  });

  it("structures inside a larger tree", () => {
    const tree = roundTrips("placedAt < now()", "binary");
    if (tree.kind !== "binary") throw new Error("expected a binary");
    expect(tree.right).toEqual({ kind: "now" });
  });
});

describe("expression editor — primitive conversions", () => {
  it("structures target + inner expression for every target", () => {
    for (const target of ["string", "long", "decimal", "money"] as const) {
      const tree = roundTrips(`${target}(qty)`, "convert");
      if (tree.kind !== "convert") throw new Error("expected a conversion");
      expect(tree.target).toBe(target);
      expect(tree.inner).toEqual({ kind: "raw", text: "qty" });
    }
  });

  it("wraps a member chain as the inner slot", () => {
    const tree = roundTrips("string(order.total.amount)", "convert");
    if (tree.kind !== "convert") throw new Error("expected a conversion");
    expect(tree.inner).toMatchObject({ kind: "member", member: "amount" });
  });

  it("composes with string concatenation (the canonical use)", () => {
    const tree = roundTrips('"qty: " + string(qty)', "binary");
    if (tree.kind !== "binary") throw new Error("expected a binary");
    expect(tree.right).toMatchObject({ kind: "convert", target: "string" });
  });

  it("re-targeting and re-typing the inner slot emits parseable source", () => {
    const tree = seed("string(qty)");
    if (tree.kind !== "convert") throw new Error("expected a conversion");
    const edited: EExpr = { ...tree, target: "decimal", inner: { kind: "raw", text: "price" } };
    expect(emitExpr(edited)).toBe("decimal(price)");
    expect(parses(emitExpr(edited))).toBe(true);
  });

  it('keeps `money("…")` (string argument) as the money literal, not a conversion', () => {
    // MoneyLit wins the parse over PrimitiveConversion for a string argument.
    expect(seed('money("1.00")').kind).toBe("money");
    expect(seed("money(price)").kind).toBe("convert");
  });
});

describe("expression editor — insert menu", () => {
  it("offers the five new forms", () => {
    const ids = NEW_EXPR_FORMS.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["list", "template", "money", "now", "convert"]));
  });

  it("every offered form seeds a blank whose emitted source parses", () => {
    for (const form of NEW_EXPR_FORMS) {
      const src = emitExpr(form.make());
      expect(parses(src), `${form.id} → ${src}`).toBe(true);
    }
  });

  it("a blank slot is the `null` literal (parseable until edited)", () => {
    expect(emitExpr(blankExpr())).toBe("null");
  });
});
