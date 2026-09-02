// `loom.toast-message-unsupported` — an `on <chan>.<Event>(e) { toast(<expr>) }`
// message expression outside the subset every realtime renderer implements.
//
// THE SILENT CRASH.  The AST validator (`checkUiNotification`,
// `src/language/validators/ui.ts`) bounds the handler STATEMENT vocabulary —
// `toast(<one expression>)` / `refetch(<Agg>…)` — but accepts ANY expression
// inside the `toast(…)`.  All FOUR renderers then implement the same narrow
// subset and `throw` a raw `Error` on anything else:
//
//   src/generator/_frontend/realtime.ts       `renderMessageExpr`       (React/Vue/Svelte/Angular)
//   src/generator/feliz/realtime.ts           `renderFsToastMessage`    (Feliz)
//   src/generator/elixir/realtime-liveview.ts `renderMessageExprElixir` (LiveView)
//   src/generator/flutter/realtime.ts         `renderDartToastMessage`  (Flutter)
//
// So `toast(string(e.at))` parses, validates, and then aborts `ddd generate
// system` with a stack trace and no `loom.*` code.  That half is still asserted
// below (`crashes codegen today`) — it is the whole property the gate exists
// for, and it must survive every widening of the subset.
//
// The gate is target-agnostic because the four `switch`es are arm-for-arm
// identical — literal / the event binding / a MULTI-LEVEL member chain off it /
// paren / binary — which is asserted here rather than assumed: `OUT_OF_SUBSET`
// is run through the JS, Feliz and Flutter emitters end-to-end, and through the
// LiveView renderer directly.
//
// MULTI-LEVEL MEMBER (2026-09-02).  `e.id` rendering while `e.order.id` crashed
// was arbitrary from the author's side.  The renderers were widened FIRST and
// the gate relaxed SECOND; `renders the same chain on every target` pins the
// exact per-target emission, including what a chain through a NULL link does —
// the empty string on all four.

import { describe, expect, it } from "vitest";
import { toastMemberPath } from "../../src/generator/_frontend/realtime.js";
import { renderMessageExprElixir } from "../../src/generator/elixir/realtime-liveview.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { ExprIR } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFiles, generateSystemFilesUnchecked } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.toast-message-unsupported";

const sys = (toast: string, platform: string) => `
system RtShop {
  subdomain Shipping {
    context Fulfillment {
      aggregate Order { customerId: string  status: string  total: int }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
    }
  }
  storage primary { type: postgres }
  resource st { for: Fulfillment, kind: state, use: primary }
  api FulfillmentApi from Shipping
  ui WebApp with scaffold(subdomains: [Shipping]) {
    api Fulfillment: FulfillmentApi
    channel Live: Fulfillment.Lifecycle
    on Live.OrderPlaced(e) { ${toast} }
  }
  deployable backend {
    platform: node
    contexts: [Fulfillment]
    serves: FulfillmentApi
    dataSources: [st]
    port: 3000
  }
  deployable webApp { platform: ${platform}  targets: backend  ui: WebApp { Fulfillment: backend }  port: 3001 }
}`;

/** The subset — every renderer emits these. */
const IN_SUBSET: ReadonlyArray<{ label: string; toast: string }> = [
  { label: "a string literal", toast: `toast("an order was placed")` },
  { label: "a non-string literal", toast: `toast(42)` },
  { label: "the bare event binding", toast: `toast(e)` },
  { label: "single-level member off the binding", toast: `toast(e.order)` },
  { label: "MULTI-LEVEL member off the binding", toast: `toast(e.order.id)` },
  {
    label: "a multi-level chain inside a concatenation",
    toast: `toast("Order " + e.order.id + " placed")`,
  },
  { label: "binary concatenation of both", toast: `toast("Order " + e.order + " placed")` },
  { label: "parenthesised", toast: `toast(("x" + e.order))` },
];

/** Outside the subset — every renderer throws.  `elixirProbe` is the same
 *  shape hand-built as IR, so the LiveView renderer can be exercised directly
 *  (it has no SPA deployable to generate through). */
const OUT_OF_SUBSET: ReadonlyArray<{
  label: string;
  toast: string;
  detail: RegExp;
  elixirProbe: ExprIR;
}> = [
  {
    label: "a method call on the binding",
    toast: `toast(e.order.toUpper())`,
    detail: /`method-call` expression/,
    elixirProbe: {
      kind: "method-call",
      receiver: { kind: "ref", name: "e" },
      member: "toUpper",
      args: [],
    } as ExprIR,
  },
  {
    label: "a cast/conversion call",
    toast: `toast(string(e.at))`,
    detail: /`convert` expression/,
    elixirProbe: {
      kind: "convert",
      to: { kind: "primitive", name: "string" },
      value: { kind: "ref", name: "e" },
    } as ExprIR,
  },
  {
    label: "a ternary",
    toast: `toast(true ? "a" : "b")`,
    detail: /`ternary` expression/,
    elixirProbe: {
      kind: "ternary",
      cond: { kind: "literal", lit: "bool", value: "true" },
      // biome-ignore lint/suspicious/noThenProperty: `then` is the IR ternary's branch field, not a thenable.
      then: { kind: "literal", lit: "string", value: "a" },
      else: { kind: "literal", lit: "string", value: "b" },
    } as ExprIR,
  },
  {
    label: "a chain rooted at a name that is not the event binding",
    toast: `toast(currentUser.email)`,
    detail: /member access off the event binding 'e' only/,
    elixirProbe: {
      kind: "member",
      receiver: { kind: "ref", name: "currentUser" },
      member: "email",
    } as ExprIR,
  },
];

const diagsOf = async (src: string) => {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`unexpected AST errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
};
const codesOf = async (src: string) => (await diagsOf(src)).map((d) => d.code);

const oneLine = (files: Map<string, string>, needle: string): string => {
  for (const c of files.values())
    for (const l of c.split("\n")) if (l.includes(needle)) return l.trim();
  throw new Error(`no emitted line containing ${JSON.stringify(needle)}`);
};

describe("loom.toast-message-unsupported", () => {
  describe("the subset stays accepted", () => {
    for (const { label, toast } of IN_SUBSET) {
      it(`${label} validates clean`, async () => {
        expect(await codesOf(sys(toast, "static"))).not.toContain(CODE);
      });
      it(`${label} renders on the JS, Feliz and Flutter emitters today`, async () => {
        await expect(generateSystemFiles(sys(toast, "static"))).resolves.toBeInstanceOf(Map);
        await expect(generateSystemFiles(sys(toast, "feliz"))).resolves.toBeInstanceOf(Map);
        await expect(generateSystemFiles(sys(toast, "flutter"))).resolves.toBeInstanceOf(Map);
      }, 180_000);
    }
  });

  // The renderers-first half of the multi-level widening, pinned per target.
  //
  // A CHAIN THROUGH A NULL LINK renders as the EMPTY STRING on all four — the
  // one cross-target contract, spelled four different ways because each target
  // needs a different guard:
  //   JS      `?.` on every hop past the first, then `?? ""`
  //   Feliz   the `toastField` Emit helper — Fable's `?` compiles to `a.b.c`
  //           and THROWS on an absent link, so it cannot serve here
  //   Flutter the null-aware index `?[]`, then `?? ''`
  //   Elixir  an `&&` guard per hop (a struct has no `Access`, and `nil.id`
  //           RAISES); `to_string(nil)` is `""`
  describe("renders the same chain on every target", () => {
    it("React/Vue/Svelte/Angular — optional chain + empty-string fallback", async () => {
      const f = await generateSystemFiles(sys(`toast("Order " + e.order.id)`, "static"));
      expect(oneLine(f, "String(event")).toContain(`"Order " + String(event.order?.id ?? "")`);
    }, 180_000);

    it("Feliz — the toastField helper, declared once and called with the path", async () => {
      const f = await generateSystemFiles(sys(`toast("Order " + e.order.id)`, "feliz"));
      expect(oneLine(f, `showToast ("Order`)).toContain(
        `showToast ("Order " + (toastField payload [| "order"; "id" |]))`,
      );
      // The helper is emitted, and its JS body short-circuits to '' on a null
      // link — the reason Fable's `?` operator is not used for the chain.
      expect(oneLine(f, "let private toastField")).toContain(
        "let private toastField (payload: obj) (path: string array) : string = jsNative",
      );
      expect(oneLine(f, "if(c==null)return")).toContain("if(c==null)return '';c=c[p[i]];");
    }, 180_000);

    it("Flutter — null-aware index + empty-string fallback", async () => {
      const f = await generateSystemFiles(sys(`toast("Order " + e.order.id)`, "flutter"));
      expect(oneLine(f, "_toast('Order")).toContain(
        `_toast('Order ' + '\${payload['order']?['id'] ?? ''}');`,
      );
    }, 180_000);

    it("LiveView — an `&&` nil guard per hop past the first", () => {
      const chain = (...ms: string[]): ExprIR =>
        ms.reduce<ExprIR>((r, member) => ({ kind: "member", receiver: r, member }) as ExprIR, {
          kind: "ref",
          name: "e",
        } as ExprIR);
      expect(renderMessageExprElixir(chain("order", "id"), "e")).toBe(
        "to_string(e.order && e.order.id)",
      );
      expect(renderMessageExprElixir(chain("order", "lineItem", "id"), "e")).toBe(
        "to_string(e.order && e.order.line_item && e.order.line_item.id)",
      );
      // Depth 1 is unchanged — the binding itself is always bound, so it needs
      // no guard and the pre-widening emission stands byte for byte.
      expect(renderMessageExprElixir(chain("orderId"), "e")).toBe("to_string(e.order_id)");
    });
  });

  // `toastMemberPath` is THE definition of "a toast member chain" — all four
  // renderers call it, so the shape they accept cannot drift apart per target.
  describe("toastMemberPath — the one shared chain definition", () => {
    const ref = (name: string): ExprIR => ({ kind: "ref", name }) as ExprIR;
    const dot = (receiver: ExprIR, member: string): ExprIR =>
      ({ kind: "member", receiver, member }) as ExprIR;

    it("flattens a chain rooted at the binding, outermost last", () => {
      expect(toastMemberPath(dot(ref("e"), "id"), "e")).toEqual(["id"]);
      expect(toastMemberPath(dot(dot(ref("e"), "order"), "id"), "e")).toEqual(["order", "id"]);
      expect(toastMemberPath(dot(dot(dot(ref("e"), "a"), "b"), "c"), "e")).toEqual(["a", "b", "c"]);
    });

    it("refuses a chain rooted at anything else", () => {
      expect(toastMemberPath(dot(ref("currentUser"), "email"), "e")).toBeUndefined();
      // A parenthesised root: no renderer has a receiver to walk down from.
      expect(
        toastMemberPath(dot({ kind: "paren", inner: ref("e") } as ExprIR, "id"), "e"),
      ).toBeUndefined();
    });
  });

  describe("outside the subset the gate fires", () => {
    for (const { label, toast, detail } of OUT_OF_SUBSET) {
      it(`${label} is rejected`, async () => {
        const diags = await diagsOf(sys(toast, "static"));
        const mine = diags.filter((d) => d.code === CODE);
        expect(
          mine.map((d) => d.message),
          `expected ${CODE} for \`${toast}\``,
        ).not.toEqual([]);
        expect(mine[0]!.severity).toBe("error");
        expect(mine.some((d) => detail.test(d.message))).toBe(true);
        // The handler is named, so the diagnostic points at a source construct.
        // It lives in `source` (the CLI prints `${code} ${source}: …`); the
        // message must not repeat it — see F2-FFE-9.
        expect(mine[0]!.source).toContain("`on Live.OrderPlaced` handler");
      });

      // The other half of the trade, and the property the whole gate exists
      // for: without it this is not a degradation, it is an ABORT with a raw
      // Error and no `loom.*` code.  Widening the subset must never move a
      // shape out of the gate's reach while a renderer still throws on it.
      it(`${label} crashes codegen today (which is what the gate replaces)`, async () => {
        // The unchecked helper: the fixture is rejected by the gate under test
        // on purpose, and the CRASH the gate replaces is the subject — the
        // checked helper would throw its phase-⑦ refusal before codegen runs.
        const why =
          "this leg proves the raw codegen abort loom.toast-message-unsupported replaces; the gate rejects the model by design";
        await expect(generateSystemFilesUnchecked(sys(toast, "static"), why)).rejects.toThrow(
          /RealtimeHandlers: /,
        );
        await expect(generateSystemFilesUnchecked(sys(toast, "feliz"), why)).rejects.toThrow(
          /Feliz realtime: /,
        );
        await expect(generateSystemFilesUnchecked(sys(toast, "flutter"), why)).rejects.toThrow(
          /Flutter realtime: /,
        );
      }, 240_000);
    }

    for (const { label, elixirProbe } of OUT_OF_SUBSET) {
      it(`${label} also throws in the LiveView renderer (same subset, four emitters)`, () => {
        expect(() => renderMessageExprElixir(elixirProbe, "e")).toThrow(/realtime handle_info: /);
      });
    }
  });

  // THE property the gate exists for, asserted from the user's side rather
  // than the validator's: an out-of-subset message must come back as the
  // `loom.*` diagnostic, NOT as the renderer's raw `Error`.  Disabling the gate
  // makes this fail with `RealtimeHandlers: unsupported expression kind
  // 'convert' in toast message.` — the original silent crash, verbatim.
  it("an out-of-subset message reaches the user as a diagnostic, never a raw throw", async () => {
    await expect(generateSystemFiles(sys(`toast(string(e.at))`, "static"))).rejects.toThrow(
      /loom\.toast-message-unsupported/,
    );
  }, 180_000);

  it("the gate is target-agnostic — it fires on a Feliz host too", async () => {
    expect(await codesOf(sys(`toast(string(e.at))`, "feliz"))).toContain(CODE);
  });

  it("a refetch-only handler is untouched", async () => {
    expect(await codesOf(sys(`refetch(Order)`, "static"))).not.toContain(CODE);
  });
});
