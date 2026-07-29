// Lossless-edit gate for the page builder's `state { … }` field mutators.
// Sibling of `system-builder/lossless-edits.test.ts`: these mutators used to
// reprint the whole StateBlock through `printStructural` (no comment
// handling) on every add/delete/retype/default edit. Assertions go through
// `lineDiff` (the builder's own hunk differ) to pin exactly which line(s)
// changed; the one exception — synthesising a brand-new block when the page
// has none — is still a whole-node insert (nothing existing to lose).

import { describe, expect, it } from "vitest";
import type { Model, Page, StateBlock } from "../../../src/language/generated/ast.js";
import { lineDiff } from "../../../web/src/builder/edit-engine.js";
import {
  addStateField,
  deleteStateField,
  listStateFields,
  retypeStateField,
  setStateDefault,
} from "../../../web/src/builder/page/state-fields.js";
import type { PrimitiveName, TypeSpec } from "../../../web/src/builder/system/fields.js";
import { parseRaw as parse } from "../../_helpers/index.js";

// Multi-line state block, each field on its own line, littered with
// comments — the formatting a whole-block reprint destroys.
const SRC = `system S {
  ui U {
    page P {
      state {
        // wizard step counter
        step: int = 0
        // the customer's chosen plan
        plan: string
      }
      // the form itself
      body: Form { of: Order }
    }
  }
}`;

const NO_STATE = `system S {
  ui U {
    page Q {
      // no local state on this page yet
      body: Text { "hi" }
    }
  }
}`;

const COMMENTS = ["// wizard step counter", "// the customer's chosen plan", "// the form itself"];

const expectCommentsIntact = (out: string | null): void => {
  expect(out).not.toBeNull();
  for (const c of COMMENTS) expect(out).toContain(c);
};

const expectHunk = (
  before: string,
  after: string | null,
  removed: string[],
  added: string[],
): void => {
  expect(after).not.toBeNull();
  const hunk = lineDiff(before, after as string);
  expect({ removed: hunk.removed, added: hunk.added }).toEqual({ removed, added });
};

// A source the parser rejects — every mutator must refuse it rather than
// splice at offsets the error-recovery parser invented.
const BROKEN = SRC.replace("page P {", "page P {{");

function* walk(node: { $type: string }): Generator<{ $type: string }> {
  yield node;
  for (const v of Object.values(node)) {
    if (Array.isArray(v))
      for (const c of v)
        if (c && typeof c === "object" && "$type" in c) yield* walk(c);
        else if (v && typeof v === "object" && "$type" in v) yield* walk(v as { $type: string });
  }
}
const findPage = (source: string, name: string): Page => {
  for (const n of walk(parse(source) as unknown as Model)) {
    if (n.$type === "Page" && (n as { name?: string }).name === name) return n as unknown as Page;
  }
  throw new Error(`no page ${name}`);
};
const stateBlock = (page: Page): StateBlock | undefined =>
  page.props.find((p) => p.$type === "StateBlock") as StateBlock | undefined;

const prim = (name: PrimitiveName): TypeSpec => ({
  base: { kind: "primitive", name },
  array: false,
  optional: false,
});

describe("builder lossless edits — page state fields", () => {
  it("addStateField appends one field line and touches nothing else", () => {
    const out = addStateField(SRC, "P", prim("boolean"));
    expectHunk(SRC, out, [], ["        field1: boolean"]);
    expectCommentsIntact(out);
  });

  it("addStateField synthesises a whole new block when the page has none", () => {
    const out = addStateField(NO_STATE, "Q", prim("string"));
    expect(out).not.toBeNull();
    expect(out).toContain("// no local state on this page yet");
    expect(out).toContain('body: Text { "hi" }');
    expect(stateBlock(findPage(out as string, "Q"))?.fields.map((f) => f.name)).toEqual(["field1"]);
  });

  it("deleteStateField removes only the field's own line", () => {
    const out = deleteStateField(SRC, "P", 1);
    expectHunk(SRC, out, ["        plan: string"], []);
    expectCommentsIntact(out);
    // The comment documenting the deleted field stays — dropping it is a
    // judgement call the builder does not get to make silently.
    expect(out).toContain("// the customer's chosen plan");
  });

  it("retypeStateField rewrites the TypeRef and keeps the field's default", () => {
    const out = retypeStateField(SRC, "P", 0, prim("decimal"));
    expectHunk(SRC, out, ["        step: int = 0"], ["        step: decimal = 0"]);
    expectCommentsIntact(out);
  });

  it("setStateDefault sets a default without disturbing the rest of the block", () => {
    const out = setStateDefault(SRC, "P", 1, '"basic"');
    expectHunk(SRC, out, ["        plan: string"], ['        plan: string = "basic"']);
    expectCommentsIntact(out);
  });

  it("setStateDefault replaces an existing default in place", () => {
    const out = setStateDefault(SRC, "P", 0, "5");
    expectHunk(SRC, out, ["        step: int = 0"], ["        step: int = 5"]);
    expectCommentsIntact(out);
  });

  it("setStateDefault('') clears an existing default", () => {
    const out = setStateDefault(SRC, "P", 0, "");
    expectHunk(SRC, out, ["        step: int = 0"], ["        step: int"]);
    expectCommentsIntact(out);
  });

  it("setStateDefault('') is a no-op when there is no default", () => {
    expect(setStateDefault(SRC, "P", 1, "")).toBe(SRC);
  });

  it("setStateDefault rejects an invalid expression", () => {
    expect(setStateDefault(SRC, "P", 0, "1 +")).toBeNull();
  });

  it("listStateFields reflects a retype", () => {
    const id: TypeSpec = { base: { kind: "id", target: "Order" }, array: false, optional: false };
    const out = retypeStateField(SRC, "P", 1, id) as string;
    const fields = listStateFields(findPage(out, "P"));
    expect(fields.map((f) => f.name)).toEqual(["step", "plan"]);
    expect(fields[1].baseLabel).toBe("Order id");
  });

  it("returns null on a source with parser errors", () => {
    expect(addStateField(BROKEN, "P")).toBeNull();
    expect(deleteStateField(BROKEN, "P", 0)).toBeNull();
    expect(retypeStateField(BROKEN, "P", 0, prim("int"))).toBeNull();
    expect(setStateDefault(BROKEN, "P", 0, "5")).toBeNull();
  });

  it("returns null for an unknown page or out-of-range index", () => {
    expect(addStateField(SRC, "Nope")).toBeNull();
    expect(deleteStateField(SRC, "P", 99)).toBeNull();
    expect(retypeStateField(SRC, "P", 99, prim("int"))).toBeNull();
    expect(setStateDefault(SRC, "P", 99, "5")).toBeNull();
  });
});
