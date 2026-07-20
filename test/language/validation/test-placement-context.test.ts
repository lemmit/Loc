import type { Diagnostic } from "langium";
import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Phase 3-core placement (test-placement.md): a `test` nested in a `context`
// (no `for`) or hoisted with `for <Context>` is a context integration test.
// It's honestly gated (`loom.context-test-unsupported`) until the integration
// renderer lands. The `for` placement rules extend: `for <that context>` is
// redundant, but `for <Agg>` inside a context stays a legit hoisted subject test.
// ---------------------------------------------------------------------------

const build = (p: { ctxBody?: string; root?: string }): string => `
  system S {
    subdomain M { context Ordering {
      aggregate Order { code: string }
      aggregate Inventory { sku: string }
      ${p.ctxBody ?? ""}
    } }
  }
  ${p.root ?? ""}
`;

const codes = (d: Diagnostic[]): string[] => d.map((x) => String(x.code ?? "")).filter(Boolean);
const errs = (d: Diagnostic[]): Diagnostic[] => d.filter((x) => x.severity === 1);

describe("validator: context integration test placement (Phase 3-core)", () => {
  it("ACCEPTS a context-nested test (no `for`) — with the honest unsupported warning", async () => {
    const { diagnostics } = await parseString(
      build({ ctxBody: `test "cross" { expect(1).toBe(1) }` }),
    );
    expect(errs(diagnostics), "no errors").toEqual([]);
    expect(codes(diagnostics)).toContain("loom.context-test-unsupported");
  });

  it("ACCEPTS a root-hoisted `test … for <Context>` — with the warning", async () => {
    const { diagnostics } = await parseString(
      build({ root: `test "cross" for Ordering { expect(1).toBe(1) }` }),
    );
    expect(errs(diagnostics), "no errors").toEqual([]);
    expect(codes(diagnostics)).toContain("loom.context-test-unsupported");
  });

  it("loom.test-redundant-for — a context-nested test that restates `for <that context>`", async () => {
    const { diagnostics } = await parseString(
      build({ ctxBody: `test "x" for Ordering { expect(1).toBe(1) }` }),
    );
    expect(codes(diagnostics)).toContain("loom.test-redundant-for");
  });

  it("a context-nested `test … for <Aggregate>` stays a hoisted aggregate test (no context warning, no error)", async () => {
    const { diagnostics } = await parseString(
      build({ ctxBody: `test "x" for Order { expect(1).toBe(1) }` }),
    );
    expect(errs(diagnostics), "no errors").toEqual([]);
    expect(codes(diagnostics)).not.toContain("loom.context-test-unsupported");
  });
});
