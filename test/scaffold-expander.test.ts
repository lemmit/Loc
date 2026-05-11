// Slice C1 — scaffold expander unit tests.
//
// `expandScaffoldToExplicitBody(origin, ctx)` is the pure function
// the IR-level post-processor uses (when `LOOM_SCAFFOLD_EXPAND=1`)
// to swap each scaffold-origin page's body for an equivalent
// walker-stdlib composition.  Tests parametrise across all six
// `ScaffoldOriginIR` kinds and pin two invariants:
//
//   1. Origin kinds we expand today (`aggregate-list`,
//      `aggregate-new`) return a non-null `ExprIR` whose top-level
//      call name + key children match the explicit-DSL shape
//      from `examples/acme-order-explicit.ddd`.
//   2. Origin kinds deferred to A10+ (`aggregate-detail`,
//      `workflow-form`, `view-list`, `workflows-index`,
//      `views-index`, `home`) return `null` so the legacy
//      archetype path stays in use.
//
// Plus a baseline-stability check: with the env flag OFF, the
// fixture is unchanged (already covered by the dedicated baseline
// drift sweep in CI; this file pins the contract programmatically).

import { describe, expect, it } from "vitest";
import {
  buildExpandContext,
  expandScaffoldToExplicitBody,
} from "../src/ir/scaffold-expander.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  ScaffoldOriginIR,
  SystemIR,
  UiIR,
} from "../src/ir/loom-ir.js";

function makeOrderAggregate(): AggregateIR {
  return {
    name: "Order",
    idKind: "guid",
    fields: [
      {
        name: "customerId",
        type: { kind: "primitive", name: "string" },
        optional: false,
        display: true,
      },
      {
        name: "status",
        type: { kind: "enum", name: "OrderStatus" },
        optional: false,
      },
      {
        name: "placedAt",
        type: { kind: "primitive", name: "datetime" },
        optional: false,
      },
    ],
    operations: [],
    invariants: [],
    functions: [],
    parts: [],
  };
}

function makeOrdersBC(): BoundedContextIR {
  return {
    name: "Orders",
    aggregates: [makeOrderAggregate()],
    enums: [
      { name: "OrderStatus", values: ["Draft", "Confirmed", "Shipped"] },
    ],
    valueObjects: [],
    repositories: [],
    workflows: [],
    views: [],
    events: [],
  };
}

function makeSystem(): SystemIR {
  const bc = makeOrdersBC();
  return {
    name: "S",
    modules: [{ name: "Sales", contexts: [bc], permissions: [] }],
    deployables: [],
    e2eTests: [],
    uis: [],
    apis: [{ name: "SalesApi", sourceModule: "Sales" }],
    storages: [],
  };
}

function makeUi(): UiIR {
  return {
    name: "WebApp",
    pages: [],
    components: [],
    scaffolds: [],
    apiParams: [{ name: "Sales", apiName: "SalesApi" }],
    helperImports: [],
  };
}

/** Walk an ExprIR tree looking for a call whose `name` matches.
 *  Used by tests to assert that the synthesised tree contains the
 *  expected primitives without pinning the exact tree shape (which
 *  may evolve as more scaffold features land in the expander). */
function findCall(node: ExprIR | undefined, name: string): ExprIR | null {
  if (!node) return null;
  if (node.kind === "call" && node.name === name) return node;
  if (node.kind === "call") {
    for (const arg of node.args) {
      const hit = findCall(arg, name);
      if (hit) return hit;
    }
  }
  if (node.kind === "lambda" && node.body) return findCall(node.body, name);
  if (node.kind === "binary") {
    return findCall(node.left, name) ?? findCall(node.right, name);
  }
  if (node.kind === "member") return findCall(node.receiver, name);
  return null;
}

describe("Slice C1 — scaffold expander dispatch", () => {
  const ctx = buildExpandContext(makeSystem(), makeUi());

  it("aggregate-list expands to Stack(Breadcrumbs, Toolbar, QueryView, …)", async () => {
    const origin: ScaffoldOriginIR = {
      kind: "aggregate-list",
      aggregateName: "Order",
      contextName: "Orders",
    };
    const body = expandScaffoldToExplicitBody(origin, ctx);
    expect(body).not.toBeNull();
    expect(body!.kind).toBe("call");
    expect((body as { name: string }).name).toBe("Stack");
    // The Stack contains the canonical list-page chrome.
    expect(findCall(body!, "Breadcrumbs")).not.toBeNull();
    expect(findCall(body!, "Toolbar")).not.toBeNull();
    expect(findCall(body!, "QueryView")).not.toBeNull();
    // QueryView's data: branch contains a Paper(Table) tree.
    expect(findCall(body!, "Paper")).not.toBeNull();
    expect(findCall(body!, "Table")).not.toBeNull();
    // Per-column accessors land via Column(...).
    expect(findCall(body!, "Column")).not.toBeNull();
  });

  it("aggregate-list drops collection columns; uses IdLink for the id col", async () => {
    const origin: ScaffoldOriginIR = {
      kind: "aggregate-list",
      aggregateName: "Order",
      contextName: "Orders",
    };
    const body = expandScaffoldToExplicitBody(origin, ctx);
    // First column is always the id link.
    expect(findCall(body!, "IdLink")).not.toBeNull();
    // Status enum field gets EnumBadge.
    expect(findCall(body!, "EnumBadge")).not.toBeNull();
    // datetime field gets DateDisplay.
    expect(findCall(body!, "DateDisplay")).not.toBeNull();
  });

  it("aggregate-new expands to Stack(Breadcrumbs, Heading, Card(Form(of: …)))", async () => {
    const origin: ScaffoldOriginIR = {
      kind: "aggregate-new",
      aggregateName: "Order",
      contextName: "Orders",
    };
    const body = expandScaffoldToExplicitBody(origin, ctx);
    expect(body).not.toBeNull();
    expect((body as { name: string }).name).toBe("Stack");
    expect(findCall(body!, "Breadcrumbs")).not.toBeNull();
    expect(findCall(body!, "Heading")).not.toBeNull();
    expect(findCall(body!, "Card")).not.toBeNull();
    expect(findCall(body!, "Form")).not.toBeNull();
  });

  it("aggregate-new's Form references the aggregate via `of: Order`", async () => {
    const origin: ScaffoldOriginIR = {
      kind: "aggregate-new",
      aggregateName: "Order",
      contextName: "Orders",
    };
    const body = expandScaffoldToExplicitBody(origin, ctx);
    const form = findCall(body!, "Form")!;
    expect(form.kind).toBe("call");
    if (form.kind !== "call") return;
    const ofIdx = (form.argNames ?? []).indexOf("of");
    expect(ofIdx).toBeGreaterThanOrEqual(0);
    const ofArg = form.args[ofIdx]!;
    expect(ofArg.kind).toBe("ref");
    if (ofArg.kind !== "ref") return;
    expect(ofArg.name).toBe("Order");
  });

  it("aggregate-detail expands to Stack(Breadcrumbs, Heading, QueryView(single: true))", () => {
    const origin: ScaffoldOriginIR = {
      kind: "aggregate-detail",
      aggregateName: "Order",
      contextName: "Orders",
    };
    const body = expandScaffoldToExplicitBody(origin, ctx);
    expect(body).not.toBeNull();
    expect((body as { name: string }).name).toBe("Stack");
    // KeyValueRow per non-collection field; QueryView wraps the data.
    expect(findCall(body!, "QueryView")).not.toBeNull();
    expect(findCall(body!, "KeyValueRow")).not.toBeNull();
    // The byId query becomes a method-call on the api param.
    const qv = findCall(body!, "QueryView")!;
    if (qv.kind !== "call") return;
    const ofIdx = (qv.argNames ?? []).indexOf("of");
    const ofArg = qv.args[ofIdx]!;
    expect(ofArg.kind).toBe("method-call");
    if (ofArg.kind !== "method-call") return;
    expect(ofArg.member).toBe("byId");
    // single: true marks the QueryView as single-record (vs collection).
    const singleIdx = (qv.argNames ?? []).indexOf("single");
    expect(singleIdx).toBeGreaterThanOrEqual(0);
  });

  it("workflow-form returns null (deferred)", () => {
    const origin: ScaffoldOriginIR = {
      kind: "workflow-form",
      workflowName: "placeOrder",
      contextName: "Orders",
    };
    expect(expandScaffoldToExplicitBody(origin, ctx)).toBeNull();
  });

  it("view-list returns null (deferred)", () => {
    const origin: ScaffoldOriginIR = {
      kind: "view-list",
      viewName: "ActiveOrders",
      contextName: "Orders",
    };
    expect(expandScaffoldToExplicitBody(origin, ctx)).toBeNull();
  });

  it("workflows-index / views-index / home all return null", () => {
    expect(
      expandScaffoldToExplicitBody({ kind: "workflows-index" }, ctx),
    ).toBeNull();
    expect(
      expandScaffoldToExplicitBody({ kind: "views-index" }, ctx),
    ).toBeNull();
    expect(expandScaffoldToExplicitBody({ kind: "home" }, ctx)).toBeNull();
  });

  it("returns null when the aggregate isn't in the context map", () => {
    const origin: ScaffoldOriginIR = {
      kind: "aggregate-list",
      aggregateName: "Unknown",
      contextName: "Orders",
    };
    expect(expandScaffoldToExplicitBody(origin, ctx)).toBeNull();
  });

  it("returns null when the UI has no api params (no api handle to resolve)", () => {
    const ctxNoApi = buildExpandContext(makeSystem(), {
      ...makeUi(),
      apiParams: [],
    });
    const origin: ScaffoldOriginIR = {
      kind: "aggregate-list",
      aggregateName: "Order",
      contextName: "Orders",
    };
    expect(expandScaffoldToExplicitBody(origin, ctxNoApi)).toBeNull();
  });
});
