import { describe, expect, it } from "vitest";
import { printExpr } from "../../src/language/print/print-expr.js";
import type { ScaffoldColumn } from "../../src/macros/stdlib/scaffold/_body-builders.js";
import {
  filterFindsForAggregate,
  filterStateFields,
  scaffoldDetails,
  scaffoldInstanceDetails,
  scaffoldInstanceList,
  scaffoldList,
  scaffoldNewForm,
  scaffoldOperations,
  scaffoldWorkflowForm,
  scalarColumnsForAggregate,
} from "../../src/macros/stdlib/scaffold/_body-builders.js";
import { parseRawResult } from "../_helpers/index.js";
import { parseString } from "../_helpers/parse.js";

// A plain-text column — the common case in the print/re-parse checks below.
const text = (name: string): ScaffoldColumn => ({ name, kind: { tag: "text" } });

// ---------------------------------------------------------------------------
// Phase 1 of docs/old/proposals/unfoldable-page-scaffolding.md — the macro-layer
// (AST→AST) scaffolders produce printable, re-parseable `.ddd` source from AST
// data alone — this is the whole scaffold body path: `scaffoldList` scaffolds
// a list, `scaffoldNewForm` scaffolds a new-form, and each returns real AST.
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
    // QueryView over the server-paged <Agg>.all (M-T2.6): the find takes the
    // page window + sort controls and the view carries `paged: true`.
    expect(src).toContain("QueryView(of: Order.all(pageNum, 10, sortKey, sortDir), paged: true");
    expect(src).toContain("loading: Skeleton(count: 5)");
    expect(src).toContain('error: Alert("Couldn\'t load orders")');
    expect(src).toContain('empty: Empty("No orders yet.")');
    expect(src).toContain("data: rows => Paper(Table(");
    // ID column links to detail; one column per scalar field, each cell
    // dispatched through its type renderer (plain text here → `Text(...)`).
    // Every column is `sortable:` with an explicit `field:` (M-T1.1).
    expect(src).toContain(
      'Column("ID", o => IdLink(o.id, of: Order), sortable: true, field: "id")',
    );
    expect(src).toContain(
      'Column("Reference", o => Text(o.reference), sortable: true, field: "reference")',
    );
    expect(src).toContain('Column("Status", o => Text(o.status), sortable: true, field: "status")');
    // Server-paged rows (M-T2.6): the Table consumes the `Paged<T>` envelope's
    // `.items` + `.totalPages` (no client-side `pageSize` slice) and flags
    // `serverPaged: true`, then the style props.
    expect(src).toContain(
      "rows: rows.items, sortKey: sortKey, sortDir: sortDir, page: pageNum, serverPaged: true, totalPages: rows.totalPages, striped: true, highlight: true, sticky: true",
    );
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
      { name: "blob", kind: { tag: "file" } },
    ];
    const src = printExpr(scaffoldList("Order", cols));
    expect(src).toContain(
      'Column("Ref", o => IdLink(o.ref, of: Customer), sortable: true, field: "ref")',
    );
    expect(src).toContain(
      'Column("Created At", o => DateDisplay(o.createdAt), sortable: true, field: "createdAt")',
    );
    expect(src).toContain(
      'Column("Active", o => Text(o.active ? "Yes" : "No"), sortable: true, field: "active")',
    );
    expect(src).toContain('Column("Total", o => Text(o.total), sortable: true, field: "total")');
    expect(src).toContain(
      'Column("Status", o => EnumBadge(o.status), sortable: true, field: "status")',
    );
    expect(src).toContain('Column("Note", o => Text(o.note), sortable: true, field: "note")');
    // A `File` column renders a `FileLink` download anchor (the FileRef object
    // is not a ReactNode) — see `typedCell` "file".
    expect(src).toContain('Column("Blob", o => FileLink(o.blob), sortable: true, field: "blob")');
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

describe("scaffoldWorkflowForm — workflow command page body", () => {
  it("scaffolds Breadcrumbs/Heading/Card(WorkflowForm)", () => {
    const src = printExpr(scaffoldWorkflowForm("placeOrder"));
    expect(src).toContain(
      'Breadcrumbs(Anchor("Home", to: "/"), Anchor("Workflows", to: "/workflows"), Text("Place Order"))',
    );
    expect(src).toContain('Heading("Place Order", level: 2)');
    expect(src).toContain('Card(WorkflowForm(runs: placeOrder, testid: "workflow-place_order"))');
    expect(src).toContain('testid: "workflow-place_order-page"');
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });
});

describe("scaffoldOperations — per-operation modals", () => {
  const withOps = (members: string) => `
    system S {
      context C {
        aggregate Order {
          reference: string
          ${members}
        }
        repository Orders for Order { }
      }
    }`;

  it("emits one Modal per public operation; first trigger is primary", async () => {
    const { model, errors } = await parseString(
      withOps("operation approve() { } operation cancel() { }"),
    );
    expect(errors).toEqual([]);
    const order = findNode(model, "Aggregate", "Order");
    const src = printExpr(scaffoldOperations(order));
    expect(src).toContain(
      'Modal(OperationForm(of: Order, op: approve, testid: "orders-op-approve"), title: "Approve", trigger: Button("Approve", emphasis: "primary", testid: "orders-op-approve"))',
    );
    expect(src).toContain('emphasis: "secondary", testid: "orders-op-cancel"');
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });

  it("skips private operations and yields an empty Group when none are public", async () => {
    const { model } = await parseString(withOps("private operation recompute() { }"));
    const order = findNode(model, "Aggregate", "Order");
    expect(printExpr(scaffoldOperations(order))).toBe("Group()");
  });
});

describe("scaffold list/detail — internal & secret fields stay off the page", () => {
  // A scaffold list/detail renders the API-read wire shape, which excludes
  // `internal`/`secret`-access fields (wire-projection.ts `forApiRead`).  If the
  // scaffold enumerated them, the emitted React would reference a column the
  // client DTO never carries and fail `tsc`.  Capability mixins (`tenantOwned`,
  // `softDeletable`) inject exactly such `internal` fields, so this is the gate
  // that keeps `with scaffold` compiling across the multi-tenant/soft-delete
  // turn.  Managed/token fields (`deletedAt`, `version`) ARE on the wire and
  // must stay.
  const withAccessFields = `
    system S {
      context C {
        aggregate Widget {
          name: string
          tenantId: string internal
          apiKey: string secret
          deletedAt: datetime? managed
          version: int token
        }
        repository Widgets for Widget { }
      }
    }
  `;

  it("scalarColumnsForAggregate drops internal + secret, keeps managed/token", async () => {
    const { model, errors } = await parseString(withAccessFields);
    expect(errors).toEqual([]);
    const widget = findNode(model, "Aggregate", "Widget");
    const names = scalarColumnsForAggregate(widget).map((c) => c.name);
    expect(names).toContain("name");
    expect(names).toContain("deletedAt");
    expect(names).toContain("version");
    expect(names).not.toContain("tenantId");
    expect(names).not.toContain("apiKey");
  });

  it("scaffoldDetails omits internal + secret field rows", async () => {
    const { model, errors } = await parseString(withAccessFields);
    expect(errors).toEqual([]);
    const widget = findNode(model, "Aggregate", "Widget");
    const src = printExpr(scaffoldDetails(widget));
    expect(src).toContain('KeyValueRow("Name"');
    expect(src).toContain('KeyValueRow("Deleted At"');
    expect(src).not.toContain("tenantId");
    expect(src).not.toContain("apiKey");
  });
});

describe("scaffoldDetails — aggregate read view + related cards", () => {
  it("builds a field card (scalars + flattened value-objects) and a related table card", async () => {
    const { model, errors } = await parseString(`
      system S {
        context C {
          valueobject Money { amount: decimal  currency: string }
          aggregate Order {
            reference: string
            total: Money
            contains lines: OrderLine[]
            entity OrderLine {
              sku: string
              quantity: int
            }
          }
          repository Orders for Order { }
        }
      }
    `);
    expect(errors).toEqual([]);
    const order = findNode(model, "Aggregate", "Order");
    const src = printExpr(scaffoldDetails(order));
    // shell: breadcrumbs / heading / by-id query
    expect(src).toContain(
      'Breadcrumbs(Anchor("Home", to: "/"), Anchor("Orders", to: "/orders"), Text("Detail"))',
    );
    expect(src).toContain('Heading("Order detail", level: 2)');
    expect(src).toContain("QueryView(of: Order.byId(id), single: true");
    expect(src).toContain('Alert("No order matches that id.", color: "yellow")');
    // field card: scalar row carries a testid; value-object flattens to labelled leaves
    expect(src).toContain(
      'KeyValueRow("Reference", Text(data.reference), testid: "orders-detail-reference")',
    );
    expect(src).toContain('KeyValueRow("Total Amount", Text(data.total.amount))');
    expect(src).toContain('KeyValueRow("Total Currency", Text(data.total.currency))');
    // related collection → a framed table card over data.lines
    expect(src).toContain('Heading("Lines", level: 4)');
    expect(src).toContain('Column("Sku", row => Text(row.sku))');
    expect(src).toContain('Column("Quantity", row => Text(row.quantity))');
    expect(src).toContain("rows: data.lines");
    expect(src).toContain('testid: "orders-detail-lines"');
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });
});

describe("scaffold instance builders — observable workflow pages", () => {
  const observable = `
    system S {
      context C {
        aggregate Order { subject: string }
        enum FulfillmentStatus { Pending, Shipped }
        workflow Fulfillment {
          orderId: Order id
          status: FulfillmentStatus
          create(o: Order id) { let x = 1 }
        }
        repository Orders for Order { }
      }
    }`;

  it("scaffoldInstanceList: correlation column links to detail, rest dispatch by type", async () => {
    const { model, errors } = await parseString(observable);
    expect(errors).toEqual([]);
    const wf = findNode(model, "Workflow", "Fulfillment");
    const src = printExpr(scaffoldInstanceList(wf));
    expect(src).toContain(
      'Column("Order Id", i => Anchor(i.orderId, to: "/workflows/fulfillment/instances/" + i.orderId))',
    );
    expect(src).toContain('Column("Status", i => EnumBadge(i.status))');
    expect(src).toContain('rowTestid: r => "fulfillment-instances-row-" + r.orderId');
    expect(src).toContain("QueryView(of: Fulfillment.instances.all");
    expect(src).toContain('Heading("Fulfillment instances", level: 2)');
    expect(src).toContain('testid: "fulfillment-instances-list"');
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });

  it("scaffoldInstanceDetails: KeyValueRows over the instance shape, queried by id", async () => {
    const { model } = await parseString(observable);
    const wf = findNode(model, "Workflow", "Fulfillment");
    const src = printExpr(scaffoldInstanceDetails(wf));
    expect(src).toContain('KeyValueRow("Order Id", IdLink(data.orderId, of: Order))');
    expect(src).toContain('KeyValueRow("Status", EnumBadge(data.status))');
    expect(src).toContain("QueryView(of: Fulfillment.instances.byId(id), single: true");
    expect(src).toContain(
      'Anchor("Fulfillment instances", to: "/workflows/fulfillment/instances")',
    );
    expect(src).toContain('Heading("Fulfillment instance", level: 2)');
    expect(src).toContain('color: "yellow"');
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });
});

describe("scaffoldList filter-bar — find inputs + match switch", () => {
  it("emits a Group of bound inputs and a match that switches the list per find", () => {
    const src = printExpr(
      scaffoldList("Order", [text("status")], {
        filters: [{ name: "byStatus", params: ["status"] }],
      }),
    );
    // one bound text input per param, testid keyed by the snake state name
    expect(src).toContain(
      'Group(Field("Status", bind: byStatusStatus, testid: "orders-filter-by_status_status"))',
    );
    // a match: when the input is non-empty, query the find; else fall back to all
    expect(src).toContain('byStatusStatus != "" => QueryView(of: Order.byStatus(byStatusStatus)');
    expect(src).toContain("else => QueryView(of: Order.all");
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });

  it("ANDs a multi-param find's inputs into one arm condition", () => {
    const src = printExpr(
      scaffoldList("Order", [text("name")], {
        filters: [{ name: "search", params: ["name", "city"] }],
      }),
    );
    expect(src).toContain('Field("Name", bind: searchName');
    expect(src).toContain('Field("City", bind: searchCity');
    expect(src).toContain(
      'searchName != "" && searchCity != "" => QueryView(of: Order.search(searchName, searchCity)',
    );
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });

  it("no filters → no Group, plain all-query list (unchanged)", () => {
    const src = printExpr(scaffoldList("Order", [text("status")]));
    expect(src).not.toContain("Group(");
    expect(src).not.toContain("match {");
    expect(src).toContain("QueryView(of: Order.all");
  });

  it("filterStateFields names one string field per find param", () => {
    expect(
      filterStateFields([
        { name: "byStatus", params: ["status"] },
        { name: "search", params: ["name", "city"] },
      ]),
    ).toEqual([{ name: "byStatusStatus" }, { name: "searchName" }, { name: "searchCity" }]);
  });
});

describe("filterFindsForAggregate — resolves filter finds from the repository AST", () => {
  it("keeps string-param list finds, drops all / scalar / non-array / non-string", async () => {
    const { model, errors } = await parseString(`
      system S {
        context C {
          aggregate Order { reference: string }
          repository Orders for Order {
            find byStatus(status: string): Order[]
            find search(name: string, city: string): Order[]
            find byTotal(total: int): Order[]
            find one(ref: string): Order
            find count(): int
          }
        }
      }
    `);
    expect(errors).toEqual([]);
    const order = findNode(model, "Aggregate", "Order");
    expect(filterFindsForAggregate(order)).toEqual([
      { name: "byStatus", params: ["status"] },
      { name: "search", params: ["name", "city"] },
    ]);
  });
});

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
    // value-object (`total: Money`) and array (`tags: Customer id[]`) drop out
    // of a list table (no plain-cell rendering).
    expect(cols).toEqual([
      { name: "buyer", kind: { tag: "id", targetName: "Customer" } },
      { name: "createdAt", kind: { tag: "datetime" } },
      { name: "active", kind: { tag: "bool" } },
      { name: "status", kind: { tag: "enum" } },
      { name: "note", kind: { tag: "text" } },
      // default-on optimistic-concurrency token (M-T3.4)
      { name: "version", kind: { tag: "numeric" } },
    ]);
  });
});
