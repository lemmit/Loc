import { describe, expect, it } from "vitest";
import { buildSystemGraph, typeLabel } from "../../../web/src/builder/system/model.js";
import { parseRaw as parse } from "../../_helpers/index.js";

// Fix 1 — v1's `buildSystemGraph` walked every construct kind EXCEPT
// `BoundedContext`, so a context never became a graph node and every
// `deployable → context` binding (drawn from `Deployable.contextRefs`) was
// silently dropped by the `has(...)` guard in `addEdge`.
describe("v1 buildSystemGraph — context nodes", () => {
  const SRC = `system Sales {
  context Orders {
    aggregate Order {
      status: string
    }
  }
  deployable Api {
    platform: node
    contexts: [Orders]
  }
}`;

  it("produces a node for each bounded context", () => {
    const { nodes } = buildSystemGraph(parse(SRC));
    const context = nodes.find((n) => n.id === "context:Orders");
    expect(context).toBeDefined();
    expect(context?.kind).toBe("context");
    expect(context?.name).toBe("Orders");
  });

  it("wires a deployable to the contexts it targets", () => {
    const { edges } = buildSystemGraph(parse(SRC));
    const contextEdges = edges.filter((e) => e.label === "context");
    expect(contextEdges).toEqual([
      expect.objectContaining({ source: "deployable:Api", target: "context:Orders" }),
    ]);
  });

  it("still wires repository → aggregate and other pre-existing edges alongside the new context node", () => {
    const D = `system Sales {
  context Orders {
    aggregate Order {
      status: string
    }
    repository Orders for Order
  }
  deployable Api {
    platform: node
    contexts: [Orders]
  }
}`;
    const { edges } = buildSystemGraph(parse(D));
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "repository:Orders",
          target: "aggregate:Order",
          label: "for",
        }),
        expect.objectContaining({
          source: "deployable:Api",
          target: "context:Orders",
          label: "context",
        }),
      ]),
    );
  });
});

// Fix 2 — `typeLabel`'s `switch` had two `case "action"` arms; the second
// (with the explanatory comment) was dead code. Both computed the identical
// label, so this just pins the surviving behavior.
describe("v1 typeLabel — action kind", () => {
  it("labels a bare action", () => {
    expect(typeLabel({ kind: "action" })).toBe("action");
  });

  it("labels an action with an argument type", () => {
    expect(typeLabel({ kind: "action", arg: { kind: "primitive", name: "string" } })).toBe(
      "action(string)",
    );
  });
});
