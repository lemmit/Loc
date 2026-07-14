import { wireFieldsFor } from "../../../src/ir/enrich/wire-projection.js";
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

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { renderCsType } from "../../../src/generator/dotnet/render-expr.js";
import { mapTypeToEcto } from "../../../src/generator/elixir/vanilla/schema-emit.js";
import { renderTsType } from "../../../src/generator/typescript/render-expr.js";
import {
  buildExternHandlersFile as _externStub,
  type AggregateIR,
  type BoundedContextIR,
} from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../../_helpers/index.js";

void _externStub; // re-export anchor; not invoked here

async function billingFixture(): Promise<{ ctx: BoundedContextIR; inv: AggregateIR }> {
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "../..", "examples/money-primitive.ddd"),
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

  it("Phoenix mapTypeToEcto('money') → ':decimal'", () => {
    expect(mapTypeToEcto({ kind: "primitive", name: "money" }, new Map())).toBe(":decimal");
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

  it('`subtotal >= money("0.00")` invariant: leftType=money, resultType=bool', async () => {
    const { inv } = await billingFixture();
    const iv = inv.invariants[0]!;
    const bin = iv.expr as Extract<typeof iv.expr, { kind: "binary" }>;
    expect(bin.leftType).toEqual({ kind: "primitive", name: "money" });
    expect(bin.resultType).toEqual({ kind: "primitive", name: "bool" });
  });
});

describe("money emission — Hono Zod schemas", () => {
  it("request zodFor(money) references the shared `moneySchema` helper", async () => {
    const { zodFor } = await import("../../../src/platform/hono/v4/routes-builder.js");
    // The string-to-Decimal transform + format check is factored out
    // to `lib/schemas.ts`; per-route schemas reference it by name
    // rather than redeclaring the chain at every field site.
    const z = zodFor({ kind: "primitive", name: "money" });
    expect(z).toBe("moneySchema");
  });
});

describe("money emission — Drizzle schema column", () => {
  it("emits NUMERIC(19, 4) for money fields via renderSchema", async () => {
    const { renderSchema } = await import("../../../src/generator/typescript/emit.js");
    const { ctx } = await billingFixture();
    const out = renderSchema(ctx);
    expect(out).toContain("numeric");
    expect(out).toContain("precision: 19");
    expect(out).toContain("scale: 4");
  });
});

describe("money emission — Hono lib/schemas.ts helper", () => {
  // The string-to-Decimal Zod transform is factored to one place;
  // routes import `moneySchema` rather than redeclaring the chain.

  async function generateHonoFiles(): Promise<Map<string, string>> {
    const { parseValid } = await import("../../_helpers/parse.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "../..", "examples/money-primitive.ddd"),
      "utf8",
    );
    void (await parseValid(src));
    // money-primitive.ddd is a bare-context source (no `system { … }`
    // block) — `generateSystems` is the multi-system orchestrator; for
    // bare contexts the single-deployable `generate ts` path is the
    // closer match.  Use the lower-level Hono emit for an inline
    // single-context generation.
    const { buildLoomModel } = await import("../../_helpers/index.js");
    const { generateTypeScriptForContexts } = await import("../../../src/platform/hono/v4/emit.js");
    const { BACKEND_PINS } = await import("../../../src/platform/hono/v4/pins.js");
    const loom = await buildLoomModel(src);
    return generateTypeScriptForContexts(loom.contexts, BACKEND_PINS);
  }

  it("emits `lib/schemas.ts` exporting `moneySchema` when a context uses money", async () => {
    const files = await generateHonoFiles();
    const schemas = files.get("lib/schemas.ts");
    expect(schemas).toBeDefined();
    expect(schemas!).toContain("export const moneySchema");
    expect(schemas!).toContain("z.string().transform");
    // Defensive parse: failures are typed Zod issues, not uncaught
    // throws.  The shared helper is the seam every route inherits.
    expect(schemas!).toContain("ctx.addIssue");
    expect(schemas!).toContain("z.NEVER");
  });

  it("omits `lib/schemas.ts` for projects without any money usage", async () => {
    const { buildLoomModel } = await import("../../_helpers/index.js");
    const { generateTypeScriptForContexts } = await import("../../../src/platform/hono/v4/emit.js");
    const { BACKEND_PINS } = await import("../../../src/platform/hono/v4/pins.js");
    const loom = await buildLoomModel(`
      context Foo {
        aggregate Bar { name: string }
        repository Bars for Bar { }
      }
    `);
    const files = generateTypeScriptForContexts(loom.contexts, BACKEND_PINS);
    expect(files.get("lib/schemas.ts")).toBeUndefined();
  });

  it("a money-bearing route file imports `moneySchema` from `../lib/schemas`", async () => {
    const files = await generateHonoFiles();
    const route = files.get("http/invoice.routes.ts");
    expect(route).toBeDefined();
    expect(route!).toContain(`import { moneySchema } from "../lib/schemas";`);
    // The route file no longer imports `Decimal` directly — the
    // shared helper owns the decimal.js dep; route handlers receive
    // `Decimal` instances by Zod inference.
    expect(route!).not.toContain(`import Decimal from "decimal.js"`);
    // No more inline `z.string().regex(...).transform(...)` chain at
    // money-field sites.
    expect(route!).toContain("subtotal: moneySchema");
  });
});

describe("money emission — repository persist drops redundant parens", () => {
  it("emits `aggregate.subtotal.toString()` (no wrapping parens)", async () => {
    const { generateSystems } = await import("../../../src/system/index.js");
    void generateSystems; // unused; kept for parallel import shape with above
    const { buildLoomModel } = await import("../../_helpers/index.js");
    const { generateTypeScriptForContexts } = await import("../../../src/platform/hono/v4/emit.js");
    const { BACKEND_PINS } = await import("../../../src/platform/hono/v4/pins.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "../..", "examples/money-primitive.ddd"),
      "utf8",
    );
    const loom = await buildLoomModel(src);
    const files = generateTypeScriptForContexts(loom.contexts, BACKEND_PINS);
    const repo = files.get("db/repositories/invoice-repository.ts");
    expect(repo).toBeDefined();
    // Defensive (value).toString() is gone — money persists as plain
    // <expr>.toString().  Method-call already binds tightly enough
    // for the receiver shape repository-builder constructs.
    expect(repo!).toContain("aggregate.subtotal.toString()");
    expect(repo!).not.toContain("(aggregate.subtotal).toString()");
  });
});

describe("money emission — wire-spec doc", () => {
  it("Invoice's subtotal field is {type: string, format: decimal}", async () => {
    const { jsonPropertyForType } = await import("../../../src/system/wire-spec.js");
    const { inv } = await billingFixture();
    const subtotal = wireFieldsFor(inv).find((f) => f.name === "subtotal");
    expect(subtotal).toBeDefined();
    expect(jsonPropertyForType(subtotal!.type)).toEqual({
      type: "string",
      format: "decimal",
    });
  });
});
