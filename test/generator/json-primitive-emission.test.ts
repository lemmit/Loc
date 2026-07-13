// Alignment test for the `json` primitive type (opaque JSON blob).
// Uses `examples/json-primitive.ddd` and asserts each backend emits the
// documented per-platform leaf mapping: domain/DTO type, Zod schema,
// Drizzle column, OpenAPI shape, and that the IR carries the primitive.
//
// One fixture, the cross-backend contract in a single file — mirrors
// `money-emission.test.ts`.  See
// docs/old/proposals/document-and-json-hierarchies.md (Option 1,
// D-DOCUMENT-AXIS).

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { renderCsType } from "../../src/generator/dotnet/render-expr.js";
import { mapTypeToEcto } from "../../src/generator/elixir/vanilla/schema-emit.js";
import { renderTsType } from "../../src/generator/typescript/render-expr.js";
import type { BoundedContextIR } from "../../src/ir/types/loom-ir.js";
import { jsonPropertyForType } from "../../src/system/wire-spec.js";
import { buildLoomModel } from "../_helpers/index.js";

async function webhooksCtx(): Promise<BoundedContextIR> {
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "examples/json-primitive.ddd"),
    "utf8",
  );
  const loom = await buildLoomModel(src);
  const ctx = loom.contexts.find((c) => c.name === "Webhooks");
  expect(ctx, "Webhooks context").toBeDefined();
  return ctx!;
}

describe("json emission — type mappings per backend", () => {
  it("TS renderTsType('json') → 'unknown'", () => {
    expect(renderTsType({ kind: "primitive", name: "json" })).toBe("unknown");
  });

  it(".NET renderCsType('json') → 'System.Text.Json.JsonElement'", () => {
    expect(renderCsType({ kind: "primitive", name: "json" })).toBe("System.Text.Json.JsonElement");
  });

  it("Phoenix mapTypeToEcto('json') → ':map'", () => {
    expect(mapTypeToEcto({ kind: "primitive", name: "json" }, new Map())).toBe(":map");
  });
});

describe("json emission — IR + wire shape", () => {
  it("a `json` field lowers to a primitive `json` TypeIR", async () => {
    const ctx = await webhooksCtx();
    const agg = ctx.aggregates.find((a) => a.name === "Delivery")!;
    const payload = agg.fields.find((f) => f.name === "payload")!;
    expect(payload.type).toEqual({ kind: "primitive", name: "json" });
  });

  it("wire-spec maps `json` to a freeform OpenAPI object (leaf, not expanded)", () => {
    expect(jsonPropertyForType({ kind: "primitive", name: "json" })).toEqual({ type: "object" });
  });
});

describe("json emission — Hono Zod schema", () => {
  it("zodFor(json) → 'z.unknown()' (opaque, no coercion)", async () => {
    const { zodFor } = await import("../../src/platform/hono/v4/routes-builder.js");
    expect(zodFor({ kind: "primitive", name: "json" })).toBe("z.unknown()");
  });
});

describe("json emission — Drizzle schema column", () => {
  it("emits a `jsonb` column for json fields via renderSchema", async () => {
    const { renderSchema } = await import("../../src/generator/typescript/emit.js");
    const ctx = await webhooksCtx();
    const out = renderSchema(ctx);
    expect(out).toContain('payload: jsonb("payload")');
    expect(out).toContain('headers: jsonb("headers")');
  });
});
