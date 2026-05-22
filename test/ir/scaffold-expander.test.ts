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
import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  ScaffoldOriginIR,
  SystemIR,
  UiIR,
} from "../../src/ir/loom-ir.js";
import {
  buildExpandContext,
  expandScaffoldToExplicitBody,
} from "../../src/ir/scaffold-expander.js";

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
    contains: [],
    parts: [],
  };
}

function makeOrdersBC(): BoundedContextIR {
  return {
    name: "Orders",
    aggregates: [makeOrderAggregate()],
    enums: [{ name: "OrderStatus", values: ["Draft", "Confirmed", "Shipped"] }],
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

  it("aggregate-detail emits a Modal + Form(of:, op:) per public operation", () => {
    const sysWithOps = makeSystem();
    const order = sysWithOps.modules[0]!.contexts[0]!.aggregates[0]!;
    order.operations = [
      {
        name: "confirm",
        visibility: "public",
        params: [],
        statements: [],
        extern: false,
        audited: false,
      },
      {
        name: "addLine",
        visibility: "public",
        params: [{ name: "qty", type: { kind: "primitive", name: "int" } }],
        statements: [],
        extern: false,
        audited: false,
      },
      {
        name: "recalc",
        visibility: "private",
        params: [],
        statements: [],
        extern: false,
        audited: false,
      },
    ];
    const ctxOps = buildExpandContext(sysWithOps, makeUi());
    const body = expandScaffoldToExplicitBody(
      { kind: "aggregate-detail", aggregateName: "Order", contextName: "Orders" },
      ctxOps,
    );
    // One Modal per *public* operation (private `recalc` excluded).
    const modals: ExprIR[] = [];
    (function collect(n: ExprIR | undefined) {
      if (!n) return;
      if (n.kind === "call") {
        if (n.name === "Modal") modals.push(n);
        for (const a of n.args) collect(a);
      }
      if (n.kind === "lambda") collect(n.body);
    })(body!);
    expect(modals.length).toBe(2);
    // Each Modal hosts a Form carrying an `op:` named arg + a
    // trigger Button.
    const modal = modals[0]!;
    if (modal.kind !== "call") return;
    const innerForm = findCall(modal, "Form")!;
    expect(innerForm.kind).toBe("call");
    if (innerForm.kind !== "call") return;
    expect((innerForm.argNames ?? []).includes("op")).toBe(true);
    expect((modal.argNames ?? []).includes("trigger")).toBe(true);
    expect(findCall(modal, "Button")).not.toBeNull();
  });

  it("workflow-form expands to Stack(Breadcrumbs, Heading, Card(Form(runs:)))", () => {
    // Augment the test ctx with a synthetic workflow.
    const sysWithWf = makeSystem();
    sysWithWf.modules[0]!.contexts[0]!.workflows.push({
      name: "placeOrder",
      params: [{ name: "qty", type: { kind: "primitive", name: "int" } }],
      transactional: false,
      statements: [],
      savesAtExit: [],
    } as never);
    const ctxWithWf = buildExpandContext(sysWithWf, makeUi());
    const origin: ScaffoldOriginIR = {
      kind: "workflow-form",
      workflowName: "placeOrder",
      contextName: "Orders",
    };
    const body = expandScaffoldToExplicitBody(origin, ctxWithWf);
    expect(body).not.toBeNull();
    expect((body as { name: string }).name).toBe("Stack");
    expect(findCall(body!, "Breadcrumbs")).not.toBeNull();
    expect(findCall(body!, "Heading")).not.toBeNull();
    expect(findCall(body!, "Card")).not.toBeNull();
    const form = findCall(body!, "Form")!;
    expect(form.kind).toBe("call");
    if (form.kind !== "call") return;
    const runsIdx = (form.argNames ?? []).indexOf("runs");
    expect(runsIdx).toBeGreaterThanOrEqual(0);
    expect((form.args[runsIdx] as { name: string }).name).toBe("placeOrder");
  });

  it("view-list expands to Stack(Heading, QueryView(Views.<name>, …))", () => {
    const sysWithView = makeSystem();
    sysWithView.modules[0]!.contexts[0]!.views.push({
      name: "ActiveOrders",
      aggregateName: "Order",
    } as never);
    const ctxWithView = buildExpandContext(sysWithView, makeUi());
    const origin: ScaffoldOriginIR = {
      kind: "view-list",
      viewName: "ActiveOrders",
      contextName: "Orders",
    };
    const body = expandScaffoldToExplicitBody(origin, ctxWithView);
    expect(body).not.toBeNull();
    expect((body as { name: string }).name).toBe("Stack");
    expect(findCall(body!, "Heading")).not.toBeNull();
    expect(findCall(body!, "QueryView")).not.toBeNull();
    expect(findCall(body!, "Table")).not.toBeNull();
    // The QueryView's `of:` is a member access on `Views`.
    const qv = findCall(body!, "QueryView")!;
    if (qv.kind !== "call") return;
    const ofIdx = (qv.argNames ?? []).indexOf("of");
    const ofArg = qv.args[ofIdx]!;
    expect(ofArg.kind).toBe("member");
    if (ofArg.kind !== "member") return;
    expect((ofArg.receiver as { name: string }).name).toBe("Views");
    expect(ofArg.member).toBe("ActiveOrders");
  });

  it("workflows-index / views-index / home all expand to Stack(...) bodies", () => {
    expect(expandScaffoldToExplicitBody({ kind: "workflows-index" }, ctx)?.kind).toBe("call");
    expect(expandScaffoldToExplicitBody({ kind: "views-index" }, ctx)?.kind).toBe("call");
    expect(expandScaffoldToExplicitBody({ kind: "home" }, ctx)?.kind).toBe("call");
  });

  it("returns null when the aggregate isn't in the context map", () => {
    const origin: ScaffoldOriginIR = {
      kind: "aggregate-list",
      aggregateName: "Unknown",
      contextName: "Orders",
    };
    expect(expandScaffoldToExplicitBody(origin, ctx)).toBeNull();
  });

  it("expands with no-handle fallback when the UI has no api params", () => {
    // Slice D1 — legacy `scaffold modules: M` deployables that
    // never declared `api X: Y` parameters still get expansion.
    // The body uses `<Agg>.all` directly (Pattern D in walker)
    // instead of `<handle>.<Agg>.all`.
    const ctxNoApi = buildExpandContext(makeSystem(), {
      ...makeUi(),
      apiParams: [],
    });
    const origin: ScaffoldOriginIR = {
      kind: "aggregate-list",
      aggregateName: "Order",
      contextName: "Orders",
    };
    const body = expandScaffoldToExplicitBody(origin, ctxNoApi);
    expect(body).not.toBeNull();
    const qv = findCall(body!, "QueryView")!;
    if (qv.kind !== "call") return;
    const ofIdx = (qv.argNames ?? []).indexOf("of");
    const ofArg = qv.args[ofIdx]!;
    expect(ofArg.kind).toBe("member");
    if (ofArg.kind !== "member") return;
    // Direct ref to Order (no api handle wrapper).
    expect((ofArg.receiver as { name: string }).name).toBe("Order");
  });
});
