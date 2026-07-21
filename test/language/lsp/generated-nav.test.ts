import { describe, expect, it } from "vitest";
import { constructIdAt, regionsForConstruct } from "../../../src/language/lsp/generated-nav.js";
import type { SourceMap } from "../../../src/trace/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Unit coverage for the pure half of "go to generated code" — the provider
// e2e test (lsp-implementation.test.ts) exercises operation/aggregate ids
// against a real generated tree, but the workflow arms of
// `constructIdAt` and `regionsForConstruct`'s selection rules (op-over-agg
// non-mixing, dedup, foreign-source filtering, macro chains) are only
// pinned here.
// ---------------------------------------------------------------------------

const SOURCE = `
context Sales {
  event OrderPlaced { order: Order id }
  aggregate Order {
    customerId: Customer id
    status: string
    operation confirm() {
      let s = status
    }
  }
  aggregate Customer {
    name: string
  }
  repository Orders for Order { }
  repository Customers for Customer { }

  workflow placeOrder {
    create(customerId: Customer id) {
      let customer = Customers.getById(customerId)
    }
  }
}
`;

// A ui with a HAND-WRITTEN nested-area page and component — the arms M9
// added (a scaffolded ui's synthesized pages have no CST, so only
// hand-written declarations are cursor-reachable).
const UI_SOURCE = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order {
        status: string
      }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource salesState { for: Orders, kind: state, use: primary }
  api ShopApi from Sales
  ui WebApp {
    component StatusPill(label: string) {
      body: Badge { label }
    }
    area Back {
      area Office {
        page OrderBoard {
          route: "/board"
          body: Text { "board" }
        }
      }
    }
  }
  deployable api { platform: node, contexts: [Orders], dataSources: [salesState], serves: ShopApi, port: 3000 }
  deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
}
`;

async function idsIn(source: string, marker: string): Promise<string[] | undefined> {
  const { model, doc, errors } = await parseString(source, { validate: true });
  if (errors.length) throw new Error(`unexpected validation errors:\n${errors.join("\n")}`);
  void model;
  const offset = source.indexOf(marker);
  expect(offset, `marker "${marker}" not found`).toBeGreaterThanOrEqual(0);
  return constructIdAt(doc, offset);
}

const idsAt = (marker: string) => idsIn(SOURCE, marker);

describe("constructIdAt", () => {
  it("returns op id then aggregate id, narrowest first, inside an operation body", async () => {
    expect(await idsAt("let s = status")).toEqual(["Sales.Order.confirm", "Sales.Order"]);
  });

  it("returns only the aggregate id on a field outside any operation", async () => {
    expect(await idsAt("customerId: Customer id")).toEqual(["Sales.Order"]);
  });

  it("maps a workflow body to Ctx.Wf", async () => {
    expect(await idsAt("Customers.getById")).toEqual(["Sales.placeOrder"]);
  });

  it("returns undefined on an event (no construct regions recorded for events)", async () => {
    expect(await idsAt("OrderPlaced {")).toBeUndefined();
  });

  it("maps a hand-written page to its area-qualified ui construct id (areas snake()d, matching PageIR.area)", async () => {
    expect(await idsIn(UI_SOURCE, 'route: "/board"')).toEqual(["WebApp.back.office.OrderBoard"]);
  });

  it("maps a ui component to Ui.Component", async () => {
    expect(await idsIn(UI_SOURCE, "Badge { label }")).toEqual(["WebApp.StatusPill"]);
  });
});

const DOC = "/proj/main.ddd";
const src = (path: string) => ({ kind: "source" as const, path, span: [0, 5] as [number, number] });

function mapOf(files: SourceMap["files"]): SourceMap {
  return { version: 1, sources: [DOC], files };
}

describe("regionsForConstruct", () => {
  it("prefers the narrowest id with any match and never mixes levels", () => {
    const map = mapOf({
      "a/agg.ts": [
        { target: [1, 40], origin: src(DOC), construct: "Sales.Order" },
        { target: [10, 10], origin: src(DOC), construct: "Sales.Order.confirm" },
      ],
    });
    const hits = regionsForConstruct(map, ["Sales.Order.confirm", "Sales.Order"], DOC);
    expect(hits).toEqual([{ file: "a/agg.ts", target: [10, 10] }]);
  });

  it("falls back to the coarser id when the narrow one has no regions", () => {
    const map = mapOf({
      "a/agg.ts": [{ target: [1, 40], origin: src(DOC), construct: "Sales.Order" }],
    });
    const hits = regionsForConstruct(map, ["Sales.Order.confirm", "Sales.Order"], DOC);
    expect(hits).toEqual([{ file: "a/agg.ts", target: [1, 40] }]);
  });

  it("filters out regions originating from a different .ddd file", () => {
    const map = mapOf({
      "a/agg.ts": [
        { target: [1, 40], origin: src("/other/lib.ddd"), construct: "Sales.Order" },
        { target: [50, 90], origin: src(DOC), construct: "Sales.Order" },
      ],
    });
    const hits = regionsForConstruct(map, ["Sales.Order"], DOC);
    expect(hits).toEqual([{ file: "a/agg.ts", target: [50, 90] }]);
  });

  it("follows macro origin chains to the source leaf", () => {
    const map = mapOf({
      "ui/page.tsx": [
        {
          target: [1, 30],
          origin: { kind: "macro" as const, macro: "scaffold", call: src(DOC) },
          construct: "Sales.Order",
        },
      ],
    });
    expect(regionsForConstruct(map, ["Sales.Order"], DOC)).toEqual([
      { file: "ui/page.tsx", target: [1, 30] },
    ]);
  });

  it("dedups identical (file, target) pairs and sorts by file then start line", () => {
    const map = mapOf({
      "b/second.ts": [{ target: [5, 9], origin: src(DOC), construct: "Sales.Order" }],
      "a/first.ts": [
        { target: [12, 20], origin: src(DOC), construct: "Sales.Order" },
        { target: [1, 4], origin: src(DOC), construct: "Sales.Order" },
        { target: [1, 4], origin: src(DOC), construct: "Sales.Order" },
      ],
    });
    expect(regionsForConstruct(map, ["Sales.Order"], DOC)).toEqual([
      { file: "a/first.ts", target: [1, 4] },
      { file: "a/first.ts", target: [12, 20] },
      { file: "b/second.ts", target: [5, 9] },
    ]);
  });

  it("returns empty when nothing matches", () => {
    expect(regionsForConstruct(mapOf({}), ["Sales.Order"], DOC)).toEqual([]);
  });
});
