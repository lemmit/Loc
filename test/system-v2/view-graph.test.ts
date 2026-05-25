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

// Filter out the synthesised "title" root node — it re-states the current
// container above its children for visual framing, but isn't part of the
// content the per-level snapshots assert against.
const ids = (g: ReturnType<typeof buildViewGraph>): string[] =>
  g.nodes.filter((n) => !n.isRoot).map((n) => n.id);

const childNodes = (g: ReturnType<typeof buildViewGraph>) => g.nodes.filter((n) => !n.isRoot);

describe("Model v2 — view-graph per level", () => {
  it("root containment skips redundant children — events (already pointed to by their emitting aggregate) and repositories (already in the support column) get no `contains` edge", () => {
    const D = `context Sales {
  aggregate Order {
    status: string
  }
  repository Orders for Order {
    find byId(id: int): Order? where this.id == id
  }
  event Placed {
  }
}`;
    const g = buildViewGraph(parse(D), [{ kind: "context", name: "Sales" }]);
    const rootId = "root:context:Sales";
    const contains = g.edges
      .filter((e) => e.kind === "contains" && e.source === rootId)
      .map((e) => e.target);
    // Only the aggregate carries a root-contains edge — the event is reached
    // via its `emits` source, and the repo sits in the side column.
    expect(contains).toEqual(["aggregate:Order"]);
  });

  it("non-root views prepend a synthesised `isRoot` title node restating the current container", () => {
    const aggG = buildViewGraph(parse(SRC), [{ kind: "aggregate", name: "Order" }]);
    const aggRoot = aggG.nodes.find((n) => n.isRoot);
    expect(aggRoot).toMatchObject({ kind: "aggregate", name: "Order", drillable: false });

    const ctxG = buildViewGraph(parse(SRC), [{ kind: "context", name: "Orders" }]);
    const ctxRoot = ctxG.nodes.find((n) => n.isRoot);
    expect(ctxRoot).toMatchObject({ kind: "context", name: "Orders", drillable: false });

    // The root view itself has no parent to re-state, so it doesn't carry a
    // synthesised title.
    const rootG = buildViewGraph(parse(SRC), []);
    expect(rootG.nodes.some((n) => n.isRoot)).toBe(false);
  });

  it("root view lists each top-level system (and standalone contexts)", () => {
    const g = buildViewGraph(parse(SRC), []);
    expect(g.title).toBe("Model");
    expect(ids(g)).toEqual(["system:Sales"]);
    expect(g.nodes[0]?.drillable).toBe(true);
  });

  it("system view lists modules and infra (storage in this fixture)", () => {
    const g = buildViewGraph(parse(SRC), [{ kind: "system", name: "Sales" }]);
    expect(g.title).toBe("system Sales");
    expect(ids(g).sort()).toEqual(["module:Billing", "module:SalesMod", "storage:Db"].sort());
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

  it("context view emits a `reads` edge from each repository to its aggregate", () => {
    const D = `context Sales {
  aggregate Order {
    sku: string
  }
  repository Orders for Order {
    find byId(id: int): Order? where this.id == id
  }
}`;
    const g = buildViewGraph(parse(D), [{ kind: "context", name: "Sales" }]);
    const repoEdges = g.edges.filter((e) => e.id.startsWith("repo-for:"));
    expect(repoEdges.map((e) => `${e.source}->${e.target}`)).toEqual([
      "repository:Orders->aggregate:Order",
    ]);
    expect(repoEdges[0]?.kind).toBe("reads");
  });

  it("context view emits a `reads` edge from a workflow to every repository it uses", () => {
    const D = `context Sales {
  aggregate Order {
    status: string
    operation confirm() {
      status := "ok"
    }
  }
  repository Orders for Order {
    find byId(id: int): Order? where this.id == id
  }
  workflow place(x: int) {
    let o = Orders.byId(x)
    o.confirm()
  }
}`;
    const g = buildViewGraph(parse(D), [{ kind: "context", name: "Sales" }]);
    const wfRepo = g.edges.filter((e) => e.id.startsWith("wf-uses-repo:"));
    expect(wfRepo.map((e) => `${e.source}->${e.target}`)).toEqual([
      "workflow:place->repository:Orders",
    ]);
    expect(wfRepo[0]?.kind).toBe("reads");
  });

  it("context view emits an `emits` edge for each aggregate→event pair", () => {
    const D = `context Sales {
  event Placed {
  }
  aggregate Order {
    status: string
    operation confirm() {
      status := "ok"
      emit Placed {
      }
    }
  }
}`;
    const g = buildViewGraph(parse(D), [{ kind: "context", name: "Sales" }]);
    const emits = g.edges.filter((e) => e.kind === "emits");
    expect(emits.map((e) => `${e.source}->${e.target}`)).toEqual(["aggregate:Order->event:Placed"]);
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

  it("aggregate view exposes derived props as nodes and emits read edges into the fields they reference", () => {
    const D = `context C {
  aggregate Order {
    amount: decimal
    qty: int
    derived total: decimal = amount * qty
  }
}`;
    const g = buildViewGraph(parse(D), [{ kind: "aggregate", name: "Order" }]);
    expect(ids(g).sort()).toEqual(["derived:total", "field:amount", "field:qty"].sort());
    const reads = g.edges.filter((e) => e.kind === "reads");
    expect(reads.map((e) => `${e.source}->${e.target}`).sort()).toEqual(
      ["derived:total->field:amount", "derived:total->field:qty"].sort(),
    );
  });

  it("aggregate view emits a `writes` edge per assigned field and a `reads` edge per accessed field on operations", () => {
    const D = `context C {
  aggregate Order {
    status: string
    note: string
    operation confirm() {
      status := note
    }
  }
}`;
    const g = buildViewGraph(parse(D), [{ kind: "aggregate", name: "Order" }]);
    const writes = g.edges
      .filter((e) => e.kind === "writes")
      .map((e) => `${e.source}->${e.target}`);
    const reads = g.edges.filter((e) => e.kind === "reads").map((e) => `${e.source}->${e.target}`);
    expect(writes).toEqual(["operation:confirm->field:status"]);
    expect(reads).toEqual(["operation:confirm->field:note"]);
  });

  it("aggregate view emits `constrains` edges from invariants to the fields they reference", () => {
    const D = `context C {
  aggregate Money {
    amount: decimal
    currency: string
    invariant amount >= 0
  }
}`;
    const g = buildViewGraph(parse(D), [{ kind: "aggregate", name: "Money" }]);
    const constrains = g.edges.filter((e) => e.kind === "constrains");
    expect(constrains.map((e) => `${e.source}->${e.target}`)).toEqual([
      "invariant:0->field:amount",
    ]);
  });

  it("aggregate view surfaces invariants as indexed nodes carrying a preview", () => {
    const INV = `context C {
  aggregate Money {
    amount: decimal
    currency: string
    invariant amount >= 0
    invariant currency.length == 3
  }
}`;
    const g = buildViewGraph(parse(INV), [{ kind: "aggregate", name: "Money" }]);
    const invariants = g.nodes.filter((n) => n.kind === "invariant");
    expect(invariants.map((n) => n.id)).toEqual(["invariant:0", "invariant:1"]);
    expect(invariants[0]?.name).toBe("amount >= 0");
    expect(invariants[1]?.name).toBe("currency.length == 3");
    expect(invariants.every((n) => !n.drillable)).toBe(true);
  });

  it("unknown name on a level yields an empty graph (graceful)", () => {
    expect(buildViewGraph(parse(SRC), [{ kind: "system", name: "Nope" }]).nodes).toEqual([]);
    expect(buildViewGraph(parse(SRC), [{ kind: "context", name: "Nope" }]).nodes).toEqual([]);
  });

  it("value-object / event / other non-operation leaves return empty", () => {
    const g = buildViewGraph(parse(SRC), [{ kind: "event", name: "Placed" }]);
    expect(g.nodes).toEqual([]);
  });

  it("operation view returns one stmt node per body statement + next edges", () => {
    const g = buildViewGraph(parse(SRC), [
      { kind: "aggregate", name: "Order" },
      { kind: "operation", name: "confirm" },
    ]);
    expect(g.title).toBe("Order.confirm()");
    // `confirm` body: `status := "Confirmed"` — one statement.
    const stmts = childNodes(g);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatchObject({ id: "stmt:0", kind: "stmt" });
    // Only edge at this level is the root-contains edge to the first stmt;
    // there's no `next` edge with a single statement.
    expect(g.edges.filter((e) => e.kind !== "contains")).toEqual([]);
  });

  it("operation view without an aggregate step above returns empty", () => {
    const g = buildViewGraph(parse(SRC), [{ kind: "operation", name: "confirm" }]);
    expect(g.nodes).toEqual([]);
  });

  const WF_SRC = `context C {
  workflow place(x: int) {
    let a = x
    a := x
    let b = 0
  }
}`;
  it("workflow view returns one stmt node per statement and chains them with next edges", () => {
    const g = buildViewGraph(parse(WF_SRC), [{ kind: "workflow", name: "place" }]);
    expect(g.title).toBe("workflow place()");
    expect(childNodes(g).map((n) => n.id)).toEqual(["stmt:0", "stmt:1", "stmt:2"]);
    expect(
      g.edges.filter((e) => e.kind === "next").map((e) => [e.source, e.target]),
    ).toEqual([
      ["stmt:0", "stmt:1"],
      ["stmt:1", "stmt:2"],
    ]);
  });

  it("repository view returns one node per find (drillable repository)", () => {
    const REPO_SRC = `context C {
  aggregate Order {
    sku: string
  }
  repository Orders for Order {
    find bySku(sku: string): Order? where this.sku == sku
    find allActive(): Order[] where true
  }
}`;
    const g = buildViewGraph(parse(REPO_SRC), [{ kind: "repository", name: "Orders" }]);
    expect(g.title).toBe("repository Orders");
    const finds = childNodes(g);
    expect(finds.map((n) => n.id)).toEqual(["find:bySku", "find:allActive"]);
    expect(finds.every((n) => n.kind === "find")).toBe(true);
  });

  it("system view surfaces deployable bindings as edges", () => {
    const SRC_D = `system S {
  module Sales {
    context Orders {
      aggregate Order {
      }
    }
  }
  ui Web {
  }
  deployable api { platform: hono, modules: Sales, port: 3000 }
  deployable webApp { platform: react, targets: api, ui: Web, port: 3001 }
}`;
    const g = buildViewGraph(parse(SRC_D), [{ kind: "system", name: "S" }]);
    const labels = g.edges.map((e) => `${e.source} -${e.label}-> ${e.target}`);
    // api includes module Sales; webApp targets api and mounts Web.
    expect(labels).toEqual(
      expect.arrayContaining([
        "deployable:api -modules-> module:Sales",
        "deployable:webApp -targets-> deployable:api",
        "deployable:webApp -ui-> ui:Web",
      ]),
    );
  });
});
