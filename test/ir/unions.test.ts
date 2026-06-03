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
    aggregate Order ids guid { code: string }
    aggregate Cancel ids guid { reason: string }
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

describe("unions — P4a not-implemented emission gate", () => {
  const gate = async (ret: string): Promise<string[]> => {
    const { model } = await parseString(REPO(ret), { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.code === "loom.union-unsupported")
      .map((d) => d.message);
  };

  it("fires on an anonymous-union find return", async () => {
    expect((await gate("Order or Cancel")).length).toBeGreaterThan(0);
  });

  it("fires on an `option` find return (option lowers to a union)", async () => {
    expect((await gate("Order option")).length).toBeGreaterThan(0);
  });

  it("does not fire when no union is used", async () => {
    expect(await gate("Order[]")).toEqual([]);
  });
});
