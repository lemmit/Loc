import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import type { BodyProp } from "../../../src/language/generated/ast.js";
import {
  type BuilderNode,
  defaultForItemLambda,
  defaultNode,
  emitBody,
  PALETTE_PRIMITIVES,
  type SPECS,
  seedFromBody,
} from "../../../web/src/builder/page/model.js";
import { fromCraft, toCraft } from "../../../web/src/builder/page/serialize.js";
import { parseRawResult } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Page-builder coverage for the primitives that used to collapse to `Opaque`:
// the layout wrappers (Section/Sticky), the input family (MultilineField/
// SelectField/FileUpload), the inline-emphasis + display leaves (Bold/Italic/
// InlineCode/FileLink/ProvenanceInfo/CodeBlock/Icon), the destroy form, and the
// `For` comprehension with its item lambda.
//
// Each case asserts BOTH halves of the recognize-or-opaque contract: the body
// seeds into a STRUCTURED node (never `Opaque`), and emitting that node back
// over the body's CST range re-parses to an identical AST.
// ---------------------------------------------------------------------------

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

/** Seed a page body in isolation; assert the fixture itself parses. */
function seed(bodyExpr: string): { node: BuilderNode; check: () => void } {
  const doc = `system S { ui U { page P { body: ${bodyExpr} } } }`;
  const original = parseRawResult(doc);
  expect(original.parserErrors, `fixture must parse:\n${bodyExpr}`).toEqual([]);
  const body = [...AstUtils.streamAst(original.value)].find(
    (n) => n.$type === "BodyProp",
  ) as BodyProp;
  const cst = body.expr.$cstNode!;
  const node = seedFromBody(body.expr);
  // Seed → emit → splice → re-parse → identical AST.
  const check = (): void => {
    const emitted = emitBody(node);
    const spliced = doc.slice(0, cst.offset) + emitted + doc.slice(cst.end);
    const re = parseRawResult(spliced);
    expect(re.parserErrors, `emitted must parse:\n${emitted}`).toEqual([]);
    expect(norm(re.value), `emitted must round-trip:\n${emitted}`).toEqual(norm(original.value));
  };
  return { node, check };
}

/** Names of the 14 primitives this slice taught the builder. */
const NEW_PRIMITIVES = [
  "Section",
  "Sticky",
  "MultilineField",
  "SelectField",
  "FileUpload",
  "Bold",
  "Italic",
  "InlineCode",
  "FileLink",
  "ProvenanceInfo",
  "CodeBlock",
  "Icon",
  "DestroyForm",
  "For",
] as const;

describe("page-builder — newly-modelled primitives round-trip", () => {
  // One canonical body per primitive, in the shape the walker registry and the
  // shipped examples actually use.
  const cases: Array<[(typeof NEW_PRIMITIVES)[number], string]> = [
    ["Section", 'Section { id: "vision", Stack { Text { "a" } } }'],
    ["Section", 'Section { Heading { "Plain", level: 2 } }'],
    ["Sticky", 'Sticky { top: "0", Container { Text { "nav" }, size: "xl" } }'],
    ["MultilineField", 'MultilineField { "Notes", bind: notes }'],
    ["SelectField", 'SelectField { "Visibility", bind: vis, options: ["Private", "Public"] }'],
    ["SelectField", 'SelectField { "Owner", bind: owner, options: owners }'],
    ["FileUpload", 'FileUpload { "Attachment", bind: attachment }'],
    ["Bold", 'Bold { "bold" }'],
    ["Italic", 'Italic { "italic" }'],
    ["InlineCode", 'InlineCode { ".ddd" }'],
    ["FileLink", "FileLink { attachment }"],
    ["FileLink", "FileLink { data.blob }"],
    ["ProvenanceInfo", 'ProvenanceInfo { of: data, field: "total" }'],
    ["ProvenanceInfo", 'ProvenanceInfo { of: data, field: "total", testid: "orders-total-prov" }'],
    ["CodeBlock", 'CodeBlock { "const x = 1" }'],
    [
      "CodeBlock",
      'CodeBlock { source: "aggregate Order {}", language: "typescript", title: "orders.ddd" }',
    ],
    ["Icon", 'Icon { name: "star" }'],
    ["Icon", 'Icon { name: iconName, size: "md" }'],
    ["Icon", 'Icon { svg: "<svg viewBox=\'0 0 24 24\'></svg>", label: "Logo" }'],
    ["DestroyForm", "DestroyForm { of: Project }"],
    ["DestroyForm", 'DestroyForm { of: Project, testid: "projects-destroy" }'],
    ["For", "For { each: Cart.lines, line => Card { line } }"],
    ["For", 'For { each: orders, o => Text { o.id }, empty: Empty { "No orders yet." } }'],
  ];

  for (const [name, bodyExpr] of cases) {
    it(`seeds ${bodyExpr} as a structured ${name}`, () => {
      const { node, check } = seed(bodyExpr);
      expect(node.name).toBe(name);
      check();
    });
  }

  it("keeps a `source:` CodeBlock named and a positional one positional", () => {
    // Both shapes are admissible (the emitter reads `source:` first, else the
    // first positional literal); each must re-emit in the shape it was written.
    expect(emitBody(seed('CodeBlock { "const x = 1" }').node)).toBe('CodeBlock { "const x = 1" }');
    expect(emitBody(seed('CodeBlock { source: "const x = 1" }').node)).toBe(
      'CodeBlock { source: "const x = 1" }',
    );
  });

  it("models Section's id + nested children (not one Opaque blob)", () => {
    const { node } = seed('Section { id: "vision", Stack { Text { "a" } } }');
    expect(node.props.id).toBe("vision");
    expect(node.children.map((c) => c.name)).toEqual(["Stack"]);
    expect(node.children[0].children[0].props.text).toBe('"a"');
  });

  it("models the input family's label + bind (+ options)", () => {
    const multiline = seed('MultilineField { "Notes", bind: notes }').node;
    expect(multiline.props).toMatchObject({ label: "Notes", bind: "notes" });
    const select = seed(
      'SelectField { "Visibility", bind: vis, options: ["Private", "Public"] }',
    ).node;
    expect(select.props).toMatchObject({ label: "Visibility", bind: "vis" });
    expect(select.props.options).toBe('["Private", "Public"]');
    const upload = seed('FileUpload { "Attachment", bind: attachment }').node;
    expect(upload.props).toMatchObject({ label: "Attachment", bind: "attachment" });
  });

  it("models an Icon name that is an expression, not a literal", () => {
    const { node } = seed('Icon { name: iconName, size: "md" }');
    expect(node.props.name).toBe("iconName");
    expect(node.props.size).toBe("md");
    // A literal name stores its source form (quoted) and re-emits identically.
    expect(seed('Icon { name: "star" }').node.props.name).toBe('"star"');
  });

  it("models DestroyForm's aggregate binding", () => {
    const { node } = seed('DestroyForm { of: Project, testid: "projects-destroy" }');
    expect(node.props).toMatchObject({ of: "Project", testid: "projects-destroy" });
  });

  it("models a For item lambda as an editable Lambda child, body intact", () => {
    const { node, check } = seed("For { each: Cart.lines, line => Card { line } }");
    expect(node.name).toBe("For");
    expect(node.props.each).toBe("Cart.lines");
    const lambda = node.children[0];
    expect(lambda.name).toBe("Lambda");
    expect(lambda.props.param).toBe("line");
    expect(lambda.children.map((c) => c.name)).toEqual(["Card"]);
    check();
    // …and the lambda survives craft's SerializedNodes round-trip.
    expect(emitBody(fromCraft(toCraft(node)))).toBe(emitBody(node));
  });

  it("models a For `empty:` arm as a slot child", () => {
    const { node } = seed(
      'For { each: orders, o => Text { o.id }, empty: Empty { "No orders yet." } }',
    );
    expect(node.children.map((c) => c.slot)).toEqual([undefined, "empty"]);
    const empty = node.children[1];
    expect(empty.name).toBe("Empty");
    expect(empty.props.message).toBe('"No orders yet."');
  });

  it("keeps a For item lambda with a nested collection op intact", () => {
    const { node, check } = seed(
      "For { each: orders.filter(o => o.status == Confirmed), o => Text { o.id } }",
    );
    expect(node.props.each).toBe("orders.filter(o => o.status == Confirmed)");
    check();
  });
});

describe("page-builder — palette seeds parseable source", () => {
  // A freshly-added palette node emits its minimal form; every one of them must
  // be valid `.ddd` on its own, or "Apply to source" writes a broken body.
  for (const name of NEW_PRIMITIVES) {
    it(`a fresh ${name} emits parseable source`, () => {
      expect(PALETTE_PRIMITIVES, `${name} must be addable from the palette`).toContain(name);
      const emitted = emitBody(defaultNode(name as keyof typeof SPECS));
      const doc = `system S { ui U { page P { body: ${emitted} } } }`;
      expect(parseRawResult(doc).parserErrors, `fresh ${name} emitted:\n${emitted}`).toEqual([]);
    });
  }

  it("a fresh palette For is childless but still parses", () => {
    // The palette click-add path has no primitive shaped like a bare `Lambda`,
    // so a fresh `For` starts with no item renderer — the gap the "+ item"
    // control (PageBuilder.tsx's addForItem, tested below) closes.
    const node = defaultNode("For");
    expect(node.children).toEqual([]);
    expect(emitBody(node)).toBe("For {}");
  });
});

// ---------------------------------------------------------------------------
// The For "+ item" control (PageBuilder.tsx's addForItem) is the For twin of
// Match's "+ arm" (addArm): a synthetic `Lambda` child isn't reachable from
// the click-add palette, so a dedicated settings-panel control builds it.
// Driving craft.js itself is out of this suite's scope (the "+ arm" control
// it mirrors has no vitest coverage either — only the Playwright e2e spec
// exercises the live button); these tests instead pin the exact subtree the
// control builds (`defaultForItemLambda`, the single source of truth shared
// with addForItem) and prove it behaves like any other structured node once
// it lands on the canvas: it emits parseable source, seeds back as a
// structured (non-Opaque) `Lambda` whose body is independently editable, its
// binder renames like any other `param` field, and it coexists with a
// previously-seeded `empty:` slot child.
// ---------------------------------------------------------------------------
describe('page-builder — For "+ item" control', () => {
  it("builds a parseable item lambda with an editable placeholder body", () => {
    const item = defaultForItemLambda();
    expect(item).toMatchObject({ name: "Lambda", props: { param: "item" } });
    expect(item.children).toHaveLength(1);
    expect(item.children[0]).toMatchObject({ name: "Text" });

    const forNode: BuilderNode = { name: "For", props: {}, children: [item] };
    const emitted = emitBody(forNode);
    const doc = `system S { ui U { page P { body: ${emitted} } } }`;
    expect(parseRawResult(doc).parserErrors, `emitted:\n${emitted}`).toEqual([]);
  });

  it("adding the item lambda yields a structured (non-opaque) round-trip with the body editable", () => {
    const item = defaultForItemLambda();
    const forNode: BuilderNode = { name: "For", props: { each: "orders" }, children: [item] };
    const emitted = emitBody(forNode);
    const doc = `system S { ui U { page P { body: ${emitted} } } }`;
    const parsed = parseRawResult(doc);
    expect(parsed.parserErrors, `emitted:\n${emitted}`).toEqual([]);

    const body = [...AstUtils.streamAst(parsed.value)].find(
      (n) => n.$type === "BodyProp",
    ) as BodyProp;
    const reseeded = seedFromBody(body.expr);
    expect(reseeded.name).toBe("For");
    const lambda = reseeded.children[0];
    expect(lambda.name).toBe("Lambda"); // structured, not Opaque
    expect(lambda.props.param).toBe("item");
    const placeholder = lambda.children[0];
    expect(placeholder.name).toBe("Text"); // the body is independently editable
    expect(placeholder.props.text).toBe('"Text"');

    // ...and it survives craft's SerializedNodes round-trip, same as any other
    // seeded-from-source node (new-primitives-roundtrip's existing For case).
    expect(emitBody(fromCraft(toCraft(reseeded)))).toBe(emitBody(reseeded));
  });

  it("renaming the item lambda's binder round-trips", () => {
    const item = defaultForItemLambda();
    // Simulates the settings panel's generic `param` field (test id
    // `c4builder-prop-param`) — Lambda's binder is already editable there for
    // any Lambda node, item lambdas included; no separate wiring needed.
    item.props.param = "order";
    const forNode: BuilderNode = { name: "For", props: { each: "orders" }, children: [item] };
    const emitted = emitBody(forNode);
    expect(emitted).toContain("order => ");
    const doc = `system S { ui U { page P { body: ${emitted} } } }`;
    const parsed = parseRawResult(doc);
    expect(parsed.parserErrors, `emitted:\n${emitted}`).toEqual([]);

    const body = [...AstUtils.streamAst(parsed.value)].find(
      (n) => n.$type === "BodyProp",
    ) as BodyProp;
    expect(seedFromBody(body.expr).children[0].props.param).toBe("order");
  });

  it("keeps a previously-seeded `empty:` slot child intact alongside the new item lambda", () => {
    // A For seeded from source with only an `empty:` arm and no item renderer
    // — the shape the control targets — then grown via the control (simulated
    // here as `addForItem` mutates the craft tree: the new Lambda's node id is
    // appended after the existing children, everything else untouched).
    const doc0 = `system S { ui U { page P { body: For { each: orders, empty: Empty { "No orders yet." } } } } }`;
    const original = parseRawResult(doc0);
    expect(original.parserErrors).toEqual([]);
    const body0 = [...AstUtils.streamAst(original.value)].find(
      (n) => n.$type === "BodyProp",
    ) as BodyProp;
    const seeded = seedFromBody(body0.expr);
    expect(seeded.name).toBe("For");
    expect(seeded.children.map((c) => c.slot)).toEqual(["empty"]);

    seeded.children.push(defaultForItemLambda());

    const emitted = emitBody(seeded);
    const doc = `system S { ui U { page P { body: ${emitted} } } }`;
    const parsed = parseRawResult(doc);
    expect(parsed.parserErrors, `emitted:\n${emitted}`).toEqual([]);

    const body = [...AstUtils.streamAst(parsed.value)].find(
      (n) => n.$type === "BodyProp",
    ) as BodyProp;
    const reseeded = seedFromBody(body.expr);
    expect(reseeded.children.map((c) => [c.name, c.slot])).toEqual([
      ["Empty", "empty"],
      ["Lambda", undefined],
    ]);
  });
});
