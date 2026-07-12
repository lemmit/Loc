// Carrier-bounded generic payloads (payload-transport-layer.md, P3a) — IR
// side.  Covers lowering a postfix `paged` / `envelope` instantiation into a
// `genericInstance` TypeIR, the stdlib shape registry, and the P3a
// not-implemented gate that blocks emission until P3b.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import {
  GENERIC_SHAPES,
  genericInstanceName,
  genericShape,
  pagedReturn,
} from "../../src/ir/stdlib/generics.js";
import type { PayloadIR, TypeIR } from "../../src/ir/types/loom-ir.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** Enrich (link-free, validation-skipped) and return a context's payloads. */
async function payloadsOf(src: string, ctxName: string): Promise<PayloadIR[]> {
  const { model } = await parseString(src, { validate: false });
  const enriched = enrichLoomModel(lowerModel(model));
  const ctx = allContexts(enriched).find((c) => c.name === ctxName);
  if (!ctx) throw new Error(`context ${ctxName} not found`);
  return ctx.payloads;
}

/** Lower (link-free, validation-skipped) and return the named value object's
 *  field type — the gate is IR-level, so we deliberately bypass the Langium
 *  validation step that `parseValid` enforces. */
async function voFieldType(src: string, voName: string, field: string): Promise<TypeIR> {
  const { model } = await parseString(src, { validate: false });
  const loom = lowerModel(model);
  const vo = allContexts(loom)
    .flatMap((c) => c.valueObjects)
    .find((v) => v.name === voName);
  if (!vo) throw new Error(`value object ${voName} not found`);
  const f = vo.fields.find((x) => x.name === field);
  if (!f) throw new Error(`field ${field} not found on ${voName}`);
  return f.type;
}

describe("generics — lowering (P3a)", () => {
  it("lowers `string paged` to a genericInstance over a primitive", async () => {
    const t = await voFieldType(
      `context C { valueobject V { items: string paged } }`,
      "V",
      "items",
    );
    expect(t).toEqual({
      kind: "genericInstance",
      ctor: "paged",
      arg: { kind: "primitive", name: "string" },
    });
  });

  it("lowers `string envelope` to an envelope instance", async () => {
    const t = await voFieldType(`context C { valueobject V { e: string envelope } }`, "V", "e");
    expect(t).toMatchObject({ kind: "genericInstance", ctor: "envelope" });
  });

  it("keeps the array wrapper outside the carrier (`string paged[]`)", async () => {
    const t = await voFieldType(`context C { valueobject V { ps: string paged[] } }`, "V", "ps");
    expect(t.kind).toBe("array");
    expect((t as { element: TypeIR }).element).toMatchObject({
      kind: "genericInstance",
      ctor: "paged",
    });
  });

  it("folds chained constructors left-associatively (`string envelope paged`)", async () => {
    const t = await voFieldType(
      `context C { valueobject V { x: string envelope paged } }`,
      "V",
      "x",
    );
    // paged(envelope(string))
    expect(t).toMatchObject({
      kind: "genericInstance",
      ctor: "paged",
      arg: {
        kind: "genericInstance",
        ctor: "envelope",
        arg: { kind: "primitive", name: "string" },
      },
    });
  });
});

describe("generics — stdlib shape registry (P3a)", () => {
  it("paged → items/page/pageSize/total/totalPages (1-based offset shape)", () => {
    const fields = genericShape("paged").fields({ kind: "entity", name: "Customer" });
    expect(fields.map((f) => f.name)).toEqual(["items", "page", "pageSize", "total", "totalPages"]);
    // `items` carries an array of the type argument; the rest are ints.
    expect(fields[0]!.type).toEqual({
      kind: "array",
      element: { kind: "entity", name: "Customer" },
    });
    for (const f of fields.slice(1)) expect(f.type).toEqual({ kind: "primitive", name: "int" });
  });

  it("envelope → id/ts/body with the argument in `body`", () => {
    const fields = genericShape("envelope").fields({ kind: "primitive", name: "string" });
    expect(fields.map((f) => f.name)).toEqual(["id", "ts", "body"]);
    expect(fields[2]!.type).toEqual({ kind: "primitive", name: "string" });
  });

  it("exposes exactly the blessed closed set", () => {
    expect(Object.keys(GENERIC_SHAPES).sort()).toEqual(["envelope", "paged"]);
  });
});

describe("generics — naming (P3b)", () => {
  it("names instances <ArgName><Ctor>", () => {
    expect(genericInstanceName("paged", { kind: "primitive", name: "string" })).toBe("StringPaged");
    expect(
      genericInstanceName("paged", { kind: "id", targetName: "Order", valueType: "guid" }),
    ).toBe("OrderIdPaged");
    expect(genericInstanceName("envelope", { kind: "entity", name: "OrderPlaced" })).toBe(
      "OrderPlacedEnvelope",
    );
  });
});

describe("generics — pagedReturn helper (P3b)", () => {
  it("recognises a top-level paged return and names the payload", () => {
    expect(
      pagedReturn({
        kind: "genericInstance",
        ctor: "paged",
        arg: { kind: "entity", name: "Order" },
      }),
    ).toEqual({ arg: { kind: "entity", name: "Order" }, name: "OrderPaged" });
  });

  it("returns null for non-paged types", () => {
    expect(pagedReturn({ kind: "array", element: { kind: "entity", name: "Order" } })).toBeNull();
    expect(
      pagedReturn({
        kind: "genericInstance",
        ctor: "envelope",
        arg: { kind: "primitive", name: "string" },
      }),
    ).toBeNull();
  });
});

describe("generics — monomorphization (P3b)", () => {
  it("synthesizes a named payload for `string paged` from a field type", async () => {
    const payloads = await payloadsOf(
      `system S { subdomain D { context C { valueobject V { items: string paged } } } }`,
      "C",
    );
    const sp = payloads.find((p) => p.name === "StringPaged");
    expect(sp).toBeDefined();
    expect(sp!.synthesized).toBe(true);
    expect(sp!.kind).toBe("payload");
    expect(sp!.fields.map((f) => f.name)).toEqual([
      "items",
      "page",
      "pageSize",
      "total",
      "totalPages",
    ]);
    expect(sp!.fields[0]!.type).toEqual({
      kind: "array",
      element: { kind: "primitive", name: "string" },
    });
  });

  it("synthesizes from a repository find return", async () => {
    const payloads = await payloadsOf(
      `system S { subdomain D { context C {
         aggregate Order { ref: string }
         repository Orders for Order { find recent(): Order id paged }
       } } }`,
      "C",
    );
    expect(payloads.some((p) => p.name === "OrderIdPaged")).toBe(true);
  });

  it("marks monomorphized payloads with their generic origin (ctor + arg)", async () => {
    const payloads = await payloadsOf(
      `system S { subdomain D { context C { response R { items: string paged } } } }`,
      "C",
    );
    const sp = payloads.find((p) => p.name === "StringPaged");
    expect(sp!.generic).toEqual({ ctor: "paged", arg: { kind: "primitive", name: "string" } });
  });

  it("dedupes repeated instantiations into one payload", async () => {
    const payloads = await payloadsOf(
      `system S { subdomain D { context C {
         valueobject V { a: string paged b: string paged }
       } } }`,
      "C",
    );
    expect(payloads.filter((p) => p.name === "StringPaged")).toHaveLength(1);
  });

  it("is idempotent — enrich(enrich(m)) yields the same payload set", async () => {
    const { model } = await parseString(
      `system S { subdomain D { context C { valueobject V { items: string paged } } } }`,
      { validate: false },
    );
    const once = enrichLoomModel(lowerModel(model));
    const twice = enrichLoomModel(once as never);
    const names = (m: typeof once): string[] =>
      allContexts(m)
        .find((c) => c.name === "C")!
        .payloads.map((p) => p.name)
        .sort();
    expect(names(twice)).toEqual(names(once));
  });
});

describe("generics — platform-aware emission gate (P3b)", () => {
  // A paged find served by the named backend platform.
  const sysWith = (platform: string): string => `
    system Shop {
      subdomain Sales {
        context Shop {
          aggregate Order { ref: string }
          repository Orders for Order { find recent(): Order paged }
        }
      }
      storage pg { type: postgres }
      resource shopState { for: Shop, kind: state, use: pg }
      deployable api { platform: ${platform}, contexts: [Shop], dataSources: [shopState], port: 4000 }
    }`;

  const gateDiags = async (platform: string): Promise<string[]> => {
    const { model } = await parseString(sysWith(platform), { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.code === "loom.generic-carrier-unsupported")
      .map((d) => d.message);
  };

  it("does NOT gate a paged find served only by hono (emission implemented)", async () => {
    expect(await gateDiags("node")).toEqual([]);
  });

  it("does NOT gate a paged find served by dotnet (emission implemented)", async () => {
    expect(await gateDiags("dotnet")).toEqual([]);
  });

  it("does NOT gate a paged find served by phoenix (emission implemented)", async () => {
    expect(await gateDiags("elixir")).toEqual([]);
  });

  it("does not fire when no generic carrier is used (hono)", async () => {
    const { model } = await parseString(
      `
      system Shop {
        subdomain Sales {
          context Shop {
            aggregate Order { ref: string }
            repository Orders for Order { find all(): Order[] }
          }
        }
        storage pg { type: postgres }
        resource shopState { for: Shop, kind: state, use: pg }
        deployable api { platform: dotnet, contexts: [Shop], dataSources: [shopState], port: 4000 }
      }`,
      { validate: false },
    );
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    expect(diags.filter((d) => d.code === "loom.generic-carrier-unsupported")).toHaveLength(0);
  });
});
