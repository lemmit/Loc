import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmptyFileSystem } from "langium";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import {
  buildSystemGraph,
  matchNodes,
  nodeDiagnostics,
} from "../../web/src/builder/system/model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "..", "examples", "sales.ddd"), "utf8");

const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;
const parse = (t: string): Model => parser.parse(t).value as Model;

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
