import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caseId, type PairwiseCase } from "../pairwise/axes.js";
import { pairwiseCover } from "../pairwise/cases.js";
import { runPipeline } from "../pairwise/harness.js";
import { GENERATION_WAIVERS, waiverFor } from "../pairwise/waivers.js";
import { SCHEMA_LOAD_WAIVERS } from "../pairwise/waivers-schema.js";
import {
  type PgServer,
  resetDatabase,
  startPgServer,
} from "./support/migration-evolution-harness.js";

// ---------------------------------------------------------------------------
// M-T9.29 slice 1 — the SCHEMA-LOAD oracle for the pairwise corpus.
//
// The compile tiers are structurally blind to the emitted SCHEMA: it is data,
// not code, so a migration chain Postgres will refuse type-checks green on
// every backend (G2/#2316 — `versioned`'s counter colliding with a declared
// `version: string` emitted `TEXT NOT NULL DEFAULT 1`, which CREATE TABLE
// rejects; the stack never started, and nothing caught it).
//
// That bug was itself a CROSSING — the `versioned` capability against a
// particular field shape — which is why this oracle belongs on the pairwise
// matrix and not only on the per-feature corpus.  Same mechanism as
// `schema-load.test.ts`: generate, `psql -f` the chain into a throwaway
// database, assert Postgres accepts it.  Nothing compiled, nothing booted.
//
// node only, deliberately: `MigrationsIR` is derived ONCE in phase ⑨ and
// `sql-pg.ts` renders it for every raw-SQL backend, so one chain covers the
// shared derivation (the same scope argument `schema-load.test.ts` makes).
// ---------------------------------------------------------------------------

const ENABLED = process.env.LOOM_PAIRWISE === "1" && process.env.LOOM_SCHEMA_LOAD === "1";
// `default` (drizzle) only: MikroORM emits `db/entities.ts` and derives its DDL
// through its own schema generator at boot, so a mikroorm case has no `.sql`
// chain for `psql -f` to read.  Its schema correctness is a different oracle
// (the mikroorm behavioral leg boots against a real Postgres) — asserting it
// here would only be asserting that an adapter which emits no chain emits no
// chain.
const CASES = pairwiseCover("node", ["default"]);

/** The emitted migration chain, grouped by deployable (each deployable gets
 *  its own database in the generated stack, so merging them would be a WRONG
 *  test, not a stricter one). */
function chainsOf(files: Map<string, string>): Map<string, { name: string; sql: string }[]> {
  const byDeployable = new Map<string, { name: string; sql: string }[]>();
  for (const [p, sql] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const m = /^([^/]+)\/db\/migrations\/.*\.sql$/.exec(p);
    if (!m) continue;
    const list = byDeployable.get(m[1]!) ?? [];
    list.push({ name: path.basename(p), sql });
    byDeployable.set(m[1]!, list);
  }
  return byDeployable;
}

function loadSql(server: PgServer, db: string, file: string): void {
  const url = `postgres://${encodeURIComponent(server.user)}:${encodeURIComponent(server.password)}@${server.host}:${server.port}/${db}`;
  // ON_ERROR_STOP: without it psql reports the error and exits 0, which turns
  // the whole gate into a no-op.
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", file], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 60_000,
  });
}

describe.skipIf(!ENABLED)("pairwise corpus — emitted migration chains load into Postgres", () => {
  let server: PgServer;
  let tmp: string;

  beforeAll(async () => {
    server = await startPgServer();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pw-schema-"));
  }, 180_000);

  afterAll(() => {
    server?.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each(CASES.map((c) => [caseId(c), c] as const))(
    "%s",
    async (_id, kase: PairwiseCase) => {
      const out = await runPipeline(kase, "node");
      if (out.verdict === "rejected") {
        console.log(`${caseId(kase)}: rejected by ${out.codes.join(", ")} — no chain to load`);
        return;
      }
      if (out.verdict === "crashed") {
        expect(
          waiverFor(GENERATION_WAIVERS, kase, "node"),
          `${caseId(kase)} crashed in codegen with no generation waiver`,
        ).toBeDefined();
        return;
      }

      const chains = chainsOf(out.files!);
      expect(chains.size, `${caseId(kase)}: emitted at least one migration chain`).toBeGreaterThan(
        0,
      );

      const waiver = waiverFor(SCHEMA_LOAD_WAIVERS, kase, "node");
      let refusal: string | undefined;
      for (const [deployable, chain] of chains) {
        const db = `pw_${caseId(kase)}_${deployable}`.replace(/[^a-z0-9]/gi, "_").toLowerCase();
        resetDatabase(server, db);
        for (const step of chain) {
          const file = path.join(tmp, `${db}__${step.name}`);
          fs.writeFileSync(file, step.sql);
          try {
            loadSql(server, db, file);
          } catch (e) {
            const err = e as { stderr?: Buffer; message?: string };
            refusal ??= `${deployable}/${step.name}: ${err.stderr?.toString() ?? err.message ?? String(e)}`;
          }
        }
      }

      if (waiver) {
        expect(
          refusal,
          `${caseId(kase)}'s chain now loads — delete its entry from ` +
            `test/pairwise/waivers-schema.ts and close its row in the findings register`,
        ).toBeDefined();
      } else {
        expect(
          refusal,
          `${caseId(kase)}: Postgres refused the emitted chain — the generated stack cannot start`,
        ).toBeUndefined();
      }
    },
    240_000,
  );
});
