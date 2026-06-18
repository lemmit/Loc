import { describe, expect, it } from "vitest";
import { printExpr } from "../../src/language/print/print-expr.js";
import type { ScaffoldColumn } from "../../src/macros/stdlib/scaffold/_body-builders.js";
import {
  scaffoldList,
  scaffoldNewForm,
  scalarColumnsForAggregate,
} from "../../src/macros/stdlib/scaffold/_body-builders.js";
import { parseRawResult } from "../_helpers/index.js";
import { parseString } from "../_helpers/parse.js";

// A plain-text column — the common case in the print/re-parse checks below.
const text = (name: string): ScaffoldColumn => ({ name, kind: { tag: "text" } });

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
    const src = printExpr(scaffoldList("Order", [text("reference"), text("status")]));
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
    // ID column links to detail; one column per scalar field, each cell
    // dispatched through its type renderer (plain text here → `Text(...)`).
    expect(src).toContain('Column("ID", o => IdLink(o.id, of: Order))');
    expect(src).toContain('Column("Reference", o => Text(o.reference))');
    expect(src).toContain('Column("Status", o => Text(o.status))');
    expect(src).toContain("rows: rows, striped: true, highlight: true, sticky: true");
    // per-row testid accessor (anchors e2e row selectors)
    expect(src).toContain('rowTestid: r => "orders-row-" + r.id');
    expect(src).toContain('testid: "orders-list"');
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });

  it("dispatches each column cell by its resolved type", () => {
    const cols: ScaffoldColumn[] = [
      { name: "ref", kind: { tag: "id", targetName: "Customer" } },
      { name: "createdAt", kind: { tag: "datetime" } },
      { name: "active", kind: { tag: "bool" } },
      { name: "total", kind: { tag: "numeric" } },
      { name: "status", kind: { tag: "enum" } },
      { name: "note", kind: { tag: "text" } },
    ];
    const src = printExpr(scaffoldList("Order", cols));
    expect(src).toContain('Column("Ref", o => IdLink(o.ref, of: Customer))');
    expect(src).toContain('Column("Created At", o => DateDisplay(o.createdAt))');
    expect(src).toContain('Column("Active", o => Text(o.active ? "Yes" : "No"))');
    expect(src).toContain('Column("Total", o => Text(o.total))');
    expect(src).toContain('Column("Status", o => EnumBadge(o.status))');
    expect(src).toContain('Column("Note", o => Text(o.note))');
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });

  it("routes the list query through the api handle when the aggregate is served over one", () => {
    const src = printExpr(scaffoldList("Order", [text("reference")], { apiHandle: "api" }));
    expect(src).toContain("QueryView(of: api.Order.all");
  });

  it("uses the aggregate's own pluralisation/casing", () => {
    const src = printExpr(scaffoldNewForm("Category"));
    expect(src).toContain('Anchor("Categories", to: "/categories")');
    expect(src).toContain('Heading("Create category", level: 2)');
    expect(src).toContain('CreateForm(of: Category, testid: "categories-new")');
  });
});

// Find an AST node by `$type`/`name`, walking only real content (a visited set
// guards against cross-reference cycles).
function findNode(root: unknown, type: string, name: string): any {
  const seen = new WeakSet<object>();
  let found: any;
  const walk = (n: unknown): void => {
    if (found || !n || typeof n !== "object") return;
    if (seen.has(n as object)) return;
    seen.add(n as object);
    if ((n as any).$type === type && (n as any).name === name) {
      found = n;
      return;
    }
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k.startsWith("$") || k === "ref") continue; // skip metadata + resolved cross-refs
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(root);
  return found;
}

describe("scalarColumnsForAggregate — resolves columns from the aggregate AST", () => {
  it("dispatches each field by type and skips value-objects / arrays", async () => {
    const { model, errors } = await parseString(`
      system S {
        context C {
          enum OrderStatus { Draft, Confirmed }
          valueobject Money { amount: decimal  currency: string }
          aggregate Customer { name: string }
          aggregate Order {
            buyer: Customer id
            createdAt: datetime
            active: bool
            total: Money
            status: OrderStatus
            note: string
            tags: Customer id[]
          }
          repository Orders for Order { }
        }
      }
    `);
    expect(errors).toEqual([]);
    const order = findNode(model, "Aggregate", "Order");
    expect(order, "Order aggregate should parse").toBeTruthy();
    const cols = scalarColumnsForAggregate(order);
    // value-object (`total: Money`) and array (`tags: Customer id[]`) drop out,
    // mirroring `expandScaffoldList`'s `valueobject`/`array` skip.
    expect(cols).toEqual([
      { name: "buyer", kind: { tag: "id", targetName: "Customer" } },
      { name: "createdAt", kind: { tag: "datetime" } },
      { name: "active", kind: { tag: "bool" } },
      { name: "status", kind: { tag: "enum" } },
      { name: "note", kind: { tag: "text" } },
    ]);
  });
});
