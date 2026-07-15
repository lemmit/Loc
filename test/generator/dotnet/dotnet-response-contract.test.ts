// M-T5.10 PR2 — .NET READS the declared `response <Agg>Response` contract
// record (spliced by `scaffoldHandlers`) instead of re-deriving the root
// `<Agg>Response` DTO from `wireShape`.
//
// Two things are pinned:
//   (a) Byte-identity — for a scaffolded aggregate the read path produces the
//       SAME `<Agg>Response` record as the wireShape baseline (the same
//       aggregate in a plain context with an auto-derived api, which has no
//       declared record).  Exercises every field branch: VO (→ `<VO>Response`),
//       containment (→ `IReadOnlyList<<Part>Response>`, NOT double-suffixed),
//       internal/secret (dropped), derived, and a provenanced trailing param.
//   (b) The record is actually READ — a hand-declared `response <Agg>Response`
//       with FEWER fields yields a DIFFERENT `<Agg>Response` record than the
//       wireShape baseline (proving the declared record wins, not ignored).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

function responsesFile(files: Map<string, string>, agg: string, plural: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(`${plural}/Responses/${agg}Responses.cs`));
  expect(key, `${agg}Responses.cs must be emitted`).toBeDefined();
  return files.get(key!)!;
}

function recordDecl(source: string, name: string): string {
  const m = source.match(new RegExp(`public sealed record ${name}\\([^)]*\\);`));
  expect(m, `record ${name} must be located`).not.toBeNull();
  return m![0];
}

// A scaffolded aggregate exercising the full apiRead matrix + every field
// shape the read path must map: a VO field, a containment (+ sibling entity),
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
    deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

// Same aggregate, plain context + auto-derived api — NO declared records, so
// the emitter keeps the wireShape path.  The byte-identity baseline.
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
    deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

// A plain context that HAND-DECLARES a divergent `response OrderResponse`
// (fewer fields than the apiRead matrix), plus the `LineResponse` sibling it
// references.  The emitter must READ this record, so the emitted
// `OrderResponse` diverges from the wireShape baseline.
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
    deployable api { platform: dotnet, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

describe("M-T5.10 PR2 — .NET reads the <Agg>Response contract record", () => {
  // M-T3.4 (default-on versioning) interaction: the wireShape baseline gains the
  // synthetic `int Version` token, and `apiReadFields` gives the scaffoldApi
  // `response OrderResponse` record the SAME token in the same wire-shape slot,
  // so the two read paths stay byte-identical.  The .NET emitter faithfully
  // READS the declared record (M-T5.10's whole point), so this is the same
  // declared-record-wins behaviour test (b) proves.
  it("(a) reads the scaffolded record byte-identically to the wireShape baseline", async () => {
    const scaffold = await generateSystemFiles(SCAFFOLD);
    const baseline = await generateSystemFiles(BASELINE);
    const scaffoldOrder = recordDecl(responsesFile(scaffold, "Order", "Orders"), "OrderResponse");
    const baselineOrder = recordDecl(responsesFile(baseline, "Order", "Orders"), "OrderResponse");
    // Both carry the synthetic version token (default-on M-T3.4).
    expect(baselineOrder).toContain("[property: Required] int Version");
    expect(scaffoldOrder).toContain("[property: Required] int Version");
    // The two read paths are byte-identical.
    expect(baselineOrder).toBe(scaffoldOrder);
    // Read path shape: VO → MoneyResponse, containment →
    // IReadOnlyList<LineResponse> (single-suffixed), internal/secret dropped,
    // leading Guid Id, trailing provenance param.
    expect(scaffoldOrder).toContain("MoneyResponse Total");
    expect(scaffoldOrder).toContain("IReadOnlyList<LineResponse> Lines");
    expect(scaffoldOrder).not.toContain("LineResponseResponse");
    expect(scaffoldOrder).toContain("Guid Id");
    expect(scaffoldOrder).toContain("ProvLineage? AmountProvenance");
    expect(scaffoldOrder).not.toContain("Note");
    expect(scaffoldOrder).not.toContain("ApiKey");
  });

  it("(b) a divergent hand-declared record yields a DIFFERENT record (proving it's read)", async () => {
    const baseline = await generateSystemFiles(BASELINE);
    const divergent = await generateSystemFiles(DIVERGENT);
    const baselineOrder = recordDecl(responsesFile(baseline, "Order", "Orders"), "OrderResponse");
    const divergentOrder = recordDecl(responsesFile(divergent, "Order", "Orders"), "OrderResponse");
    expect(divergentOrder).not.toBe(baselineOrder);
    // The declared record has only `code` (plus the re-prepended Guid Id) — the
    // wireShape-only fields must be gone, proving the record was read, not the
    // wireShape.
    expect(divergentOrder).toContain("Guid Id");
    expect(divergentOrder).toContain("string Code");
    expect(divergentOrder).not.toContain("MoneyResponse Total");
    expect(divergentOrder).not.toContain("IReadOnlyList<LineResponse> Lines");
  });
});
