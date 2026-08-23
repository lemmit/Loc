import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { freePort, hasDocker } from "./support/tenancy-isolation-harness.js";

// ---------------------------------------------------------------------------
// M-T3.17 — the hierarchical-tenancy subtree read is INDEX-USABLE, proven by
// `EXPLAIN` against a real Postgres rather than by prose.
//
// This is the gate the first version of the predicate did not have, and its
// absence is exactly how the regression happened: #2562 replaced the sargable
// `data_key LIKE anchor || '.%'` with the correct-but-unindexable
// `strpos(data_key, anchor || '.') = 1`, and nothing noticed that every
// deep/global read had become a sequential scan.  A structural test can only
// assert that the emitted SQL *contains* a LIKE; only the planner can say
// whether it USES the index.
//
// What it runs is the emitter's own output, not a hand-written approximation:
//   * the schema is the migration SQL `generate system` emits (including the
//     `data_key text_pattern_ops` index the tenancy derivation adds), and
//   * the predicate is lifted verbatim out of a generated repository — the
//     MikroORM `raw("…")` fragment and the Ecto `fragment("…")` call, the two
//     backends whose emitters produce literal SQL.  All five backends emit the
//     same two-term shape (`policy-deep-scope.test.ts` pins that), so what the
//     planner says about this text is what it says about the family.
//
// Opt-in (docker + a postgres pull): LOOM_TENANCY_E2E=1.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TENANCY_E2E === "1";

/** Rows seeded so the planner has a real choice — on a 10-row table a
 *  sequential scan is genuinely cheaper, and asserting "Index Scan" there would
 *  only be measuring `enable_seqscan`. */
const SEED_ROWS = 20_000;

/** The caller's org path in the seeded tree, and the four values the generated
 *  repository binds for it: the anchor, the escaped LIKE pattern, the anchored
 *  needle, and the tenant claim.  `org_7` carries a `_`, so the pattern's
 *  escape (`org!_7.%`) is exercised, not just present. */
const ANCHOR = "org_7";
const BINDS = ["org_7", "org!_7.%", "org_7.", "org_7"];

interface Pg {
  psql: (sql: string) => string;
  stop: () => void;
}

/** A throwaway postgres this suite owns, so `docker exec … psql` is available
 *  (the shared harness also accepts a URL override, which has no container to
 *  exec into). */
async function startPg(label: string): Promise<Pg> {
  const name = `loom-explain-pg-${label}-${process.pid}`;
  const port = await freePort();
  execSync(
    `docker run -d --rm --name ${name} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=app -p ${port}:5432 postgres:18-alpine`,
    { stdio: "pipe", timeout: 300_000 },
  );
  // Readiness needs THREE consecutive successful queries, not one `pg_isready`:
  // the official image runs initdb against a temporary server first, which
  // answers `pg_isready` and then shuts down ("the database system is shutting
  // down" on the very next statement).  Requiring the connection to survive a
  // beat rides out that handover.
  const deadline = Date.now() + 120_000;
  let streak = 0;
  while (streak < 3) {
    try {
      execSync(`docker exec ${name} psql -U postgres -d app -c "select 1"`, {
        stdio: "pipe",
        timeout: 5_000,
      });
      streak++;
    } catch {
      streak = 0;
      if (Date.now() > deadline) {
        execSync(`docker rm -f ${name}`, { stdio: "pipe" });
        throw new Error("postgres never became ready");
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    psql: (sql: string) =>
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          name,
          "psql",
          "-U",
          "postgres",
          "-d",
          "app",
          "-v",
          "ON_ERROR_STOP=1",
          "-f",
          "-",
        ],
        { input: sql, encoding: "utf8", timeout: 120_000 },
      ),
    stop: () => {
      try {
        execSync(`docker rm -f ${name}`, { stdio: "pipe", timeout: 15_000 });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Generate the hierarchy corpus fixture for one platform into a temp dir. */
function generate(platform: string, tag: string): string {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-explain-${tag}-`));
  const fixture = fs.readFileSync(
    path.join(repoRoot, "test", "fixtures", "corpus", "tenancy-hierarchy.ddd"),
    "utf8",
  );
  const dddPath = path.join(outDir, `${tag}.ddd`);
  fs.writeFileSync(dddPath, fixture.replace("__PLATFORM__", platform));
  execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, { stdio: "pipe", cwd: repoRoot });
  return outDir;
}

function readAll(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.set(p, fs.readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

/** Locate the Ecto `fragment("<subtree sql>", …args)` call in the emitted
 *  Phoenix source and return its SQL plus the raw argument list.  A regex can
 *  find the opening but not the close — the argument list contains nested
 *  `^(…)` pins whose parens defeat any non-greedy `))` match — so the closing
 *  paren is found by BALANCE, which is also what makes the extraction survive a
 *  change in how many arguments the fragment takes. */
function findEctoFragment(text: string): { sql: string; args: string } | null {
  const open = /fragment\("((?:[^"\\]|\\.)*IS NOT NULL(?:[^"\\]|\\.)*)",\s*/.exec(text);
  if (!open) return null;
  const start = open.index + open[0].length;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        return { sql: JSON.parse(`"${open[1]}"`) as string, args: text.slice(start, i) };
      }
      depth--;
    }
  }
  return null;
}

/** Split a call's argument list on TOP-LEVEL commas. */
function splitArgs(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((a) => a.trim()).filter((a) => a.length > 0);
}

describe.skipIf(!ENABLED)(
  "M-T3.17 — the deep/global subtree read uses the data_key index (LOOM_TENANCY_E2E=1)",
  () => {
    it("EXPLAIN shows an index scan on accounts_data_key_idx for the emitted predicate", async () => {
      if (!hasDocker()) throw new Error("docker unreachable — this proof needs a real postgres");
      let pg: Pg | undefined;
      try {
        // --- 1. the schema, straight out of the migration emitter -----------
        const drizzleDir = generate("node", "schema");
        const migrations = [...readAll(drizzleDir)]
          .filter(([p]) => p.includes(`${path.sep}migrations${path.sep}`) && p.endsWith(".sql"))
          .map(([, c]) => c)
          .join("\n");
        expect(migrations, "no migration SQL emitted").toContain('CREATE TABLE "books"."accounts"');
        // The index this whole mission is about.  If the tenancy derivation
        // ever stops emitting it, the EXPLAIN below could only ever say
        // "Seq Scan", so assert it here rather than debug it there.
        expect(
          migrations,
          "the data_key prefix index is missing — a sargable predicate has nothing to ride",
        ).toMatch(
          /CREATE INDEX "accounts_data_key_idx" ON "books"\."accounts" \("data_key" text_pattern_ops\)/,
        );

        pg = await startPg("subtree");
        pg.psql(migrations.replace(/-->\s*statement-breakpoint/g, ""));

        // --- 2. enough rows that the planner has a real choice --------------
        pg.psql(
          `INSERT INTO "books"."accounts" (id, label, amount, tenant_id, data_key, version)
           SELECT gen_random_uuid(), 'r' || i, 1, 'org_' || (i % 100),
                  'org_' || (i % 100) || '.child' || (i % 7), 1
           FROM generate_series(1, ${SEED_ROWS}) AS i;
           ANALYZE "books"."accounts";`,
        );

        // --- 3. the predicate, lifted out of a generated repository ---------
        const mikroDir = generate("node { persistence: mikroorm }", "mikro");
        const repo = [...readAll(mikroDir)].find(([p]) =>
          p.endsWith(`db${path.sep}repositories${path.sep}account-repository.ts`),
        );
        expect(repo, "mikroorm account repository not emitted").toBeDefined();
        const frag = /raw\("((?:[^"\\]|\\.)*)"/.exec(repo![1]);
        expect(frag, "no raw() SQL fragment in the emitted repository").not.toBeNull();
        const emitted = JSON.parse(`"${frag![1]}"`) as string;
        // Guard against measuring the wrong thing: this must be the subtree
        // predicate, not some other raw() the emitter happened to add.
        expect(emitted).toContain("data_key");
        expect(emitted).toContain("tenant_id");

        let n = 0;
        const predicate = emitted.replace(/\?/g, () => `$${++n}`);
        expect(n, "unexpected placeholder count in the emitted predicate").toBe(BINDS.length);
        // PREPARE + EXPLAIN EXECUTE in ONE psql session (a prepared statement
        // is session-scoped).  Going through PREPARE rather than inlining the
        // literals is the point: the generated repositories bind PARAMETERS, so
        // the plan under test is the parameterized one.
        const plan = pg.psql(
          `PREPARE subtree(${BINDS.map(() => "text").join(",")}) AS ` +
            `SELECT * FROM "books"."accounts" WHERE ${predicate};\n` +
            `EXPLAIN EXECUTE subtree(${BINDS.map((b) => `'${b}'`).join(", ")});`,
        );

        // --- 4. the assertion this mission exists for -----------------------
        expect(
          plan,
          `the subtree read did NOT use accounts_data_key_idx — it is still a scan:\n${plan}`,
        ).toMatch(/(Index|Bitmap Index) Scan[^\n]*accounts_data_key_idx/);
        expect(plan, `no Index Cond on the data_key index:\n${plan}`).toMatch(/Index Cond:/);
        expect(plan, `unexpectedly still a sequential scan:\n${plan}`).not.toMatch(
          /Seq Scan on accounts/,
        );
        // …and the anchored recheck is still in the plan, applied to the rows
        // the index returned.  That term is what makes the wildcard trap
        // unreachable — a plan that rides the index but lost the recheck would
        // be the #2562 leak with better performance.
        expect(plan, `the anchored recheck vanished from the plan:\n${plan}`).toMatch(/strpos/);

        // --- 5. the Ecto spelling of the same predicate plans the same way ---
        // Ecto passes COLUMNS as fragment arguments too, so rebuild the SQL by
        // walking the emitted argument list: `record.<f>` slots become real
        // column references, value slots (`^…`) become `$n` binds.
        const elixirDir = generate("elixir", "ecto");
        const ectoText = [...readAll(elixirDir)].map(([, c]) => c).join("\n");
        const call = findEctoFragment(ectoText);
        expect(call, "no Ecto subtree fragment emitted").not.toBeNull();
        const ectoArgs = splitArgs(call!.args);
        const ectoBinds: string[] = [];
        let a = 0;
        const ectoSql = call!.sql.replace(/\?/g, () => {
          const arg = ectoArgs[a++]!;
          const col = /^\w+\.(\w+)$/.exec(arg);
          if (col) return `"${col[1]}"`;
          ectoBinds.push(BINDS[ectoBinds.length] ?? ANCHOR);
          return `$${ectoBinds.length}`;
        });
        expect(a, "argument list did not line up with the fragment's placeholders").toBe(
          ectoArgs.length,
        );
        const ectoPlan = pg.psql(
          `PREPARE ecto_subtree(${ectoBinds.map(() => "text").join(",")}) AS ` +
            `SELECT * FROM "books"."accounts" WHERE ${ectoSql};\n` +
            `EXPLAIN EXECUTE ecto_subtree(${ectoBinds.map((b) => `'${b}'`).join(", ")});`,
        );
        expect(
          ectoPlan,
          `the Ecto spelling did NOT use accounts_data_key_idx:\n${ectoPlan}`,
        ).toMatch(/(Index|Bitmap Index) Scan[^\n]*accounts_data_key_idx/);
      } finally {
        pg?.stop();
      }
    }, 900_000);
  },
);
