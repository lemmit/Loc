import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// D-VANILLA-DEFAULT — the default flip has LANDED.  A bare `platform: elixir`
// (no explicit `foundation:`) now resolves to `vanilla` (plain Phoenix
// LiveView on Ecto) in `lower-platform.ts:greenfieldAxisDefaults`;
// `foundation: ash` is the explicit opt-in.  The transitional
// `loom.foundation-default-flipping` warning that preceded the flip is gone —
// omitting `foundation:` is no longer ambiguous, so it must NOT warn.  See
// `docs/decisions.md#D-VANILLA-DEFAULT`.
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

describe("D-VANILLA-DEFAULT — flip landed, no transitional warning", () => {
  it("does NOT warn on a bare elixir deployable (the flip has landed — default is vanilla)", async () => {
    const { errors, warnings } = await parse(sys("elixir"));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /D-VANILLA-DEFAULT|foundation/.test(w))).toBe(false);
  });

  it("does NOT warn on an elixir block with a non-foundation axis but no foundation:", async () => {
    const { errors, warnings } = await parse(sys("elixir { application: serviceLayer }"));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /D-VANILLA-DEFAULT|foundation/.test(w))).toBe(false);
  });

  it("does NOT warn when foundation: ash is explicit", async () => {
    const { errors, warnings } = await parse(sys("elixir { foundation: ash }"));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /D-VANILLA-DEFAULT|foundation/.test(w))).toBe(false);
  });

  it("does NOT warn when foundation: vanilla is explicit", async () => {
    const { errors, warnings } = await parse(sys("elixir { foundation: vanilla }"));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /D-VANILLA-DEFAULT|foundation/.test(w))).toBe(false);
  });
});
