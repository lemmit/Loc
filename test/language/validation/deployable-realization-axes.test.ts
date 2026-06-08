import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// D-REALIZATION-AXES — the `platform: <name> { … }` block carries six
// optional realization axes.  This PR is DSL-surface + validation only:
// the grammar admits the block, lowering normalizes defaults, and the
// validator enforces R1 (out-of-menu, against the live REAL-adapter menu)
// and R4 (a `foundation:` framework owns some axes).  Menus list only
// implemented adapters, so on dotnet/hono the adapter axes are size-1
// today (selecting a stub is rejected, not run).
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
  it("parses a full six-axis block (values gated by validator, not parser)", async () => {
    const { errors, model } = await parse(
      sys(
        "dotnet { foundation: vanilla, application: cqrs, persistence: efcore, directoryLayout: byLayer, transport: minimalApi, runtime: transactional }",
      ),
    );
    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });

  it("parses a subset / reordered / trailing-comma block", async () => {
    const { errors } = await parse(sys("dotnet { persistence: efcore, application: cqrs, }"));
    expect(errors).toEqual([]);
  });

  it("bare `platform: dotnet` still parses with zero errors (regression)", async () => {
    const { errors } = await parse(sys("dotnet"));
    expect(errors).toEqual([]);
  });

  it('a pin carries a block: `platform: "hono@v4" { persistence: drizzle }`', async () => {
    const { errors } = await parse(sys(`"hono@v4" { persistence: drizzle }`));
    expect(errors).toEqual([]);
  });
});

describe("realization axes — R1 out-of-menu", () => {
  it("accepts `persistence: dapper` on dotnet (real since Phase 5c)", async () => {
    // The R1 menu now lists dapper as a real adapter; feature-level gating
    // (loom.dapper-unsupported) lives in the IR validator, not here.
    const { errors } = await parse(sys("dotnet { persistence: dapper }"));
    expect(errors.some((e) => /persistence: dapper/.test(e))).toBe(false);
  });

  it("rejects a reserved-but-unimplemented persistence (`marten` on dotnet)", async () => {
    const { errors } = await parse(sys("dotnet { persistence: marten }"));
    expect(errors.some((e) => /persistence: marten.*reserved.*not yet implemented/.test(e))).toBe(
      true,
    );
    expect(errors.some((e) => /'efcore'/.test(e))).toBe(true);
  });

  it("rejects an unimplemented application value (`serviceLayer` on dotnet)", async () => {
    const { errors } = await parse(sys("dotnet { application: serviceLayer }"));
    expect(errors.some((e) => /application: serviceLayer/.test(e))).toBe(true);
  });

  it("accepts `directoryLayout: byFeature` on dotnet (real since Phase 5a)", async () => {
    const { errors } = await parse(sys("dotnet { directoryLayout: byFeature }"));
    expect(errors).toEqual([]);
  });

  it("rejects a wholly-unknown value as unknown, not reserved", async () => {
    const { errors } = await parse(sys("dotnet { persistence: bogusdb }"));
    expect(errors.some((e) => /persistence: bogusdb.*is not available/.test(e))).toBe(true);
  });

  it("accepts the real default values on dotnet", async () => {
    const { errors } = await parse(
      sys("dotnet { application: cqrs, persistence: efcore, directoryLayout: byLayer }"),
    );
    expect(errors).toEqual([]);
  });

  it("accepts `application: serviceLayer` on hono (where `layered` is the real adapter)", async () => {
    const { errors } = await parse(sys("hono { application: serviceLayer }"));
    expect(errors).toEqual([]);
  });

  it("rejects any axis on a frontend platform (no realization axes there)", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M { context C { } }
        ui W { page Home() { route: "/" body: Heading { "hi" } } }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: static { persistence: efcore }, targets: api, ui: W, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => /persistence: efcore.*not available on platform 'static'/.test(e)),
    ).toBe(true);
  });
});

describe("realization axes — R4 foundation owns layers", () => {
  it("rejects `foundation: ash` + `application:` on phoenix (Ash supplies it)", async () => {
    const { errors } = await parse(sys("phoenix { foundation: ash, application: serviceLayer }"));
    expect(
      errors.some((e) =>
        /foundation: ash.*owns the application layer.*remove 'application:'/i.test(e),
      ),
    ).toBe(true);
  });

  it("rejects `foundation: ash` + `transport:` on phoenix", async () => {
    const { errors } = await parse(sys("phoenix { foundation: ash, transport: phoenixRouter }"));
    expect(errors.some((e) => /foundation: ash.*owns the transport layer/i.test(e))).toBe(true);
  });

  it("`foundation: vanilla` owns nothing — no R4 error", async () => {
    const { errors } = await parse(sys("dotnet { foundation: vanilla, application: cqrs }"));
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P1 of proposals/vanilla-phoenix-foundation.md — the menu admits
// `foundation: vanilla` on phoenix (D-VANILLA-PHOENIX-FOUNDATION pinned the
// axis value), but R5 rejects the value until the vanilla emitter ships in
// P2. The grammar+lowering still need to carry the value cleanly so the
// rejection is a clean validator error, not a parse / IR crash.
// ---------------------------------------------------------------------------
describe("realization axes — R5 vanilla-on-phoenix planned but not yet implemented", () => {
  it("parses `foundation: vanilla` on phoenix without a grammar / out-of-menu error", async () => {
    // The menu lift (platform-rules.ts:184) means R1 does NOT fire on this
    // value. R5 still rejects it, but with the focused emitter-not-shipped
    // diagnostic — not a generic "not on the menu" rejection.
    const { errors } = await parse(sys("phoenix { foundation: vanilla }"));
    expect(errors.some((e) => /foundation: vanilla.*not available on platform/i.test(e))).toBe(
      false,
    );
    expect(errors.some((e) => /foundation: vanilla.*reserved.*not yet implemented/i.test(e))).toBe(
      true,
    );
  });

  it("R5 diagnostic names the proposal + the three today-actionable escapes", async () => {
    const { errors } = await parse(sys("phoenix { foundation: vanilla }"));
    const msg =
      errors.find((e) => /foundation: vanilla.*reserved.*not yet implemented/i.test(e)) ?? "";
    // Names the proposal so the user can read why.
    expect(msg).toContain("vanilla-phoenix-foundation.md");
    expect(msg).toContain("D-VANILLA-PHOENIX-FOUNDATION");
    // Lists the three escapes (foundation: ash; node/dotnet; track P2).
    expect(msg).toContain("foundation: ash");
    expect(msg).toContain("platform: node");
    expect(msg).toContain("platform: dotnet");
  });

  it("does NOT fire on phoenix with `foundation: ash` (current emit path)", async () => {
    const { errors } = await parse(sys("phoenix { foundation: ash }"));
    expect(errors.some((e) => /foundation: vanilla.*reserved.*not yet implemented/i.test(e))).toBe(
      false,
    );
  });

  it("`foundation: vanilla` is accepted on non-phoenix platforms (the existing default)", async () => {
    // Regression: the menu lift shouldn't change anything for dotnet/node.
    const { errors } = await parse(sys("dotnet { foundation: vanilla }"));
    expect(errors).toEqual([]);
  });
});
