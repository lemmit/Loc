import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type AstNode, AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import type { BodyProp, Page } from "../../src/language/generated/ast.js";
import { type BuilderNode, emitBody, enumStateFields, expectedAssignEnum, seedFromBody } from "../../web/src/builder/page/model.js";
import { fromCraft, toCraft } from "../../web/src/builder/page/serialize.js";
import { parseRawResult } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Page-builder data-layer round-trip (Builders).  For every page
// `body:` in the corpus: seed the builder tree, emit it back, splice over the
// body's CST range, re-parse, and assert an identical AST.  Recognize-or-opaque
// must lose nothing.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$refText === "string") return { $ref: o.$refText };
    if (typeof o.$type === "string") {
      const out: Record<string, unknown> = { $type: o.$type };
      for (const k of Object.keys(o)) if (!k.startsWith("$")) out[k] = norm(o[k]);
      return out;
    }
  }
  return v;
}

function collectDddFiles(): string[] {
  const dirs = [path.join(repoRoot, "examples"), path.join(repoRoot, "web/src/examples")];
  const out: string[] = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith(".ddd")) out.push(path.join(d, f));
  }
  return out.sort();
}

describe("page-builder model round-trip", () => {
  for (const file of collectDddFiles()) {
    const rel = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, "utf8");
    const original = parseRawResult(text);
    if (original.parserErrors.length > 0) continue; // fragments handled elsewhere

    const bodies: BodyProp[] = [];
    for (const node of AstUtils.streamAst(original.value) as Iterable<AstNode>) {
      if (node.$type === "BodyProp") bodies.push(node as BodyProp);
    }
    if (bodies.length === 0) continue;

    it(`round-trips ${bodies.length} page body/bodies in ${rel}`, () => {
      const normOrig = norm(original.value);
      for (const body of bodies) {
        const cst = body.expr.$cstNode;
        if (!cst) continue;
        const emitted = emitBody(seedFromBody(body.expr));
        const spliced = text.slice(0, cst.offset) + emitted + text.slice(cst.end);
        const re = parseRawResult(spliced);
        expect(re.parserErrors, `emitted body must parse:\n${emitted}`).toEqual([]);
        expect(norm(re.value), `emitted body must round-trip:\n${emitted}`).toEqual(normOrig);
      }
    });
  }
});

describe("page-builder model — primitive coverage", () => {
  // Seed → emit → splice → re-parse a body in isolation; assert identical AST.
  const roundtrips = (bodyExpr: string): void => {
    const doc = `system S { ui U { page P { body: ${bodyExpr} } } }`;
    const original = parseRawResult(doc);
    expect(original.parserErrors, `fixture must parse:\n${bodyExpr}`).toEqual([]);
    const body = [...AstUtils.streamAst(original.value)].find(
      (n) => n.$type === "BodyProp",
    ) as BodyProp;
    const cst = body.expr.$cstNode!;
    const emitted = emitBody(seedFromBody(body.expr));
    const spliced = doc.slice(0, cst.offset) + emitted + doc.slice(cst.end);
    const re = parseRawResult(spliced);
    expect(re.parserErrors, `emitted must parse:\n${emitted}`).toEqual([]);
    expect(norm(re.value), `emitted must round-trip:\n${emitted}`).toEqual(norm(original.value));
  };

  for (const bodyExpr of [
    "List { of: Order }",
    'CreateForm { of: Order, testid: "orders-new" }',
    "CreateForm { of: Product }",
    "OperationForm { account.withdraw }",
    "WorkflowForm { runs: PlaceOrder }",
    'Badge { "Alpha", color: "blue" }',
    // Expression-valued props (the `expr` prop kind): data-bound args must
    // round-trip verbatim, not collapse the whole call to Opaque.
    "Badge { order.status }",
    'Badge { line.total, color: "green" }',
    "Badge { format(amount) }",
    'Alert { "Couldn\'t load" }',
    'Anchor { "Home", to: "/" }',
    "Divider {}",
    'Empty { "Nothing here" }',
    'Grid { Text { "a" }, Text { "b" }, Text { "c" } }',
    'Toolbar { Button { "Save" }, Button { "Cancel" } }',
    'Stack { Heading { "Title", level: 2 }, List { of: Order } }',
    // Containers with props: titled/modified containers whose
    // children must remain editable nodes, not collapse to Opaque.
    'Card { "Summary", Stack { Text { "hi" } } }',
    'Card { Stack { Text { "untitled" } } }',
    'Card { "Just a title" }',
    'Container { Stack { Text { "x" } }, size: "md" }',
    'Paper { Text { "p" }, padding: "lg" }',
    // remaining stdlib scalar/expr primitives.
    'Stat { "Active users", "1,247" }',
    'Stat { "Revenue", order.total }',
    "Money { line.subtotal }",
    "DateDisplay { order.placedAt }",
    "EnumBadge { order.status }",
    "IdLink { order.id, of: Order }",
    'Field { "Your name", bind: userName }',
    'NumberField { "Quantity", bind: qty }',
    'PasswordField { "Password", bind: passphrase }',
    'Toggle { "Notifications", bind: notifications }',
    'Image { src: "/logo.png", alt: "Logo" }',
    'Avatar { alt: "User" }',
    "Skeleton { count: 5 }",
    "Loader {}",
    "Slot {}",
    'Breadcrumbs { Anchor { "Home", to: "/" }, Text { "Orders" } }',
    'KeyValueRow { "Total", Text { "42" } }',
    'KeyValueRow { "Total", order.total }',
    // Tabs holds editable Tab children, each with a title + body.
    'Tabs { Tab { "Overview", Text { "a" } }, Tab { "Details", List { of: Order } } }',
    'Card { "Tabs", Tabs { Tab { "Overview", Text { "Overview tab body" } } } }',
    // lambdas (expression body) and Table/Column accessors.
    'Table { rows: orders, Column { "ID", o => IdLink { o.id, of: Order } }, Column { "Status", o => EnumBadge { o.status } } }',
    'Column { "Name", o => Text { o.name } }',
    // match: predicate arms with value children + optional else.
    'match {\n  step == 0 => Text { "first" }\n  step == 1 => Text { "second" }\n}',
    'match {\n  step == 1 => List { of: Order },\n  else => Empty { "loading" }\n}',
    // Named-arg child slots: QueryView branches, Table callbacks, Modal trigger
    // are nested editable nodes rather than collapsing the parent to Opaque.
    'QueryView { of: orders, loading: Skeleton { count: 5 }, empty: Empty { "none" }, data: List { of: Order } }',
    'QueryView { of: orders, data: rows => Table { Column { "ID", o => Text { o.id } }, rows: rows } }',
    'Table { Column { "Name", o => Text { o.name } }, rows: orders, rowTestid: r => "row-" + r.id }',
    'Modal { CreateForm { of: Order }, trigger: Button { "Edit" } }',
    // Non-canonical arg order (a positional after a named arg) must round-trip
    // by preserving the source ordering, not fall back to Opaque.
    'Badge { color: "blue", order.status }',
    'Container { size: "md", Stack { Text { "x" } } }',
    'Table { rows: orders, Column { "ID", o => Text { o.id } }, Column { "Name", o => Text { o.name } } }',
    'Table { rows: orders, rowTestid: r => "row-" + r.id, Column { "ID", o => IdLink { o.id, of: Order } } }',
    // Passthrough modifiers (unmodelled named args) and optional positionals
    // must round-trip rather than collapse the node to Opaque.
    "Empty {}",
    'Stack { Text { "x" }, testid: "panel" }',
    'Toolbar { Heading { "Orders", level: 2 }, testid: "bar" }',
    'Table { Column { "ID", o => Text { o.id } }, rows: orders, striped: true, sticky: true }',
    // Text content that is an expression (not a bare string literal).
    'Text { "Hello, " + userName }',
    "Heading { pageTitle, level: 1 }",
    // Event-handler lambdas keep the carrying primitive recognised (the handler
    // round-trips as a passthrough prop).
    'Button { "Save", onClick: e => save() }',
    'Button { "Increment", onClick: e => { count := count + 1 } }',
    // Qualified refs in a `ref` slot.
    "CreateForm { of: Sales.Order }",
    "IdLink { o.id, of: Catalog.Product }",
    // Detail / MasterDetail primitives.
    "Detail { of: Order, by: id }",
    "MasterDetail { of: Order, scope: Orders.byCustomer(c), detail: o => Stack { Text { o.name } } }",
    // Block-bodied (statement) handler lambdas in a named-child slot.
    'Table { rows: orders, onRowClick: r => {\n  select(r.id)\n}, Column { "ID", o => Text { o.id } } }',
    'Table { rows: orders, onRowClick: r => {\n  let x = r.id\n  select(x)\n}, Column { "ID", o => Text { o.id } } }',
  ]) {
    it(`round-trips ${bodyExpr}`, () => roundtrips(bodyExpr));
  }
});

describe("page-builder model — user-defined component calls", () => {
  const seedWith = (bodyExpr: string, comps: Record<string, string[]>) => {
    const doc = `system S { ui U { page P { body: ${bodyExpr} } } }`;
    const original = parseRawResult(doc);
    expect(original.parserErrors, `fixture must parse:\n${bodyExpr}`).toEqual([]);
    const body = [...AstUtils.streamAst(original.value)].find(
      (n) => n.$type === "BodyProp",
    ) as BodyProp;
    const node = seedFromBody(body.expr, new Map(Object.entries(comps)));
    const cst = body.expr.$cstNode!;
    const spliced = doc.slice(0, cst.offset) + emitBody(node) + doc.slice(cst.end);
    const re = parseRawResult(spliced);
    expect(re.parserErrors, `emitted must parse:\n${emitBody(node)}`).toEqual([]);
    expect(norm(re.value)).toEqual(norm(original.value));
    return node;
  };

  it("recognises a component call (positional args → param-named props)", () => {
    const node = seedWith("OrderPanel { order }", { OrderPanel: ["panelOrder"] });
    expect(node.name).toBe("OrderPanel");
    expect(node.props.panelOrder).toBe("order");
  });

  it("keeps a non-component call (a value function) Opaque", () => {
    // `format` isn't a component, so it stays a value expression, not a node.
    const node = seedWith("Text { format(amount) }", { OrderPanel: ["order"] });
    expect(node.name).toBe("Text");
    expect(node.props.text).toBe("format(amount)");
  });

  it("recognises a component nested in a MasterDetail detail lambda", () => {
    const node = seedWith("MasterDetail { of: Order, detail: o => OrderPanel { o } }", {
      OrderPanel: ["order"],
    });
    expect(node.name).toBe("MasterDetail");
    const detail = node.children.find((c) => c.slot === "detail")!;
    expect(detail.name).toBe("Lambda");
    expect(detail.children[0].name).toBe("OrderPanel");
    expect(detail.children[0].props.order).toBe("o");
  });
});

describe("page-builder model — per-position enum inference", () => {
  // Inference is local: an enum-typed state-field bare-ident assignment target
  // gets an enum-case picker for its value; everything else stays free text.
  // We parse a real page with a `state {}` block and consult `enumStateFields`
  // against an `enums` map (the same shape `BuilderPane.collectEnums` builds).
  const pageWith = (stateBody: string): Page => {
    const doc = `system S { context C { enum OrderStatus { New, Confirmed, Shipped } } ui U { page P { ${stateBody} body: Text { "x" } } } }`;
    const r = parseRawResult(doc);
    expect(r.parserErrors).toEqual([]);
    const page = [...AstUtils.streamAst(r.value)].find((n) => n.$type === "Page") as Page;
    return page;
  };
  const enums = new Map<string, readonly string[]>([["OrderStatus", ["New", "Confirmed", "Shipped"]]]);

  it("indexes enum-typed state fields by name → enum name", () => {
    const page = pageWith("state { status: OrderStatus notes: string count: int }");
    const fields = enumStateFields(page, enums);
    expect(fields.size).toBe(1);
    expect(fields.get("status")).toBe("OrderStatus");
  });

  it("skips state fields whose named base isn't in the enums map", () => {
    // `Order` is a named type (an aggregate id-ref shape elsewhere); without an
    // entry in the enums map it must not be claimed by the inference.
    const page = pageWith("state { o: OrderStatus x: Order }");
    const fields = enumStateFields(page, enums);
    expect([...fields.keys()].sort()).toEqual(["o"]);
  });

  it("returns an empty map for a page with no state block", () => {
    const page = pageWith("");
    expect(enumStateFields(page, enums).size).toBe(0);
  });

  it("returns the expected enum for a bare-ident assignment target", () => {
    const fields = new Map([["status", "OrderStatus"]]);
    expect(expectedAssignEnum("status", fields)).toBe("OrderStatus");
    // Trims incidental whitespace from the structured target field.
    expect(expectedAssignEnum("  status  ", fields)).toBe("OrderStatus");
  });

  it("declines non-bare-ident targets (member access, calls, empty)", () => {
    const fields = new Map([["status", "OrderStatus"]]);
    expect(expectedAssignEnum("draft.status", fields)).toBeNull();
    expect(expectedAssignEnum("draft[status]", fields)).toBeNull();
    expect(expectedAssignEnum("set()", fields)).toBeNull();
    expect(expectedAssignEnum("", fields)).toBeNull();
  });

  it("returns null for an unknown bare ident (not a state field)", () => {
    const fields = new Map([["status", "OrderStatus"]]);
    expect(expectedAssignEnum("notAField", fields)).toBeNull();
  });
});

describe("page-builder model — container-with-props seed shape", () => {
  const seed = (bodyExpr: string) => {
    const doc = `system S { ui U { page P { body: ${bodyExpr} } } }`;
    const original = parseRawResult(doc);
    expect(original.parserErrors, `fixture must parse:\n${bodyExpr}`).toEqual([]);
    const body = [...AstUtils.streamAst(original.value)].find(
      (n) => n.$type === "BodyProp",
    ) as BodyProp;
    return seedFromBody(body.expr);
  };

  it("recognises Card title + nested children (not Opaque)", () => {
    const node = seed('Card { "Summary", Stack { Text { "hi" } } }');
    expect(node.name).toBe("Card");
    expect(node.props.title).toBe("Summary");
    expect(node.children.map((c) => c.name)).toEqual(["Stack"]);
    const stack = node.children[0];
    expect(stack.children.map((c) => c.name)).toEqual(["Text"]);
    // `text`-kind content stores the source expression form (a quoted literal).
    expect(stack.children[0].props.text).toBe('"hi"');
  });

  it("treats a leading call as content (no title)", () => {
    const node = seed('Card { Stack { Text { "x" } } }');
    expect(node.name).toBe("Card");
    expect(node.props.title).toBeUndefined();
    expect(node.children.map((c) => c.name)).toEqual(["Stack"]);
  });

  it("recognises Container/Paper named modifiers + children", () => {
    const container = seed('Container { Stack { Text { "x" } }, size: "md" }');
    expect(container.name).toBe("Container");
    expect(container.props.size).toBe("md");
    expect(container.children.map((c) => c.name)).toEqual(["Stack"]);

    const paper = seed('Paper { Text { "p" }, padding: "lg" }');
    expect(paper.name).toBe("Paper");
    expect(paper.props.padding).toBe("lg");
    expect(paper.children.map((c) => c.name)).toEqual(["Text"]);
  });

  it("recognises the real Table form (named rows: before positional Columns)", () => {
    const node = seed(
      'Table { rows: orders, Column { "ID", o => Text { o.id } }, Column { "Name", o => Text { o.name } } }',
    );
    expect(node.name).toBe("Table");
    expect(node.props.rows).toBe("orders");
    expect(node.children.map((c) => c.name)).toEqual(["Column", "Column"]);
    // The named-before-positional ordering is recorded so emit replays it.
    expect(emitBody(node)).toBe(
      'Table { rows: orders, Column { "ID", o => Text { o.id } }, Column { "Name", o => Text { o.name } } }',
    );
    // And it survives the craft serialization round-trip.
    expect(emitBody(fromCraft(toCraft(node)))).toBe(emitBody(node));
  });

  it("keeps unmodelled named modifiers as passthrough props (not Opaque)", () => {
    const node = seed('Stack { Text { "x" }, testid: "panel" }');
    expect(node.name).toBe("Stack");
    expect(node.props.testid).toBe('"panel"');
    expect(node.children.map((c) => c.name)).toEqual(["Text"]);
    expect(emitBody(node)).toBe('Stack { Text { "x" }, testid: "panel" }');
  });

  it("recognises expression-valued text content (not Opaque)", () => {
    const node = seed('Text { "Hello, " + userName }');
    expect(node.name).toBe("Text");
    expect(node.props.text).toBe('"Hello, " + userName');
  });

  it("models an event-handler lambda as an editable slot child", () => {
    const node = seed('Button { "Increment", onClick: e => { count := count + 1 } }');
    expect(node.name).toBe("Button");
    expect(node.props.label).toBe('"Increment"');
    const handler = node.children.find((c) => c.slot === "onClick")!;
    expect(handler.name).toBe("Lambda");
    expect(handler.props.__block).toBe("1");
    // The assignment statement is modelled with structured target/op/value.
    const stmt = handler.children[0];
    expect(stmt.name).toBe("Stmt");
    expect(stmt.props).toMatchObject({
      kind: "assign",
      target: "count",
      op: ":=",
      value: "count + 1",
    });
  });

  it("structures an assignment statement but keeps other statements raw", () => {
    const node = seed(
      'Table { rows: r, onRowClick: x => {\n  draft.id := x.id\n  refresh()\n}, Column { "ID", o => Text { o.id } } }',
    );
    const lambda = node.children.find((c) => c.slot === "onRowClick")!;
    expect(lambda.children[0].props).toMatchObject({
      kind: "assign",
      target: "draft.id",
      value: "x.id",
    });
    expect(lambda.children[1].props.src).toBe("refresh()");
  });

  it("structures a navigate(...) statement into target page + params", () => {
    const node = seed(
      'Button { "Go", onClick: e => {\n  navigate(OrderConsole, draft.customerId)\n} }',
    );
    const handler = node.children.find((c) => c.slot === "onClick")!;
    expect(handler.children[0].props).toMatchObject({
      kind: "navigate",
      to: "OrderConsole",
      params: "draft.customerId",
    });
    expect(emitBody(fromCraft(toCraft(node)))).toBe(emitBody(node));
  });

  it("structures navigate without params", () => {
    const node = seed('Button { "Go", onClick: e => {\n  navigate(Home)\n} }');
    const handler = node.children.find((c) => c.slot === "onClick")!;
    expect(handler.children[0].props).toMatchObject({ kind: "navigate", to: "Home", params: "" });
    expect(emitBody(node)).toContain("navigate(Home)");
  });

  it("falls back to a bare stmt when navigate's target is not a NameRef", () => {
    // Loom's `navigate` takes a NameRef page; a non-NameRef first arg shouldn't
    // be structured (we'd have no safe round-trip), so we keep the original
    // source verbatim instead of crashing or producing a malformed nav row.
    const node = seed('Button { "Go", onClick: e => {\n  navigate(pickPage(x))\n} }');
    const handler = node.children.find((c) => c.slot === "onClick")!;
    expect(handler.children[0].name).toBe("Stmt");
    expect(handler.children[0].props.kind).toBeUndefined();
    expect(handler.children[0].props.src).toBe("navigate(pickPage(x))");
  });

  it("structures `let` and keeps a bare call verbatim, both round-tripping", () => {
    const node = seed(
      'Button { "Go", onClick: e => {\n  let total = order.total + 1\n  refresh(order)\n} }',
    );
    const handler = node.children.find((c) => c.slot === "onClick")!;
    expect(handler.children[0].props).toMatchObject({
      kind: "let",
      name: "total",
      value: "order.total + 1",
    });
    expect(handler.children[1].props.src).toBe("refresh(order)");
    expect(emitBody(fromCraft(toCraft(node)))).toBe(emitBody(node));
  });

  it("models a block-handler lambda slot as editable statement rows", () => {
    const node = seed(
      'Table { rows: orders, onRowClick: r => {\n  let x = r.id\n  select(x)\n}, Column { "ID", o => Text { o.id } } }',
    );
    const handler = node.children.find((c) => c.slot === "onRowClick")!;
    expect(handler.name).toBe("Lambda");
    expect(handler.props.param).toBe("r");
    expect(handler.props.__block).toBe("1");
    expect(handler.children.map((c) => c.name)).toEqual(["Stmt", "Stmt"]);
    // `let` is structured (name / value); the bare call stays a verbatim src row.
    expect(handler.children[0].props).toMatchObject({ kind: "let", name: "x", value: "r.id" });
    expect(handler.children[1].props.src).toBe("select(x)");
    // __block + statement rows survive the craft serialization round-trip.
    expect(emitBody(fromCraft(toCraft(node)))).toBe(emitBody(node));
  });

  it("recognises a qualified ref binding", () => {
    const node = seed("CreateForm { of: Sales.Order }");
    expect(node.name).toBe("CreateForm");
    expect(node.props.of).toBe("Sales.Order");
  });

  it("recognises the instance-qualified operation form + runs binding", () => {
    const op = seed("OperationForm { account.withdraw }");
    expect(op.name).toBe("OperationForm");
    expect(op.props.operation).toBe("account.withdraw");
    const wf = seed("WorkflowForm { runs: PlaceOrder }");
    expect(wf.name).toBe("WorkflowForm");
    expect(wf.props.runs).toBe("PlaceOrder");
  });

  it("recognises a call with optional positionals omitted", () => {
    expect(seed("Empty {}").name).toBe("Empty");
    expect(seed("Heading {}").name).toBe("Heading");
  });

  it("emits an as-yet-empty single-child slot as a placeholder", () => {
    const lambda: BuilderNode = { name: "Lambda", props: { param: "x" }, children: [] };
    expect(emitBody(lambda)).toBe("x => Empty {}");
  });

  it("emits a match else last regardless of child order", () => {
    const node: BuilderNode = {
      name: "Match",
      props: {},
      children: [
        {
          name: "MatchElse",
          props: {},
          children: [{ name: "Empty", props: { message: "n" }, children: [] }],
        },
        {
          name: "MatchArm",
          props: { cond: "1 == 1" },
          children: [{ name: "Text", props: { text: "a" }, children: [] }],
        },
      ],
    };
    const out = emitBody(node);
    expect(out.indexOf("else =>")).toBeGreaterThan(out.indexOf("1 == 1 =>"));
    // And it re-parses cleanly.
    expect(parseRawResult(`system S { ui U { page P { body: ${out} } } }`).parserErrors).toEqual(
      [],
    );
  });

  it("models named-arg child slots and survives the craft round-trip", () => {
    const node = seed(
      'QueryView { of: orders, loading: Skeleton { count: 5 }, data: rows => Table { Column { "ID", o => Text { o.id } }, rows: rows } }',
    );
    expect(node.name).toBe("QueryView");
    expect(node.props.of).toBe("orders");
    const slots = node.children.map((c) => c.slot);
    expect(slots).toEqual(["loading", "data"]);
    const data = node.children.find((c) => c.slot === "data")!;
    expect(data.name).toBe("Lambda");
    expect(data.children[0].name).toBe("Table");

    // The slot tag must round-trip through craft's SerializedNodes shape, then
    // re-emit identically.
    const recovered = fromCraft(toCraft(node));
    expect(recovered.children.map((c) => c.slot)).toEqual(["loading", "data"]);
    expect(emitBody(recovered)).toBe(emitBody(node));
  });

  it("recognises Tabs with nested editable Tab children", () => {
    const node = seed(
      'Tabs { Tab { "Overview", Text { "a" } }, Tab { "Details", List { of: Order } } }',
    );
    expect(node.name).toBe("Tabs");
    expect(node.children.map((c) => c.name)).toEqual(["Tab", "Tab"]);
    const [tab1, tab2] = node.children;
    expect(tab1.props.label).toBe("Overview");
    expect(tab1.children.map((c) => c.name)).toEqual(["Text"]);
    expect(tab2.props.label).toBe("Details");
    expect(tab2.children[0].props.of).toBe("Order");
  });

  it("models a lambda as param + body child", () => {
    const node = seed('Column { "Status", o => EnumBadge { o.status } }');
    expect(node.name).toBe("Column");
    expect(node.props.header).toBe("Status");
    const lambda = node.children[0];
    expect(lambda.name).toBe("Lambda");
    expect(lambda.props.param).toBe("o");
    expect(lambda.children[0].name).toBe("EnumBadge");
    expect(lambda.children[0].props.value).toBe("o.status");
  });

  it("models a block-bodied lambda as a Lambda with statement rows", () => {
    const node = seed('Column { "X", o => { let y = o.id } }');
    expect(node.name).toBe("Column");
    const lambda = node.children[0];
    expect(lambda.name).toBe("Lambda");
    expect(lambda.props.__block).toBe("1");
    expect(lambda.children.map((c) => c.name)).toEqual(["Stmt"]);
    expect(lambda.children[0].props).toMatchObject({ kind: "let", name: "y", value: "o.id" });
  });

  it("models match arms with cond + value children and an else", () => {
    const node = seed('match {\n  step == 0 => Text { "first" }\n  else => Empty { "none" }\n}');
    expect(node.name).toBe("Match");
    expect(node.children.map((c) => c.name)).toEqual(["MatchArm", "MatchElse"]);
    const [arm, els] = node.children;
    expect(arm.props.cond).toBe("step == 0");
    expect(arm.children[0].name).toBe("Text");
    expect(els.children[0].name).toBe("Empty");
  });

  it("recognises data-bound expr props (not Opaque)", () => {
    const member = seed("Badge { order.status }");
    expect(member.name).toBe("Badge");
    expect(member.props.value).toBe("order.status");

    const call = seed('Badge { format(amount), color: "green" }');
    expect(call.name).toBe("Badge");
    expect(call.props.value).toBe("format(amount)");
    expect(call.props.color).toBe("green");

    // A string literal in an expr slot round-trips through the printer
    // (re-quoted), still recognised as a Badge rather than Opaque.
    const lit = seed('Badge { "Alpha" }');
    expect(lit.name).toBe("Badge");
    expect(lit.props.value).toBe('"Alpha"');
  });
});
