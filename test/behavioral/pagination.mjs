// M-T1.1 / M-T2.6 runtime acceptance capstone.
//
// Boots the GENERATED Hono backend (from `pagination.ddd`) on PGlite —
// the same in-process boot the behavioral tier uses (`run.mjs`) — then
// SEEDS 1000 rows over the real HTTP create surface and drives the paged
// list endpoint (`GET /api/widgets?page=&pageSize=&sort=&dir=`), asserting
// the server-computed window, envelope counters, and whitelisted ORDER BY.
//
// This is the acceptance proof the emitted DSL `test e2e` cannot express:
// it has no loop, so it cannot seed 1000 rows to exercise a real second
// page.  Seed `name` in the REVERSE order of `rank` (name asc == rank desc)
// so a server that ignored the `sort` field — or sorted by the wrong
// column — is caught, not masked by a coincidentally-shared order.
//
// Usage:  npm ci  (in this dir, once) ; node pagination.mjs
// Exit non-zero on any failed assertion or a boot error.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const DDD = join(HERE, "pagination.ddd");
const N = 1000;

/** Bootstraps the generated backend on PGlite and returns a `fetch`-like
 *  dispatch bound to its Hono app. */
function entrySource(deplDir) {
  const J = JSON.stringify;
  return `
import { synthDDL } from ${J(join(REPO, "web/src/runtime/ddl.ts"))};
import { createApp } from ${J(join(deplDir, "http/index.ts"))};
import * as schema from ${J(join(deplDir, "db/schema.ts"))};
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { is, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

export async function boot() {
  const pglite = new PGlite();
  await pglite.exec(synthDDL(schema, { is, Table, getTableConfig }));
  const db = drizzle(pglite, { schema });
  const app = createApp(db);
  const dispatch = (path, init) => app.fetch(new Request("http://x" + path, init));
  const close = () => pglite.close?.();
  return { dispatch, close };
}
`;
}

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failures++;
    process.stdout.write(`  ✗ ${name}${detail ? `  — ${detail}` : ""}\n`);
  }
}

async function main() {
  const genDir = mkdtempSync(join(tmpdir(), "loom-paging-"));
  const workDir = join(HERE, ".work", "pagination");
  mkdirSync(workDir, { recursive: true });
  try {
    process.stdout.write(`▶ generating ${DDD}\n`);
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", DDD, "-o", genDir], {
      stdio: "pipe",
    });
    const deplDir = join(genDir, "api");
    const entry = join(workDir, "entry.mts");
    const bundle = join(workDir, "bundle.mjs");
    writeFileSync(entry, entrySource(deplDir));
    await build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      packages: "external",
      logLevel: "warning",
    });
    const { boot } = await import(pathToFileURL(bundle).href);
    const { dispatch, close } = await boot();

    const getJson = async (path) => {
      const r = await dispatch(path, { method: "GET" });
      return { status: r.status, body: await r.json() };
    };

    // ── Seed 1000 rows.  `name` runs opposite to `rank`: rank i ⇒ name
    // w<0999-i> so name-asc order == rank-desc order. ─────────────────────
    process.stdout.write(`▶ seeding ${N} widgets\n`);
    const pad = (n) => String(n).padStart(4, "0");
    for (let base = 0; base < N; base += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, N - base) }, (_, k) => {
          const i = base + k;
          return dispatch("/api/widgets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: `w${pad(N - 1 - i)}`, rank: i }),
          });
        }),
      );
    }

    process.stdout.write("▶ asserting paged reads\n");

    // 1. Page 1, sorted by rank asc — first window + envelope counters.
    {
      const { status, body } = await getJson("/api/widgets?page=1&pageSize=25&sort=rank&dir=asc");
      check("page 1 responds 200", status === 200, `status=${status}`);
      check("page 1 window is 25 rows", body.items.length === 25, `len=${body.items.length}`);
      check("page 1 first row rank=0", body.items[0]?.rank === 0, `rank=${body.items[0]?.rank}`);
      check("page 1 last row rank=24", body.items[24]?.rank === 24, `rank=${body.items[24]?.rank}`);
      check("total=1000", body.total === N, `total=${body.total}`);
      check("totalPages=40", body.totalPages === 40, `totalPages=${body.totalPages}`);
      check("page counter echoed", body.page === 1, `page=${body.page}`);
      check("pageSize counter echoed", body.pageSize === 25, `pageSize=${body.pageSize}`);
    }

    // 2. Page 2 — the window is offset by exactly one page (the property a
    //    seed-less DSL e2e cannot reach).
    {
      const { body } = await getJson("/api/widgets?page=2&pageSize=25&sort=rank&dir=asc");
      check("page 2 first row rank=25", body.items[0]?.rank === 25, `rank=${body.items[0]?.rank}`);
      check("page 2 last row rank=49", body.items[24]?.rank === 49, `rank=${body.items[24]?.rank}`);
    }

    // 3. Descending direction on rank.
    {
      const { body } = await getJson("/api/widgets?page=1&pageSize=10&sort=rank&dir=desc");
      check("rank desc first row rank=999", body.items[0]?.rank === 999, `rank=${body.items[0]?.rank}`);
      check("rank desc 10th row rank=990", body.items[9]?.rank === 990, `rank=${body.items[9]?.rank}`);
    }

    // 4. Sort by a DIFFERENT field — name asc == rank desc by construction,
    //    so this proves the server honours the `sort` field, not a fixed
    //    column.
    {
      const { body } = await getJson("/api/widgets?page=1&pageSize=25&sort=name&dir=asc");
      check("name asc first row is name w0000", body.items[0]?.name === "w0000", `name=${body.items[0]?.name}`);
      check("name asc first row rank=999 (opposite of rank)", body.items[0]?.rank === 999, `rank=${body.items[0]?.rank}`);
    }

    // 5. Last page and beyond — the tail is a full window; past it is empty
    //    but the envelope counters still report the true totals.
    {
      const last = await getJson("/api/widgets?page=40&pageSize=25&sort=rank&dir=asc");
      check("last page (40) is full 25 rows", last.body.items.length === 25, `len=${last.body.items.length}`);
      check("last page last row rank=999", last.body.items[24]?.rank === 999, `rank=${last.body.items[24]?.rank}`);
      const past = await getJson("/api/widgets?page=41&pageSize=25&sort=rank&dir=asc");
      check("past-last page is empty", past.body.items.length === 0, `len=${past.body.items.length}`);
      check("past-last page still reports total=1000", past.body.total === N, `total=${past.body.total}`);
    }

    // 6. An unknown sort field falls back to the id whitelist default — no
    //    crash, still a well-formed envelope over all 1000.
    {
      const { status, body } = await getJson("/api/widgets?page=1&pageSize=5&sort=DROP&dir=asc");
      check("unknown sort field falls back (200, no crash)", status === 200, `status=${status}`);
      check("unknown sort field still totals 1000", body.total === N, `total=${body.total}`);
    }

    // 7. Bare list (no query params) — the emitted defaults apply
    //    (page 1, pageSize 20).
    {
      const { body } = await getJson("/api/widgets");
      check("default page=1", body.page === 1, `page=${body.page}`);
      check("default pageSize=20", body.pageSize === 20, `pageSize=${body.pageSize}`);
      check("default window is 20 rows", body.items.length === 20, `len=${body.items.length}`);
    }

    await close();
  } finally {
    rmSync(genDir, { recursive: true, force: true });
  }

  process.stdout.write(`\n${failures === 0 ? "PASS" : `FAIL (${failures} assertion(s))`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`ERROR: ${err?.stack ?? err}\n`);
  process.exit(1);
});
