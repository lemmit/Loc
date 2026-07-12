// Discriminated unions (payload-transport-layer.md, P4a) — IR side.
//
// Covers lowering both union surfaces (anonymous `A or B`; named
// `payload Foo = A | B`) and the `option` carrier (`T option` → `union[T,
// none]`) to a `union` TypeIR, the canonicalization / structural-key helpers,
// and the P4a not-implemented emission gate that blocks unions until P4b–d.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { canonicalUnion, typeKey } from "../../src/ir/stdlib/unions.js";
import type { PayloadIR, TypeIR } from "../../src/ir/types/loom-ir.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** Lower (link-free, validation-skipped) and return the single find's return
 *  type in context `C`. */
async function findReturn(src: string): Promise<TypeIR> {
  const { model } = await parseString(src, { validate: false });
  const ctx = allContexts(lowerModel(model)).find((c) => c.name === "C")!;
  return ctx.repositories[0]!.finds[0]!.returnType;
}

/** Lower + enrich and return a context's payloads. */
async function payloadsOf(src: string, ctxName: string): Promise<PayloadIR[]> {
  const { model } = await parseString(src, { validate: false });
  const enriched = enrichLoomModel(lowerModel(model));
  return allContexts(enriched).find((c) => c.name === ctxName)!.payloads;
}

const REPO = (ret: string): string => `
  context C {
    aggregate Order { code: string }
    aggregate Cancel { reason: string }
    repository Orders for Order { find f(): ${ret} }
  }
`;

describe("unions — lowering (P4a)", () => {
  it("lowers `A or B` to a union TypeIR over the two entities", async () => {
    const t = await findReturn(REPO("Order or Cancel"));
    expect(t).toEqual({
      kind: "union",
      variants: [
        { kind: "entity", name: "Order" },
        { kind: "entity", name: "Cancel" },
      ],
    });
  });

  it("lowers `T option` to `union[T, none]`", async () => {
    const t = await findReturn(REPO("Order option"));
    expect(t).toEqual({
      kind: "union",
      variants: [{ kind: "entity", name: "Order" }, { kind: "none" }],
    });
  });

  it("flattens nested unions left-to-right — `string or int option` is `union[string, int, none]`", async () => {
    const t = await findReturn(REPO("string or int option"));
    expect(t).toEqual({
      kind: "union",
      variants: [
        { kind: "primitive", name: "string" },
        { kind: "primitive", name: "int" },
        { kind: "none" },
      ],
    });
  });

  it("does not dedupe duplicate variants at lowering (left for the validator)", async () => {
    const t = await findReturn(REPO("Order or Order"));
    expect(t.kind).toBe("union");
    expect((t as { variants: TypeIR[] }).variants).toHaveLength(2);
  });
});

describe("unions — named `payload Foo = A | B` (P4a)", () => {
  it("lowers a named union into PayloadIR.variants with empty fields", async () => {
    const payloads = await payloadsOf(
      `system S { subdomain D { context C {
         payload OrderEvent = OrderPlaced | OrderCancelled
         event OrderPlaced { ts: datetime }
         event OrderCancelled { ts: datetime }
       } } }`,
      "C",
    );
    const u = payloads.find((p) => p.name === "OrderEvent")!;
    expect(u.variants).toEqual([
      { kind: "entity", name: "OrderPlaced" },
      { kind: "entity", name: "OrderCancelled" },
    ]);
    expect(u.fields).toHaveLength(0);
  });
});

describe("unions — monomorphization (P4b)", () => {
  it("synthesizes a named payload for an anonymous `A or B` find return", async () => {
    const payloads = await payloadsOf(
      `system S { subdomain D { context C {
         aggregate Order { code: string }
         aggregate Cancel { reason: string }
         repository Orders for Order { find f(): Order or Cancel }
       } } }`,
      "C",
    );
    const u = payloads.find((p) => p.name === "OrderOrCancel");
    expect(u).toBeDefined();
    expect(u!.synthesized).toBe(true);
    expect(u!.variants).toEqual([
      { kind: "entity", name: "Order" },
      { kind: "entity", name: "Cancel" },
    ]);
  });

  it("does not re-synthesize a named union (`payload Foo = …` keeps its name)", async () => {
    const payloads = await payloadsOf(
      `system S { subdomain D { context C {
         payload OrderEvent = OrderPlaced | OrderCancelled
         event OrderPlaced { ts: datetime }
         event OrderCancelled { ts: datetime }
       } } }`,
      "C",
    );
    expect(payloads.filter((p) => p.name === "OrderEvent")).toHaveLength(1);
    // No anonymous-union payload (`OrderPlacedOrOrderCancelled`) synthesized —
    // the named union already covers the shape.
    expect(payloads.some((p) => p.name === "OrderPlacedOrOrderCancelled")).toBe(false);
  });

  it("dedupes a repeated anonymous union into one payload", async () => {
    const payloads = await payloadsOf(
      `system S { subdomain D { context C {
         aggregate Order { code: string }
         aggregate Cancel { reason: string }
         repository Orders for Order { find a(): Order or Cancel  find b(): Order or Cancel }
       } } }`,
      "C",
    );
    expect(payloads.filter((p) => p.name === "OrderOrCancel")).toHaveLength(1);
  });
});

describe("unions — stdlib helpers (P4a)", () => {
  it("typeKey is associative-commutative — `A or B` keys equal `B or A`", () => {
    const a: TypeIR = { kind: "entity", name: "A" };
    const b: TypeIR = { kind: "entity", name: "B" };
    expect(typeKey({ kind: "union", variants: [a, b] })).toBe(
      typeKey({ kind: "union", variants: [b, a] }),
    );
  });

  it("canonicalUnion flattens a nested union into the parent", () => {
    const inner: TypeIR = {
      kind: "union",
      variants: [{ kind: "primitive", name: "int" }, { kind: "none" }],
    };
    const out = canonicalUnion([{ kind: "primitive", name: "string" }, inner]);
    expect(out).toEqual({
      kind: "union",
      variants: [
        { kind: "primitive", name: "string" },
        { kind: "primitive", name: "int" },
        { kind: "none" },
      ],
    });
  });
});

describe("unions — platform-aware emission gate (P4b)", () => {
  // A union find served by the named backend platform.  P4b emits unions on
  // hono (`node`); .NET / Phoenix stay gated until P4c / P4d.
  const sysWith = (platform: string, ret: string): string => `
    system Shop {
      subdomain Sales {
        context Shop {
          aggregate Order { code: string }
          aggregate Cancel { reason: string }
          repository Orders for Order { find f(): ${ret} }
        }
      }
      storage pg { type: postgres }
      resource shopState { for: Shop, kind: state, use: pg }
      deployable api { platform: ${platform}, contexts: [Shop], dataSources: [shopState], port: 4000 }
    }`;

  const gate = async (platform: string, ret: string): Promise<string[]> => {
    const { model } = await parseString(sysWith(platform, ret), { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.code === "loom.union-unsupported")
      .map((d) => d.message);
  };

  it("does NOT gate a union find served by hono (emission implemented in P4b)", async () => {
    expect(await gate("node", "Order or Cancel")).toEqual([]);
  });

  it("does NOT gate an `option` find served by hono", async () => {
    expect(await gate("node", "Order option")).toEqual([]);
  });

  it("does NOT gate a union find served by dotnet (emission implemented in P4c)", async () => {
    expect(await gate("dotnet", "Order or Cancel")).toEqual([]);
  });

  it("does NOT gate a union find served by phoenix (emission implemented in P4d)", async () => {
    expect(await gate("elixir", "Order or Cancel")).toEqual([]);
  });

  it("does not fire when no union is used (phoenix)", async () => {
    expect(await gate("elixir", "Order[]")).toEqual([]);
  });
});
