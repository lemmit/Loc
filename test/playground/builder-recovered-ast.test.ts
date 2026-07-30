import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import type { Page } from "../../src/language/generated/ast.js";
import { collectBodies } from "../../web/src/builder/page/bodies.js";
import { emitBody, enumStateFields, seedFromBody } from "../../web/src/builder/page/model.js";
import { parseDdd } from "../../web/src/builder/parse.js";
import { buildViewGraph } from "../../web/src/builder/system-v2/view-graph.js";

// ---------------------------------------------------------------------------
// Recovered-AST safety for the builders.
//
// The page builder stays mounted in the background on desktop and re-parses the
// live source on a 350 ms debounce, so it renders against *partially recovered*
// ASTs on nearly every keystroke.  Langium's error recovery keeps the enclosing
// node and leaves the sub-node it couldn't parse `undefined`; dereferencing one
// threw in render, and with only an app-level ErrorBoundary that white-screened
// the whole playground.
//
// These are the shapes recovery actually produces (verified against the parser
// the builders use, `web/src/builder/parse.ts`), fed through the exact helpers
// the pane's memos call before its `parserErrors` guard can run.
// ---------------------------------------------------------------------------

const pageOf = (src: string, name: string): Page => {
  for (const n of AstUtils.streamAst(parseDdd(src).ast)) {
    if (n.$type === "Page" && (n as Page).name === name) return n as Page;
  }
  throw new Error(`no page ${name}`);
};

describe("builder — partially recovered ASTs", () => {
  it("a `body:` with no expression parses to `BodyProp.expr === undefined`", () => {
    const parsed = parseDdd(`system S { ui U { page P { body: } } }`);
    expect(parsed.parserErrors.length).toBeGreaterThan(0);
    const props = pageOf(`system S { ui U { page P { body: } } }`, "P").props;
    const body = props.find((p) => p.$type === "BodyProp");
    expect(body).toBeDefined();
    expect((body as { expr?: unknown }).expr).toBeUndefined();
  });

  it("collectBodies drops a page whose `body:` expression didn't parse", () => {
    const bodies = collectBodies(parseDdd(`system S { ui U { page P { body: } } }`).ast);
    expect(bodies).toEqual([]);
  });

  it("collectBodies still yields the pages whose bodies DID parse", () => {
    const src = `system S {
  ui U {
    page Ok { body: Stack { Text { text: "hi" } } }
    page Broken { body: }
  }
}`;
    expect(collectBodies(parseDdd(src).ast).map((b) => b.name)).toEqual(["Ok"]);
  });

  it("seedFromBody degrades to an empty Opaque node instead of throwing on a missing expression", () => {
    const node = seedFromBody(undefined);
    expect(node.name).toBe("Opaque");
    expect(node.props.raw).toBe("");
    expect(() => emitBody(node)).not.toThrow();
  });

  it("seedFromBody survives a match arm whose value didn't parse", () => {
    const src = `system S { ui U { page P { body: match { true => , else => Empty {} } } } }`;
    const parsed = parseDdd(src);
    expect(parsed.parserErrors.length).toBeGreaterThan(0);
    const [body] = collectBodies(parsed.ast);
    expect(body).toBeDefined();
    const node = seedFromBody(body.expr);
    expect(node.name).toBe("Match");
    // The unparsed arm value seeds as an empty Opaque child, the `else` intact.
    expect(node.children.map((c) => c.name)).toEqual(["MatchArm", "MatchElse"]);
    expect(node.children[0].children[0].name).toBe("Opaque");
    expect(() => emitBody(node)).not.toThrow();
  });

  it("seedFromBody survives a match `else` whose value didn't parse", () => {
    const src = `system S { ui U { page P { body: match { true => Empty {}, else => } } } }`;
    const [body] = collectBodies(parseDdd(src).ast);
    expect(() => emitBody(seedFromBody(body.expr))).not.toThrow();
  });

  it("seedFromBody survives a legacy call with a missing argument", () => {
    const src = `system S { ui U { page P { body: Stack(Text(), ) } } }`;
    const [body] = collectBodies(parseDdd(src).ast);
    expect(() => emitBody(seedFromBody(body.expr))).not.toThrow();
  });

  it("a `state { x: }` with no type parses to `StateField.type === undefined`", () => {
    const src = `system S { ui U { page P { state { x: } body: Stack {} } } }`;
    const page = pageOf(src, "P");
    const sb = page.props.find((p) => p.$type === "StateBlock") as { fields: { type?: unknown }[] };
    expect(sb.fields[0].type).toBeUndefined();
  });

  it("enumStateFields skips a state field whose type didn't parse", () => {
    const src = `system S {
  ui U {
    page P {
      state { half: , status: Status }
      body: Stack {}
    }
  }
}`;
    const enums = new Map<string, readonly string[]>([["Status", ["Open", "Closed"]]]);
    const fields = enumStateFields(pageOf(src, "P"), enums);
    // The half-typed field is dropped; the well-formed one still resolves.
    expect([...fields]).toEqual([["status", "Status"]]);
  });

  it("enumStateFields returns an empty map (not a throw) when every field is half-typed", () => {
    const src = `system S { ui U { page P { state { x: } body: Stack {} } } }`;
    expect(enumStateFields(pageOf(src, "P"), new Map()).size).toBe(0);
  });
});

describe("model v2 — buildViewGraph on a source with parser errors", () => {
  // The pane now gates on `parserErrors` (matching v1), so this shouldn't be
  // reachable from the UI — but the pure function must degrade, not throw.
  it("does not throw on a recovered AST", () => {
    const src = `system S {
  context C {
    aggregate A {
      status:
      operation go() {
        status :=
      }
    }
  }
}`;
    const parsed = parseDdd(src);
    expect(parsed.parserErrors.length).toBeGreaterThan(0);
    expect(() => buildViewGraph(parsed.ast, [])).not.toThrow();
    expect(() => buildViewGraph(parsed.ast, [{ kind: "aggregate", name: "A" }])).not.toThrow();
  });

  it("does not throw when a page body is half-typed", () => {
    const parsed = parseDdd(`system S { ui U { page P { body: } } }`);
    expect(() => buildViewGraph(parsed.ast, [])).not.toThrow();
  });
});
