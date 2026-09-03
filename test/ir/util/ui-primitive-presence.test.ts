import { describe, expect, it } from "vitest";
import type { ExprIR, UiIR } from "../../../src/ir/types/loom-ir.js";
import { bodyUsesChart, uiUsesChart } from "../../../src/ir/util/chart.js";
import { bodyUsesDataGrid, dataGridHosts, uiUsesDataGrid } from "../../../src/ir/util/data-grid.js";

// `Chart` and `DataGrid` presence in a page body — sibling modules, tested as a
// pair.  M-T9.17 slice 5 — no test calls any of the five exports.
//
// Each answers one question for TWO consumers: the IR validator gates the
// primitive on targets that cannot render it (`loom.chart-unsupported-target` /
// `loom.datagrid-unsupported-target`), and an emitter asks the same question to
// decide whether the generated `package.json` carries the dependency
// (`@mantine/charts` for react, `@tanstack/table-core` for feliz).  A false
// negative therefore has two distinct shapes: a page that silently renders
// nothing on an unsupported target, or a generated project whose import has no
// dependency behind it.
//
// `data-grid.ts` records a fixed bug worth pinning directly: a PAGE-ONLY scan
// let a grid moved into a COMPONENT through, and the targets without the seam
// degraded silently (flutter emitted `SizedBox.shrink()`, heex an
// unsupported-primitive comment).  Components render into pages, so a grid in
// one is exactly as unrenderable.  Both modules now scan components — asserted
// separately for each, since the two are independent copies of the same rule.

const call = (name: string, args: ExprIR[] = []): ExprIR =>
  ({ kind: "call", name, args }) as unknown as ExprIR;

/** A body that only CONTAINS the primitive, nested — the shape a shallow
 *  `body.kind === "call"` check would miss. */
const nested = (inner: ExprIR): ExprIR =>
  ({ kind: "call", name: "Stack", args: [call("Card", [inner])] }) as unknown as ExprIR;

const ui = (pages: unknown[], components: unknown[] = []): UiIR =>
  ({ name: "Admin", pages, components }) as unknown as UiIR;

const page = (name: string, body?: ExprIR) => ({ name, body });

describe("bodyUsesChart / bodyUsesDataGrid — the body scan", () => {
  it("finds the primitive at the root of a body", () => {
    expect(bodyUsesChart(call("Chart"))).toBe(true);
    expect(bodyUsesDataGrid(call("DataGrid"))).toBe(true);
  });

  it("finds it NESTED inside other primitives", () => {
    // A page body is a tree of layout primitives; a root-only check would call
    // every realistic page chart-free.
    expect(bodyUsesChart(nested(call("Chart")))).toBe(true);
    expect(bodyUsesDataGrid(nested(call("DataGrid")))).toBe(true);
  });

  it("is false for a body using neither", () => {
    expect(bodyUsesChart(nested(call("Table")))).toBe(false);
    expect(bodyUsesDataGrid(nested(call("Table")))).toBe(false);
  });

  it("does not confuse the two primitives with each other", () => {
    // They gate different targets and different dependencies, so a scan that
    // matched both names would add a dependency no import needs and refuse a
    // model that renders fine.
    expect(bodyUsesChart(call("DataGrid"))).toBe(false);
    expect(bodyUsesDataGrid(call("Chart"))).toBe(false);
  });

  it("matches the name EXACTLY, not by prefix or substring", () => {
    expect(bodyUsesChart(call("ChartLegend"))).toBe(false);
    expect(bodyUsesDataGrid(call("DataGridColumn"))).toBe(false);
  });

  it("tolerates an undefined body", () => {
    expect(bodyUsesChart(undefined)).toBe(false);
    expect(bodyUsesDataGrid(undefined)).toBe(false);
  });
});

describe("uiUsesChart / uiUsesDataGrid — pages AND components", () => {
  it("is false for a ui using neither", () => {
    expect(uiUsesChart(ui([page("Home", call("Table"))]))).toBe(false);
    expect(uiUsesDataGrid(ui([page("Home", call("Table"))]))).toBe(false);
  });

  it("is true from a PAGE body", () => {
    expect(uiUsesChart(ui([page("Home", call("Chart"))]))).toBe(true);
    expect(uiUsesDataGrid(ui([page("Home", call("DataGrid"))]))).toBe(true);
  });

  it("is true from a COMPONENT body — the arm the page-only scan dropped", () => {
    // Asserted with every PAGE explicitly primitive-free, so it cannot pass on
    // the strength of the page arm.  This is the fixed bug, for both modules.
    expect(uiUsesChart(ui([page("Home", call("Table"))], [page("Widget", call("Chart"))]))).toBe(
      true,
    );
    expect(
      uiUsesDataGrid(ui([page("Home", call("Table"))], [page("Widget", call("DataGrid"))])),
    ).toBe(true);
  });

  it("scans a LATER page/component, not just the first", () => {
    expect(uiUsesChart(ui([page("A", call("Table")), page("B", call("Chart"))]))).toBe(true);
    expect(uiUsesDataGrid(ui([], [page("A", call("Table")), page("B", call("DataGrid"))]))).toBe(
      true,
    );
  });

  it("tolerates pages/components with no body at all", () => {
    expect(uiUsesChart(ui([page("Empty")], [page("AlsoEmpty")]))).toBe(false);
    expect(uiUsesDataGrid(ui([page("Empty")], [page("AlsoEmpty")]))).toBe(false);
  });
});

describe("dataGridHosts — the diagnostic's host labels", () => {
  // Only `data-grid` carries this; `chart` reports presence alone.  The labels
  // are what `loom.datagrid-unsupported-target` names, so an author with one
  // grid in one component gets pointed at that component rather than told
  // "somewhere in this ui".
  it("is empty when nothing uses a grid", () => {
    expect(dataGridHosts(ui([page("Home", call("Table"))]))).toEqual([]);
  });

  it("labels a page as `page '<name>'`", () => {
    expect(dataGridHosts(ui([page("Orders", call("DataGrid"))]))).toEqual(["page 'Orders'"]);
  });

  it("labels a component as `component '<name>'`", () => {
    expect(dataGridHosts(ui([], [page("Grid", call("DataGrid"))]))).toEqual(["component 'Grid'"]);
  });

  it("lists pages before components, and every host, not just the first", () => {
    const hosts = dataGridHosts(
      ui(
        [page("A", call("DataGrid")), page("B", call("Table")), page("C", call("DataGrid"))],
        [page("W", call("DataGrid"))],
      ),
    );
    expect(hosts).toEqual(["page 'A'", "page 'C'", "component 'W'"]);
  });

  it("agrees with `uiUsesDataGrid` by construction", () => {
    // `uiUsesDataGrid` is defined as `dataGridHosts(...).length > 0`; pinning
    // the agreement keeps a future short-circuit from splitting the two.
    const withGrid = ui([page("A", call("DataGrid"))]);
    const without = ui([page("A", call("Table"))]);
    expect(uiUsesDataGrid(withGrid)).toBe(dataGridHosts(withGrid).length > 0);
    expect(uiUsesDataGrid(without)).toBe(dataGridHosts(without).length > 0);
  });
});
