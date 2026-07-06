import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// D-REALIZATION-AXES — the `platform: <name> { … }` block carries three
// optional realization axes (application / persistence / directoryLayout).
// This is DSL-surface + validation only: the grammar admits the block,
// lowering normalizes defaults, and the validator enforces R1 (out-of-menu,
// against the live adapter menu).  Every menu is now stub-free, so any
// out-of-menu value is rejected as "not available" (the transport / runtime
// axes and every reserved stub were removed).  (The `foundation:` axis was
// removed — it was a single-value knob, `vanilla` everywhere.)
// ---------------------------------------------------------------------------

async function parse(source: string) {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    model: doc.parseResult.value as Model,
  };
}

const sys = (platformClause: string) => `
  system S {
    subdomain M { context C { } }
    deployable api { platform: ${platformClause}, contexts: [C], port: 3000 }
  }
`;

describe("realization axes — grammar admits the block", () => {
  it("parses a full two-axis block (values gated by validator, not parser)", async () => {
    const { errors, model } = await parse(
      sys("dotnet { persistence: efcore, directoryLayout: byLayer }"),
    );
    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });

  it("parses a reordered / trailing-comma block", async () => {
    const { errors } = await parse(
      sys("dotnet { directoryLayout: byLayer, persistence: efcore, }"),
    );
    expect(errors).toEqual([]);
  });

  it("bare `platform: dotnet` still parses with zero errors (regression)", async () => {
    const { errors } = await parse(sys("dotnet"));
    expect(errors).toEqual([]);
  });

  it('a pin carries a block: `platform: "node@v4" { persistence: drizzle }`', async () => {
    const { errors } = await parse(sys(`"node@v4" { persistence: drizzle }`));
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression (B5): an unrecognized (typo'd) quoted `platform:` used to CRASH
// validation.  R3's `resolveStyleLayoutCompat(family, …)` called
// `adaptersFor(family)`, which derefs the surface `platformFor(family)`
// returns — `undefined` for a name that isn't a known backend family — throwing
// a TypeError.  Because the whole document is validated in one function, that
// throw wiped EVERY diagnostic for the file (surfacing only "An error occurred
// during validation: Cannot read properties of undefined (reading 'adapters')").
// The guard now returns quietly for a non-backend family, leaving
// `checkDeployablePlatform`'s own unknown-platform diagnostic to stand.
// ---------------------------------------------------------------------------
describe("unknown quoted platform — no validator crash (B5)", () => {
  it("an unknown quoted platform yields the unknown-platform diagnostic, not a crash", async () => {
    const { errors } = await parse(sys('"totallybogus"'));
    expect(errors.some((e) => /An error occurred during validation/.test(e))).toBe(false);
    expect(errors.some((e) => /Unknown platform 'totallybogus'/.test(e))).toBe(true);
  });

  it("other unrelated errors in the same document still surface (crash used to wipe them)", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M { context C { } }
        deployable api { platform: "totallybogus", contexts: [C], port: 3000 }
        theme { primary: "red" }
      }
    `);
    expect(errors.some((e) => /An error occurred during validation/.test(e))).toBe(false);
    expect(errors.some((e) => /Unknown platform 'totallybogus'/.test(e))).toBe(true);
    expect(errors.some((e) => /theme 'primary' must be a CSS hex color/.test(e))).toBe(true);
  });
});

describe("realization axes — R1 out-of-menu", () => {
  it("accepts `persistence: dapper` on dotnet (real since Phase 5c)", async () => {
    // The R1 menu now lists dapper as a real adapter; feature-level gating
    // (loom.dapper-unsupported) lives in the IR validator, not here.
    const { errors } = await parse(sys("dotnet { persistence: dapper }"));
    expect(errors.some((e) => /persistence: dapper/.test(e))).toBe(false);
  });

  it("rejects a removed persistence value (`marten` on dotnet) as not available", async () => {
    // The marten stub was removed; it is now a wholly-unknown value.
    const { errors } = await parse(sys("dotnet { persistence: marten }"));
    expect(errors.some((e) => /persistence: marten.*is not available/.test(e))).toBe(true);
    expect(errors.some((e) => /'efcore'/.test(e))).toBe(true);
  });

  it("accepts `directoryLayout: byFeature` on dotnet (real since Phase 5a)", async () => {
    const { errors } = await parse(sys("dotnet { directoryLayout: byFeature }"));
    expect(errors).toEqual([]);
  });

  it("rejects a wholly-unknown value as unknown", async () => {
    const { errors } = await parse(sys("dotnet { persistence: bogusdb }"));
    expect(errors.some((e) => /persistence: bogusdb.*is not available/.test(e))).toBe(true);
  });

  it("accepts the real default values on dotnet", async () => {
    const { errors } = await parse(sys("dotnet { persistence: efcore, directoryLayout: byLayer }"));
    expect(errors).toEqual([]);
  });

  it("rejects any axis on a frontend platform (no realization axes there)", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M { context C { } }
        ui W { page Home() { route: "/" body: Heading { "hi" } } }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static { persistence: efcore }, targets: api, ui: W, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => /persistence: efcore.*not available on platform 'static'/.test(e)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R3 — the backend's fixed emission STYLE must support the resolved
// directoryLayout (StyleAdapter.supportedLayouts).  Style is no longer a user
// knob (one fixed style per backend), so R3 pairs the platform DEFAULT style
// with the chosen `directoryLayout`.  Every backend's default style supports
// every layout in its own menu, so R3 has no reachable rejection today; these
// tests pin that it does NOT false-fire on the valid combinations.
// ---------------------------------------------------------------------------
describe("realization axes — R3 style ↔ directoryLayout compatibility", () => {
  it("accepts node default style + either layout — style/layout orthogonal", async () => {
    expect((await parse(sys("node { directoryLayout: byLayer }"))).errors).toEqual([]);
    expect((await parse(sys("node { directoryLayout: byFeature }"))).errors).toEqual([]);
  });

  it("accepts dotnet default style (cqrs) + either layout", async () => {
    expect((await parse(sys("dotnet { directoryLayout: byLayer }"))).errors).toEqual([]);
    expect((await parse(sys("dotnet { directoryLayout: byFeature }"))).errors).toEqual([]);
  });

  it("bare platforms (default style × default layout) never trip R3", async () => {
    expect((await parse(sys("node"))).errors).toEqual([]);
    expect((await parse(sys("dotnet"))).errors).toEqual([]);
    expect((await parse(sys("elixir"))).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `platform: elixir` generates plain Phoenix LiveView on Ecto (the Ash
// foundation was removed).  A bare `platform: elixir` parses, lowers, and
// validates without error; the Ash-era `persistence: ashPostgres` value is
// simply out-of-menu now — R1 rejects it against elixir's single data layer
// (`ecto`).
// ---------------------------------------------------------------------------
describe("realization axes — elixir is plain Ecto/Phoenix (Ash removed)", () => {
  it("accepts a bare `platform: elixir`", async () => {
    const { errors } = await parse(sys("elixir"));
    expect(errors).toEqual([]);
  });

  it("rejects the retired `phoenix` platform alias (D-ELIXIR-PLATFORM)", async () => {
    const { errors } = await parse(sys('"phoenix"'));
    expect(errors.some((e) => /Unknown platform 'phoenix'/.test(e))).toBe(true);
  });

  it("rejects `persistence: ashPostgres` on elixir (out-of-menu — ecto only)", async () => {
    const { errors } = await parse(sys("elixir { persistence: ashPostgres }"));
    expect(errors.some((e) => /persistence: ashPostgres.*platform 'elixir'.*'ecto'/.test(e))).toBe(
      true,
    );
  });

  it("accepts `persistence: ecto` on elixir (the only data layer)", async () => {
    const { errors } = await parse(sys("elixir { persistence: ecto }"));
    expect(errors).toEqual([]);
  });

  it("dotnet persistence is unaffected", async () => {
    expect((await parse(sys("dotnet { persistence: efcore }"))).errors).toEqual([]);
    expect((await parse(sys("dotnet { persistence: dapper }"))).errors).toEqual([]);
  });
});
