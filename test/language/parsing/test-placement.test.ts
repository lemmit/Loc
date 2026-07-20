import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import {
  isTestBlock,
  type Model,
  type System,
  type TestBlock,
} from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// `test … for <Aggregate>` head + hoisted placement (test-placement.md, Phase 1).
// Grammar-level coverage: the optional `for` head parses and its `[Aggregate:ID]`
// cross-reference resolves; a TestBlock now parses at context and file-root
// scope in addition to inside an aggregate.
// ---------------------------------------------------------------------------

const src = (opts: { nested?: string; ctx?: string; root?: string }): string => `
  system S {
    subdomain M { context C {
      aggregate Order { code: string  ${opts.nested ?? ""} }
      ${opts.ctx ?? ""}
    } }
  }
  ${opts.root ?? ""}
`;

const firstTest = (model: Model): TestBlock =>
  [...AstUtils.streamAllContents(model)].find(isTestBlock) as TestBlock;

describe("parse: test placement (`for` head + hoisted positions)", () => {
  it("parses a NESTED test (no `for`) — the historical form", async () => {
    const { model, errors } = await parseString(
      src({ nested: `test "nested" { expect(1).toBe(1) }` }),
    );
    expect(errors, errors.join("\n")).toEqual([]);
    const t = firstTest(model);
    expect(t.target).toBeUndefined();
    expect(t.$container.$type).toBe("Aggregate");
  });

  it("parses a CONTEXT-scoped test with `for` and resolves the target", async () => {
    const { model, errors } = await parseString(
      src({ ctx: `test "in ctx" for Order { expect(1).toBe(1) }` }),
    );
    expect(errors, errors.join("\n")).toEqual([]);
    const t = firstTest(model);
    expect(t.$container.$type).toBe("BoundedContext");
    expect(t.target?.ref?.name).toBe("Order");
  });

  it("parses a ROOT/file-level test with `for` and resolves across the context", async () => {
    const { model, errors } = await parseString(
      src({ root: `test "at root" for Order { expect(1).toBe(1) }` }),
    );
    expect(errors, errors.join("\n")).toEqual([]);
    const t = firstTest(model);
    expect(t.$container.$type).toBe("Model");
    expect(t.target?.ref?.name).toBe("Order");
  });

  it("keeps `test e2e … against` unambiguous from the new root `test … for`", async () => {
    // Both start with `test`; `e2e` after the keyword must still route to TestE2E.
    const { model, errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate Order { code: string } } }
        deployable api { platform: node, contexts: [C], port: 3000 }
        test e2e "round trip" against api { expect(1).toBe(1) }
      }
      test "unit at root" for Order { expect(1).toBe(1) }
    `);
    expect(errors, errors.join("\n")).toEqual([]);
    const sys = model.members.find((m): m is System => m.$type === "System");
    expect(sys?.members.some((m) => m.$type === "TestE2E")).toBe(true);
    expect(model.members.some((m) => m.$type === "TestBlock")).toBe(true);
  });
});
