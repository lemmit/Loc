// .NET collection-mutation path selection — which member `xs += v` / `xs -= v`
// actually writes to.
//
// The .NET entity emitter uses a `_<name>` PRIVATE BACKING FIELD only for
// CONTAINMENT collections.  A `Target id[]` reference collection and a plain
// SCALAR array (`codes: int[]`) are both emitted as writable public `List<T>`
// properties with no backing field at all, so routing their mutation through
// `_codes` is CS0103 ("the name '_codes' does not exist in the current
// context") — the generated project does not compile.
//
// The scalar-array half was live on `main` until the `collection-op-shapes`
// corpus fixture was minted: no fixture anywhere mutated a scalar array, so the
// dotnet compile tier had never rendered this path.  (Sibling of audit finding
// A13 — the Java half of the same "scalar-array mutation" blind spot.)
// Reproduced against the real `dotnet build /warnaserror` before the fix and
// verified clean after.

import { describe, expect, it } from "vitest";
import { renderCsStatements } from "../../../src/generator/dotnet/render-stmt.js";
import type { EnrichedAggregateIR, StmtIR, TypeIR } from "../../../src/ir/types/loom-ir.js";

const INT: TypeIR = { kind: "primitive", name: "int" };
const LINE: TypeIR = { kind: "entity", name: "LineItem" };

/** Minimal aggregate context: one scalar-array FIELD (`codes: int[]`), one
 *  CONTAINMENT (`lines`), one `Target id[]` association (`tagIds`). */
const agg = {
  name: "Order",
  fields: [{ name: "codes", type: { kind: "array", element: INT } }],
  associations: [{ fieldName: "tagIds" }],
} as unknown as EnrichedAggregateIR;

const add = (field: string, elementType: TypeIR): StmtIR => ({
  kind: "add",
  target: { segments: [field] },
  value: { kind: "ref", name: "v", refKind: "param" },
  elementType,
  collection: true,
});

const remove = (field: string, elementType: TypeIR): StmtIR => ({
  kind: "remove",
  target: { segments: [field] },
  value: { kind: "ref", name: "v", refKind: "param" },
  elementType,
  collection: true,
});

describe("dotnet scalar-array mutation targets the public property, not a `_` backing field", () => {
  it("`codes += v` / `codes -= v` on an `int[]` FIELD writes `Codes`", () => {
    expect(renderCsStatements([add("codes", INT)], { thisName: "this", agg })).toBe(
      "        Codes.Add(v);",
    );
    expect(renderCsStatements([remove("codes", INT)], { thisName: "this", agg })).toBe(
      "        Codes.Remove(v);",
    );
  });

  it("a `Target id[]` reference collection still uses the public property (unchanged)", () => {
    expect(renderCsStatements([add("tagIds", INT)], { thisName: "this", agg })).toBe(
      "        TagIds.Add(v);",
    );
  });

  it("a CONTAINMENT still routes through the `_` backing field (byte-identical)", () => {
    expect(renderCsStatements([add("lines", LINE)], { thisName: "this", agg })).toBe(
      "        _lines.Add(v);",
    );
  });

  it("with no aggregate context, falls back to the containment convention", () => {
    expect(renderCsStatements([add("lines", LINE)])).toBe("        _lines.Add(v);");
  });
});
