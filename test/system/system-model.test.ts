import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmptyFileSystem, URI } from "langium";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrichments.js";
import type { TraceabilityIR } from "../../src/ir/loom-ir.js";
import { lowerModel } from "../../src/ir/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import {
  buildSystemGraph,
  coverageByNode,
  matchNodes,
  nodeDiagnostics,
  typeLabel,
  wireShapeOf,
} from "../../web/src/builder/system/model.js";
import { parseRaw as parse } from "../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "..", "examples", "sales.ddd"), "utf8");
const salesSystem = readFileSync(
  path.join(here, "..", "..", "web", "src", "examples", "sales-system.ddd"),
  "utf8",
);

// A fully-linked model (cross-refs resolved), mirroring the builder's
// `buildLinkedModel` so `entitles`/`covers` lower correctly.
async function linked(src: string): Promise<Model> {
  const shared = createDddServices(EmptyFileSystem).shared;
  const doc = shared.workspace.LangiumDocumentFactory.fromString(
    src,
    URI.parse("memory:///cov.ddd"),
  );
  shared.workspace.LangiumDocuments.addDocument(doc);
  await shared.workspace.DocumentBuilder.build([doc], { validation: false });
  return doc.parseResult.value as Model;
}

describe("System graph — emit edges from operation bodies", () => {
  it("wires an aggregate to every event it emits", () => {
    const { edges } = buildSystemGraph(parse(sales));
    const emits = edges.filter((e) => e.label === "emits");
    // Order.addLine emits LineAdded; Order.confirm emits OrderConfirmed.
    expect(emits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "aggregate:Order", target: "event:OrderConfirmed" }),
        expect.objectContaining({ source: "aggregate:Order", target: "event:LineAdded" }),
      ]),
    );
  });

  it("dedupes repeated emits of the same event from one owner", () => {
    const { edges } = buildSystemGraph(parse(sales));
    const lineAdded = edges.filter((e) => e.label === "emits" && e.target === "event:LineAdded");
    expect(lineAdded).toHaveLength(1);
  });
});

describe("System graph — diagnostics attribution", () => {
  const nested = `system S {
  module M {
    context C {
      aggregate Order {
        qty: int
        invariant qty > 0
      }
    }
  }
}`;
  const diagAt = (line: number, severity: "error" | "warning" = "error") => ({
    range: { start: { line }, end: { line } },
    severity,
    message: `at ${line}`,
  });

  it("attributes a diagnostic to the tightest containing node, not its ancestors", () => {
    const graph = buildSystemGraph(parse(nested));
    const order = graph.nodes.find((n) => n.id === "aggregate:Order")!;
    const inside = order.ast.$cstNode!.range.start.line + 1; // the `qty: int` line
    const map = nodeDiagnostics(graph, [diagAt(inside)]);
    expect([...map.keys()]).toEqual(["aggregate:Order"]);
    expect(map.get("aggregate:Order")).toHaveLength(1);
  });

  it("drops a diagnostic that falls outside every node's span", () => {
    const graph = buildSystemGraph(parse(nested));
    const map = nodeDiagnostics(graph, [diagAt(0)]); // the `system S {` line
    expect(map.size).toBe(0);
  });
});

describe("System graph — search / kind filter", () => {
  it("matches every node when query and kinds are both empty", () => {
    const graph = buildSystemGraph(parse(sales));
    expect(matchNodes(graph, "", []).size).toBe(graph.nodes.length);
  });

  it("matches by case-insensitive name or kind substring", () => {
    const graph = buildSystemGraph(parse(sales));
    expect(matchNodes(graph, "order", [])).toContain("aggregate:Order");
    // The kind token is searchable too.
    const events = matchNodes(graph, "event", []);
    expect([...events].every((id) => id.startsWith("event:"))).toBe(true);
    expect(events.size).toBeGreaterThan(0);
  });

  it("filters by kind, intersecting with the query", () => {
    const graph = buildSystemGraph(parse(sales));
    const aggsWithO = matchNodes(graph, "o", ["aggregate"]);
    expect([...aggsWithO].every((id) => id.startsWith("aggregate:"))).toBe(true);
    expect(aggsWithO).toContain("aggregate:Order");
    // A repository (different kind) is excluded by the aggregate-only filter.
    expect([...aggsWithO].some((id) => id.startsWith("repository:"))).toBe(false);
  });
});

describe("System graph — traceability coverage", () => {
  it("classifies nodes covered / uncovered / none from the traceability index", () => {
    const graph = buildSystemGraph(parse(sales));
    const trace: Pick<TraceabilityIR, "codeElements" | "testsByCodeElement"> = {
      codeElements: {
        "Sales.Order": "aggregate",
        "Sales.Order.confirm": "operation",
        "Sales.Customer": "aggregate",
      },
      testsByCodeElement: {
        // An operation under Order is covered → Order rolls up to covered.
        "Sales.Order.confirm": ["TC-1"],
      },
    };
    const cov = coverageByNode(graph, trace);
    expect(cov.get("aggregate:Order")).toBe("covered");
    expect(cov.get("aggregate:Customer")).toBe("uncovered"); // referenced, untested
    expect(cov.get("aggregate:Product")).toBe("none"); // not referenced at all
  });

  it("runs the real lower → enrich → coverage path on a system with traceability", async () => {
    const model = await linked(salesSystem);
    const loom = enrichLoomModel(lowerModel(model));
    expect(loom.traceability).toBeDefined();
    const cov = coverageByNode(buildSystemGraph(model), loom.traceability!);
    // Every node gets one of the three statuses, and the system declares enough
    // testCases that at least one construct is covered.
    expect(
      [...cov.values()].every((s) => s === "covered" || s === "uncovered" || s === "none"),
    ).toBe(true);
    expect([...cov.values()].some((s) => s === "covered")).toBe(true);
  });
});

describe("System graph — wire shape (DTO) preview", () => {
  it("labels IR types compactly", () => {
    expect(typeLabel({ kind: "primitive", name: "string" })).toBe("string");
    expect(typeLabel({ kind: "array", element: { kind: "valueobject", name: "Money" } })).toBe(
      "Money[]",
    );
    expect(typeLabel({ kind: "optional", inner: { kind: "enum", name: "Status" } })).toBe(
      "Status?",
    );
    expect(typeLabel({ kind: "id", targetName: "Order", valueType: "uuid" })).toBe("Id<Order>");
  });

  it("exposes an aggregate's enrichment-computed wire shape, id first", async () => {
    const model = await linked(salesSystem);
    const loom = enrichLoomModel(lowerModel(model));
    const aggName = buildSystemGraph(model).nodes.find((n) => n.kind === "aggregate")!.name;
    const ws = wireShapeOf(loom, "aggregate", aggName);
    expect(ws).not.toBeNull();
    expect(ws!.length).toBeGreaterThan(0);
    expect(ws![0].source).toBe("id"); // canonical order starts with the id field
    // An unknown construct has no wire shape.
    expect(wireShapeOf(loom, "aggregate", "Nope")).toBeNull();
  });
});
