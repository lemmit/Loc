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

  it("recognises `application: flat` as reserved (vocabulary parity flat→serviceLayer→cqrs)", async () => {
    // `flat` is the spec's simplest application topology — registered as a stub
    // so it's reserved-not-implemented (not 'unknown') on dotnet and node.
    for (const plat of ["dotnet", "hono"]) {
      const { errors } = await parse(sys(`${plat} { application: flat }`));
      expect(errors.some((e) => /application: flat.*reserved.*not yet implemented/.test(e))).toBe(
        true,
      );
    }
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
// Slice 0 of docs/plans/vanilla-foundation-tdd-plan.md — the previous
// R5 emitter-not-implemented rejection is lifted now that the
// `vanilla/` orchestrator subtree exists.  `foundation: vanilla` on
// `platform: elixir` (and its legacy `phoenix` alias) must now parse,
// lower, and validate without error.
// ---------------------------------------------------------------------------
describe("realization axes — foundation: vanilla on elixir is accepted (Slice 0)", () => {
  it("accepts `foundation: vanilla` on elixir without R5 (gate lifted)", async () => {
    const { errors } = await parse(sys("elixir { foundation: vanilla }"));
    expect(errors).toEqual([]);
  });

  it("accepts the legacy `phoenix` alias too", async () => {
    const { errors } = await parse(sys("phoenix { foundation: vanilla }"));
    expect(errors).toEqual([]);
  });

  it("does NOT fire on elixir with `foundation: ash` (current emit path)", async () => {
    const { errors } = await parse(sys("elixir { foundation: ash }"));
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

// ---------------------------------------------------------------------------
// R6 — persistence / application must be compatible with the foundation
// (docs/plans/realization-axes-alignment.md).  `ash` admits only its
// framework family (`ashPostgres`); `vanilla` admits the non-framework
// libraries (`ecto`).  The effective foundation is the explicit value or the
// platform default, so a cross pair is rejected either way.
// ---------------------------------------------------------------------------
describe("realization axes — R6 foundation ↔ persistence/application compatibility", () => {
  it("rejects `foundation: ash` + `persistence: ecto` (ash wants its own data layer)", async () => {
    const { errors } = await parse(sys("elixir { foundation: ash, persistence: ecto }"));
    expect(
      errors.some((e) =>
        /persistence: ecto.*incompatible with 'foundation: ash'.*'ashPostgres'/.test(e),
      ),
    ).toBe(true);
  });

  it("rejects `foundation: vanilla` + `persistence: ashPostgres` (plain Ecto only)", async () => {
    const { errors } = await parse(sys("elixir { foundation: vanilla, persistence: ashPostgres }"));
    expect(
      errors.some((e) =>
        /persistence: ashPostgres.*incompatible with 'foundation: vanilla'.*'ecto'/.test(e),
      ),
    ).toBe(true);
  });

  it("rejects `persistence: ecto` with NO foundation on elixir (defaults to ash)", async () => {
    const { errors } = await parse(sys("elixir { persistence: ecto }"));
    expect(
      errors.some((e) =>
        /persistence: ecto.*incompatible with 'foundation: ash'.*default on 'elixir'/.test(e),
      ),
    ).toBe(true);
  });

  it("accepts `foundation: vanilla` + `persistence: ecto` (the aligned pair)", async () => {
    const { errors } = await parse(sys("elixir { foundation: vanilla, persistence: ecto }"));
    expect(errors).toEqual([]);
  });

  it("rejects `foundation: vanilla` + `application: ash` (Ash style needs Ash)", async () => {
    const { errors } = await parse(sys("elixir { foundation: vanilla, application: ash }"));
    expect(
      errors.some((e) =>
        /application: ash.*incompatible with 'foundation: vanilla'.*'vanilla'/.test(e),
      ),
    ).toBe(true);
  });

  it("no R6 error for a foundation without an explicit data layer", async () => {
    expect((await parse(sys("elixir { foundation: ash }"))).errors).toEqual([]);
    expect((await parse(sys("elixir { foundation: vanilla }"))).errors).toEqual([]);
    expect((await parse(sys("elixir"))).errors).toEqual([]);
  });

  it("dotnet persistence (vanilla foundation) is unaffected — no framework binding", async () => {
    expect((await parse(sys("dotnet { persistence: efcore }"))).errors).toEqual([]);
    expect((await parse(sys("dotnet { persistence: dapper }"))).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// transport: is now an adapter-backed axis (realization-axes-alignment.md
// slice 3), not a greenfield single value.  Each backend ships one real
// transport; dotnet additionally reserves `controllers` as a stub.
// ---------------------------------------------------------------------------
describe("realization axes — transport is adapter-backed", () => {
  it("accepts the real transport (dotnet `minimalApi`)", async () => {
    // The canonical node/elixir transports (`hono` / `phoenix`) are hard
    // platform keywords, so they aren't user-writable axis values — they're
    // set by the lowering default.  dotnet's `minimalApi` is a plain ID.
    expect((await parse(sys("dotnet { transport: minimalApi }"))).errors).toEqual([]);
  });

  it("rejects `transport: controllers` on dotnet as reserved-but-unimplemented", async () => {
    const { errors } = await parse(sys("dotnet { transport: controllers }"));
    expect(
      errors.some((e) => /transport: controllers.*reserved.*not yet implemented/.test(e)),
    ).toBe(true);
    expect(errors.some((e) => /'minimalApi'/.test(e))).toBe(true);
  });

  it("rejects a wholly-unknown transport as unknown, not reserved", async () => {
    const { errors } = await parse(sys("dotnet { transport: grpc }"));
    expect(errors.some((e) => /transport: grpc.*is not available/.test(e))).toBe(true);
  });

  it("rejects a cross-platform transport (`minimalApi` on elixir)", async () => {
    const { errors } = await parse(sys("elixir { transport: minimalApi }"));
    expect(errors.some((e) => /transport: minimalApi.*is not available/.test(e))).toBe(true);
  });
});
