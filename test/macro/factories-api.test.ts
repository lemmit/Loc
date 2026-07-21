// Direct unit tests for the macro factory API surface
// (`src/macros/api/factories.ts`, `ui-factories.ts`, `factories-internals.ts`).
//
// Coverage scope:
//   - Type-reference factories: primType, idRef, namedType
//   - Member factories: field, param, operation
//   - Expression / statement factories: nameRef, memberAccess,
//     assignStmt, assignStmtPath, not, thisRef, nullLit
//   - UI factories: stringLit, boolLit, nameRefExpr, callExpr,
//     routeProp, bodyProp, pageMenuMeta, page
//   - Cross-decl helpers: aggregatesIn, workflowsIn,
//     targetFields
//   - Origin tracking: _withOrigin propagation + originOf walking
//     up `$container` chain
//
// These factories are the contract every macro author depends on;
// each test isolates one factory and asserts the AST node shape +
// container wiring + (when applicable) origin tag.

import { describe, expect, it } from "vitest";
import type { Aggregate, BoundedContext, Subdomain } from "../../src/language/generated/ast.js";
import { isAggregate, isBoundedContext, isSubdomain } from "../../src/language/generated/ast.js";
import type { OriginToken } from "../../src/macros/api/define.js";
import {
  aggregatesIn,
  assignStmt,
  assignStmtPath,
  field,
  idRef,
  memberAccess,
  namedType,
  nameRef,
  not,
  nullLit,
  operation,
  param,
  primType,
  targetFields,
  thisRef,
  workflowsIn,
} from "../../src/macros/api/factories.js";
import { _withOrigin, ORIGIN_PROP, originOf } from "../../src/macros/api/factories-internals.js";
import {
  bodyProp,
  boolLit,
  callExpr,
  nameRefExpr,
  page,
  pageMenuMeta,
  routeProp,
  stringLit,
} from "../../src/macros/api/ui-factories.js";
import { parseString } from "../_helpers/index.js";

// Minimal OriginToken to thread through `_withOrigin` for tag assertions.
const fakeOrigin: OriginToken = {
  _kind: "macro-origin",
  macroName: "test-macro",
  callNode: {} as any,
};

describe("type-reference factories", () => {
  it("primType('string') wraps a PrimitiveType in a TypeRef envelope", () => {
    const t = primType("string");
    expect(t.$type).toBe("TypeRef");
    expect(t.base?.$type).toBe("PrimitiveType");
    expect((t.base as { name: string }).name).toBe("string");
    expect(t.array).toBe(false);
    expect(t.optional).toBe(false);
  });

  it("primType honours array + optional opts and wires $container on the inner type", () => {
    const t = primType("int", { array: true, optional: true });
    expect(t.array).toBe(true);
    expect(t.optional).toBe(true);
    expect((t.base as { $container?: unknown }).$container).toBe(t);
  });

  it("idRef('Order') builds a TypeRef whose base is an IdType targeting Order", () => {
    const t = idRef("Order");
    expect(t.base?.$type).toBe("IdType");
    expect((t.base as { target: { $refText: string } }).target.$refText).toBe("Order");
  });

  it("namedType('Money') builds a TypeRef whose base is a NamedType", () => {
    const t = namedType("Money");
    expect(t.base?.$type).toBe("NamedType");
    expect((t.base as { target: { $refText: string } }).target.$refText).toBe("Money");
  });
});

describe("member factories", () => {
  it("field('name', primType) builds a Property with default no provenance / no access", () => {
    const p = field("name", primType("string"));
    expect(p.$type).toBe("Property");
    expect(p.name).toBe("name");
    expect(p.provenanced).toBe(false);
    expect((p as { access?: string }).access).toBeUndefined();
  });

  it("field with access opt propagates the modifier", () => {
    const p = field("createdAt", primType("datetime"), { access: "managed" });
    expect((p as { access?: string }).access).toBe("managed");
  });

  it("param builds a Parameter and wires $container on its type", () => {
    const t = primType("int");
    const p = param("n", t);
    expect(p.$type).toBe("Parameter");
    expect(p.name).toBe("n");
    expect((t as { $container?: unknown }).$container).toBe(p);
  });

  it("operation wraps params + body and wires per-child $containerIndex", () => {
    const p1 = param("x", primType("int"));
    const p2 = param("y", primType("int"));
    const op = operation("compute", [p1, p2], []);
    expect(op.$type).toBe("Operation");
    expect(op.params).toEqual([p1, p2]);
    expect((p1 as { $containerIndex?: number }).$containerIndex).toBe(0);
    expect((p2 as { $containerIndex?: number }).$containerIndex).toBe(1);
    expect(op.private).toBe(false);
    expect(op.extern).toBe(false);
    expect(op.audited).toBe(false);
  });

  it("operation honours private/audited opts", () => {
    const op = operation("rotate", [], [], { private: true, audited: true });
    expect(op.private).toBe(true);
    expect(op.audited).toBe(true);
  });
});

describe("expression + statement factories", () => {
  it("nameRef returns a NameRef AST node", () => {
    const r = nameRef("subject");
    expect(r.$type).toBe("NameRef");
    expect(r.name).toBe("subject");
  });

  it("memberAccess builds a PostfixChain with one MemberSuffix", () => {
    const chain = memberAccess(nameRef("input"), "subject");
    expect(chain.$type).toBe("PostfixChain");
    expect(chain.suffixes).toHaveLength(1);
    const suffix = chain.suffixes[0]!;
    expect(suffix.$type).toBe("MemberSuffix");
    expect((suffix as { member: string }).member).toBe("subject");
    expect((suffix as { call: boolean }).call).toBe(false);
  });

  it("memberAccess with call: true threads args into the MemberSuffix", () => {
    const arg = nameRef("x");
    const chain = memberAccess(nameRef("svc"), "process", { call: true, args: [arg] });
    const suffix = chain.suffixes[0]!;
    expect((suffix as { call: boolean }).call).toBe(true);
    expect((suffix as { args: unknown[] }).args).toHaveLength(1);
  });

  it("assignStmt builds an AssignOrCallStmt with a single-segment LValue", () => {
    const s = assignStmt("subject", nameRef("input.subject" /* not really */));
    expect(s.$type).toBe("AssignOrCallStmt");
    expect(s.op).toBe(":=");
    expect((s.target as { head: string; tail: string[] }).head).toBe("subject");
    expect((s.target as { tail: string[] }).tail).toEqual([]);
  });

  it("assignStmtPath builds a dotted LValue", () => {
    const s = assignStmtPath(["this", "address", "city"], stringLit("Berlin"));
    expect((s.target as { head: string; tail: string[] }).head).toBe("this");
    expect((s.target as { tail: string[] }).tail).toEqual(["address", "city"]);
  });

  it("assignStmtPath rejects an empty path", () => {
    expect(() => assignStmtPath([], nameRef("x"))).toThrow(/at least one segment/);
  });

  it("not(expr) wraps the operand in a UnaryExpr with op '!'", () => {
    const inner = nameRef("active");
    const n = not(inner);
    expect(n.$type).toBe("UnaryExpr");
    expect(n.op).toBe("!");
    expect((inner as { $container?: unknown }).$container).toBe(n);
  });

  it("thisRef returns a ThisRef AST node (not a NameRef)", () => {
    const r = thisRef();
    expect(r.$type).toBe("ThisRef");
  });

  it("nullLit returns a NullLit AST node with value 'null'", () => {
    const n = nullLit();
    expect(n.$type).toBe("NullLit");
    expect((n as { value?: string }).value).toBe("null");
  });
});

describe("ui factories", () => {
  it("stringLit strips delimiters — stores raw text in `value`", () => {
    const s = stringLit("hello");
    expect(s.$type).toBe("StringLit");
    expect(s.value).toBe("hello");
  });

  it("boolLit stores 'true' / 'false' as strings (matches the parser)", () => {
    expect(boolLit(true).value).toBe("true");
    expect(boolLit(false).value).toBe("false");
  });

  it("nameRefExpr is structurally identical to factories.nameRef", () => {
    const r = nameRefExpr("Order");
    expect(r.$type).toBe("NameRef");
    expect(r.name).toBe("Order");
  });

  it("callExpr builds a PostfixChain with head=NameRef and a CallSuffix", () => {
    const chain = callExpr("List", [{ name: "of", value: nameRefExpr("Order") }]);
    expect(chain.$type).toBe("PostfixChain");
    expect((chain.head as { name: string }).name).toBe("List");
    const suffix = chain.suffixes[0]!;
    expect(suffix.$type).toBe("CallSuffix");
    expect((suffix as { args: unknown[] }).args).toHaveLength(1);
  });

  it("routeProp returns a RouteProp with the route string", () => {
    const r = routeProp("/orders/:id");
    expect(r.$type).toBe("RouteProp");
    expect(r.value).toBe("/orders/:id");
  });

  it("bodyProp wraps an Expression and wires $container on it", () => {
    const expr = nameRefExpr("Heading");
    const b = bodyProp(expr);
    expect(b.$type).toBe("BodyProp");
    expect(b.expr).toBe(expr);
    expect((expr as { $container?: unknown }).$container).toBe(b);
  });

  it("pageMenuMeta packs Record<string, Expression> entries with $containerIndex", () => {
    const meta = pageMenuMeta({ section: stringLit("Orders"), hidden: boolLit(false) });
    expect(meta.$type).toBe("PageMenuMeta");
    expect(meta.entries).toHaveLength(2);
    expect(meta.entries.map((e) => e.name)).toEqual(["section", "hidden"]);
    expect((meta.entries[0] as { $containerIndex: number }).$containerIndex).toBe(0);
  });

  it("page composes route + body (+ optional menu) into a Page node", () => {
    const p = page({
      name: "Home",
      route: "/",
      body: callExpr("Heading", [{ value: stringLit("hi") }]),
    });
    expect(p.$type).toBe("Page");
    expect(p.name).toBe("Home");
    expect(p.props).toHaveLength(2); // route + body, no menu
    expect(p.props[0]!.$type).toBe("RouteProp");
    expect(p.props[1]!.$type).toBe("BodyProp");
  });

  it("page with menu opt appends a third PageMenuMeta prop", () => {
    const p = page({
      name: "Hidden",
      route: "/hidden",
      body: nameRefExpr("Empty"),
      menu: { hidden: boolLit(true) },
    });
    expect(p.props).toHaveLength(3);
    expect(p.props[2]!.$type).toBe("PageMenuMeta");
  });
});

describe("origin tracking", () => {
  it("nodes built outside `_withOrigin` carry no origin tag", () => {
    const n = nameRef("plain");
    expect((n as Record<string, unknown>)[ORIGIN_PROP]).toBeUndefined();
    expect(originOf(n)).toBeUndefined();
  });

  it("`_withOrigin(t, fn)` tags every node fn produces", () => {
    const built = _withOrigin(fakeOrigin, () => ({
      a: nameRef("x"),
      b: stringLit("y"),
      c: field("z", primType("int")),
    }));
    expect(originOf(built.a)).toBe(fakeOrigin);
    expect(originOf(built.b)).toBe(fakeOrigin);
    expect(originOf(built.c)).toBe(fakeOrigin);
  });

  it("origin is cleared when the `_withOrigin` callback returns", () => {
    _withOrigin(fakeOrigin, () => nameRef("scoped"));
    const after = nameRef("after");
    expect(originOf(after)).toBeUndefined();
  });

  it("nested `_withOrigin` restores the outer origin on return", () => {
    const outer: OriginToken = { ...fakeOrigin, macroName: "outer" };
    const inner: OriginToken = { ...fakeOrigin, macroName: "inner" };
    let outerNode: ReturnType<typeof nameRef> | undefined;
    let innerNode: ReturnType<typeof nameRef> | undefined;
    let afterInnerNode: ReturnType<typeof nameRef> | undefined;
    _withOrigin(outer, () => {
      outerNode = nameRef("outer");
      _withOrigin(inner, () => {
        innerNode = nameRef("inner");
      });
      afterInnerNode = nameRef("after-inner");
    });
    expect(originOf(outerNode!)?.macroName).toBe("outer");
    expect(originOf(innerNode!)?.macroName).toBe("inner");
    expect(originOf(afterInnerNode!)?.macroName).toBe("outer");
  });

  it("originOf walks up `$container` chain — a deep child reports its host's origin", () => {
    const op = _withOrigin(fakeOrigin, () =>
      operation("rotate", [param("n", primType("int"))], []),
    );
    const innerParam = op.params[0]!;
    expect(originOf(innerParam)).toBe(fakeOrigin);
  });
});

describe("cross-decl helpers (aggregatesIn / workflowsIn)", () => {
  async function parseSubdomain(): Promise<Subdomain> {
    const { model } = await parseString(`
      system S {
        subdomain Sales {
          context Sales {
            aggregate Order { name: string operation go() {} }
            aggregate Customer { email: string operation go() {} }
            repository Orders for Order { }
            workflow fulfil {
      create() { }
    }
          }
        }
      }
    `);
    for (const sm of model.members ?? []) {
      if (sm.$type !== "System") continue;
      for (const m of (sm as { members: unknown[] }).members ?? []) {
        if (isSubdomain(m as Subdomain)) return m as Subdomain;
      }
    }
    throw new Error("no subdomain found");
  }

  it("aggregatesIn(subdomain) flattens aggregates across all its contexts", async () => {
    const mod = await parseSubdomain();
    const aggs = aggregatesIn(mod);
    expect(aggs.map((a) => a.name)).toEqual(["Order", "Customer"]);
  });

  it("aggregatesIn(context) returns only that context's aggregates", async () => {
    const mod = await parseSubdomain();
    const ctx = (mod.contexts ?? [])[0] as BoundedContext;
    expect(isBoundedContext(ctx)).toBe(true);
    expect(aggregatesIn(ctx).map((a) => a.name)).toEqual(["Order", "Customer"]);
  });

  it("workflowsIn(subdomain) returns declared workflows", async () => {
    const mod = await parseSubdomain();
    expect(workflowsIn(mod).map((w) => w.name)).toEqual(["fulfil"]);
  });
});

describe("targetFields — Property filter", () => {
  async function parseAggregate(decl: string): Promise<Aggregate> {
    const { model, errors } = await parseString(`
      system Demo {
        subdomain M { context C {
          aggregate A {
            ${decl}
          }
        }}
      }
    `);
    if (errors.length) throw new Error(errors.join("; "));
    for (const sm of model.members ?? []) {
      if (sm.$type !== "System") continue;
      for (const m of (sm as { members: unknown[] }).members ?? []) {
        if (!isSubdomain(m as Subdomain)) continue;
        for (const ctx of (m as Subdomain).contexts ?? []) {
          for (const cm of (ctx as BoundedContext).members ?? []) {
            if (isAggregate(cm) && cm.name === "A") return cm;
          }
        }
      }
    }
    throw new Error("aggregate A not found");
  }

  it("returns only Property declarations, excluding operations and derived", async () => {
    const agg = await parseAggregate(`
      name: string
      email: string
      derived display: string = name
      operation rotate() { }
    `);
    expect(targetFields(agg).map((f) => f.name)).toEqual(["name", "email", "version"]);
  });
});
