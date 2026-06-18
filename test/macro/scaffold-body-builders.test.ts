import { describe, expect, it } from "vitest";
import { printExpr } from "../../src/language/print/print-expr.js";
import { scaffoldList, scaffoldNewForm } from "../../src/macros/stdlib/scaffold/_body-builders.js";
import { parseRawResult } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Phase 1 of docs/proposals/unfoldable-page-scaffolding.md — the macro-layer
// (AST→AST) scaffolders produce printable, re-parseable `.ddd` source from AST
// data alone.  This is the foundation for lifting the scaffold body expansion
// out of the opaque IR-phase-⑤c expander: `scaffoldList` scaffolds a list,
// `scaffoldNewForm` scaffolds a new-form, and each returns real AST.
// ---------------------------------------------------------------------------

const inPage = (body: string): string =>
  `system S {
    context C {
      aggregate Order { reference: string  status: string }
      repository Orders for Order { }
    }
    ui U { page P { route: "/p" body: ${body} } }
  }`;

describe("scaffold body-builders — AST → printable source", () => {
  it("scaffoldNewForm scaffolds the create-page body", () => {
    const src = printExpr(scaffoldNewForm("Order"));
    expect(src).toContain("Stack(");
    expect(src).toContain(
      'Breadcrumbs(Anchor("Home", to: "/"), Anchor("Orders", to: "/orders"), Text("New"))',
    );
    expect(src).toContain('Heading("Create order", level: 2)');
    expect(src).toContain('Card(CreateForm(of: Order, testid: "orders-new"))');
    expect(src).toContain('testid: "orders-new-page"');
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });

  it("scaffoldList scaffolds a list: toolbar + QueryView over a column table", () => {
    const src = printExpr(scaffoldList("Order", ["reference", "status"]));
    // breadcrumb + toolbar with a "New order" button
    expect(src).toContain('Breadcrumbs(Anchor("Home", to: "/"), Text("Orders"))');
    expect(src).toContain('Heading("Orders", level: 2)');
    expect(src).toContain('Button("New order", to: "/orders/new", testid: "orders-list-create")');
    // QueryView over <Agg>.all with loading/error/empty/data branches
    expect(src).toContain("QueryView(of: Order.all");
    expect(src).toContain("loading: Skeleton(count: 5)");
    expect(src).toContain('error: Alert("Couldn\'t load orders")');
    expect(src).toContain('empty: Empty("No orders yet.")');
    expect(src).toContain("data: rows => Paper(Table(");
    // ID column links to detail; one column per scalar field
    expect(src).toContain('Column("ID", o => IdLink(o.id, of: Order))');
    expect(src).toContain('Column("Reference", o => o.reference)');
    expect(src).toContain('Column("Status", o => o.status)');
    expect(src).toContain("rows: rows, striped: true, highlight: true, sticky: true");
    expect(src).toContain('testid: "orders-list"');
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });

  it("routes the list query through the api handle when the aggregate is served over one", () => {
    const src = printExpr(scaffoldList("Order", ["reference"], { apiHandle: "api" }));
    expect(src).toContain("QueryView(of: api.Order.all");
  });

  it("uses the aggregate's own pluralisation/casing", () => {
    const src = printExpr(scaffoldNewForm("Category"));
    expect(src).toContain('Anchor("Categories", to: "/categories")');
    expect(src).toContain('Heading("Create category", level: 2)');
    expect(src).toContain('CreateForm(of: Category, testid: "categories-new")');
  });
});
