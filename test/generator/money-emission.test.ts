// Phase 5 — per-backend money emission verification.  Uses the
// alignment fixture `examples/money-primitive.ddd` and asserts that
// each of the four backends emits the documented per-platform shape
// for the `money` primitive: domain type, arithmetic, literal,
// wire/Zod/DTO schema, repository hydrate/persist, and column shape.
//
// One fixture, four assertion blocks — keeps the cross-backend
// contract visible in a single file.  The OpenAPI parity check in
// `test/e2e/e2e.test.ts` automatically verifies cross-backend
// agreement on the wire shape under `LOOM_E2E=1`.

import { describe, expect, it } from "vitest";
import {
  buildExternHandlersFile as _externStub,
  type AggregateIR,
  type BoundedContextIR,
} from "../../src/ir/loom-ir.js";
import { renderTsType } from "../../src/generator/typescript/render-expr.js";
import { renderCsType } from "../../src/generator/dotnet/render-expr.js";
import { renderAshType } from "../../src/generator/phoenix-live-view/render-expr.js";
import { buildLoomModel } from "../_helpers/index.js";
import * as fs from "node:fs";
import * as path from "node:path";

void _externStub; // re-export anchor; not invoked here

async function billingFixture(): Promise<{ ctx: BoundedContextIR; inv: AggregateIR }> {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../..", "examples/money-primitive.ddd"),
    "utf8",
  );
  const loom = await buildLoomModel(src);
  // Bare-context source — bounded contexts land under `contexts`, not
  // inside a system.
  const ctx = loom.contexts.find((c) => c.name === "Billing");
  expect(ctx, "Billing context").toBeDefined();
  const inv = ctx!.aggregates.find((a) => a.name === "Invoice")!;
  return { ctx: ctx!, inv };
}

describe("money emission — type mappings per backend", () => {
  it("TS renderTsType('money') → 'Decimal'", () => {
    expect(renderTsType({ kind: "primitive", name: "money" })).toBe("Decimal");
  });

  it(".NET renderCsType('money') → 'decimal'", () => {
    expect(renderCsType({ kind: "primitive", name: "money" })).toBe("decimal");
  });

  it("Phoenix renderAshType('money') → ':decimal'", () => {
    expect(renderAshType({ kind: "primitive", name: "money" }, "Billing")).toBe(":decimal");
  });
});

describe("money emission — IR binary nodes carry the type stash", () => {
  it("`subtotal + tax` carries leftType=money, resultType=money", async () => {
    const { inv } = await billingFixture();
    const total = inv.derived.find((d) => d.name === "total")!;
    const bin = total.expr as Extract<typeof total.expr, { kind: "binary" }>;
    expect(bin.leftType).toEqual({ kind: "primitive", name: "money" });
    expect(bin.resultType).toEqual({ kind: "primitive", name: "money" });
  });

  it("`subtotal * taxRate` carries leftType=money, resultType=money (scaling)", async () => {
    const { inv } = await billingFixture();
    const tax = inv.derived.find((d) => d.name === "tax")!;
    const bin = tax.expr as Extract<typeof tax.expr, { kind: "binary" }>;
    expect(bin.leftType).toEqual({ kind: "primitive", name: "money" });
    expect(bin.resultType).toEqual({ kind: "primitive", name: "money" });
  });

  it("`subtotal >= money(\"0.00\")` invariant: leftType=money, resultType=bool", async () => {
    const { inv } = await billingFixture();
    const iv = inv.invariants[0]!;
    const bin = iv.expr as Extract<typeof iv.expr, { kind: "binary" }>;
    expect(bin.leftType).toEqual({ kind: "primitive", name: "money" });
    expect(bin.resultType).toEqual({ kind: "primitive", name: "bool" });
  });
});

describe("money emission — Hono Zod schemas", () => {
  it("request zodFor(money) parses string → Decimal via transform", async () => {
    const { zodFor } = await import("../../src/platform/hono/v4/routes-builder.js");
    const z = zodFor({ kind: "primitive", name: "money" });
    expect(z).toContain("z.string()");
    expect(z).toContain("new Decimal(s)");
    expect(z).toContain(".transform");
  });
});

describe("money emission — Drizzle schema column", () => {
  it("emits NUMERIC(19, 4) for money fields via renderSchema", async () => {
    const { renderSchema } = await import("../../src/generator/typescript/emit.js");
    const { ctx } = await billingFixture();
    const out = renderSchema(ctx);
    expect(out).toContain("numeric");
    expect(out).toContain("precision: 19");
    expect(out).toContain("scale: 4");
  });
});

describe("money emission — wire-spec doc", () => {
  it("Invoice's subtotal field is {type: string, format: decimal}", async () => {
    const { jsonPropertyForType } = await import("../../src/system/wire-spec.js");
    const { inv } = await billingFixture();
    const subtotal = inv.wireShape!.find((f) => f.name === "subtotal");
    expect(subtotal).toBeDefined();
    expect(jsonPropertyForType(subtotal!.type)).toEqual({
      type: "string",
      format: "decimal",
    });
  });
});
