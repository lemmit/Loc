// M-T5.10 PR6 — Elixir (Phoenix / OpenApiSpex) READS the declared
// `response <Agg>Response` contract record (spliced by `scaffoldHandlers`)
// instead of re-deriving the root `<Agg>Response` schema module from
// `wireShape`.
//
// Two things are pinned:
//   (a) Byte-identity — for a scaffolded aggregate the read path produces the
//       SAME `<Agg>Response` OpenApiSpex schema as the wireShape baseline (the
//       same aggregate in a plain context with an auto-derived api, no declared
//       record).  Exercises every field branch: VO (→ raw `$ref`), containment
//       (→ `array` of `<Part>Response` module atom, NOT double-suffixed),
//       internal/secret (dropped), derived, and a provenanced field.
//   (b) The record is actually READ — a hand-declared `response <Agg>Response`
//       with FEWER fields yields a DIFFERENT schema than the wireShape baseline.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// The generated Phoenix OpenApiSpex schema module for the aggregate response.
function orderResponseSchema(files: Map<string, string>): string {
  const chosen = [...files.keys()].find((k) => k.endsWith("order_response.ex"));
  expect(chosen, "order_response.ex must be emitted").toBeDefined();
  return files.get(chosen!)!;
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
    deployable api { platform: elixir, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
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
    deployable api { platform: elixir, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
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
    deployable api { platform: elixir, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
  }
`;

describe("M-T5.10 PR6 — Elixir reads the <Agg>Response contract record", () => {
  it("(a) reads the scaffolded record identically to the wireShape baseline modulo the default-on version token (M-T3.4)", async () => {
    const scaffold = await generateSystemFiles(SCAFFOLD);
    const baseline = await generateSystemFiles(BASELINE);
    const scaffoldOrder = orderResponseSchema(scaffold);
    const baselineOrder = orderResponseSchema(baseline);
    // Default-on versioning (M-T3.4) injects the synthetic `version` token as an
    // IR-level capability field, so the wireShape-derived BASELINE read schema
    // carries it.  The scaffold path reads the DECLARED `<Agg>Response` contract
    // record verbatim (built at the AST layer from `apiReadFields`, before the
    // capability field is lowered), so it carries only the domain fields.  The
    // two therefore now differ by EXACTLY `version`; every other field branch —
    // containment → array of the LineResponse module atom (single-suffixed),
    // internal/secret dropped, leading id, derived kept — stays byte-identical.
    const stripVersion = (s: string) =>
      s
        .replace(/\n\s*version: %OpenApiSpex\.Schema\{type: :integer\},/, "")
        .replace(", :version,", ",");
    expect(stripVersion(baselineOrder)).toBe(scaffoldOrder);
    // The wireShape baseline carries version; the declared scaffold contract does not.
    expect(baselineOrder).toContain("version: %OpenApiSpex.Schema{type: :integer}");
    expect(baselineOrder).toContain(":version");
    expect(scaffoldOrder).not.toContain("version");
    expect(scaffoldOrder).toContain("items: ApiWeb.Api.Schemas.LineResponse");
    expect(scaffoldOrder).not.toContain("LineResponseResponse");
    expect(scaffoldOrder).toMatch(/\bid: %OpenApiSpex\.Schema\{type: :string, format: :uuid\}/);
    expect(scaffoldOrder).not.toContain("note:");
    expect(scaffoldOrder).not.toContain("apiKey:");
  });

  it("(b) a divergent hand-declared record yields a DIFFERENT schema (proving it's read)", async () => {
    const baseline = await generateSystemFiles(BASELINE);
    const divergent = await generateSystemFiles(DIVERGENT);
    const baselineOrder = orderResponseSchema(baseline);
    const divergentOrder = orderResponseSchema(divergent);
    expect(divergentOrder).not.toBe(baselineOrder);
    // Only `code` (plus the re-prepended id) survives — the wireShape-only
    // fields are gone, proving the record was read.
    expect(divergentOrder).toMatch(/\bid: %OpenApiSpex\.Schema\{type: :string, format: :uuid\}/);
    expect(divergentOrder).toContain("code:");
    expect(divergentOrder).not.toContain("items: ApiWeb.Api.Schemas.LineResponse");
    expect(divergentOrder).toContain("required: [:id, :code]");
  });
});
