import { describe, expect, it } from "vitest";
import type { Model, Page, StateBlock } from "../../src/language/generated/ast.js";
import {
  addStateField,
  deleteStateField,
  listStateFields,
  retypeStateField,
  setStateDefault,
} from "../../web/src/builder/page/state-fields.js";
import type { TypeSpec } from "../../web/src/builder/system/fields.js";
import { parseRaw as parse, parseRawOk as parses } from "../_helpers/index.js";

function* walk(node: { $type: string }): Generator<{ $type: string }> {
  yield node;
  for (const v of Object.values(node)) {
    if (Array.isArray(v))
      for (const c of v)
        if (c && typeof c === "object" && "$type" in c) yield* walk(c);
        else if (v && typeof v === "object" && "$type" in v) yield* walk(v as { $type: string });
  }
}
const findPage = (m: Model, name: string): Page => {
  for (const n of walk(m))
    if (n.$type === "Page" && (n as { name?: string }).name === name) return n as unknown as Page;
  throw new Error(`page not found: ${name}`);
};
const stateBlock = (page: Page): StateBlock | undefined =>
  page.props.find((p) => p.$type === "StateBlock") as StateBlock | undefined;

const WITH_STATE = `system S { ui U { page P {
  state { step: int = 0 }
  body: CreateForm(of: Order)
} } }`;
const NO_STATE = `system S { ui U { page Q {
  body: Text("hi")
} } }`;

describe("Page builder — state field editing", () => {
  it("lists state fields with type + default", () => {
    const fields = listStateFields(findPage(parse(WITH_STATE), "P"));
    expect(fields.map((f) => f.name)).toEqual(["step"]);
    expect(fields[0].baseLabel).toBe("int");
    expect(fields[0].init).toBe("0");
  });

  it("adds a field to an existing state block", () => {
    const src = addStateField(WITH_STATE, "P")!;
    expect(src).not.toBeNull();
    expect(parses(src)).toBe(true);
    const fields = listStateFields(findPage(parse(src), "P"));
    expect(fields.map((f) => f.name)).toEqual(["step", "field1"]);
  });

  it("creates a state block when the page has none, preserving the body", () => {
    const src = addStateField(NO_STATE, "Q")!;
    expect(src).not.toBeNull();
    expect(parses(src)).toBe(true);
    const sb = stateBlock(findPage(parse(src), "Q"));
    expect(sb?.fields.map((f) => f.name)).toEqual(["field1"]);
    expect(src).toMatch(/body:\s*Text\("hi"\)/);
  });

  it("retypes a state field to an Id<> reference", () => {
    const spec: TypeSpec = { base: { kind: "id", target: "Order" }, array: false, optional: false };
    const src = retypeStateField(WITH_STATE, "P", 0, spec)!;
    expect(src).toMatch(/step: Order id/);
  });

  it("sets and clears a default initializer; rejects an invalid expression", () => {
    let src = setStateDefault(WITH_STATE, "P", 0, "5")!;
    expect(src).toMatch(/step: int = 5/);
    src = setStateDefault(WITH_STATE, "P", 0, "")!;
    expect(src).toMatch(/step: int(?! =)/);
    expect(setStateDefault(WITH_STATE, "P", 0, "1 +")).toBeNull();
  });

  it("deletes a field", () => {
    const src = deleteStateField(WITH_STATE, "P", 0)!;
    expect(parses(src)).toBe(true);
    expect(stateBlock(findPage(parse(src), "P"))?.fields ?? []).toHaveLength(0);
  });

  it("returns null for an unknown page or out-of-range index", () => {
    expect(addStateField(WITH_STATE, "Nope")).toBeNull();
    expect(deleteStateField(WITH_STATE, "P", 9)).toBeNull();
    expect(
      retypeStateField(WITH_STATE, "P", 9, {
        base: { kind: "primitive", name: "int" },
        array: false,
        optional: false,
      }),
    ).toBeNull();
  });
});
