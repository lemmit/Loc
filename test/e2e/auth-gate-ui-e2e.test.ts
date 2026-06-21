import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Runtime auth UI-gate smoke — proves the auth gate WORKS at runtime, not just
// that it compiles.  Each frontend serves the shared `auth-gate.ddd` fixture (a
// gated ui: an ungated "Public" link, an "admin"-gated link/page, a
// "superadmin"-gated link/page, and an "admin"-gated operation button).  The
// emitted SPA is built + `vite preview`d; a shared Playwright spec
// (test/e2e/support/auth-gate.spec.ts) mocks `/auth/me` to a chosen role (no
// backend) and asserts each gate site hides/shows correctly — the real
// client-side `currentUser.role === …` evaluation the compile-only build gates
// can't exercise.
//
// Opt-in — heavy (npm install + vite build + a Playwright browser download).
//   LOOM_AUTH_GATE_E2E=1 npx vitest run test/e2e/auth-gate-ui-e2e.test.ts
// Mirrors the generated-svelte-e2e harness.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixture = path.join(here, "fixtures", "auth-gate-e2e", "auth-gate.ddd");
const sharedSpec = path.join(here, "support", "auth-gate.spec.ts");

const ENABLED = process.env.LOOM_AUTH_GATE_E2E === "1";

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 900_000 });
  } catch (e) {
    // execSync buries the child's stdout/stderr; surface them so a failing
    // `playwright test` (or build) shows WHICH assertion/step failed.
    const err = e as { stdout?: string; stderr?: string };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    throw new Error(`Command failed: ${cmd}\n${out}`);
  }
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not pick a free port"));
      }
    });
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms`);
}

/** Generate the fixture as `platform: <fw>` into a fresh workdir, returning the
 *  emitted `web/` project dir. */
function generateAs(fw: string, work: string): string {
  const src = fs.readFileSync(fixture, "utf-8").replace("platform: svelte", `platform: ${fw}`);
  fs.writeFileSync(path.join(work, "main.ddd"), src);
  run(`node ${cli} generate system ${work}/main.ddd -o ${work}/out`, repoRoot);
  return path.join(work, "out", "web");
}

/** Copy the shared gate spec into the emitted e2e/ dir, install it + a chromium
 *  browser, and run ONLY that spec against the preview server. */
function runGateSpec(project: string, baseUrl: string): void {
  const e2e = path.join(project, "e2e");
  expect(fs.existsSync(path.join(e2e, "fixtures.ts")), "e2e harness emitted").toBe(true);
  fs.copyFileSync(sharedSpec, path.join(e2e, "auth-gate.spec.ts"));
  run("npm install --no-audit --no-fund", e2e);
  run("npx playwright install --with-deps chromium", e2e);
  run(`E2E_BASE_URL=${baseUrl} npx playwright test auth-gate.spec.ts`, e2e);
}

async function previewAndTest(project: string, build: () => void, buildDir: string): Promise<void> {
  build();
  expect(fs.existsSync(path.join(project, buildDir)), "frontend build output").toBe(true);
  const port = await freePort();
  const preview = spawn(
    "npx",
    ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: project, stdio: "pipe", detached: true },
  );
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, 60_000);
    runGateSpec(project, baseUrl);
  } finally {
    if (preview.pid !== undefined) {
      try {
        process.kill(-preview.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

describe.skipIf(!ENABLED)("auth UI-gate runtime smoke", () => {
  it("svelte: menu / page-guard / op-button gate by role", { timeout: 900_000 }, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gate-svelte-"));
    const project = generateAs("svelte", work);
    expect(fs.existsSync(path.join(project, "svelte.config.js")), "svelte project emitted").toBe(
      true,
    );
    run("npm install --no-audit --no-fund", project);
    run("npx svelte-kit sync", project);
    await previewAndTest(project, () => run("npx vite build", project), "build");
  });
});
