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
// implemented adapters, so on dotnet/node the adapter axes are size-1
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
        "dotnet { foundation: vanilla, application: cqrs, persistence: efcore, directoryLayout: byLayer, transport: controllers, runtime: transactional }",
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

  it('a pin carries a block: `platform: "node@v4" { persistence: drizzle }`', async () => {
    const { errors } = await parse(sys(`"node@v4" { persistence: drizzle }`));
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

  it("accepts `application: serviceLayer` on node (where `layered` is the real adapter)", async () => {
    const { errors } = await parse(sys("node { application: serviceLayer }"));
    expect(errors).toEqual([]);
  });

  it("recognises `application: flat` as reserved (vocabulary parity flat→serviceLayer→cqrs)", async () => {
    // `flat` is the spec's simplest application topology — registered as a stub
    // so it's reserved-not-implemented (not 'unknown') on dotnet and node.
    for (const plat of ["dotnet", "node"]) {
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
// R3 — the resolved application STYLE must support the resolved
// directoryLayout (StyleAdapter.supportedLayouts; realization-axes-alignment
// .md).  The rule is wired, but style and layout are ORTHOGONAL by design (the
// LayoutAdapter only remaps file paths — layout-surface.ts), so every real
// style supports every real layout on its platform: R3 is a forward guard with
// no reachable rejection today.  These tests pin that it does NOT false-fire on
// the valid combinations (incl. the node `layered` + `byFeature` regression
// that a too-narrow `supportedLayouts` would have broken).
// ---------------------------------------------------------------------------
describe("realization axes — R3 style ↔ directoryLayout compatibility", () => {
  it("accepts node `serviceLayer` (layered) + either layout — style/layout orthogonal", async () => {
    expect(
      (await parse(sys("node { application: serviceLayer, directoryLayout: byLayer }"))).errors,
    ).toEqual([]);
    expect(
      (await parse(sys("node { application: serviceLayer, directoryLayout: byFeature }"))).errors,
    ).toEqual([]);
  });

  it("accepts dotnet `cqrs` + either layout", async () => {
    expect(
      (await parse(sys("dotnet { application: cqrs, directoryLayout: byLayer }"))).errors,
    ).toEqual([]);
    expect(
      (await parse(sys("dotnet { application: cqrs, directoryLayout: byFeature }"))).errors,
    ).toEqual([]);
  });

  it("bare platforms (default style × default layout) never trip R3", async () => {
    expect((await parse(sys("node"))).errors).toEqual([]);
    expect((await parse(sys("dotnet"))).errors).toEqual([]);
    expect((await parse(sys("elixir"))).errors).toEqual([]);
  });
});

describe("realization axes — R4 foundation owns layers", () => {
  it("rejects `foundation: ash` + `application:` on elixir (Ash supplies it)", async () => {
    const { errors } = await parse(sys("elixir { foundation: ash, application: serviceLayer }"));
    expect(
      errors.some((e) =>
        /foundation: ash.*owns the application layer.*remove 'application:'/i.test(e),
      ),
    ).toBe(true);
  });

  it("rejects `foundation: ash` + `transport:` on elixir", async () => {
    const { errors } = await parse(sys("elixir { foundation: ash, transport: phoenix }"));
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
// `platform: elixir` must now parse, lower, and validate without error.
// (The legacy `phoenix` / `phoenixLiveView` platform aliases were retired.)
// ---------------------------------------------------------------------------
describe("realization axes — foundation: vanilla on elixir is accepted (Slice 0)", () => {
  it("accepts `foundation: vanilla` on elixir without R5 (gate lifted)", async () => {
    const { errors } = await parse(sys("elixir { foundation: vanilla }"));
    expect(errors).toEqual([]);
  });

  it("rejects the retired `phoenix` platform alias (D-ELIXIR-PLATFORM)", async () => {
    const { errors } = await parse(sys('"phoenix"'));
    expect(errors.some((e) => /Unknown platform 'phoenix'/.test(e))).toBe(true);
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

  it("accepts `persistence: ecto` with NO foundation on elixir (defaults to vanilla)", async () => {
    // Post D-VANILLA-DEFAULT the omitted-foundation default is vanilla, whose
    // data layer IS ecto — so the aligned pair needs no explicit `foundation:`.
    const { errors } = await parse(sys("elixir { persistence: ecto }"));
    expect(errors).toEqual([]);
  });

  it("rejects `persistence: ashPostgres` with NO foundation on elixir (defaults to vanilla)", async () => {
    // The mirror: the default vanilla foundation does NOT admit Ash's framework
    // data layer — `foundation: ash` must be set explicitly to use ashPostgres.
    const { errors } = await parse(sys("elixir { persistence: ashPostgres }"));
    expect(
      errors.some((e) =>
        /persistence: ashPostgres.*incompatible with 'foundation: vanilla'.*default on 'elixir'/.test(
          e,
        ),
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
        // Compatible style for the vanilla foundation is the real pipeline shape
        // `serviceLayer` (= adapter `layered`), not a style named after the
        // foundation.
        /application: ash.*incompatible with 'foundation: vanilla'.*'serviceLayer'/.test(e),
      ),
    ).toBe(true);
  });

  it("accepts `foundation: vanilla` + `application: serviceLayer` (plain Phoenix's real pipeline)", async () => {
    // The plain-Phoenix style is the real `layered`/`serviceLayer` shape — it
    // is the explicit spelling of the vanilla foundation's defaulted style.
    const { errors } = await parse(
      sys("elixir { foundation: vanilla, application: serviceLayer }"),
    );
    expect(errors).toEqual([]);
  });

  it("rejects `application: vanilla` — `vanilla` is a foundation, never a style", async () => {
    const { errors } = await parse(sys("elixir { foundation: vanilla, application: vanilla }"));
    expect(errors.some((e) => /application: vanilla/.test(e))).toBe(true);
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
// transport; dotnet additionally reserves `minimalApi` as a stub.  (The
// labels were historically inverted — the backend has always emitted
// attribute-routed `[ApiController]` controllers, so `controllers` is the
// real surface and the unbuilt `app.MapGet/MapPost` endpoint mapping is
// the reserved one.  Swapped 2026-06-10.)
// ---------------------------------------------------------------------------
describe("realization axes — transport is adapter-backed", () => {
  it("accepts the real transport (dotnet `controllers`)", async () => {
    // The canonical node/elixir transports (`hono` / `phoenix`) are set by
    // the lowering default rather than written by hand, so they aren't
    // exercised as user axis values here.  dotnet's `controllers` is a plain ID.
    expect((await parse(sys("dotnet { transport: controllers }"))).errors).toEqual([]);
  });

  it("rejects `transport: minimalApi` on dotnet as reserved-but-unimplemented", async () => {
    const { errors } = await parse(sys("dotnet { transport: minimalApi }"));
    expect(errors.some((e) => /transport: minimalApi.*reserved.*not yet implemented/.test(e))).toBe(
      true,
    );
    expect(errors.some((e) => /'controllers'/.test(e))).toBe(true);
  });

  it("rejects a wholly-unknown transport as unknown, not reserved", async () => {
    const { errors } = await parse(sys("dotnet { transport: grpc }"));
    expect(errors.some((e) => /transport: grpc.*is not available/.test(e))).toBe(true);
  });

  it("recognises node transport alternatives as reserved (`express` / `fastify`)", async () => {
    for (const t of ["express", "fastify"]) {
      const { errors } = await parse(sys(`node { transport: ${t} }`));
      expect(
        errors.some((e) => new RegExp(`transport: ${t}.*reserved.*not yet implemented`).test(e)),
      ).toBe(true);
    }
  });

  it("rejects a cross-platform transport (`minimalApi` on elixir)", async () => {
    const { errors } = await parse(sys("elixir { transport: controllers }"));
    expect(errors.some((e) => /transport: controllers.*is not available/.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runtime: is now an adapter-backed axis (realization-axes-alignment.md slice
// 5).  Every backend ships `transactional` (real); actor runtimes are reserved
// stubs — `orleans` on dotnet, `genserver` on elixir.
// ---------------------------------------------------------------------------
describe("realization axes — runtime is adapter-backed", () => {
  it("accepts the real `transactional` runtime on every backend", async () => {
    expect((await parse(sys("dotnet { runtime: transactional }"))).errors).toEqual([]);
    expect((await parse(sys("node { runtime: transactional }"))).errors).toEqual([]);
    expect((await parse(sys("elixir { runtime: transactional }"))).errors).toEqual([]);
  });

  it("recognises non-transactional runtimes as reserved (`orleans` dotnet, `genserver` elixir, `worker` node)", async () => {
    const d = await parse(sys("dotnet { runtime: orleans }"));
    expect(d.errors.some((e) => /runtime: orleans.*reserved.*not yet implemented/.test(e))).toBe(
      true,
    );
    const e = await parse(sys("elixir { runtime: genserver }"));
    expect(e.errors.some((m) => /runtime: genserver.*reserved.*not yet implemented/.test(m))).toBe(
      true,
    );
    const n = await parse(sys("node { runtime: worker }"));
    expect(n.errors.some((m) => /runtime: worker.*reserved.*not yet implemented/.test(m))).toBe(
      true,
    );
  });

  it("rejects an actor runtime on a backend that doesn't reserve it (`orleans` on node)", async () => {
    const { errors } = await parse(sys("node { runtime: orleans }"));
    expect(errors.some((e) => /runtime: orleans.*is not available/.test(e))).toBe(true);
  });
});
