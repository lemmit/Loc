// F2-ADP-3 — the OTHER consequence of a self-provisioning persistence adapter:
// it has no Postgres-schema concept, and until this gate that was silent.
//
// `resolveDataSourceConfig` DEFAULTS a binding's schema to `snake(<context>)`,
// so a context named `Alpha` with a bare `resource s { for: Alpha, kind: state,
// use: pg }` — no `schema:` anywhere in the source — makes every migration-chain
// adapter route its tables into `alpha`:
//
//   efcore   builder.ToTable("as", "alpha")
//   drizzle  pgSchema("alpha").table("as", …)
//
// while the self-provisioning adapters name them unqualified:
//
//   dapper   CREATE TABLE IF NOT EXISTS "as"          (→ public.as)
//   mikroorm @Entity({ tableName: "as" })             (→ public.as)
//
// Both reproduced byte-for-byte before the gate: `generate system` on the
// two-deployable model below wrote `reader/Infrastructure/Persistence/DbSchema.cs`
// with `CREATE TABLE IF NOT EXISTS ""as""` next to
// `writer/…/Configurations/AConfiguration.cs` line `builder.ToTable("as", "alpha")`
// and a writer migration doing `CREATE SCHEMA IF NOT EXISTS ""alpha""`.  Two
// physical tables, both deployables green, each reading an empty database.
//
// Second arm: a LONE self-provisioning deployable is at least self-consistent
// (it creates and reads `public.as`), so the default is not gated — but an
// EXPLICIT `schema:` / `tablePrefix:` on its binding IS a request the adapter
// silently drops, and that is gated too.
//
// And the exemption BOTH arms need: `schema: "public"`.  There the two namings
// converge on one physical table — `CREATE TABLE "public"."as"` from the
// migration chain, and the unqualified `CREATE TABLE "as"` resolving through
// Postgres's default `search_path` to the same place — so neither arm's claim
// holds.  Verified by generating: the writer emits `builder.ToTable("as",
// "public")` and `CREATE SCHEMA IF NOT EXISTS ""public""; CREATE TABLE
// ""public"".""as""`, against the reader's unqualified DDL, and no emitted
// connection string overrides `search_path`.  A `tablePrefix:` is NOT exempt
// even beside `schema: "public"` — it renames the table rather than placing it.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** Two deployables over ONE context; the adapters are the only variables. */
const CO_HOSTED = (writerPlatform: string, readerPlatform: string, bindingExtras = ""): string => `
system Adp3 {
  subdomain S {
    context Alpha {
      aggregate A { label: string }
      repository As for A { }
    }
  }
  api AlphaApi from S
  storage primary { type: postgres }
  resource alphaState { for: Alpha, kind: state, use: primary${bindingExtras} }
  deployable writer {
    platform: ${writerPlatform}
    contexts: [Alpha]
    dataSources: [alphaState]
    serves: AlphaApi
    port: 4000
  }
  deployable reader {
    platform: ${readerPlatform}
    contexts: [Alpha]
    dataSources: [alphaState]
    serves: AlphaApi
    port: 4100
  }
}
`;

/** One deployable; `bindingExtras` is the only variable. */
const LONE = (platform: string, bindingExtras: string): string => `
system Adp3b {
  subdomain S {
    context Alpha {
      aggregate A { label: string }
      repository As for A { }
    }
  }
  api AlphaApi from S
  storage primary { type: postgres }
  resource alphaState { for: Alpha, kind: state, use: primary${bindingExtras} }
  deployable reader {
    platform: ${platform}
    contexts: [Alpha]
    dataSources: [alphaState]
    serves: AlphaApi
    port: 4100
  }
}
`;

async function diagsFor(src: string) {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const errorsWithCode = (diags: Awaited<ReturnType<typeof diagsFor>>, code: string) =>
  diags.filter((d) => d.severity === "error" && d.code === code);

describe("self-provisioning adapters vs. the dataSource's Postgres schema", () => {
  it("dapper beside efcore on one context is refused — the tables would not be the same tables", async () => {
    const diags = await diagsFor(CO_HOSTED("dotnet", "dotnet { persistence: dapper }"));
    const gate = errorsWithCode(diags, "loom.dapper-unsupported");
    expect(gate.length, JSON.stringify(diags.map((d) => d.code))).toBe(1);
    expect(gate[0]!.message).toContain("UNQUALIFIED (public)");
    expect(gate[0]!.message).toContain("'writer' (efcore)");
    expect(gate[0]!.message).toContain("persistence: efcore");
    expect(gate[0]!.source).toBe("Adp3/reader");
  });

  it("mikroorm beside drizzle is refused the same way — the limit is the adapter, not the platform", async () => {
    const diags = await diagsFor(CO_HOSTED("node", "node { persistence: mikroorm }"));
    const gate = errorsWithCode(diags, "loom.mikroorm-unsupported");
    expect(gate.length, JSON.stringify(diags.map((d) => d.code))).toBe(1);
    expect(gate[0]!.message).toContain("UNQUALIFIED (public)");
    expect(gate[0]!.message).toContain("persistence: drizzle");
  });

  it("two MIGRATION-CHAIN deployables over one context are fine — they agree on the schema", async () => {
    const diags = await diagsFor(CO_HOSTED("dotnet", "node"));
    expect(errorsWithCode(diags, "loom.dapper-unsupported")).toEqual([]);
    expect(errorsWithCode(diags, "loom.mikroorm-unsupported")).toEqual([]);
  });

  it("a LONE dapper deployable is fine — it creates and reads the same unqualified tables", async () => {
    const diags = await diagsFor(LONE("dotnet { persistence: dapper }", ""));
    expect(errorsWithCode(diags, "loom.dapper-unsupported")).toEqual([]);
  });

  it("...but an EXPLICIT `schema:` on its binding is refused — the request is dropped, not honoured", async () => {
    const diags = await diagsFor(LONE("dotnet { persistence: dapper }", `, schema: "legacy"`));
    const gate = errorsWithCode(diags, "loom.dapper-unsupported");
    expect(gate.length, JSON.stringify(diags.map((d) => d.code))).toBe(1);
    expect(gate[0]!.message).toContain(`declares 'schema: "legacy"'`);
    expect(gate[0]!.message).toContain("land in 'public'");
  });

  it("...and so is an explicit `tablePrefix:`, for the same reason", async () => {
    const diags = await diagsFor(LONE("dotnet { persistence: dapper }", `, tablePrefix: "t_"`));
    const gate = errorsWithCode(diags, "loom.dapper-unsupported");
    expect(gate.length, JSON.stringify(diags.map((d) => d.code))).toBe(1);
    expect(gate[0]!.message).toContain(`declares 'tablePrefix: "t_"'`);
  });

  it("an explicit schema on the DEFAULT adapter stays accepted — it is honoured there", async () => {
    const diags = await diagsFor(LONE("dotnet", `, schema: "legacy"`));
    expect(errorsWithCode(diags, "loom.dapper-unsupported")).toEqual([]);
  });

  // --- the `schema: "public"` exemption -----------------------------------
  // Both arms above describe a divergence that does not exist here: naming
  // `public` explicitly asks for exactly where an unqualified table already
  // lands, so the two adapters address ONE table.

  it("dapper beside efcore is ACCEPTED when the binding names `public` — one physical table", async () => {
    const diags = await diagsFor(
      CO_HOSTED("dotnet", "dotnet { persistence: dapper }", `, schema: "public"`),
    );
    expect(
      errorsWithCode(diags, "loom.dapper-unsupported"),
      "the split-brain message claims two DIFFERENT physical tables, and here there is one",
    ).toEqual([]);
  });

  it("the mikroorm twin is accepted too — the exemption is about the schema, not the adapter", async () => {
    const diags = await diagsFor(
      CO_HOSTED("node", "node { persistence: mikroorm }", `, schema: "public"`),
    );
    expect(errorsWithCode(diags, "loom.mikroorm-unsupported")).toEqual([]);
  });

  it("a LONE dapper deployable naming `public` is accepted — the request IS honoured", async () => {
    const diags = await diagsFor(LONE("dotnet { persistence: dapper }", `, schema: "public"`));
    expect(
      errorsWithCode(diags, "loom.dapper-unsupported"),
      "the dropped-request message says the tables 'land in public' — which is what was asked for",
    ).toEqual([]);
  });

  it('`tablePrefix:` beside `schema: "public"` is still refused, and the message names the PREFIX', async () => {
    const diags = await diagsFor(
      LONE("dotnet { persistence: dapper }", `, schema: "public", tablePrefix: "t_"`),
    );
    const gate = errorsWithCode(diags, "loom.dapper-unsupported");
    expect(gate.length, JSON.stringify(diags.map((d) => d.code))).toBe(1);
    // Quoting the exempt `schema:` clause here would point the author at the
    // one clause they are allowed to keep.
    expect(gate[0]!.message).toContain(`declares 'tablePrefix: "t_"'`);
    expect(gate[0]!.message).not.toContain(`declares 'schema: "public"'`);
  });

  it("a prefix breaks the convergence for the CO-HOSTED arm too", async () => {
    const diags = await diagsFor(
      CO_HOSTED(
        "dotnet",
        "dotnet { persistence: dapper }",
        `, schema: "public", tablePrefix: "t_"`,
      ),
    );
    expect(errorsWithCode(diags, "loom.dapper-unsupported").length).toBe(1);
  });
});
