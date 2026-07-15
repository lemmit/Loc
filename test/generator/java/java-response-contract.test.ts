// M-T5.10 PR5 — Java (Spring Boot) READS the declared `response <Agg>Response`
// contract record (spliced by `scaffoldHandlers`) instead of re-deriving the
// root `<Agg>Response` record from `wireShape`.  Unlike the sibling backends the
// Java response record also carries a `from(<domain>)` static mapper, so the
// declared record drives selection + order + component types while the mapper is
// reconstructed from the domain — a containment field is already `<Part>Response`
// so its mapper peels to `<Part>Response::from`, never `<Part>ResponseResponse`.
//
// Two things are pinned:
//   (a) Byte-identity — for a scaffolded aggregate the read path produces the
//       SAME `<Agg>Response` record as the wireShape baseline (the same
//       aggregate in a plain context with an auto-derived api, no declared
//       record).  Exercises every field branch: VO (→ `<VO>Response`),
//       containment (→ `List<<Part>Response>`, NOT double-suffixed),
//       internal/secret (dropped), derived, and a provenanced trailing param.
//   (b) The record is actually READ — a hand-declared `response <Agg>Response`
//       with FEWER fields yields a DIFFERENT record than the wireShape baseline.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// The generated Java aggregate response record file.
function orderResponseFile(files: Map<string, string>): string {
  const chosen = [...files.keys()].find(
    (k) => k.endsWith("OrderResponse.java") && !k.endsWith("CreateOrderResponse.java"),
  );
  expect(chosen, "OrderResponse.java must be emitted").toBeDefined();
  return files.get(chosen!)!;
}

// Extract the `public record OrderResponse(<components>) {` component list — the
// components are joined on one line and carry no nested parens, so the capture
// stops at the first `)`.
function recordComponents(source: string, name: string): string {
  const m = source.match(new RegExp(`public record ${name}\\(([^)]*)\\) \\{`));
  expect(m, `record ${name} must be located`).not.toBeNull();
  return m![1];
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
    deployable api { platform: java, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
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
    deployable api { platform: java, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
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
    deployable api { platform: java, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

describe("M-T5.10 PR5 — Java reads the <Agg>Response contract record", () => {
  it("(a) reads the scaffolded record byte-identically to the wireShape baseline", async () => {
    const scaffold = await generateSystemFiles(SCAFFOLD);
    const baseline = await generateSystemFiles(BASELINE);
    const scaffoldOrder = recordComponents(orderResponseFile(scaffold), "OrderResponse");
    const baselineOrder = recordComponents(orderResponseFile(baseline), "OrderResponse");
    // Byte-identical read path: VO → MoneyResponse, containment →
    // List<LineResponse> (single-suffixed), internal/secret dropped, leading
    // UUID id, trailing provenance param.  Under default-on versioning (M-T3.4)
    // the wireShape baseline carries an `int version` token, and `apiReadFields`
    // gives the scaffoldHandlers-spliced DECLARED `response` record the SAME
    // token, so the two stay byte-identical.
    expect(baselineOrder).toContain(", int version,");
    expect(scaffoldOrder).toContain(", int version,");
    expect(baselineOrder).toBe(scaffoldOrder);
    expect(scaffoldOrder).toContain("MoneyResponse total");
    expect(scaffoldOrder).toContain("List<LineResponse> lines");
    expect(scaffoldOrder).not.toContain("LineResponseResponse");
    expect(scaffoldOrder).toContain("UUID id");
    expect(scaffoldOrder).toContain("ProvLineage amountProvenance");
    expect(scaffoldOrder).not.toContain("note");
    expect(scaffoldOrder).not.toContain("apiKey");
    // The `from(<domain>)` mapper peels the response name — never double-suffixed.
    const scaffoldFull = orderResponseFile(scaffold);
    expect(scaffoldFull).toContain("value.lines().stream().map(LineResponse::from).toList()");
    expect(scaffoldFull).not.toContain("LineResponseResponse::from");
  });

  it("(b) a divergent hand-declared record yields a DIFFERENT record (proving it's read)", async () => {
    const baseline = await generateSystemFiles(BASELINE);
    const divergent = await generateSystemFiles(DIVERGENT);
    const baselineOrder = recordComponents(orderResponseFile(baseline), "OrderResponse");
    const divergentOrder = recordComponents(orderResponseFile(divergent), "OrderResponse");
    expect(divergentOrder).not.toBe(baselineOrder);
    // Only `code` (plus the re-prepended UUID id) survives — the wireShape-only
    // fields are gone, proving the record was read.
    expect(divergentOrder).toContain("UUID id");
    expect(divergentOrder).toContain("String code");
    expect(divergentOrder).not.toContain("MoneyResponse total");
    expect(divergentOrder).not.toContain("List<LineResponse> lines");
  });
});
