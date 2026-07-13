// AST-level validator coverage for `avg(λ)`.  Unlike `min`/`max`, `avg`
// DESUGARS during lowering to `count == 0 ? null : sum(λ) / count` — so the IR
// validator (which runs post-lowering) never sees an `avg` node.  Its two gates
// therefore fire at the AST level (`checkAvgProjection`):
//   • loom.avg-non-numeric      — the λ-body must be int/long/decimal/money.
//   • loom.collection-op-in-ui  — `avg` has no renderable page-body form.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: unknown }[]): string[] =>
  diags.map((d) => String(d.code ?? "")).filter(Boolean);

const wrapAgg = (body: string) => `
  context Shop {
    aggregate Order {
      contains lines: OrderLine[]
      ${body}
      entity OrderLine { qty: int  price: money  name: string  active: bool }
    }
    repository Orders for Order { }
  }`;

// `avg` in a UI component body — a numeric-array component param resolves to
// `int[]`, so the receiver typechecks and only the UI-position gate fires.
const uiAvg = (proj: string) => `
  system Shop {
    subdomain Sales {
      context Sales {
        aggregate Order with crudish { customerId: string }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui WebApp {
      api Sales: SalesApi
      component Averaged(amounts: int[]) {
        body: Heading { amounts.avg(${proj}), level: 3 }
      }
      page Home { route: "/"  body: Averaged(amounts: [ ]) }
    }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api { platform: node  contexts: [Sales]  dataSources: [salesState]  serves: SalesApi  port: 3000 }
    deployable webApp { platform: react  targets: api  ui: WebApp { Sales: api }  port: 3001 }
  }`;

describe("validator — avg(λ) numeric projection gate (loom.avg-non-numeric)", () => {
  it("flags `avg(λ)` over a string projection", async () => {
    const { diagnostics } = await parseString(
      wrapAgg("derived m: decimal? = lines.avg(l => l.name)"),
    );
    expect(codesOf(diagnostics)).toContain("loom.avg-non-numeric");
  });

  it("flags `avg(λ)` over a bool projection", async () => {
    const { diagnostics } = await parseString(
      wrapAgg("derived m: decimal? = lines.avg(l => l.active)"),
    );
    expect(codesOf(diagnostics)).toContain("loom.avg-non-numeric");
  });

  it("does NOT flag `avg(λ)` over an int projection (positive)", async () => {
    const { diagnostics, errors } = await parseString(
      wrapAgg("derived m: decimal? = lines.avg(l => l.qty)"),
    );
    expect(codesOf(diagnostics)).not.toContain("loom.avg-non-numeric");
    expect(errors).toEqual([]);
  });

  it("does NOT flag `avg(λ)` over a money projection (positive)", async () => {
    const { diagnostics, errors } = await parseString(
      wrapAgg("derived m: money? = lines.avg(l => l.price)"),
    );
    expect(codesOf(diagnostics)).not.toContain("loom.avg-non-numeric");
    expect(errors).toEqual([]);
  });
});

describe("validator — avg(λ) not available in a page body (loom.collection-op-in-ui)", () => {
  it("rejects `avg` in a UI component body", async () => {
    const { diagnostics } = await parseString(uiAvg("a => a"));
    expect(codesOf(diagnostics)).toContain("loom.collection-op-in-ui");
  });
});
