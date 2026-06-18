import { describe, expect, it } from "vitest";
import { printExpr } from "../../src/language/print/print-expr.js";
import { scaffoldNewFormBody } from "../../src/macros/stdlib/scaffold/_body-builders.js";
import { parseRawResult } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Phase 1 of docs/proposals/unfoldable-page-scaffolding.md — proves the
// macro-layer (AST→AST) body builders produce printable, re-parseable `.ddd`
// source from AST data alone, which is the foundation for lifting the
// scaffold body expansion out of the opaque IR-phase-⑤c expander.
// ---------------------------------------------------------------------------

describe("scaffold body-builders — AST → printable source", () => {
  it("scaffoldNewForm body builds the expected tree as printable source", () => {
    const src = printExpr(scaffoldNewFormBody("Order"));
    // Breadcrumbs · Heading · Card(CreateForm) — the canonical New-form shape,
    // built from the aggregate name alone (no field reflection needed).
    expect(src).toContain("Stack(");
    expect(src).toContain('Breadcrumbs(Anchor("Home", to: "/")');
    expect(src).toContain('Anchor("Orders", to: "/orders")');
    expect(src).toContain('Text("New")');
    expect(src).toContain('Heading("Create order", level: 2)');
    expect(src).toContain('Card(CreateForm(of: Order, testid: "orders-new"))');
    expect(src).toContain('testid: "orders-new-page"');
  });

  it("uses the aggregate's own pluralisation/casing", () => {
    // `Category` → plural `Categories`, slug `categories`.
    const src = printExpr(scaffoldNewFormBody("Category"));
    expect(src).toContain('Anchor("Categories", to: "/categories")');
    expect(src).toContain('Heading("Create category", level: 2)');
    expect(src).toContain('CreateForm(of: Category, testid: "categories-new")');
  });

  it("the printed body parses back as a valid page body (round-trips to source)", () => {
    const src = printExpr(scaffoldNewFormBody("Order"));
    const doc = `system S {
      context C { aggregate Order { name: string } repository Orders for Order { } }
      ui U { page OrderNew { route: "/orders/new" body: ${src} } }
    }`;
    const re = parseRawResult(doc);
    expect(re.parserErrors.map((e) => e.message).join("\n")).toBe("");
  });
});
