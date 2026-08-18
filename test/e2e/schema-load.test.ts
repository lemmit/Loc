import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/parse.js";
import { corpusSource, corpusSourceFor, validateCorpusCase } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";
import {
  type PgServer,
  resetDatabase,
  startPgServer,
} from "./support/migration-evolution-harness.js";

// ---------------------------------------------------------------------------
// Schema-load gate (LOOM_SCHEMA_LOAD=1) — does the emitted DDL actually LOAD?
//
// The per-PR compile gates (`tsc --noEmit`, `mix compile`, `gradle
// testClasses`) are structurally blind to the emitted SCHEMA: it is data, not
// code, so a project whose migrations Postgres will refuse still compiles
// green on every backend.  G2 (#2316) is the proof — a user-declared
// `version: string` collided with the `versioned` capability's counter and
// emitted
//
//     CREATE TABLE "ops"."releases" ( … "version" TEXT NOT NULL DEFAULT 1, … )
//
// which Postgres rejects at CREATE TABLE.  The stack never starts.  Nothing
// caught it: five backends compiled, no sentinel was written, and the
// behavioural tiers never got far enough to boot.
//
// This is the cheapest oracle that would have: generate, then `psql -f` the
// emitted migration chain into a throwaway database.  Nothing is compiled,
// nothing is booted, no application exists — the question is only whether the
// DDL is valid SQL that Postgres will accept.
//
// SCOPE — one backend, deliberately.  `MigrationsIR` is derived ONCE in phase
// ⑨ and shared by every backend with a database, and the Postgres renderer
// (`src/generator/sql-pg.ts`) is likewise shared: node, python and java all
// emit raw `.sql` from it (only .NET's EF and Elixir's Ecto use their own
// DSLs).  So node's chain exercises the shared derivation, and running the
// other two would re-assert the same SQL at 3x the cost.  If that stops being
// true — a backend growing its own renderer — this needs revisiting, and
// `docs/migrations.md` is the place that would say so.
// ---------------------------------------------------------------------------

const ENABLED = process.env.LOOM_SCHEMA_LOAD === "1";

/** Emitted migration files for a corpus feature on node, in chain order,
 *  GROUPED BY DEPLOYABLE.
 *
 *  Each deployable gets its own database in the generated stack — that is what
 *  `db-init/00-create-databases.sql` provisions — so their chains must load
 *  into separate databases here too.  Merging them is not a stricter test, it
 *  is a wrong one: the two services of the `api-call` fixture both own an
 *  `orders` schema, and a single database makes the second chain fail with
 *  `relation "orders" already exists` on perfectly valid output. */
async function migrationChains(
  featureId: string,
): Promise<Map<string, { name: string; sql: string }[]>> {
  const source = corpusSource(featureId).replaceAll("__PLATFORM__", "node");
  const { model, errors } = await parseString(source);
  if (errors.length > 0) throw new Error(`${featureId} failed to validate:\n${errors.join("\n")}`);
  const files = generateSystems(model).files;
  const byDeployable = new Map<string, { name: string; sql: string }[]>();
  for (const [p, sql] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const m = /^([^/]+)\/db\/migrations\/.*\.sql$/.exec(p);
    if (!m) continue;
    const deployable = m[1]!;
    const list = byDeployable.get(deployable) ?? [];
    list.push({ name: path.basename(p), sql });
    byDeployable.set(deployable, list);
  }
  return byDeployable;
}

/** Load one SQL file into `db`, surfacing Postgres's own error on failure. */
function loadSql(server: PgServer, db: string, file: string): void {
  const url = `postgres://${encodeURIComponent(server.user)}:${encodeURIComponent(server.password)}@${server.host}:${server.port}/${db}`;
  // ON_ERROR_STOP makes psql exit non-zero on the FIRST failing statement —
  // without it psql reports the error and carries on with status 0, which
  // would turn this whole gate into a no-op.
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", file], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 60_000,
  });
}

describe.skipIf(!ENABLED)("emitted migration chains load into Postgres", () => {
  let server: PgServer;
  let tmp: string;

  beforeAll(async () => {
    server = await startPgServer();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-schema-load-"));
  }, 120_000);

  afterAll(() => {
    server?.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (const feature of CORPUS) {
    it(`${feature.id}`, async () => {
      const chains = await migrationChains(feature.id);
      // A fixture with no SQL backend emits no chain — nothing to assert,
      // and silently passing a no-op is exactly what this gate is against,
      // so say so.
      if (chains.size === 0) {
        console.log(`${feature.id}: no emitted .sql migrations — skipped`);
        return;
      }

      for (const [deployable, chain] of chains) {
        const db = `sl_${feature.id}_${deployable}`.replace(/[^a-z0-9]/gi, "_").toLowerCase();
        resetDatabase(server, db);

        for (const step of chain) {
          const file = path.join(tmp, `${db}__${step.name}`);
          fs.writeFileSync(file, step.sql);
          try {
            loadSql(server, db, file);
          } catch (e) {
            const err = e as { stderr?: Buffer; message?: string };
            expect.fail(
              `${feature.id} (${deployable}): Postgres refused '${step.name}' — the ` +
                `generated stack cannot start.\n${err.stderr?.toString() ?? err.message ?? String(e)}`,
            );
          }
        }
      }
    }, 180_000);
  }
});

// ---------------------------------------------------------------------------
// The SECOND schema writer: `persistence: dapper`'s `DbSchema.Sql` (M-T6.42).
//
// The gate above deliberately runs ONE backend, because `MigrationsIR` and
// `sql-pg.ts` are shared by every backend with a database.  The Dapper adapter
// is the exception that reasoning does not cover: it emits NO migration chain
// at all (`hasMigrations = !usingDapper` in the .NET orchestrator) and
// provisions itself from a hand-rolled `CREATE TABLE IF NOT EXISTS` block that
// `DbSchema.EnsureAsync` applies on boot.  So the shared renderer's guarantees
// — quoted identifiers among them — say nothing about this DDL.
//
// That blind spot had a cost: the adapter emitted BARE identifiers, and a
// `.ddd` field named `order` / `group` / `limit` produced
//
//     CREATE TABLE tickets (order integer not null, …)
//
// which Postgres refuses.  The C# compiled (the DDL is a string literal), the
// corpus compile tier was green, and the failure waited until boot.  This is
// the same cheap oracle applied to the same class of output: generate, then
// `psql -f` what the adapter would run.
//
// It reads the DDL out of the emitted `DbSchema.cs` rather than re-deriving it,
// so what is loaded here is byte-for-byte what `EnsureAsync` executes —
// including the verbatim-literal `""` un-doubling, which is itself a step this
// gate would catch getting wrong.
// ---------------------------------------------------------------------------

/** The DDL `DbSchema.EnsureAsync` would run, per deployable, for a corpus
 *  feature generated under `persistence: dapper` — or an empty map when the
 *  feature declares no .NET deployable. */
async function dapperSchemas(featureId: string): Promise<Map<string, string>> {
  const source = corpusSourceFor(featureId, "dotnet", "dapper");
  const { model, errors } = await parseString(source);
  if (errors.length > 0) throw new Error(`${featureId} failed to validate:\n${errors.join("\n")}`);
  const files = generateSystems(model).files;
  const out = new Map<string, string>();
  for (const [p, cs] of files) {
    const m = /^([^/]+)\/Infrastructure\/Persistence\/DbSchema\.cs$/.exec(p);
    if (!m) continue;
    // `public const string Sql = @"…";` — a C# VERBATIM literal, so a quote
    // inside it is written `""`.  Un-double to recover the SQL itself.
    const body = /public const string Sql = @"([\s\S]*?)\n";/.exec(cs);
    if (!body) throw new Error(`${featureId}: ${p} has no 'public const string Sql' block`);
    out.set(m[1]!, body[1]!.replace(/""/g, '"'));
  }
  return out;
}

describe.skipIf(!ENABLED)("the dapper adapter's self-applied DDL loads into Postgres", () => {
  let server: PgServer;
  let tmp: string;

  beforeAll(async () => {
    server = await startPgServer();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-schema-load-"));
  }, 120_000);

  afterAll(() => {
    server?.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (const feature of CORPUS.filter((f) => f.backends.includes("dotnet"))) {
    it(`${feature.id}`, async () => {
      // A feature the adapter honestly REFUSES (`loom.dapper-unsupported`)
      // never reaches an emitter, so there is no DDL to load.  Asked of the
      // validator rather than of a hand-kept list, so this cannot go stale
      // against the boundary the way a duplicated map would.
      const diags = await validateCorpusCase(feature.id, "dotnet", "dapper");
      if (diags.some((d) => d.severity === "error" && d.code === "loom.dapper-unsupported")) {
        console.log(`${feature.id}: refused under persistence: dapper — no DDL to load`);
        return;
      }

      const schemas = await dapperSchemas(feature.id);
      expect(
        schemas.size,
        `${feature.id}: no DbSchema.cs emitted under 'persistence: dapper' — this adapter ` +
          "provisions its own schema, so an absent one means the stack cannot start.",
      ).toBeGreaterThan(0);

      for (const [deployable, ddl] of schemas) {
        const db = `dsl_${feature.id}_${deployable}`.replace(/[^a-z0-9]/gi, "_").toLowerCase();
        resetDatabase(server, db);
        // `EnsureAsync` splits on `;` and runs one statement per round trip
        // (a CREATE INDEX must not be PARSED before its table exists), so load
        // it the same way rather than as one multi-statement file.
        const statements = ddl
          .split(";")
          .map((x) => x.trim())
          .filter((x) => x.length > 0);
        for (const [i, stmt] of statements.entries()) {
          const file = path.join(tmp, `${db}__${i}.sql`);
          fs.writeFileSync(file, `${stmt};\n`);
          try {
            loadSql(server, db, file);
          } catch (e) {
            const err = e as { stderr?: Buffer; message?: string };
            expect.fail(
              `${feature.id} (${deployable}): Postgres refused a DbSchema statement — the ` +
                `generated stack cannot start.\n${stmt}\n\n` +
                `${err.stderr?.toString() ?? err.message ?? String(e)}`,
            );
          }
        }
      }
    }, 180_000);
  }
});
