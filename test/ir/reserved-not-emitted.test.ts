// `loom.reserved-not-emitted` (M-T5.9) — the ONE meta-diagnostic for a
// PARSE-BUT-NO-EMIT surface.
//
// Loom's grammar keeps growing a clause ahead of the emitter that would honour
// it: `timerSource … in: "<tz>"`, `overlap: allow`, `storage … connection:
// secret(x)`.  Each parses, validates and lowers, and then no generator reads
// it — `ddd parse --json` said `errors: 0, warnings: 0, diagnostics: []` and
// `generate system` produced byte-identical output with and without the clause.
// The runtime then does the OPPOSITE of what the source says (the cron fires in
// UTC; overlapping runs are still skipped; the deployment reads a heuristically
// derived connection string, not the declared secret).
//
// `src/ir/validate/checks/reserved-surfaces.ts` is the registry these route
// through; the last test here is its completeness pin — a row that no longer
// fires is a row whose emitter landed, and it must be deleted rather than left
// warning about behaviour that now works.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { RESERVED_SURFACES } from "../../src/ir/validate/checks/reserved-surfaces.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.reserved-not-emitted";

const sys = (storageClause: string, timerClause: string) => `
system Reaping {
  subdomain Ops {
    context Sweeps {
      event SweepTick { at: datetime }
      aggregate Job with crudish { name: string }
      repository Jobs for Job { }
    }
  }
  api Api from Ops
  storage pg { type: postgres${storageClause} }
  resource st { for: Sweeps, kind: state, use: pg }
  deployable d {
    platform: node
    contexts: [Sweeps]
    dataSources: [st]
    serves: Api
    port: 4000
  }
  timerSource sweep { for: SweepTick, cron: "*/5 * * * *"${timerClause} }
}`;

async function diags(storageClause = "", timerClause = "") {
  const { model, errors } = await parseString(sys(storageClause, timerClause));
  if (errors.length) throw new Error(`unexpected parse errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

describe("loom.reserved-not-emitted", () => {
  it('warns on `timerSource … in: "<tz>"` — the cron actually fires in UTC', async () => {
    const hits = (await diags("", `, in: "America/New_York"`)).filter((d) => d.code === CODE);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe("warning");
    expect(hits[0]!.source).toBe("Reaping/timerSource/sweep");
    expect(hits[0]!.message).toContain(`in: "America/New_York"`);
    // The message must state the CONSEQUENCE, not just "unsupported" — the
    // point of the code is that the runtime does something else.
    expect(hits[0]!.message).toMatch(/UTC/);
  });

  it("warns on `overlap: allow` — overlapping runs are still skipped", async () => {
    const hits = (await diags("", ", overlap: allow")).filter((d) => d.code === CODE);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain("overlap: allow");
    expect(hits[0]!.message).toMatch(/advisory lock/);
  });

  it("warns on `storage … connection:` and names the declared source", async () => {
    const hits = (await diags(`, connection: env("DB_URL")`)).filter((d) => d.code === CODE);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.source).toBe("Reaping/storage/pg");
    expect(hits[0]!.message).toContain(`connection: env("DB_URL")`);
  });

  it("warns once PER declaration when several reserved clauses are spelled", async () => {
    const hits = (
      await diags(`, connection: secret(dbUrl)`, `, in: "Europe/Berlin", overlap: allow`)
    ).filter((d) => d.code === CODE);
    expect(hits).toHaveLength(3);
  });

  it("POSITIVE CONTROL: a system spelling none of them raises nothing", async () => {
    expect((await diags()).map((d) => d.code)).not.toContain(CODE);
  });

  // Completeness / anti-rot pin.  A registry row exists only because its
  // emitter does not — so every row must still be reachable from source.  A row
  // whose probe can never fire is either a typo or an emitter that landed
  // without deleting its warning; both are silent lies about what ships.
  it("every RESERVED_SURFACES row is reachable — no stale rows", async () => {
    const fired = new Set(
      (await diags(`, connection: secret(dbUrl)`, `, in: "Europe/Berlin", overlap: allow`))
        .filter((d) => d.code === CODE)
        .map((d) => d.message),
    );
    const unreached = RESERVED_SURFACES.filter(
      (s) => ![...fired].some((m) => m.includes(s.consequence)),
    ).map((s) => s.id);
    expect(unreached).toEqual([]);
  });
});
