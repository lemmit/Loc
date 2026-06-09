// Direct unit tests for Phoenix's `renderTypespec` — the Elixir typespec
// (`@spec` / `@type`) sibling of `renderAshType`.  Used by event-module,
// value-object-module, polymorphic-TPC-reader, and aggregate-helper
// emission to give Dialyzer and IDE hover docs a field-accurate shape.
//
// `renderAshType` produces Ash attribute types (`:string`, `:integer`);
// these tests pin the corresponding Elixir typespec syntax (`String.t()`,
// `integer()`, `T | nil`, `[T]`, `Mod.Ctx.X.t()`).

import { describe, expect, it } from "vitest";
import { renderTypespec } from "../../../src/generator/elixir/render-expr.js";
import type { TypeIR } from "../../../src/ir/types/loom-ir.js";

const CTX = "MyApp.Sales";

const prim = (name: string): TypeIR => ({ kind: "primitive", name }) as TypeIR;

describe("renderTypespec — primitives", () => {
  it("maps int / long to integer()", () => {
    expect(renderTypespec(prim("int"), CTX)).toBe("integer()");
    expect(renderTypespec(prim("long"), CTX)).toBe("integer()");
  });
  it("maps decimal and money to Decimal.t()", () => {
    expect(renderTypespec(prim("decimal"), CTX)).toBe("Decimal.t()");
    expect(renderTypespec(prim("money"), CTX)).toBe("Decimal.t()");
  });
  it("maps string and guid to String.t()", () => {
    expect(renderTypespec(prim("string"), CTX)).toBe("String.t()");
    expect(renderTypespec(prim("guid"), CTX)).toBe("String.t()");
  });
  it("maps bool to boolean()", () => {
    expect(renderTypespec(prim("bool"), CTX)).toBe("boolean()");
  });
  it("maps datetime to DateTime.t()", () => {
    expect(renderTypespec(prim("datetime"), CTX)).toBe("DateTime.t()");
  });
  it("maps json to map()", () => {
    expect(renderTypespec(prim("json"), CTX)).toBe("map()");
  });
});

describe("renderTypespec — reference types", () => {
  it("maps id to String.t() (UUID string on the struct)", () => {
    expect(renderTypespec({ kind: "id", targetName: "Order" } as TypeIR, CTX)).toBe("String.t()");
  });
  it("maps enum to <Ctx>.<Name>.t()", () => {
    expect(renderTypespec({ kind: "enum", name: "OrderStatus" } as TypeIR, CTX)).toBe(
      "MyApp.Sales.OrderStatus.t()",
    );
  });
  it("maps valueobject to <Ctx>.<Name>.t()", () => {
    expect(renderTypespec({ kind: "valueobject", name: "Money" } as TypeIR, CTX)).toBe(
      "MyApp.Sales.Money.t()",
    );
  });
  it("maps entity to <Ctx>.<Name>.t()", () => {
    expect(renderTypespec({ kind: "entity", name: "OrderLine" } as TypeIR, CTX)).toBe(
      "MyApp.Sales.OrderLine.t()",
    );
  });
});

describe("renderTypespec — combinators", () => {
  it("maps array to [T]", () => {
    expect(renderTypespec({ kind: "array", element: prim("string") } as TypeIR, CTX)).toBe(
      "[String.t()]",
    );
  });
  it("maps optional to `T | nil`", () => {
    expect(renderTypespec({ kind: "optional", inner: prim("string") } as TypeIR, CTX)).toBe(
      "String.t() | nil",
    );
  });
  it("composes array of valueobject correctly", () => {
    expect(
      renderTypespec(
        { kind: "array", element: { kind: "valueobject", name: "LineItem" } } as TypeIR,
        CTX,
      ),
    ).toBe("[MyApp.Sales.LineItem.t()]");
  });
  it("composes optional array correctly", () => {
    expect(
      renderTypespec(
        { kind: "optional", inner: { kind: "array", element: prim("int") } } as TypeIR,
        CTX,
      ),
    ).toBe("[integer()] | nil");
  });
});

describe("renderTypespec — error cases", () => {
  it("throws on slot (UI-only)", () => {
    expect(() => renderTypespec({ kind: "slot" } as TypeIR, CTX)).toThrow(/UI-only/);
  });
  it("renders a generic carrier as `map()` (transport-only; never a stored typespec)", () => {
    expect(
      renderTypespec(
        { kind: "genericInstance", ctor: "paged", arg: { kind: "primitive", name: "string" } },
        CTX,
      ),
    ).toBe("map()");
  });
});

describe("renderTypespec — shared <App>.Types vocabulary", () => {
  const TYPES = "MyApp.Types";

  it("routes id through <Types>.id() when typesModule is set", () => {
    expect(renderTypespec({ kind: "id", targetName: "Order" } as TypeIR, CTX, TYPES)).toBe(
      "MyApp.Types.id()",
    );
  });
  it("routes primitive datetime through <Types>.timestamp()", () => {
    expect(renderTypespec(prim("datetime"), CTX, TYPES)).toBe("MyApp.Types.timestamp()");
  });
  it("falls back to String.t() for id when typesModule is unset", () => {
    expect(renderTypespec({ kind: "id", targetName: "Order" } as TypeIR, CTX)).toBe("String.t()");
  });
  it("falls back to DateTime.t() for datetime when typesModule is unset", () => {
    expect(renderTypespec(prim("datetime"), CTX)).toBe("DateTime.t()");
  });
  it("propagates typesModule through array combinator", () => {
    expect(
      renderTypespec(
        { kind: "array", element: { kind: "id", targetName: "Order" } } as TypeIR,
        CTX,
        TYPES,
      ),
    ).toBe("[MyApp.Types.id()]");
  });
  it("propagates typesModule through optional combinator", () => {
    expect(
      renderTypespec(
        { kind: "optional", inner: { kind: "id", targetName: "Order" } } as TypeIR,
        CTX,
        TYPES,
      ),
    ).toBe("MyApp.Types.id() | nil");
  });
  it("leaves String.t() (the primitive) alone — only `id` routes through Types", () => {
    expect(renderTypespec(prim("string"), CTX, TYPES)).toBe("String.t()");
  });
});
