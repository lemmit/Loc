// ExprTarget call-arm coverage for `callKind: "domain-service"`
// (domain-services.md).  One fixed Call node, rendered through all five
// backend leaf tables — the call-syntax each backend emits for a
// `Pricing.quote(cart, customer)` member call into the generated service.

import { describe, expect, it } from "vitest";
import { renderCsExpr } from "../../src/generator/dotnet/render-expr.js";
import { renderExpr as renderElixirExpr } from "../../src/generator/elixir/render-expr.js";
import { renderJavaExpr } from "../../src/generator/java/render-expr.js";
import { renderPyExpr } from "../../src/generator/python/render-expr.js";
import { renderTsExpr } from "../../src/generator/typescript/render-expr.js";
import type { ExprIR } from "../../src/ir/types/loom-ir.js";

const CALL: ExprIR = {
  kind: "call",
  callKind: "domain-service",
  name: "quote",
  args: [
    { kind: "ref", name: "cart", refKind: "param" },
    { kind: "ref", name: "customer", refKind: "param" },
  ],
  serviceRef: { service: "Pricing", op: "quote" },
};

describe("domain-service call rendering — every backend leaf", () => {
  it("TS: Pricing.quote(cart, customer)", () => {
    expect(renderTsExpr(CALL)).toBe("Pricing.quote(cart, customer)");
  });

  it(".NET: Pricing.Quote(cart, customer)", () => {
    expect(renderCsExpr(CALL)).toBe("Pricing.Quote(cart, customer)");
  });

  it("Java: Pricing.quote(cart, customer)", () => {
    expect(renderJavaExpr(CALL)).toBe("Pricing.quote(cart, customer)");
  });

  it("Python: bare module function quote(cart, customer)", () => {
    expect(renderPyExpr(CALL)).toBe("quote(cart, customer)");
  });

  it("Elixir: fully-qualified MyApp.Domain.Services.Pricing.quote(...)", () => {
    expect(renderElixirExpr(CALL)).toBe("MyApp.Domain.Services.Pricing.quote(cart, customer)");
  });
});
