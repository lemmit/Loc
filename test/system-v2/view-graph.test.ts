import { describe, expect, it } from "vitest";
import { buildViewGraph } from "../../web/src/builder/system-v2/view-graph.js";
import { parseRaw as parse } from "../_helpers/index.js";

// A canonical multi-level system used by the per-level snapshots below.
const SRC = `system Sales {
  module SalesMod {
    context Orders {
      aggregate Order {
        status: string
        operation confirm() {
          status := "Confirmed"
        }
      }
      event Placed {
      }
    }
  }
  module Billing {
    context Invoices {
      aggregate Invoice {
      }
    }
  }
  storage Db {
    type: postgres
  }
}`;

const ids = (g: ReturnType<typeof buildViewGraph>): string[] => g.nodes.map((n) => n.id);

describe("Model v2 — view-graph per level", () => {
  it("root view lists each top-level system (and standalone contexts)", () => {
    const g = buildViewGraph(parse(SRC), []);
    expect(g.title).toBe("Model");
    expect(ids(g)).toEqual(["system:Sales"]);
    expect(g.nodes[0]?.drillable).toBe(true);
  });

  it("system view lists modules and infra (storage in this fixture)", () => {
    const g = buildViewGraph(parse(SRC), [{ kind: "system", name: "Sales" }]);
    expect(g.title).toBe("system Sales");
    expect(ids(g).sort()).toEqual(
      ["module:Billing", "module:SalesMod", "storage:Db"].sort(),
    );
    // Modules drill in; storage is a leaf at this phase.
    const mod = g.nodes.find((n) => n.id === "module:SalesMod")!;
    const stg = g.nodes.find((n) => n.id === "storage:Db")!;
    expect(mod.drillable).toBe(true);
    expect(stg.drillable).toBe(false);
  });

  it("module view lists its contexts", () => {
    const g = buildViewGraph(parse(SRC), [{ kind: "module", name: "SalesMod" }]);
    expect(g.title).toBe("module SalesMod");
    expect(ids(g)).toEqual(["context:Orders"]);
  });

  it("context view lists aggregates / events / etc.", () => {
    const g = buildViewGraph(parse(SRC), [{ kind: "context", name: "Orders" }]);
    expect(g.title).toBe("context Orders");
    expect(ids(g).sort()).toEqual(["aggregate:Order", "event:Placed"].sort());
    // Aggregate drills in; event is a leaf at this phase.
    expect(g.nodes.find((n) => n.id === "aggregate:Order")?.drillable).toBe(true);
    expect(g.nodes.find((n) => n.id === "event:Placed")?.drillable).toBe(false);
  });

  it("aggregate view lists operations + fields", () => {
    const g = buildViewGraph(parse(SRC), [{ kind: "aggregate", name: "Order" }]);
    expect(g.title).toBe("aggregate Order");
    expect(ids(g).sort()).toEqual(["field:status", "operation:confirm"].sort());
    expect(g.nodes.find((n) => n.id === "operation:confirm")?.drillable).toBe(true);
    expect(g.nodes.find((n) => n.id === "field:status")?.drillable).toBe(false);
  });

  it("unknown name on a level yields an empty graph (graceful)", () => {
    expect(buildViewGraph(parse(SRC), [{ kind: "system", name: "Nope" }]).nodes).toEqual([]);
    expect(buildViewGraph(parse(SRC), [{ kind: "context", name: "Nope" }]).nodes).toEqual([]);
  });

  it("operation / workflow / value-object leaves return empty (Phase 2 fills)", () => {
    const g = buildViewGraph(parse(SRC), [{ kind: "operation", name: "confirm" }]);
    expect(g.nodes).toEqual([]);
    expect(g.title).toBe("operation confirm");
  });
});
