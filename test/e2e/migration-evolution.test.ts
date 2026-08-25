import { execSync, spawn } from "node:child_process";
import { describe, it } from "vitest";
import {
  type BackendDriver,
  handleFor,
  type PgConn,
  runMigrationEvolutionGate,
  runMoneyBoundsCatchUpGate,
} from "./support/migration-evolution-harness.js";

// ---------------------------------------------------------------------------
// Migration-evolution gate (M-T2.13) — NODE/Hono/Drizzle backend.
//
// Two runtime checks against a real Postgres (see the harness header):
//   (1) migrate-chain schema ≡ fresh-create schema, and
//   (2) a seeded v1 row survives the derived forward migration with correct
//       values (renamed column value preserved, back-filled NOT-NULL populated,
//       nullable add NULL).
//
// The per-PR compile/first-boot tiers prove a migration EMITS and applies to a
// FRESH db; this is the only tier that proves it EVOLVES on data that already
// exists — the silent-data-loss class the M-T2.1/M-T2.2/M-T2.3 language work
// only shapes.
//
// Opt-in: LOOM_MIGRATION_E2E=1.  Needs docker (postgres sidecar) or
// LOOM_MIGRATION_PG_URL, plus host `psql` for schema introspection.
// ---------------------------------------------------------------------------

const ENABLED = process.env.LOOM_MIGRATION_E2E === "1";

const nodeDriver: BackendDriver = {
  platform: "node",
  toolchain: { name: "node", check: () => true },
  install(appDir) {
    execSync("npm install --silent --no-audit --no-fund", {
      cwd: appDir,
      stdio: "pipe",
      timeout: 180_000,
    });
  },
  boot(appDir, pg: PgConn, port) {
    const url = `postgres://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.db}`;
    const child = spawn("npx", ["tsx", "index.ts"], {
      cwd: appDir,
      env: { ...process.env, DATABASE_URL: url, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    return handleFor(child, `http://127.0.0.1:${port}`).handle;
  },
  readyTimeoutMs: 90_000,
};

describe.skipIf(!ENABLED)(
  "migration-evolution gate over the generated node backend (LOOM_MIGRATION_E2E=1)",
  () => {
    it("migrate-chain ≡ fresh-create, and seeded rows survive forward-migrate", async () => {
      await runMigrationEvolutionGate(nodeDriver);
    }, 480_000);
  },
);

describe.skipIf(!ENABLED)(
  "money-bounds catch-up gate — a pre-#2575 database receives NUMERIC(19,4) through review (M-T2.14)",
  () => {
    it("diffs the bound out, refuses it without --allow-destructive, applies it with", async () => {
      await runMoneyBoundsCatchUpGate();
    }, 240_000);
  },
);
