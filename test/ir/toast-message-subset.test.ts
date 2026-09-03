// `loom.toast-message-unsupported` — an `on <chan>.<Event>(e) { toast(<expr>) }`
// message expression outside the v1 subset every realtime renderer implements.
//
// THE SILENT CRASH.  The AST validator (`checkUiNotification`,
// `src/language/validators/ui.ts`) bounds the handler STATEMENT vocabulary —
// `toast(<one expression>)` / `refetch(<Agg>…)` — but accepts ANY expression
// inside the `toast(…)`.  All three renderers then implement the same narrow v1
// subset and `throw` a raw `Error` on anything else:
//
//   src/generator/_frontend/realtime.ts       `renderMessageExpr`      (React/Vue/Svelte/Angular)
//   src/generator/feliz/realtime.ts           `renderFsToastMessage`   (Feliz)
//   src/generator/elixir/realtime-liveview.ts `renderMessageExprElixir` (LiveView)
//
// So `toast(e.order.id)` parsed, validated, and then aborted `ddd generate
// system` with a stack trace and no `loom.*` code.  Measured on this HEAD for
// all three (the `renders … today` / `crashes codegen today` halves below).
//
// The gate is target-agnostic because the three `switch`es are arm-for-arm
// identical — literal / the event binding / SINGLE-LEVEL member off it / paren /
// binary — which is asserted here rather than assumed: `OUT_OF_SUBSET` is run
// through the JS and Feliz emitters end-to-end, and through the LiveView
// renderer directly.

import { describe, expect, it } from "vitest";
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

/** The v1 subset — every renderer emits these. */
const IN_SUBSET: ReadonlyArray<{ label: string; toast: string }> = [
  { label: "a string literal", toast: `toast("an order was placed")` },
  { label: "a non-string literal", toast: `toast(42)` },
  { label: "the bare event binding", toast: `toast(e)` },
  { label: "single-level member off the binding", toast: `toast(e.order)` },
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
    label: "two-level member access",
    toast: `toast(e.order.id)`,
    detail: /SINGLE-LEVEL member access/,
    elixirProbe: {
      kind: "member",
      receiver: { kind: "member", receiver: { kind: "ref", name: "e" }, member: "order" },
      member: "id",
    } as ExprIR,
  },
  {
    label: "a method call on the binding",
    toast: `toast(e.order.toUpper())`,
    detail: /`method-call` expression|SINGLE-LEVEL member access/,
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
    label: "a name that is not the event binding",
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

describe("loom.toast-message-unsupported", () => {
  describe("the v1 subset stays accepted", () => {
    for (const { label, toast } of IN_SUBSET) {
      it(`${label} validates clean`, async () => {
        expect(await codesOf(sys(toast, "static"))).not.toContain(CODE);
      });
      it(`${label} renders on the JS and Feliz emitters today`, async () => {
        await expect(generateSystemFiles(sys(toast, "static"))).resolves.toBeInstanceOf(Map);
        await expect(generateSystemFiles(sys(toast, "feliz"))).resolves.toBeInstanceOf(Map);
      }, 120_000);
    }
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

      // The other half of the trade: without the gate this is not a
      // degradation, it is an ABORT.  Both SPA renderers are exercised
      // end-to-end; the LiveView one directly (it has no SPA deployable).
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
      }, 120_000);
    }

    for (const { label, elixirProbe } of OUT_OF_SUBSET) {
      it(`${label} also throws in the LiveView renderer (same subset, three emitters)`, () => {
        expect(() => renderMessageExprElixir(elixirProbe, "e")).toThrow(/realtime handle_info: /);
      });
    }
  });

  it("the gate is target-agnostic — it fires on a Feliz host too", async () => {
    expect(await codesOf(sys(`toast(e.order.id)`, "feliz"))).toContain(CODE);
  });

  it("a refetch-only handler is untouched", async () => {
    expect(await codesOf(sys(`refetch(Order)`, "static"))).not.toContain(CODE);
  });
});
