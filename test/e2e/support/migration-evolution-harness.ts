// Shared harness for the migration-EVOLUTION gate (M-T2.13) across the five SQL
// backends.
//
// The per-PR compile/first-boot tiers prove a migration EMITS and APPLIES to a
// fresh database.  Nothing proved a migration *evolves* correctly on data that
// already exists — the silent-data-loss class.  This harness runs the two
// runtime checks the mission asks for, per backend, against a real Postgres:
//
//   CHECK 1 — migrate-vs-create equivalence.  The schema after applying the
//     FULL migration chain (Initial v1 → delta v2) must be byte-for-byte
//     equivalent to the schema of a FRESH create of the head (v2) model.  A
//     drift means an `ALTER` diverged from what a `CREATE` of the same shape
//     produces.
//
//   CHECK 2 — populated forward-migrate.  Seed a v1 row through the REST
//     surface, evolve the `.ddd` to v2, apply the derived forward migration,
//     and assert the row SURVIVES with correct values (renamed column keeps its
//     value, back-filled NOT-NULL column is populated, nullable add is NULL).
//     A destructive/lossy column change the derive should have gated shows up
//     here as a lost or wrong row.
//
// The two `.ddd` versions live in test/e2e/fixtures/migration-evolution/{base,
// evolved}.ddd; the v1→v2 delta is a value-preserving rename + a back-filled
// NOT-NULL add + a nullable add (see evolved.ddd).  Only the boot mechanics
// differ per backend, so those stay in a per-backend `BackendDriver`; the
// Postgres lifecycle, the schema fingerprint, and both assertion sequences live
// here and are backend-agnostic.

import { type ChildProcess, execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..", "..");
export const cli = path.join(repoRoot, "bin", "cli.js");
const fixtureDir = path.join(repoRoot, "test", "e2e", "fixtures", "migration-evolution");

export function readFixture(name: "base" | "evolved"): string {
  return fs.readFileSync(path.join(fixtureDir, `${name}.ddd`), "utf8");
}

export function hasDocker(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not pick a free port"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Postgres — ONE server, TWO databases.  CHECK 1 needs the chain schema and the
// fresh-create schema side by side, so the harness stands up a single server
// and creates two databases in it (`chain`, `fresh`).  Honours
// `LOOM_MIGRATION_PG_URL` (the CI `services:` container) and otherwise spins a
// docker sidecar — same convention as the tenancy harness.
// ---------------------------------------------------------------------------

export interface PgServer {
  host: string;
  port: number;
  user: string;
  password: string;
  stop: () => void;
}

/** One database on the server — what a backend boot connects to. */
export interface PgConn {
  host: string;
  port: number;
  user: string;
  password: string;
  db: string;
}

export async function startPgServer(): Promise<PgServer> {
  const override = process.env.LOOM_MIGRATION_PG_URL;
  if (override) {
    const u = new URL(override);
    return {
      host: u.hostname,
      port: Number(u.port || "5432"),
      user: decodeURIComponent(u.username || "postgres"),
      password: decodeURIComponent(u.password || "postgres"),
      stop: () => {},
    };
  }
  if (!hasDocker()) {
    throw new Error(
      "migration-evolution e2e: docker unreachable and no LOOM_MIGRATION_PG_URL override given.",
    );
  }
  const name = `loom-migration-pg-${process.pid}`;
  const port = await freePort();
  execSync(
    `docker run -d --rm --name ${name} ` +
      `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app ` +
      `-p ${port}:5432 postgres:18-alpine`,
    { stdio: "pipe", timeout: 60_000 },
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      execSync(`docker exec ${name} pg_isready -U postgres`, { stdio: "pipe", timeout: 5_000 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return {
    host: "127.0.0.1",
    port,
    user: "postgres",
    password: "postgres",
    stop: () => {
      try {
        execSync(`docker rm -f ${name}`, { stdio: "pipe", timeout: 15_000 });
      } catch {
        /* best-effort */
      }
    },
  };
}

function serverUrl(s: PgServer, db: string): string {
  return `postgres://${encodeURIComponent(s.user)}:${encodeURIComponent(s.password)}@${s.host}:${s.port}/${db}`;
}

/** Run one SQL statement via host `psql` (preinstalled on GitHub runners; the
 *  tenancy-hierarchy gate relies on the same).  Returns trimmed stdout. */
function psql(s: PgServer, db: string, sql: string): string {
  try {
    return execFileSync("psql", [serverUrl(s, db), "-tAqc", sql], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
      .toString()
      .trim();
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    throw new Error(
      `psql failed (is postgresql-client on PATH?): ${err.stderr?.toString() ?? err.message ?? e}`,
    );
  }
}

/** Drop-and-recreate a database for a clean slate. */
export function resetDatabase(s: PgServer, db: string): void {
  psql(s, "postgres", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  psql(s, "postgres", `CREATE DATABASE "${db}"`);
}

export function connFor(s: PgServer, db: string): PgConn {
  return { host: s.host, port: s.port, user: s.user, password: s.password, db };
}

// Migration-runner bookkeeping tables/schemas each backend maintains — excluded
// from the fingerprint so CHECK 1 compares only the DOMAIN schema.  node:
// `drizzle.__drizzle_migrations`; python: `__loom_migrations`; dotnet:
// `__EFMigrationsHistory`; java: `flyway_schema_history`; elixir/Ecto:
// `schema_migrations`.
const TRACKING_SCHEMAS = ["pg_catalog", "information_schema", "drizzle"];
const TRACKING_TABLES = [
  "__drizzle_migrations",
  "__loom_migrations",
  "__efmigrationshistory",
  "flyway_schema_history",
  "schema_migrations",
];

/**
 * A normalized, ORDER-INDEPENDENT fingerprint of a database's domain schema:
 * one sorted line per column (`schema.table | column | type | nullable |
 * default`) and one per primary key.  Columns are sorted by NAME, not physical
 * ordinal — a rename leaves a column in place while an add appends, so the
 * physical order legitimately differs between the chain and a fresh create; the
 * SET of columns and their types/nullability/PKs must not.
 */
export function fingerprintSchema(s: PgServer, db: string): string {
  const notSchemas = TRACKING_SCHEMAS.map((x) => `'${x}'`).join(",");
  const notTables = TRACKING_TABLES.map((x) => `'${x}'`).join(",");
  const q = `
SELECT string_agg(line, E'\\n' ORDER BY line) FROM (
  SELECT format('COL %s.%s | %s | %s | nullable=%s | default=%s',
                c.table_schema, c.table_name, c.column_name, c.data_type,
                c.is_nullable, coalesce(c.column_default,'-')) AS line
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
  WHERE c.table_schema NOT IN (${notSchemas}) AND lower(c.table_name) NOT IN (${notTables})
  UNION ALL
  SELECT format('PK  %s.%s | %s',
                tc.table_schema, tc.table_name,
                string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position))
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
  WHERE tc.constraint_type='PRIMARY KEY'
    AND tc.table_schema NOT IN (${notSchemas}) AND lower(tc.table_name) NOT IN (${notTables})
  GROUP BY tc.table_schema, tc.table_name
) s`;
  return psql(s, db, q);
}

// ---------------------------------------------------------------------------
// Codegen — write the fixture with the platform substituted and `generate
// system` into an output tree.  The v1 generation writes the baseline snapshot;
// the v2 generation over the SAME tree diffs against it to derive the forward
// migration.  A FRESH tree generation of v2 has no baseline, so it emits the
// full Initial(v2) — the fresh-create side of CHECK 1.
// ---------------------------------------------------------------------------

export function generate(source: string, platform: string, outDir: string): void {
  const dddPath = path.join(outDir, "app.ddd");
  fs.writeFileSync(dddPath, source.replaceAll("__PLATFORM__", platform));
  try {
    execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
      stdio: "pipe",
      cwd: repoRoot,
    });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `generate system failed for ${platform}:\n${err.stdout?.toString() ?? ""}\n${err.stderr?.toString() ?? ""}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Boot readiness + REST assertion sequences (backend-agnostic).
// ---------------------------------------------------------------------------

export async function waitForReady(
  base: string,
  bootLog: () => string,
  ms = 120_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(`${base}/ready`);
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`backend never became ready; log:\n${bootLog().slice(0, 8192)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function rows<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)) {
    return (body as { items: T[] }).items;
  }
  throw new Error(`expected a list or {items:[…]} envelope, got: ${JSON.stringify(body)}`);
}

/** The seeded v1 row's value fingerprint — asserted to survive forward-migration. */
export const SEED = { name: "Widget", price: 9.99 } as const;

/** POST a v1 Product `{name, price}` and return its id. */
export async function seedV1Product(base: string): Promise<string> {
  const r = await fetch(`${base}/api/products`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: SEED.name, price: String(SEED.price) }),
  });
  expect(r.status, `seed create: ${await r.clone().text()}`).toBe(201);
  const { id } = (await r.json()) as { id: string };
  expect(id, "created product id").toBeTruthy();
  return id;
}

interface V2Product {
  id: string;
  name: string;
  unitPrice: string | number;
  sku: string;
  description: string | null;
}

/**
 * CHECK 2 — the seeded v1 row survived the forward migration with correct
 * values: same id, name preserved, `price` renamed to `unitPrice` with its
 * value intact (compared numerically — wire money scale varies per backend),
 * `sku` back-filled to "SEED", `description` NULL (the nullable add).
 */
export async function assertForwardMigrated(base: string, id: string): Promise<void> {
  const r = await fetch(`${base}/api/products/${id}`);
  expect(r.status, `forward-migrated read: ${await r.clone().text()}`).toBe(200);
  const p = (await r.json()) as V2Product;
  expect(p.name, "name preserved").toBe(SEED.name);
  expect(Number(p.unitPrice), "renamed price value preserved as unitPrice").toBeCloseTo(
    SEED.price,
    2,
  );
  expect(p.sku, "NOT-NULL add back-filled").toBe("SEED");
  expect(p.description, "nullable add is NULL").toBeNull();

  // The row must still be the ONLY row (no phantom/duplicate from the migration).
  const list = rows<V2Product>(await (await fetch(`${base}/api/products`)).json());
  expect(
    list.filter((x) => x.id === id).length,
    "exactly one surviving row for the seeded id",
  ).toBe(1);
}

/** CHECK 1 — the chain schema and the fresh-create schema are equivalent. */
export function assertSchemaEquivalent(fpChain: string, fpFresh: string): void {
  expect(fpChain, "chain-migrated schema must be non-empty").toBeTruthy();
  expect(
    fpChain,
    `migrate-chain schema drifted from a fresh create of the head model.\n` +
      `--- chain (Initial v1 → delta v2) ---\n${fpChain}\n` +
      `--- fresh (Initial v2) ---\n${fpFresh}`,
  ).toBe(fpFresh);
}

// ---------------------------------------------------------------------------
// Per-backend driver — the only backend-specific surface.  Boot mechanics and
// the out-of-band migrate step (Ecto) live here; the orchestration below is
// shared.
// ---------------------------------------------------------------------------

export interface BootHandle {
  base: string;
  bootLog: () => string;
  stop: () => void;
}

export interface BackendDriver {
  /** `__PLATFORM__` substitution value (node/python/java/dotnet/elixir). */
  platform: string;
  /** Toolchain presence check + its name (for the skip message). */
  toolchain: { name: string; check: () => boolean };
  /** One-time dependency install / compile against a freshly-generated tree. */
  install: (appDir: string) => void;
  /** Rebuild compiled artifacts after a regenerate (java bootJar); no-op else. */
  rebuild?: (appDir: string) => void;
  /**
   * Apply pending migrations OUT OF BAND where boot does not (Ecto:
   * ecto.create + ecto.migrate).  No-op for backends that migrate at boot
   * (node/python/dotnet/java).  Called before each boot against `pg`.
   */
  migrate?: (appDir: string, pg: PgConn) => void;
  /** Boot the app against `pg` on `port`.  Backends that migrate at boot do so here. */
  boot: (appDir: string, pg: PgConn, port: number) => BootHandle;
  /** Ready-poll budget (cold builds vary widely per backend). */
  readyTimeoutMs: number;
}

/** Kill a detached child's whole process group, best-effort. */
export function killChild(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** Wire a spawned child's stdout/stderr into an accumulating boot log + BootHandle. */
export function handleFor(
  child: ChildProcess,
  base: string,
): { handle: BootHandle; child: ChildProcess } {
  let log = "";
  child.stdout?.on("data", (c: Buffer) => {
    log += c.toString("utf8");
  });
  child.stderr?.on("data", (c: Buffer) => {
    log += c.toString("utf8");
  });
  return { child, handle: { base, bootLog: () => log, stop: () => killChild(child) } };
}

// ---------------------------------------------------------------------------
// The shared gate — runs both checks end to end for one backend.
//
//   Tree A (evolution): generate v1 → install → boot on `chain` → seed → stop
//     → regenerate v2 over the same tree → rebuild/migrate → boot on `chain`
//     → CHECK 2 (row survived) → fingerprint(chain).
//   Tree B (fresh): generate v2 fresh → install → migrate → boot on `fresh`
//     → fingerprint(fresh).
//   CHECK 1: fingerprint(chain) ≡ fingerprint(fresh).
// ---------------------------------------------------------------------------

export async function runMigrationEvolutionGate(driver: BackendDriver): Promise<void> {
  if (!driver.toolchain.check()) {
    throw new Error(
      `migration-evolution ${driver.platform}: \`${driver.toolchain.name}\` not on PATH.`,
    );
  }
  const base = readFixture("base");
  const evolved = readFixture("evolved");

  const treeA = fs.mkdtempSync(path.join(os.tmpdir(), `loom-mev-${driver.platform}-chain-`));
  const treeB = fs.mkdtempSync(path.join(os.tmpdir(), `loom-mev-${driver.platform}-fresh-`));
  const appA = path.join(treeA, "d");
  const appB = path.join(treeB, "d");

  let server: PgServer | undefined;
  const boots: BootHandle[] = [];
  const boot = async (appDir: string, pg: PgConn): Promise<BootHandle> => {
    driver.migrate?.(appDir, pg);
    const port = await freePort();
    const h = driver.boot(appDir, pg, port);
    boots.push(h);
    await waitForReady(h.base, h.bootLog, driver.readyTimeoutMs);
    return h;
  };

  try {
    server = await startPgServer();
    resetDatabase(server, "chain");
    resetDatabase(server, "fresh");
    const chain = connFor(server, "chain");
    const fresh = connFor(server, "fresh");

    // --- Tree A: v1 → seed → evolve → forward-migrate ---
    generate(base, driver.platform, treeA);
    driver.install(appA);
    const v1 = await boot(appA, chain);
    const id = await seedV1Product(v1.base);
    v1.stop();
    await settle();

    generate(evolved, driver.platform, treeA); // diff against the v1 baseline snapshot
    driver.rebuild?.(appA);
    const v2 = await boot(appA, chain);
    await assertForwardMigrated(v2.base, id); // CHECK 2
    const fpChain = fingerprintSchema(server, "chain");
    v2.stop();
    await settle();

    // --- Tree B: fresh create of the head (v2) model ---
    generate(evolved, driver.platform, treeB);
    driver.install(appB);
    const fb = await boot(appB, fresh);
    const fpFresh = fingerprintSchema(server, "fresh");
    fb.stop();

    assertSchemaEquivalent(fpChain, fpFresh); // CHECK 1
  } finally {
    for (const b of boots) b.stop();
    server?.stop();
    for (const dir of [treeA, treeB]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Give a killed detached child a moment to release its port before the reboot. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 1_500));
}
