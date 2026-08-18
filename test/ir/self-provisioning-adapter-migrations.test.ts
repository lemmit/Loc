// A declared `migration` block on a SELF-PROVISIONING persistence adapter is
// now an honest error instead of a silent no-op.
//
// Two adapters opt out of the phase-⑨ `MigrationsIR` chain and provision their
// schema themselves at boot:
//
//   - `persistence: dapper`   — `hasMigrations = !usingDapper`
//     (`src/generator/dotnet/index.ts`); `DbSchema.EnsureAsync` runs a
//     `CREATE TABLE IF NOT EXISTS` block, which does NOTHING to an existing
//     table — so a declared rename/backfill/sql step never runs.  The column
//     keeps its old name; the app 500s, or quietly reads the NULL the backfill
//     was supposed to fill.
//   - `persistence: mikroorm` — `hasMigrations = !usingMikro`
//     (`src/platform/hono/v4/emit.ts`, shared by v5); `orm.schema.updateSchema()`
//     has no rename intent to consult, so it resolves `old -> new` as DROP +
//     ADD, i.e. it DELETES the data the rename existed to preserve.
//
// Both were silent: the model validated, the project compiled, the migration
// simply was not there.  The gate lives at phase ⑦ because that is where the
// DECLARED intents live (`renameIntents` / `tableRenameIntents` /
// `backfillIntents` / `sqlMigrationSteps`); the derived `MigrationsIR` only
// exists in phase ⑨, downstream of every validator.
//
// This slice is the GATE only — teaching either adapter to actually carry a
// migration chain is a separate piece of work.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** One system whose `platform:` clause is the only variable — the adapter is
 *  the independent variable, the model is not. */
const SYS = (platformClause: string, migrationBlock: string): string => `
system Shop {
  subdomain Orders {
    context Orders {
      aggregate Order with crudish {
        code: string
        quantity: int
      }
      repository Orders for Order { }
    }
  }
  api A from Orders
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d {
    platform: ${platformClause}
    contexts: [Orders]
    dataSources: [s]
    serves: A
    port: 3000
  }
}
${migrationBlock}`;

async function diagsFor(platformClause: string, migrationBlock: string) {
  const { model } = await parseString(SYS(platformClause, migrationBlock), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const RENAME_COLUMN = `migration "rename-qty" { Order.qty -> quantity }`;
const RENAME_TABLE = `migration "rename-order" { PurchaseOrder -> Order }`;
const BACKFILL = `migration "fill-qty" { Order.quantity = 0 }`;
const RAW_SQL = `migration "touch" { sql "UPDATE orders SET quantity = 1" }`;

const CASES = [
  ["column rename", RENAME_COLUMN],
  ["table rename", RENAME_TABLE],
  ["backfill", BACKFILL],
  ["raw sql step", RAW_SQL],
] as const;

describe("declared migrations vs. the self-provisioning persistence adapters", () => {
  describe("persistence: dapper", () => {
    for (const [label, block] of CASES) {
      it(`refuses a ${label} — the CREATE TABLE IF NOT EXISTS boot would silently skip it`, async () => {
        const diags = await diagsFor("dotnet { persistence: dapper }", block);
        const gate = diags.filter(
          (d) => d.severity === "error" && d.code === "loom.dapper-unsupported",
        );
        expect(gate.length, JSON.stringify(diags.map((d) => d.code))).toBe(1);
        expect(gate[0]!.message).toContain("emits no migration chain");
        expect(gate[0]!.message).toContain("persistence: efcore");
      });

      it(`accepts the same ${label} on the default (EF Core) adapter`, async () => {
        const diags = await diagsFor("dotnet", block);
        expect(diags.filter((d) => d.code === "loom.dapper-unsupported")).toEqual([]);
      });
    }
  });

  describe("persistence: mikroorm", () => {
    for (const [label, block] of CASES) {
      it(`refuses a ${label} — updateSchema() would resolve it as DROP + ADD`, async () => {
        const diags = await diagsFor("node { persistence: mikroorm }", block);
        const gate = diags.filter(
          (d) => d.severity === "error" && d.code === "loom.mikroorm-unsupported",
        );
        expect(gate.length, JSON.stringify(diags.map((d) => d.code))).toBe(1);
        expect(gate[0]!.message).toContain("emits no migration chain");
        expect(gate[0]!.message).toContain("persistence: drizzle");
      });

      it(`accepts the same ${label} on the default (drizzle) adapter`, async () => {
        const diags = await diagsFor("node", block);
        expect(diags.filter((d) => d.code === "loom.mikroorm-unsupported")).toEqual([]);
      });
    }
  });

  // The gate must not fire on a model that declares no migration at all —
  // otherwise "dapper refuses migrations" would read as "dapper refuses".
  it("stays silent on both adapters when no migration block is declared", async () => {
    for (const platform of ["dotnet { persistence: dapper }", "node { persistence: mikroorm }"]) {
      const diags = await diagsFor(platform, "");
      expect(
        diags.filter(
          (d) => d.code === "loom.dapper-unsupported" || d.code === "loom.mikroorm-unsupported",
        ),
      ).toEqual([]);
    }
  });
});
