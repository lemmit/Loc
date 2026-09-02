// G2667-D4 — `explicit-handlers-emit.ts` carried a private COPY of the
// id-value → CLR-type mapping, and the copy disagreed with the original:
//
//   csIdValueClrType (dto-mapping.ts)  int -> "int"
//   the local switch                   int -> "long"
//
// So an `int`-keyed aggregate reached through an explicit `route … -> Handler`
// would bind a `long` route token and hand it to a ctor taking `int` — CS1503,
// in a file the .NET compile gate would only reach with such a model.
//
// It is LATENT, and honestly so: `lowerAggregate` pins `idValueType` to `guid`
// (`src/ir/lower/lower.ts`), so no `.ddd` can reach the divergent arm today —
// which is exactly why no generator test could catch it and why the copy sat
// there. The durable guard is therefore structural: the mapping has ONE
// derivation in the .NET tree, and this test fails if a second one appears.
//
// (If a future slice adds a DSL surface for non-guid ids, this test should be
// joined by a behavioural one over a real `.ddd`.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { csIdValueClrType } from "../../../src/generator/dotnet/dto-mapping.js";

const src = (rel: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../src/generator/dotnet/${rel}`, import.meta.url)),
    "utf8",
  );

describe("the .NET id → CLR type mapping has one derivation", () => {
  it("csIdValueClrType maps every id value type", () => {
    expect(csIdValueClrType("guid")).toBe("Guid");
    expect(csIdValueClrType("int")).toBe("int");
    expect(csIdValueClrType("long")).toBe("long");
    expect(csIdValueClrType("string")).toBe("string");
  });

  it("explicit-handlers-emit routes through it instead of re-deciding", () => {
    const file = src("explicit-handlers-emit.ts");
    expect(file).toContain("csIdValueClrType(t.valueType)");
    // The shape of the copy that was here: a ternary chain over `valueType`
    // producing the C# type name.  Its `int` arm said "long".
    expect(
      file,
      "explicit-handlers-emit re-derives the id CLR type instead of importing csIdValueClrType",
    ).not.toMatch(/valueType === "guid" \? "Guid"/);
  });

  it("no other .NET emitter re-derives it either", () => {
    for (const rel of [
      "cqrs/controller.ts",
      "emit/api.ts",
      "emit/dapper.ts",
      "emit/efcore.ts",
      "workflow-emit.ts",
      "query-projection-emit.ts",
    ]) {
      expect(src(rel), `${rel} re-derives the id CLR type`).not.toMatch(
        /valueType === "guid" \? "Guid"/,
      );
    }
  });
});
