import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EmptyFileSystem, AstUtils, type AstNode } from "langium";
import { createDddServices } from "../src/language/ddd-module.js";
import { seedFromBody, emitBody } from "../web/src/builder/page/model.js";
import type { BodyProp } from "../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Page-builder data-layer round-trip (Builders, Phase 1).  For every page
// `body:` in the corpus: seed the builder tree, emit it back, splice over the
// body's CST range, re-parse, and assert an identical AST.  Recognize-or-opaque
// must lose nothing.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;

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
    const original = parser.parse(text);
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
        const re = parser.parse(spliced);
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
    const original = parser.parse(doc);
    expect(original.parserErrors, `fixture must parse:\n${bodyExpr}`).toEqual([]);
    const body = [...AstUtils.streamAst(original.value)].find((n) => n.$type === "BodyProp") as BodyProp;
    const cst = body.expr.$cstNode!;
    const emitted = emitBody(seedFromBody(body.expr));
    const spliced = doc.slice(0, cst.offset) + emitted + doc.slice(cst.end);
    const re = parser.parse(spliced);
    expect(re.parserErrors, `emitted must parse:\n${emitted}`).toEqual([]);
    expect(norm(re.value), `emitted must round-trip:\n${emitted}`).toEqual(norm(original.value));
  };

  for (const bodyExpr of [
    'List(of: Order)',
    'Form(of: Order, testid: "orders-new")',
    'Form(creates: Product)',
    'Badge("Alpha", color: "blue")',
    // Expression-valued props (the `expr` prop kind): data-bound args must
    // round-trip verbatim, not collapse the whole call to Opaque.
    'Badge(order.status)',
    'Badge(line.total, color: "green")',
    'Badge(format(amount))',
    'Alert("Couldn\'t load")',
    'Anchor("Home", to: "/")',
    'Divider()',
    'Empty("Nothing here")',
    'Grid(Text("a"), Text("b"), Text("c"))',
    'Toolbar(Button("Save"), Button("Cancel"))',
    'Stack(Heading("Title", level: 2), List(of: Order))',
    // Containers with props (Phase A): titled/modified containers whose
    // children must remain editable nodes, not collapse to Opaque.
    'Card("Summary", Stack(Text("hi")))',
    'Card(Stack(Text("untitled")))',
    'Card("Just a title")',
    'Container(Stack(Text("x")), size: "md")',
    'Paper(Text("p"), padding: "lg")',
    // Phase 2 — remaining stdlib scalar/expr primitives.
    'Stat("Active users", "1,247")',
    'Stat("Revenue", order.total)',
    'Money(line.subtotal)',
    'DateDisplay(order.placedAt)',
    'EnumBadge(order.status)',
    'IdLink(order.id, of: Order)',
    'Field("Your name", bind: userName)',
    'NumberField("Quantity", bind: qty)',
    'PasswordField("Password", bind: secret)',
    'Toggle("Notifications", bind: notifications)',
    'Image(src: "/logo.png", alt: "Logo")',
    'Avatar(alt: "User")',
    'Skeleton(count: 5)',
    'Loader()',
    'Slot()',
    'Breadcrumbs(Anchor("Home", to: "/"), Text("Orders"))',
    'KeyValueRow("Total", Text("42"))',
    'KeyValueRow("Total", order.total)',
    // Phase 3 — Tabs holds editable Tab children, each with a title + body.
    'Tabs(Tab("Overview", Text("a")), Tab("Details", List(of: Order)))',
    'Card("Tabs", Tabs(Tab("Overview", Text("Overview tab body"))))',
    // Phase 4 — lambdas (expression body) and Table/Column accessors.
    'Table(rows: orders, Column("ID", o => IdLink(o.id, of: Order)), Column("Status", o => EnumBadge(o.status)))',
    'Column("Name", o => Text(o.name))',
    // Phase 5 — match: predicate arms with value children + optional else.
    'match {\n  step == 0 => Text("first")\n  step == 1 => Text("second")\n}',
    'match {\n  step == 1 => List(of: Order),\n  else => Empty("loading")\n}',
  ]) {
    it(`round-trips ${bodyExpr}`, () => roundtrips(bodyExpr));
  }
});

describe("page-builder model — container-with-props seed shape", () => {
  const seed = (bodyExpr: string) => {
    const doc = `system S { ui U { page P { body: ${bodyExpr} } } }`;
    const original = parser.parse(doc);
    expect(original.parserErrors, `fixture must parse:\n${bodyExpr}`).toEqual([]);
    const body = [...AstUtils.streamAst(original.value)].find((n) => n.$type === "BodyProp") as BodyProp;
    return seedFromBody(body.expr);
  };

  it("recognises Card title + nested children (not Opaque)", () => {
    const node = seed('Card("Summary", Stack(Text("hi")))');
    expect(node.name).toBe("Card");
    expect(node.props.title).toBe("Summary");
    expect(node.children.map((c) => c.name)).toEqual(["Stack"]);
    const stack = node.children[0];
    expect(stack.children.map((c) => c.name)).toEqual(["Text"]);
    expect(stack.children[0].props.text).toBe("hi");
  });

  it("treats a leading call as content (no title)", () => {
    const node = seed('Card(Stack(Text("x")))');
    expect(node.name).toBe("Card");
    expect(node.props.title).toBeUndefined();
    expect(node.children.map((c) => c.name)).toEqual(["Stack"]);
  });

  it("recognises Container/Paper named modifiers + children", () => {
    const container = seed('Container(Stack(Text("x")), size: "md")');
    expect(container.name).toBe("Container");
    expect(container.props.size).toBe("md");
    expect(container.children.map((c) => c.name)).toEqual(["Stack"]);

    const paper = seed('Paper(Text("p"), padding: "lg")');
    expect(paper.name).toBe("Paper");
    expect(paper.props.padding).toBe("lg");
    expect(paper.children.map((c) => c.name)).toEqual(["Text"]);
  });

  it("recognises Tabs with nested editable Tab children", () => {
    const node = seed('Tabs(Tab("Overview", Text("a")), Tab("Details", List(of: Order)))');
    expect(node.name).toBe("Tabs");
    expect(node.children.map((c) => c.name)).toEqual(["Tab", "Tab"]);
    const [tab1, tab2] = node.children;
    expect(tab1.props.label).toBe("Overview");
    expect(tab1.children.map((c) => c.name)).toEqual(["Text"]);
    expect(tab2.props.label).toBe("Details");
    expect(tab2.children[0].props.of).toBe("Order");
  });

  it("models a lambda as param + body child", () => {
    const node = seed('Column("Status", o => EnumBadge(o.status))');
    expect(node.name).toBe("Column");
    expect(node.props.header).toBe("Status");
    const lambda = node.children[0];
    expect(lambda.name).toBe("Lambda");
    expect(lambda.props.param).toBe("o");
    expect(lambda.children[0].name).toBe("EnumBadge");
    expect(lambda.children[0].props.value).toBe("o.status");
  });

  it("keeps a block-bodied lambda Opaque", () => {
    const node = seed("Column(\"X\", o => { let y = o.id })");
    expect(node.name).toBe("Column");
    expect(node.children[0].name).toBe("Opaque");
  });

  it("models match arms with cond + value children and an else", () => {
    const node = seed('match {\n  step == 0 => Text("first")\n  else => Empty("none")\n}');
    expect(node.name).toBe("Match");
    expect(node.children.map((c) => c.name)).toEqual(["MatchArm", "MatchElse"]);
    const [arm, els] = node.children;
    expect(arm.props.cond).toBe("step == 0");
    expect(arm.children[0].name).toBe("Text");
    expect(els.children[0].name).toBe("Empty");
  });

  it("recognises data-bound expr props (not Opaque)", () => {
    const member = seed("Badge(order.status)");
    expect(member.name).toBe("Badge");
    expect(member.props.value).toBe("order.status");

    const call = seed("Badge(format(amount), color: \"green\")");
    expect(call.name).toBe("Badge");
    expect(call.props.value).toBe("format(amount)");
    expect(call.props.color).toBe("green");

    // A string literal in an expr slot round-trips through the printer
    // (re-quoted), still recognised as a Badge rather than Opaque.
    const lit = seed('Badge("Alpha")');
    expect(lit.name).toBe("Badge");
    expect(lit.props.value).toBe('"Alpha"');
  });
});
