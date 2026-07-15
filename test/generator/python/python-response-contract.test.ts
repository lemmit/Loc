// M-T5.10 PR4 — Python (FastAPI/Pydantic) READS the declared `response
// <Agg>Response` contract record (spliced by `scaffoldHandlers`) instead of
// re-deriving the root `<Agg>Response` model from `wireShape`.
//
// Two things are pinned:
//   (a) Byte-identity — for a scaffolded aggregate the read path produces the
//       SAME `<Agg>Response` Pydantic model as the wireShape baseline (the same
//       aggregate in a plain context with an auto-derived api, which has no
//       declared record).  Exercises every field branch: VO, containment (→
//       `list[<Part>Response]`, NOT double-suffixed), internal/secret (dropped),
//       derived, and a provenanced trailing field.
//   (b) The record is actually READ — a hand-declared `response <Agg>Response`
//       with FEWER fields yields a DIFFERENT model than the wireShape baseline.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// The generated Python routes file that carries the response Pydantic models.
function modelsFile(files: Map<string, string>): string {
  const chosen = [...files.keys()].find(
    (k) => k.endsWith(".py") && files.get(k)!.includes("class OrderResponse(BaseModel):"),
  );
  expect(chosen, "a file declaring OrderResponse(BaseModel) must be emitted").toBeDefined();
  return files.get(chosen!)!;
}

// Extract the `class OrderResponse(BaseModel):` block up to the next blank line.
function responseModel(source: string, name: string): string {
  const m = source.match(new RegExp(`class ${name}\\(BaseModel\\):\\n(?:    .*\\n)+`));
  expect(m, `model ${name} must be located`).not.toBeNull();
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
    deployable api { platform: python, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
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
    deployable api { platform: python, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
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
    deployable api { platform: python, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

describe("M-T5.10 PR4 — Python reads the <Agg>Response contract record", () => {
  it("(a) reads the scaffolded record byte-identically to the wireShape baseline", async () => {
    const scaffold = await generateSystemFiles(SCAFFOLD);
    const baseline = await generateSystemFiles(BASELINE);
    const scaffoldOrder = responseModel(modelsFile(scaffold), "OrderResponse");
    const baselineOrder = responseModel(modelsFile(baseline), "OrderResponse");
    // Identical read path: containment → list[LineResponse] (single-suffixed),
    // internal/secret dropped, leading id, trailing provenance.  Versioning is
    // default-on (M-T3.4): the wireShape baseline carries the synthetic
    // `version: int` read token, and `apiReadFields` gives the
    // scaffoldHandlers-declared `response OrderResponse` record the SAME token
    // in the same wire-shape slot — so the two stay byte-identical.
    expect(baselineOrder).toBe(scaffoldOrder);
    expect(baselineOrder).toContain("    version: int\n");
    expect(scaffoldOrder).toContain("    version: int\n");
    expect(scaffoldOrder).toContain("list[LineResponse]");
    expect(scaffoldOrder).not.toContain("LineResponseResponse");
    expect(scaffoldOrder).toContain("id: ");
    expect(scaffoldOrder).not.toContain("note:");
    expect(scaffoldOrder).not.toContain("apiKey:");
  });

  it("(b) a divergent hand-declared record yields a DIFFERENT model (proving it's read)", async () => {
    const baseline = await generateSystemFiles(BASELINE);
    const divergent = await generateSystemFiles(DIVERGENT);
    const baselineOrder = responseModel(modelsFile(baseline), "OrderResponse");
    const divergentOrder = responseModel(modelsFile(divergent), "OrderResponse");
    expect(divergentOrder).not.toBe(baselineOrder);
    // Only `code` (plus the re-prepended id) survives — the wireShape-only
    // fields are gone, proving the record was read.
    expect(divergentOrder).toContain("id: ");
    expect(divergentOrder).toContain("code:");
    expect(divergentOrder).not.toContain("list[LineResponse]");
  });
});
