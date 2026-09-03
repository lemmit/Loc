import { describe, expect, it } from "vitest";
import { printExpr } from "../../src/language/print/print-expr.js";
import type {
  FilterParam,
  ScaffoldColumn,
} from "../../src/macros/stdlib/scaffold/_body-builders.js";
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

/** Collapse the printer's wrapped argument lists back to their one-line form.
 *  These assertions are about WHAT a builder emits, not where the line happened
 *  to break — and the wrap budget is indent-aware (2026-07 unfold review), so a
 *  deeply-nested call wraps at a narrower width than a shallow one. */
const flat = (s: string): string =>
  s
    .replace(/\(\s*\n\s*/g, "(")
    .replace(/,\s*\n\s*/g, ", ")
    .replace(/\s*\n\s*\)/g, ")");

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
    // page window + sort controls and the view carries `paged: true`. The
    // whole tree is deep enough to wrap onto indented, one-entry-per-line
    // form (print-expr.ts's `wrapArgList`/`printBuilderCall`).
    expect(src).toContain("QueryView(");
    expect(src).toContain("of: Order.all(pageNum, 10, sortKey, sortDir),");
    expect(src).toContain("paged: true,");
    expect(src).toContain("loading: Skeleton(count: 5)");
    expect(src).toContain('error: Alert("Couldn\'t load orders")');
    expect(src).toContain('empty: Empty("No orders yet.")');
    expect(src).toContain("data: rows => Paper(");
    expect(src).toContain("Table(");
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
    // `serverPaged: true`, then the style props — one per line.
    expect(src).toContain("rows: rows.items,");
    expect(src).toContain("sortKey: sortKey,");
    expect(src).toContain("sortDir: sortDir,");
    expect(src).toContain("page: pageNum,");
    expect(src).toContain("serverPaged: true,");
    expect(src).toContain("totalPages: rows.totalPages,");
    expect(src).toContain("striped: true,");
    expect(src).toContain("highlight: true,");
    expect(src).toContain("sticky: true,");
    // per-row testid accessor (anchors e2e row selectors)
    expect(src).toContain('rowTestid: r => "orders-row-" + r.id');
    expect(src).toContain('testid: "orders-list"');
    // formatted: one arg per indented line, not collapsed onto one long line
    expect(src.split("\n").length).toBeGreaterThan(10);
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
    expect(src).toContain("of: api.Order.all(pageNum, 10, sortKey, sortDir),");
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
    expect(src).toContain('OperationForm(of: Order, op: approve, testid: "orders-op-approve"),');
    expect(src).toContain('title: "Approve",');
    expect(src).toContain(
      'trigger: Button("Approve", emphasis: "primary", testid: "orders-op-approve")',
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

  // ── The soft-delete break-out ──────────────────────────────────────────────
  // A soft delete puts the row behind the `softDeletable` capability's read
  // filter, so the Detail page it was invoked from immediately re-reads its own
  // record and gets a 404: the user is left on a page of stale fields under
  // "Couldn't load <entity>", with the modal's success toast still fading.  Such
  // an operation renders as an `Action` with `then: navigate("/<plural>")`
  // instead — the same do-it-then-leave shape `DestroyForm` already uses for the
  // hard delete.
  //
  // Detection is by BODY (`isDeleted := true`), never by name: the name belongs
  // to the author, the assignment is what the read filter reacts to.  `restore`
  // writes the same field with `false` and is the control that separates
  // "reads the assignment" from "matches the field name".
  //
  // Mutation-proved: `s.value.value === "true"` → `!== "false"` in
  // `removesRecordFromReads` makes `restore` break out too and fails the
  // "restore keeps its modal" arm; dropping the `instanceVar &&` guard fails the
  // "no in-scope record" arm.
  describe("a record-removing operation leaves the page instead of opening a modal", () => {
    const softDeletable = withOps(
      "isDeleted: bool\n" +
        "operation softDelete() { isDeleted := true }\n" +
        "operation restore() { isDeleted := false }\n" +
        "operation approve() { }",
    );

    it("renders the soft delete as an Action that navigates to the list", async () => {
      const { model, errors } = await parseString(softDeletable);
      expect(errors).toEqual([]);
      const order = findNode(model, "Aggregate", "Order");
      const src = flat(printExpr(scaffoldOperations(order, "data")));
      expect(src).toContain(
        'Action(data.softDelete, then: navigate("/orders"), testid: "orders-op-softDelete")',
      );
      // It must not ALSO keep a modal — that would leave the page mounted.
      expect(src).not.toContain('testid: "orders-op-softDelete"),\n      title:');
      expect(src).not.toMatch(/OperationForm\(data\.softDelete/);
      expect(
        parseRawResult(inPage(printExpr(scaffoldOperations(order, "data"))))
          .parserErrors.map((e) => e.message)
          .join("\n"),
      ).toBe("");
    });

    it("`restore` writes the same field with false, and keeps its modal", async () => {
      const { model } = await parseString(softDeletable);
      const order = findNode(model, "Aggregate", "Order");
      const src = flat(printExpr(scaffoldOperations(order, "data")));
      expect(src).toContain("OperationForm(data.restore");
      expect(src).not.toContain("Action(data.restore");
      // …and an ordinary operation is untouched.
      expect(src).toContain("OperationForm(data.approve");
    });

    it("keeps the modal when there is no in-scope record to read the id off", async () => {
      const { model } = await parseString(softDeletable);
      const order = findNode(model, "Aggregate", "Order");
      // No `instanceVar` — `Action(<instance>.<op>)` has no receiver to resolve,
      // so the by-name modal is the only shape that works.
      const src = flat(printExpr(scaffoldOperations(order)));
      expect(src).toContain("OperationForm(of: Order, op: softDelete");
      expect(src).not.toContain("Action(");
    });

    it("an operation with parameters is never treated as a record removal", async () => {
      const { model } = await parseString(
        withOps("isDeleted: bool\noperation purge(reason: string) { isDeleted := true }"),
      );
      const order = findNode(model, "Aggregate", "Order");
      const src = flat(printExpr(scaffoldOperations(order, "data")));
      // It needs its form — an `Action` fires with no arguments.
      expect(src).toContain("OperationForm(data.purge");
      expect(src).not.toContain("Action(data.purge");
    });
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
    expect(src).toContain("of: Order.byId(id),");
    expect(src).toContain("single: true,");
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

  it("pairs a provenanced field's value with a ProvenanceInfo disclosure", async () => {
    const { model, errors } = await parseString(`
      system S {
        context C {
          aggregate Order {
            reference: string
            total: int provenanced
          }
          repository Orders for Order { }
        }
      }
    `);
    expect(errors).toEqual([]);
    const order = findNode(model, "Aggregate", "Order");
    const src = printExpr(scaffoldDetails(order));
    // The provenanced field wraps value + a "?" disclosure in a Group.  The
    // FIGURE reads the wire carrier's `value` member (M-T6.12) — a bare
    // `data.total` would render the whole `{ value, lineage }` object.
    expect(src).toContain("Group(");
    expect(src).toContain("Text(data.total.value)");
    expect(src).toContain(
      'ProvenanceInfo(of: data, field: "total", testid: "orders-detail-total-prov")',
    );
    // A plain field gets no disclosure — exactly one ProvenanceInfo on the page.
    expect(src).toContain('KeyValueRow("Reference", Text(data.reference)');
    expect(src.match(/ProvenanceInfo\(/g)).toHaveLength(1);
    // Still prints to re-parseable `.ddd` source (unfold-safe).
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
    expect(flat(src)).toContain(
      'Column("Order Id", i => Anchor(i.orderId, to: "/workflows/fulfillment/instances/" + i.orderId))',
    );
    expect(src).toContain('Column("Status", i => EnumBadge(i.status))');
    expect(src).toContain('rowTestid: r => "fulfillment-instances-row-" + r.orderId');
    expect(src).toContain("of: Fulfillment.instances.all,");
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
    expect(src).toContain("of: Fulfillment.instances.byId(id),");
    expect(src).toContain("single: true,");
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

/** A `FilterParam` for the builder tests.  `type` is only consulted for the
 *  `number` arm (it is cloned onto the state field), so a bare TypeRef stub is
 *  enough for the string/id arms. */
const PRIM_FOR_KIND: Record<FilterParam["kind"], string> = {
  string: "string",
  ref: "string",
  number: "int",
  bool: "bool",
};

const fp = (name: string, kind: FilterParam["kind"] = "string"): FilterParam =>
  ({
    name,
    kind,
    // `cloneTypeRef` reads `.base.$type` / `.base.name`, so the stub needs a
    // real `base` node — not just a bare TypeRef shell.
    type: {
      $type: "TypeRef",
      array: false,
      optional: false,
      base: { $type: "PrimitiveType", name: PRIM_FOR_KIND[kind] },
    },
  }) as unknown as FilterParam;

describe("scaffoldList filter-bar — find inputs + match switch", () => {
  it("emits a Group of bound inputs and a match that switches the list per find", () => {
    const src = printExpr(
      scaffoldList("Order", [text("status")], {
        filters: [{ name: "byStatus", params: [fp("status")] }],
      }),
    );
    // one bound text input per param, testid keyed by the snake state name
    expect(src).toContain(
      'Group(Field("Status", bind: byStatusStatus, testid: "orders-filter-by_status_status"))',
    );
    // a match: when the input is non-empty, query the find; else fall back to all
    expect(src).toContain('byStatusStatus != "" => QueryView(');
    expect(src).toContain("of: Order.byStatus(byStatusStatus),");
    expect(src).toContain("else => QueryView(");
    expect(src).toContain("of: Order.all(pageNum, 10, sortKey, sortDir),");
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });

  // M-T1.15: a `bool` param is the one kind whose NATURAL input is WRONG rather
  // than missing — a `Toggle` binds a bool state whose zero value is `false`,
  // which collapses "filter for false" and "no filter" into one page state and
  // puts half the domain out of reach.  The bar binds a three-state string
  // select instead, and passes the comparison as the find argument.
  it("a bool param binds a three-state SelectField and passes the comparison as the argument", () => {
    const src = flat(
      printExpr(
        scaffoldList("Order", [text("status")], {
          filters: [{ name: "byActive", params: [fp("active", "bool")] }],
        }),
      ),
    );
    expect(src).toContain(
      'SelectField("Active", bind: byActiveActive, options: ["true", "false"], ' +
        'testid: "orders-filter-by_active_active")',
    );
    // "unset" is `""` — NOT one of the two options, so both `true` and `false`
    // stay reachable (the whole point of not using a Toggle here).
    expect(src).toContain('byActiveActive != "" => QueryView(');
    // the find takes a `bool`, so the comparison IS the argument
    expect(src).toContain('of: Order.byActive(byActiveActive == "true"),');
    expect(src).not.toContain("Toggle(");
    expect(
      parseRawResult(inPage(src))
        .parserErrors.map((e) => e.message)
        .join("\n"),
    ).toBe("");
  });

  it("ANDs a multi-param find's inputs into one arm condition", () => {
    const src = printExpr(
      scaffoldList("Order", [text("name")], {
        filters: [{ name: "search", params: [fp("name"), fp("city")] }],
      }),
    );
    expect(src).toContain('Field("Name", bind: searchName');
    expect(src).toContain('Field("City", bind: searchCity');
    expect(src).toContain('searchName != "" && searchCity != "" => QueryView(');
    expect(src).toContain("of: Order.search(searchName, searchCity),");
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
    expect(src).toContain("of: Order.all(pageNum, 10, sortKey, sortDir),");
  });

  it("filterStateFields: a bare string field per string/id param, a typed spec per number", () => {
    // string and `X id` params keep the bare-name spelling (byte-identical
    // emission); a numeric param carries the find param's own type onto the
    // state field so the state and the find ARGUMENT agree by construction.
    expect(
      filterStateFields([
        { name: "byStatus", params: [fp("status")] },
        { name: "search", params: [fp("name"), fp("city")] },
      ]),
    ).toEqual(["byStatusStatus", "searchName", "searchCity"]);

    const withNumber = filterStateFields([{ name: "byTotal", params: [fp("total", "number")] }]);
    expect(withNumber).toHaveLength(1);
    expect(withNumber[0]).toMatchObject({ name: "byTotalTotal", type: "string" });
  });
});

describe("filterFindsForAggregate — resolves filter finds from the repository AST", () => {
  it("keeps string- and numeric-param list finds, drops all / scalar / non-array", async () => {
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
    // `byTotal(total: int)` is offered too since M-T1.15 — an int/long/`X id`
    // param renders a NumberField rather than being silently dropped.
    // `params` carries a live `TypeRef` since M-T1.15; project to the fields
    // under test rather than deep-comparing AST nodes.
    expect(
      filterFindsForAggregate(order).map((f) => ({
        name: f.name,
        params: f.params.map((x) => [x.name, x.kind]),
      })),
    ).toEqual([
      { name: "byStatus", params: [["status", "string"]] },
      {
        name: "search",
        params: [
          ["name", "string"],
          ["city", "string"],
        ],
      },
      { name: "byTotal", params: [["total", "number"]] },
    ]);
  });

  // M-T1.15: the per-param-type verdict, in ONE place — every renderable type
  // is offered, every held-back one is dropped, and the reason each is on the
  // side it is on is a fact about the FRONTENDS (see `filterParamKind`), not a
  // preference.  `guid`/`datetime` are `z.string()` on the request wire and
  // `string` in every frontend's state emitter, so a text box over them agrees
  // by construction; `enum` is the `z.enum([...])` union against a `string`
  // state (TS2322) and `decimal`/`money` have no type-checking zero sentinel.
  it("offers guid / datetime / bool params, and still drops enum, decimal, money, arrays and optionals", async () => {
    const { model, errors } = await parseString(`
      system S {
        context C {
          enum Status { Draft, Confirmed }
          aggregate Customer { name: string }
          aggregate Order { reference: string }
          repository Orders for Order {
            find byCorr(corr: guid): Order[]
            find byPlacedAt(at: datetime): Order[]
            find byActive(a: bool): Order[]
            find byBuyer(b: Customer id): Order[]
            find byStatus(s: Status): Order[]
            find byTotal(t: decimal): Order[]
            find byPrice(p: money): Order[]
            find byRefs(rs: string[]): Order[]
            find byMaybe(m: string?): Order[]
          }
        }
      }
    `);
    expect(errors).toEqual([]);
    const order = findNode(model, "Aggregate", "Order");
    expect(
      filterFindsForAggregate(order).map((f) => [f.name, f.params.map((p) => p.kind)]),
    ).toEqual([
      ["byCorr", ["string"]],
      ["byPlacedAt", ["string"]],
      ["byActive", ["bool"]],
      ["byBuyer", ["ref"]],
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
    // `provenanced` is false on every column here — none of these fields carry
    // the modifier, so no cell reads through the wire carrier (M-T6.12).
    expect(cols).toEqual([
      { name: "buyer", kind: { tag: "id", targetName: "Customer" }, provenanced: false },
      { name: "createdAt", kind: { tag: "datetime" }, provenanced: false },
      { name: "active", kind: { tag: "bool" }, provenanced: false },
      { name: "status", kind: { tag: "enum" }, provenanced: false },
      { name: "note", kind: { tag: "text" }, provenanced: false },
      // default-on optimistic-concurrency token (M-T3.4)
      { name: "version", kind: { tag: "numeric" }, provenanced: false },
    ]);
  });
});
