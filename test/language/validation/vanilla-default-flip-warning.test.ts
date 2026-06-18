import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// D-VANILLA-DEFAULT — warn-then-flip sequencing.  Before the actual
// default flip lands in `lower-platform.ts:greenfieldAxisDefaults`,
// emit a `loom.foundation-default-flipping` warning on every bare
// `platform: elixir` (no explicit `foundation:`) for one release cycle.
// Users who want to keep today's `ash` behaviour after the flip set
// `foundation: ash` explicitly; users who want to opt in early set
// `foundation: vanilla`.  See `docs/decisions.md#D-VANILLA-DEFAULT`.
// ---------------------------------------------------------------------------

async function parse(source: string) {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    warnings: diags.filter((d) => d.severity === 2).map((d) => d.message),
    model: doc.parseResult.value as Model,
  };
}

const sys = (platformClause: string) => `
  system S {
    subdomain M { context C { } }
    deployable api { platform: ${platformClause}, contexts: [C], port: 3000 }
  }
`;

describe("D-VANILLA-DEFAULT — warn-then-flip sequencing", () => {
  it("warns on bare `platform: elixir` (no explicit `foundation:`)", async () => {
    const { errors, warnings } = await parse(sys("elixir"));
    expect(errors).toEqual([]);
    expect(
      warnings.some((w) =>
        /'platform: elixir' without an explicit 'foundation:' will switch from 'ash' to 'vanilla'/.test(
          w,
        ),
      ),
    ).toBe(true);
  });

  it("warns on `platform: elixir { }` with a non-foundation axis but no `foundation:`", async () => {
    // The realization-axes block is present (e.g. with `application:` set)
    // but `foundation:` is omitted — same default-flip risk as bare elixir.
    const { errors, warnings } = await parse(sys("elixir { application: ash }"));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /D-VANILLA-DEFAULT/.test(w))).toBe(true);
  });

  it("does NOT warn when `foundation: ash` is explicit", async () => {
    const { errors, warnings } = await parse(sys("elixir { foundation: ash }"));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /D-VANILLA-DEFAULT/.test(w))).toBe(false);
  });

  it("does NOT warn when `foundation: vanilla` is explicit", async () => {
    const { errors, warnings } = await parse(sys("elixir { foundation: vanilla }"));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /D-VANILLA-DEFAULT/.test(w))).toBe(false);
  });

  it("does NOT warn on the legacy `phoenix` alias with `foundation: vanilla`", async () => {
    // The desugar maps `phoenix` → `elixir`, and the explicit foundation
    // suppresses the warning.
    const { errors, warnings } = await parse(sys("phoenix { foundation: vanilla }"));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /D-VANILLA-DEFAULT/.test(w))).toBe(false);
  });

  it("DOES warn on bare `platform: phoenix` (legacy alias, same default semantics)", async () => {
    // The desugar maps `phoenix` → `elixir`; bare `phoenix` carries the
    // same implicit-foundation default-flip risk as bare `elixir`.
    const { warnings } = await parse(sys("phoenix"));
    expect(warnings.some((w) => /D-VANILLA-DEFAULT/.test(w))).toBe(true);
  });

  it("does NOT warn on other backend platforms (hono / dotnet / java / python)", async () => {
    for (const plat of ["node", "dotnet", "java", "python"]) {
      const { warnings } = await parse(sys(plat));
      expect(
        warnings.some((w) => /D-VANILLA-DEFAULT/.test(w)),
        `${plat} should NOT trigger the flip warning`,
      ).toBe(false);
    }
  });
});
