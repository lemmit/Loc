import type { Diagnostic } from "langium";
import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Placement rules for the unit `test` block (test-placement.md, Phase 1):
//   - hoisted (context/root) without `for` → loom.test-needs-target
//   - nested (aggregate member) with `for`  → loom.test-redundant-for
//   - `for` naming an unknown/non-aggregate → linker error (typed cross-ref),
//     NOT a themed code.
// ---------------------------------------------------------------------------

// Placeholders: __NESTED__ inside the aggregate, __CTX__ beside it in the
// context, __ROOT__ at file top level.
const build = (p: { nested?: string; ctx?: string; root?: string }): string => `
  system S {
    subdomain M { context C {
      aggregate Order { code: string  ${p.nested ?? ""} }
      ${p.ctx ?? ""}
    } }
  }
  ${p.root ?? ""}
`;

const codes = (diags: Diagnostic[]): string[] =>
  diags.map((d) => String(d.code ?? "")).filter(Boolean);

describe("validator: test placement", () => {
  it("ACCEPTS a hoisted test with `for` (context scope)", async () => {
    const { errors } = await parseString(
      build({ ctx: `test "t" for Order { expect(1).toBe(1) }` }),
    );
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("ACCEPTS a hoisted test with `for` (root scope)", async () => {
    const { errors } = await parseString(
      build({ root: `test "t" for Order { expect(1).toBe(1) }` }),
    );
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("ACCEPTS a nested test with no `for` (historical form)", async () => {
    const { errors } = await parseString(build({ nested: `test "t" { expect(1).toBe(1) }` }));
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("loom.test-needs-target — hoisted at context with no `for`", async () => {
    const { diagnostics } = await parseString(build({ ctx: `test "t" { expect(1).toBe(1) }` }));
    expect(codes(diagnostics)).toContain("loom.test-needs-target");
  });

  it("loom.test-needs-target — hoisted at root with no `for`", async () => {
    const { diagnostics } = await parseString(build({ root: `test "t" { expect(1).toBe(1) }` }));
    expect(codes(diagnostics)).toContain("loom.test-needs-target");
  });

  it("loom.test-redundant-for — nested test that restates `for`", async () => {
    const { diagnostics } = await parseString(
      build({ nested: `test "t" for Order { expect(1).toBe(1) }` }),
    );
    expect(codes(diagnostics)).toContain("loom.test-redundant-for");
  });

  it("unknown `for` target is a linker error (not a themed code)", async () => {
    const { errors } = await parseString(
      build({ root: `test "t" for Nope { expect(1).toBe(1) }` }),
    );
    expect(errors.join("\n")).toMatch(/Nope|resolve|reference/i);
  });
});
