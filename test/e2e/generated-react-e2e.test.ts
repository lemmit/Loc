import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Runtime e2e for the React frontend (test-parity audit, finding F3).
//
// The `generated-react-build` gate compiles the React project (tsc
// --noEmit + vite build) but never RUNS it, and `behavioral-ui-e2e`
// exercises the EMITTED `*.ui.spec.ts` (the page-object round-trips) —
// neither runs the route-driven `e2e/smoke.spec.ts` the React generator
// also emits.  Vue and Svelte each have a dedicated *-e2e workflow that
// `vite preview`s the bundle and runs that smoke spec; React did not, so
// a runtime-only routing/mount regression (a broken root mount, a nav
// link that resolves wrong) could slip its smoke spec entirely.
//
// This is the React sibling of generated-{vue,svelte}-e2e.test.ts: build
// the bundle, serve it with `vite preview`, and run the SPA's own emitted
// Playwright smoke spec (every param-less page navigates and loads)
// against it.  Pure client-side: the smoke checks routing + the SPA shell,
// no backend needed (API calls may 404 against no server; the smoke only
// asserts navigation + a visible body).
//
// Opt-in — heavy (npm installs + a Playwright browser download).  Run with
// `LOOM_REACT_E2E=1 npx vitest run test/e2e/generated-react-e2e.test.ts`
// (or via the generated-react-e2e.yml CI workflow).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_REACT_E2E === "1";
const PACK = process.env.LOOM_REACT_E2E_PACK ?? "mantine@v7";
// showcase.ddd's `console_web` is the richest React deployable (exercises
// every walker primitive), so its smoke spec navigates the widest page set
// — the same cell generated-react-build leans on.
const EXAMPLE = "examples/showcase.ddd";
const REACT_DIR = "console_web";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 900_000 });
}

// Rewrite the FIRST `design:` slot to the qualified pack — showcase's
// first slot belongs to `console_web`, the deployable we build.  Falls
// back to injecting into a `deployable <name> { … }` block when no slot
// exists.  Mirrors the react-build / svelte-e2e helpers.
function injectDesign(src: string, qualified: string): string {
  const existing = /(\bdesign:\s*)(?:"[^"]*"|\w+)/;
  if (existing.test(src)) return src.replace(existing, `$1"${qualified}"`);
  const multiLine = /(deployable \w+ \{)([^}]*?)\n(\s*)\}/;
  return src.replace(multiLine, (_, head, body, indent) => {
    return `${head}${body}\n${indent}design: "${qualified}"\n${indent}}`;
  });
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

describe.skipIf(!ENABLED)("generated react project runs (vite preview + Playwright smoke)", () => {
  it(`${EXAMPLE} × ${PACK}`, { timeout: 900_000 }, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "loom-react-e2e-"));
    const src = fs.readFileSync(path.join(repoRoot, EXAMPLE), "utf-8");
    fs.writeFileSync(path.join(work, "main.ddd"), injectDesign(src, PACK));
    run(`node ${cli} generate system ${work}/main.ddd -o ${work}/out`, repoRoot);

    const project = path.join(work, "out", REACT_DIR);
    expect(fs.existsSync(path.join(project, "package.json")), "react project emitted").toBe(true);
    run("npm install --no-audit --no-fund", project);
    run("npx vite build --logLevel warn", project);
    expect(fs.existsSync(path.join(project, "dist", "index.html")), "vite build output").toBe(true);

    // Serve the built static bundle with `vite preview` on a free port.
    const port = await freePort();
    const preview = spawn(
      "npx",
      ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      { cwd: project, stdio: "pipe", detached: true },
    );
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForServer(baseUrl, 60_000);

      // The emitted Playwright suite lives under e2e/ with its own
      // package.json.  Install it + a chromium browser, then run the
      // smoke spec against the preview server.
      const e2e = path.join(project, "e2e");
      expect(fs.existsSync(path.join(e2e, "smoke.spec.ts")), "smoke spec emitted").toBe(true);
      run("npm install --no-audit --no-fund", e2e);
      run("npx playwright install --with-deps chromium", e2e);
      run(`E2E_BASE_URL=${baseUrl} npx playwright test smoke.spec.ts`, e2e);
    } finally {
      // Kill the preview process group (detached → negative pid).
      if (preview.pid !== undefined) {
        try {
          process.kill(-preview.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
  });
});
