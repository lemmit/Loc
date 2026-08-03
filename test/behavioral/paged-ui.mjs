// The hand-written paged table, proven in a browser on 1000 real rows.
//
// `pagination.mjs` proves the SERVER half of paged-by-default: seed 1000 rows
// over HTTP, then assert the window, the envelope counters and the whitelisted
// ORDER BY.  This is the other half — the page an author actually writes.
//
// A bare `Table` over `.all` (see `paged-ui.ddd`) is auto-upgraded to server
// paging at the macro layer; before that it rendered the backend's default
// first window with no pager, so rows 21+ were unreachable and nothing on
// screen said so.  Emitted-text tests pin the shape of the rewrite; only a
// browser over a thousand seeded rows proves the rewrite NAVIGATES — that the
// page state the pager writes reaches the server and comes back as different
// rows.
//
// The stack is the UI tier's (`ui-stack.mjs`): generated Hono backend on
// PGlite + the vite-built React bundle, one origin, no docker.  The spec is
// `paged-ui.pw.ts`, copied in as `paged-ui.spec.ts` — hand-authored because
// the DSL's `test e2e` has no loop and so can never seed a real second page.
//
// Usage:  npm ci  (in this dir, once) ; node paged-ui.mjs
// Exit non-zero on any failed assertion or a boot error.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildServerModule,
  findDistRoot,
  findFrontendDeployable,
  findNodeDeployable,
  outcomesFromPlaywrightJson,
  REPO,
} from "./ui-stack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DDD = join(HERE, "paged-ui.ddd");
const SPEC = join(HERE, "paged-ui.pw.ts");
const WORK = join(HERE, ".work-paged-ui");
const N = 1000;

// The backend is bundled and booted IN THIS PROCESS, so its pino logger writes
// to our stdout — and the 1000-row seed alone would emit 2000 request lines,
// burying the spec results.  Set before the bundle is imported: the level is
// read once at module init.
process.env.LOG_LEVEL ??= "warn";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

/** Seed `N` widgets over the real HTTP create surface, `name` running OPPOSITE
 *  to `rank` so name-asc order == rank-desc order.  A server that ignored the
 *  `sort` field — or sorted by the wrong column — is then caught by the spec
 *  rather than masked by a coincidentally-shared order. */
async function seed(base) {
  const pad = (n) => String(n).padStart(4, "0");
  for (let from = 0; from < N; from += 50) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(50, N - from) }, (_, k) => {
        const i = from + k;
        return fetch(`${base}/api/widgets`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `w${pad(N - 1 - i)}`, rank: i }),
        });
      }),
    );
    const bad = batch.find((r) => !r.ok);
    if (bad) throw new Error(`seed failed: POST /api/widgets → ${bad.status}`);
  }
  // The spec's page count is derived from this total; a short seed would turn
  // every downstream assertion into a confusing off-by-N rather than a clear
  // "the seed didn't take".
  const listed = await (await fetch(`${base}/api/widgets?page=1&pageSize=1`)).json();
  if (listed.total !== N) throw new Error(`seeded ${listed.total} widgets, expected ${N}`);
}

async function main() {
  const genDir = mkdtempSync(join(tmpdir(), "loom-paged-ui-"));
  mkdirSync(WORK, { recursive: true });
  let server;
  let failures = 0;
  try {
    process.stdout.write(`▶ generating ${DDD}\n`);
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", DDD, "-o", genDir], {
      stdio: "pipe",
    });
    const frontendDir = findFrontendDeployable(genDir);
    const deplDir = findNodeDeployable(genDir);
    const e2eDir = join(frontendDir, "e2e");

    process.stdout.write("▶ building the generated frontend\n");
    execFileSync(npm, ["install", "--no-audit", "--no-fund"], { cwd: frontendDir, stdio: "pipe" });
    execFileSync(npm, ["run", "build"], { cwd: frontendDir, stdio: "pipe" });
    const distDir = findDistRoot(frontendDir);

    const { startServer } = await buildServerModule(deplDir, WORK);
    server = await startServer({ distDir });
    const base = `http://127.0.0.1:${server.port}`;
    process.stdout.write(`    stack on :${server.port}\n`);

    process.stdout.write(`▶ seeding ${N} widgets\n`);
    await seed(base);

    // The spec is hand-authored, so it is COPIED in rather than emitted —
    // renamed on the way so the repo's vitest run never discovers it.
    copyFileSync(SPEC, join(e2eDir, "paged-ui.spec.ts"));

    process.stdout.write("▶ driving the page in a browser\n");
    execFileSync(npm, ["install", "--no-audit", "--no-fund"], { cwd: e2eDir, stdio: "pipe" });
    execFileSync(npx, ["playwright", "install", "--with-deps", "chromium"], {
      cwd: e2eDir,
      stdio: "pipe",
    });
    const reportFile = join(WORK, "report.json");
    // ASYNC spawn — `spawnSync` would block the event loop and freeze the
    // in-process server, so every request from the browser would hang.
    await new Promise((res) => {
      const cp = spawn(npx, ["playwright", "test", "--reporter=list,json"], {
        cwd: e2eDir,
        stdio: "inherit",
        env: {
          ...process.env,
          E2E_BASE_URL: base,
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
        },
      });
      cp.on("exit", res);
    });
    if (!existsSync(reportFile)) throw new Error("Playwright produced no JSON report");
    const results = outcomesFromPlaywrightJson(JSON.parse(readFileSync(reportFile, "utf8")));
    if (results.length === 0) throw new Error("Playwright ran no specs");
    for (const r of results) {
      const ok = r.status === "pass";
      if (!ok) failures++;
      process.stdout.write(`  ${ok ? "✓" : "✗"} ${r.name}\n`);
      if (!ok && r.error) {
        const lines = String(r.error)
          .replace(/\[[0-9;]*m/g, "")
          .split("\n")
          .slice(0, 6);
        process.stdout.write(`      ${lines.join("\n      ")}\n`);
      }
    }
  } finally {
    if (server) await server.close().catch(() => {});
    rmSync(genDir, { recursive: true, force: true });
  }

  process.stdout.write(`\n${failures === 0 ? "PASS" : `FAIL (${failures} spec(s))`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`ERROR: ${err?.stack ?? err}\n`);
  process.exit(1);
});
