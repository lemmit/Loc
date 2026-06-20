import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Runtime e2e for the Svelte frontend (next-steps item 6).
//
// The `generated-svelte-build` gate compiles the SvelteKit project
// (svelte-check + vite build) but never RUNS it — so a runtime-only
// regression (a broken root mount, a nav link that resolves wrong, the
// native-`<select>` interaction the page-object review caught only
// statically) would slip through.  This boots the built bundle with
// `vite preview` and runs the SPA's own emitted Playwright smoke spec
// (`e2e/smoke.spec.ts`) against it — every param-less page navigates and
// loads.  Pure client-side: the smoke checks routing + the SPA shell, no
// backend needed (API calls may 404 against no server; the smoke only
// asserts navigation + a visible body).
//
// Opt-in — heavy (npm installs + a Playwright browser download).  Run
// with `LOOM_SVELTE_E2E=1 npx vitest run test/e2e/generated-svelte-e2e.test.ts`
// (or via the generated-svelte-e2e.yml CI workflow).  Mirrors the react
// runtime-e2e pattern (embed-react-elixir.test.ts).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_SVELTE_E2E === "1";
const PACK = process.env.LOOM_SVELTE_E2E_PACK ?? "shadcnSvelte@v1";
const EXAMPLE = "examples/svelte-shop.ddd";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 900_000 });
}

function injectDesign(src: string, qualified: string): string {
  const existing = /(\bdesign:\s*)(?:"[^"]*"|\w+)/;
  if (existing.test(src)) return src.replace(existing, `$1"${qualified}"`);
  const multiLine = /(deployable web \{)([^}]*?)\n(\s*)\}/;
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

describe.skipIf(!ENABLED)("generated svelte project runs (vite preview + Playwright smoke)", () => {
  it(`${EXAMPLE} × ${PACK}`, { timeout: 900_000 }, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "loom-svelte-e2e-"));
    const src = fs.readFileSync(path.join(repoRoot, EXAMPLE), "utf-8");
    fs.writeFileSync(path.join(work, "main.ddd"), injectDesign(src, PACK));
    run(`node ${cli} generate system ${work}/main.ddd -o ${work}/out`, repoRoot);

    const project = path.join(work, "out", "web");
    expect(fs.existsSync(path.join(project, "svelte.config.js")), "svelte project emitted").toBe(
      true,
    );
    run("npm install --no-audit --no-fund", project);
    run("npx svelte-kit sync", project);
    run("npx vite build", project);
    expect(fs.existsSync(path.join(project, "build", "index.html")), "vite build output").toBe(
      true,
    );

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
