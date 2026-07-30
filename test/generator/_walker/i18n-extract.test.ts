// i18n user-visible-string extraction (M-T1.11, i18n.md Phase 1).
//
// `collectUiMessages` / `buildMessageCatalog` walk a UI's pages/components/menu
// and pull every plain string literal in a user-visible slot into a
// content-hash-keyed catalog entry.  These pin the two stability properties the
// key scheme (D-I18N-KEY) exists for — reorder-invariance and rephrase-rekey —
// plus role-in-key disambiguation and the dynamic-slot skip.

import { describe, expect, it } from "vitest";
import { collectUiMessages, icuFromConcat } from "../../../src/generator/_walker/i18n-extract.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";
import { buildMessageCatalog } from "../../../src/system/i18n-catalog.js";
import { parseString } from "../../_helpers/parse.js";

// Minimal ExprIR builders for direct `icuFromConcat` unit tests — a lowered
// backtick template is a left-assoc `binary "+"` chain of string literals
// interleaved with holes (see `lowerTemplateString`).
const str = { kind: "primitive", name: "string" } as const;
const lit = (value: string): ExprIR => ({ kind: "literal", lit: "string", value });
const ref = (name: string): ExprIR => ({ kind: "ref", name, refKind: "param" }) as ExprIR;
const member = (receiver: ExprIR, m: string): ExprIR => ({
  kind: "member",
  receiver,
  member: m,
  receiverType: str,
  memberType: str,
});
const plus = (left: ExprIR, right: ExprIR): ExprIR => ({
  kind: "binary",
  op: "+",
  left,
  right,
  leftType: str,
  resultType: str,
});
// The transparent i18n wrapper a formatted hole (`{total, number}`) lowers to —
// `icuFromConcat` peels it, splices `format` into the display + positional ICU
// text, and stores the peeled RAW value as the hole expr.
const i18n = (inner: ExprIR, format: string): ExprIR =>
  ({ kind: "i18nFormat", inner, format }) as ExprIR;

async function catalogOf(source: string): Promise<Record<string, string>> {
  const { model } = await parseString(source, { validate: false });
  return buildMessageCatalog(enrichLoomModel(lowerModel(model)).systems[0]!);
}

const wrap = (uiBody: string) => `
  system T {
    subdomain S {
      context S {
        aggregate Order with crudish { status: string }
        repository Orders for Order { }
      }
    }
    api SApi from S
    ui Web {
      api S: SApi
      ${uiBody}
    }
  }
`;

describe("i18n message extraction", () => {
  it("extracts user-visible literals under content-hash keys", async () => {
    const cat = await catalogOf(
      wrap(`page Home {
        route: "/"
        body: Stack { Heading { "Welcome" }, Text { "Browse orders" }, Empty { "Nothing here" } }
      }`),
    );
    const byMessage = Object.entries(cat);
    expect(byMessage).toContainEqual([expect.stringMatching(/^page\.Home\.heading\./), "Welcome"]);
    expect(byMessage).toContainEqual([
      expect.stringMatching(/^page\.Home\.text\./),
      "Browse orders",
    ]);
    expect(byMessage).toContainEqual([
      expect.stringMatching(/^page\.Home\.empty\./),
      "Nothing here",
    ]);
  });

  it("is reorder-invariant — sibling order does not change the catalog", async () => {
    const a = await catalogOf(
      wrap(`page P { route: "/" body: Stack { Heading { "One" }, Text { "Two" } } }`),
    );
    const b = await catalogOf(
      wrap(`page P { route: "/" body: Stack { Text { "Two" }, Heading { "One" } } }`),
    );
    expect(a).toEqual(b);
  });

  it("re-keys on a rephrase — old key drops, new key appears (delete-old + add-new)", async () => {
    const before = await catalogOf(wrap(`page P { route: "/" body: Heading { "Orders" } }`));
    const after = await catalogOf(wrap(`page P { route: "/" body: Heading { "Order list" } }`));
    const [beforeKey] = Object.keys(before);
    const [afterKey] = Object.keys(after);
    expect(before[beforeKey!]).toBe("Orders");
    expect(after[afterKey!]).toBe("Order list");
    expect(afterKey).not.toBe(beforeKey);
    expect(after).not.toHaveProperty(beforeKey!);
  });

  it("distinguishes the same string in different slots by role", async () => {
    const cat = await catalogOf(
      wrap(`page P { route: "/" body: Stack { Heading { "Orders" }, Text { "Orders" } } }`),
    );
    const keys = Object.keys(cat);
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.startsWith("page.P.heading."))).toBe(true);
    expect(keys.some((k) => k.startsWith("page.P.text."))).toBe(true);
    // Same string ⇒ the two keys share the trailing content hash.
    const hashes = keys.map((k) => k.split(".").pop());
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("skips dynamic slots — a non-literal text arg is not extracted", async () => {
    const cat = await catalogOf(
      wrap(`page Show(o: Order) { route: "/x/:id" body: Heading { o.status } }`),
    );
    expect(Object.keys(cat)).toHaveLength(0);
  });

  it("extracts the page title and menu chrome", async () => {
    const cat = await catalogOf(
      wrap(`page Home {
        route: "/"
        title: "Dashboard"
        body: Heading { "Hi" }
      }
      menu { section "Reports" { link Home } }`),
    );
    const messages = Object.values(cat);
    expect(messages).toContain("Dashboard");
    expect(messages).toContain("Reports");
    expect(Object.keys(cat).some((k) => k.startsWith("page.Home.title."))).toBe(true);
    expect(Object.keys(cat).some((k) => k.startsWith("menu.section."))).toBe(true);
  });

  it("collectUiMessages is deterministic and pure", async () => {
    const { model } = await parseString(
      wrap(`page P { route: "/" body: Stack { Heading { "A" }, Text { "B" } } }`),
      { validate: false },
    );
    const ui = enrichLoomModel(lowerModel(model)).systems[0]!.uis[0]!;
    expect(collectUiMessages(ui)).toEqual(collectUiMessages(ui));
  });
});

describe("icuFromConcat — interpolated-string detection (i18n-strings.md Option B)", () => {
  it("derives named display + positional hash + ordered holes", () => {
    // `Order {order.id}` → ["Order ", order.id]
    const icu = icuFromConcat(plus(lit("Order "), member(ref("order"), "id")));
    expect(icu).toEqual({
      display: "Order {id}", // dotted path → last segment
      positional: "Order {0}", // hash input — rename-stable
      holes: [{ name: "id", expr: member(ref("order"), "id") }],
    });
  });

  it("names bare refs by themselves and numbers holes positionally", () => {
    // `You have {count} of {total}` → ["You have ", count, " of ", total]
    const icu = icuFromConcat(
      plus(plus(plus(lit("You have "), ref("count")), lit(" of ")), ref("total")),
    );
    expect(icu?.display).toBe("You have {count} of {total}");
    expect(icu?.positional).toBe("You have {0} of {1}");
    expect(icu?.holes.map((h) => h.name)).toEqual(["count", "total"]);
  });

  it("dedups a repeated placeholder name with _2/_3 suffixes", () => {
    // `{a.id} vs {b.id}` → last segments collide on `id`
    const icu = icuFromConcat(
      plus(plus(member(ref("a"), "id"), lit(" vs ")), member(ref("b"), "id")),
    );
    expect(icu?.display).toBe("{id} vs {id_2}");
    expect(icu?.positional).toBe("{0} vs {1}"); // positions never collide
  });

  it("is rename-stable — the positional hash ignores which field fills the hole", () => {
    const a = icuFromConcat(plus(lit("Order "), member(ref("order"), "id")));
    const b = icuFromConcat(plus(lit("Order "), member(ref("order"), "number")));
    // Different display (translator-readable), identical hash input (stable key).
    expect(a?.display).not.toBe(b?.display);
    expect(a?.positional).toBe(b?.positional);
  });

  it("splices a `, number, ::currency/USD` format into both display + positional", () => {
    // `Total: {order.total, number, ::currency/USD}`
    const icu = icuFromConcat(
      plus(lit("Total: "), i18n(member(ref("order"), "total"), ", number, ::currency/USD")),
    );
    expect(icu).toEqual({
      display: "Total: {total, number, ::currency/USD}", // named + skeleton
      positional: "Total: {0, number, ::currency/USD}", // hash input carries the format
      // the stored expr is the PEELED raw value (a number), not the wrapper
      holes: [{ name: "total", expr: member(ref("order"), "total") }],
    });
  });

  it("D-I18N-KEY: a FORMAT change re-keys (positional differs)", () => {
    const currency = icuFromConcat(
      plus(lit("Total: "), i18n(member(ref("order"), "total"), ", number, ::currency/USD")),
    );
    const percent = icuFromConcat(
      plus(lit("Total: "), i18n(member(ref("order"), "total"), ", number, ::percent")),
    );
    // A different rendering IS a different message → different hash input.
    expect(currency?.positional).not.toBe(percent?.positional);
  });

  it("D-I18N-KEY: a field RENAME keeps the key (positional ignores the field)", () => {
    const a = icuFromConcat(
      plus(lit("Total: "), i18n(member(ref("order"), "total"), ", number, ::currency/USD")),
    );
    const b = icuFromConcat(
      plus(lit("Total: "), i18n(member(ref("order"), "amount"), ", number, ::currency/USD")),
    );
    // Different display (translator-readable), identical hash input (stable key).
    expect(a?.display).not.toBe(b?.display);
    expect(a?.positional).toBe(b?.positional);
  });

  it("returns undefined for a non-interpolation — no text, no holes, or plain literal", () => {
    expect(icuFromConcat(lit("Just text"))).toBeUndefined(); // not a chain
    expect(icuFromConcat(plus(lit("a"), lit("b")))).toBeUndefined(); // no hole
    // numeric `count + 1` (no string literal operand) is arithmetic, not a message
    const numeric: ExprIR = {
      kind: "binary",
      op: "+",
      left: ref("count"),
      right: { kind: "literal", lit: "int", value: "1" },
      resultType: { kind: "primitive", name: "int" },
    };
    expect(icuFromConcat(numeric)).toBeUndefined();
  });
});

describe("i18n message extraction — interpolated (ICU) entries", () => {
  const icuWrap = (uiBody: string) => `
    system T {
      subdomain S {
        context S {
          aggregate Order with crudish { status: string, ref: string }
          repository Orders for Order { }
        }
      }
      api SApi from S
      ui Web { api S: SApi; ${uiBody} }
    }
  `;

  it("extracts an interpolated template as a named-display catalog entry", async () => {
    const { model } = await parseString(
      icuWrap('page D(o: Order) { route: "/d/:id" body: Heading { `Order {o.status}` } }'),
      { validate: false },
    );
    const cat = buildMessageCatalog(enrichLoomModel(lowerModel(model)).systems[0]!);
    expect(Object.values(cat)).toContain("Order {status}"); // named display
    expect(Object.keys(cat).some((k) => k.startsWith("page.D.heading."))).toBe(true);
  });

  it("keys the ICU entry over the positional form — a field rename keeps the key", async () => {
    const keyOf = async (body: string) => {
      const { model } = await parseString(icuWrap(body), { validate: false });
      return Object.keys(buildMessageCatalog(enrichLoomModel(lowerModel(model)).systems[0]!))[0];
    };
    const a = await keyOf(
      'page D(o: Order) { route: "/d/:id" body: Heading { `Ref {o.status}` } }',
    );
    const b = await keyOf('page D(o: Order) { route: "/d/:id" body: Heading { `Ref {o.ref}` } }');
    expect(a).toBe(b); // same surrounding text ⇒ same key regardless of the field
  });
});
