// M-T5.10 PR3 — Hono READS the declared `response <Agg>Response` contract
// record (spliced by `scaffoldHandlers`) instead of re-deriving the root
// `<Agg>Response` zod schema from `wireShape`.
//
// Two things are pinned:
//   (a) Byte-identity — for a scaffolded aggregate the read path produces the
//       SAME `<Agg>Response` zod schema as the wireShape baseline (the same
//       aggregate in a plain context with an auto-derived api, which has no
//       declared record).  Exercises every field branch: VO (→ `<VO>Schema`),
//       containment (→ `z.array(<Part>Response)`, NOT double-suffixed),
//       internal/secret (dropped), derived, and a provenanced trailing field.
//       M-T3.4 note — versioning is now default-on: the wireShape-derived
//       baseline carries a synthetic `version: z.number().int()` token, but the
//       scaffoldHandlers-spliced `response OrderResponse` record is read
//       verbatim (declared records are authoritative — see (b)) and so omits it.
//       The two read paths are byte-identical modulo that one field.
//   (b) The record is actually READ — a hand-declared `response <Agg>Response`
//       with FEWER fields yields a DIFFERENT schema than the wireShape baseline.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// The generated Hono routes file that carries the response zod schemas.
function routesFile(files: Map<string, string>): string {
  const key = [...files.keys()].find(
    (k) => k.endsWith("http/orders.ts") || /Order.*routes\.ts$/.test(k),
  );
  const chosen =
    key ??
    [...files.keys()].find(
      (k) => k.endsWith(".ts") && files.get(k)!.includes("OrderResponse = z.object("),
    );
  expect(chosen, "a routes file declaring OrderResponse must be emitted").toBeDefined();
  return files.get(chosen!)!;
}

// Extract `export const OrderResponse = z.object({ ... }).openapi("OrderResponse");`
function responseSchema(source: string, name: string): string {
  const m = source.match(
    new RegExp(`export const ${name} = z\\.object\\(\\{[\\s\\S]*?\\}\\)\\.openapi\\("${name}"\\);`),
  );
  expect(m, `schema ${name} must be located`).not.toBeNull();
  return m![0];
}

// A scaffolded aggregate exercising the full apiRead matrix + every field shape
// the read path must map: a VO field, a containment (+ sibling entity),
// internal/secret (dropped), a derived getter, and a provenanced field.
const SCAFFOLD = `
  system Shop {
    subdomain Sales {
      context Ordering with scaffoldHandlers {
        valueobject Money { amount: decimal  currency: string }
        aggregate Order {
          code: string
          total: Money
          note: string internal
          apiKey: string secret
          amount: decimal provenanced
          derived label: string = code
          contains lines: Line[]
          entity Line {
            sku: string
            qty: int
            cost: int internal
          }
          create(code: string) { code := code }
          operation cancel() { code := "x" }
        }
        repository Orders for Order { }
      }
    }
    api SalesApi with scaffoldApi(of: Sales)
    storage pg { type: postgres }
    resource st { for: Ordering, kind: state, use: pg }
    deployable api { platform: node, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

// Same aggregate, plain context + auto-derived api — NO declared records, so the
// emitter keeps the wireShape path.  The byte-identity baseline.
const BASELINE = `
  system Shop {
    subdomain Sales {
      context Ordering {
        valueobject Money { amount: decimal  currency: string }
        aggregate Order {
          code: string
          total: Money
          note: string internal
          apiKey: string secret
          amount: decimal provenanced
          derived label: string = code
          contains lines: Line[]
          entity Line {
            sku: string
            qty: int
            cost: int internal
          }
          create(code: string) { code := code }
          operation cancel() { code := "x" }
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    storage pg { type: postgres }
    resource st { for: Ordering, kind: state, use: pg }
    deployable api { platform: node, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

// A plain context HAND-DECLARING a divergent `response OrderResponse` (fewer
// fields), plus the `LineResponse` sibling it references.
const DIVERGENT = `
  system Shop {
    subdomain Sales {
      context Ordering {
        valueobject Money { amount: decimal  currency: string }
        response LineResponse { sku: string  qty: int }
        response OrderResponse { code: string }
        aggregate Order {
          code: string
          total: Money
          note: string internal
          apiKey: string secret
          amount: decimal provenanced
          derived label: string = code
          contains lines: Line[]
          entity Line {
            sku: string
            qty: int
            cost: int internal
          }
          create(code: string) { code := code }
          operation cancel() { code := "x" }
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    storage pg { type: postgres }
    resource st { for: Ordering, kind: state, use: pg }
    deployable api { platform: node, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

describe("M-T5.10 PR3 — Hono reads the <Agg>Response contract record", () => {
  it("(a) reads the scaffolded record byte-identically to the wireShape baseline", async () => {
    const scaffold = await generateSystemFiles(SCAFFOLD);
    const baseline = await generateSystemFiles(BASELINE);
    const scaffoldOrder = responseSchema(routesFile(scaffold), "OrderResponse");
    const baselineOrder = responseSchema(routesFile(baseline), "OrderResponse");
    // Byte-identical read path: VO → MoneySchema, containment →
    // z.array(LineResponse) (single-suffixed), internal/secret dropped, leading
    // id, trailing provenance.  M-T3.4: the wireShape baseline carries the
    // default-on synthetic `version` token, and `apiReadFields` gives the
    // scaffold-declared record the SAME token in the same slot, so the two are
    // byte-identical.
    expect(baselineOrder).toContain("version: z.number().int(),");
    expect(scaffoldOrder).toContain("version: z.number().int(),");
    expect(baselineOrder).toBe(scaffoldOrder);
    expect(scaffoldOrder).toContain("z.array(LineResponse)");
    expect(scaffoldOrder).not.toContain("LineResponseResponse");
    expect(scaffoldOrder).toContain("id: z.string()");
    expect(scaffoldOrder).not.toContain("note:");
    expect(scaffoldOrder).not.toContain("apiKey:");
  });

  it("(b) a divergent hand-declared record yields a DIFFERENT schema (proving it's read)", async () => {
    const baseline = await generateSystemFiles(BASELINE);
    const divergent = await generateSystemFiles(DIVERGENT);
    const baselineOrder = responseSchema(routesFile(baseline), "OrderResponse");
    const divergentOrder = responseSchema(routesFile(divergent), "OrderResponse");
    expect(divergentOrder).not.toBe(baselineOrder);
    // Only `code` (plus the re-prepended id) survives — the wireShape-only
    // fields are gone, proving the record was read.
    expect(divergentOrder).toContain("id: z.string()");
    expect(divergentOrder).toContain("code:");
    expect(divergentOrder).not.toContain("z.array(LineResponse)");
  });
});
