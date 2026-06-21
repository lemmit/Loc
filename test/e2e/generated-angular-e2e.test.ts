import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Runtime e2e for the Angular frontend (angular-frontend-plan.md Slice 6 —
// the runtime gate folded in on top of the page-object / smoke-spec
// generator work).
//
// The `generated-angular-build` gate compiles the Angular project (`ng build`
// = strict template typecheck + esbuild bundle) but never RUNS it — so a
// runtime-only regression (a broken root mount, a nav link that resolves
// wrong, a router restructured into routes that don't match) would slip
// through.  This boots the built `dist/browser/` static bundle with a tiny
// SPA-fallback static server and runs the SPA's own emitted Playwright smoke
// spec (`e2e/smoke.spec.ts`) against it — every param-less page navigates and
// loads.  Pure client-side: the smoke checks routing + the SPA shell, no
// backend needed (API calls may fail against no server; the smoke only
// asserts navigation + a visible body).
//
// The static server runs as a DETACHED child process (not in-process): the
// Playwright run below blocks via `execSync`, which would starve an
// in-process server's event loop.  This is the same reason the Vue / Svelte
// siblings `spawn` `vite preview` rather than serving inline.
//
// Opt-in — heavy (npm installs + an `ng build` + a Playwright browser
// download).  Run with
//   `LOOM_ANGULAR_E2E=1 npx vitest run test/e2e/generated-angular-e2e.test.ts`
// (or via the generated-angular-e2e.yml CI workflow).  The sibling-gate shape
// matches the Vue / Svelte runtime-e2e (generated-vue-e2e.test.ts).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_ANGULAR_E2E === "1";
const PACK = process.env.LOOM_ANGULAR_E2E_PACK ?? "angularMaterial@v1";

// The Slice-6 runtime gate exercises the scaffold-synthesised page set
// (list / new / home) — the same fixture the build gate's SCAFFOLD case
// uses, so the e2e and build gates stay aligned.  Inline so this test owns
// no example-file dependency (Angular's showcase example lands in Slice 5).
const SOURCE = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Customer with crudish {
          name: string
          email: string
        }
        aggregate Order with crudish {
          total: int
        }
      }
    }
    ui WebApp with scaffold(subdomains: [Sales]) { }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
    deployable web { platform: angular, targets: api, ui: WebApp, port: 3004 }
  }
`;

// Dependency-free SPA-fallback static server, written to disk + run as a
// detached child.  Serves the built `dist/browser/` bundle; unknown paths
// fall back to index.html so client-side routing resolves.
const STATIC_SERVER = `
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
const ROOT = process.argv[2];
const PORT = Number(process.argv[3]);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript",
  ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".woff": "font/woff",
};
function serve(res, p) {
  return stat(p).then((s) => {
    if (!s.isFile()) return false;
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    createReadStream(p).pipe(res);
    return true;
  }).catch(() => false);
}
createServer((req, res) => {
  const url = req.url ?? "/";
  const rel = normalize(decodeURIComponent(url.split("?")[0])).replace(/^(\\.\\.[/\\\\])+/, "");
  const fp = join(ROOT, rel);
  Promise.resolve(fp.startsWith(ROOT) ? serve(res, fp) : false).then((ok) => {
    if (ok) return;
    serve(res, join(ROOT, "index.html")).then((served) => {
      if (served) return;
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
    });
  });
}).listen(PORT, "127.0.0.1", () => console.log("serving " + ROOT + " on :" + PORT));
`;

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 900_000 });
}

/** Inject `design: "<pack>"` into the angular deployable (single-line or
 *  multi-line `platform: angular` block) — same helper shape as the
 *  generated-angular-build gate. */
function injectDesign(src: string, qualified: string): string {
  const existing = /(\bdesign:\s*)(?:"[^"]*"|\w+)/;
  if (existing.test(src)) return src.replace(existing, `$1"${qualified}"`);
  const singleLine = /(deployable \w+ \{[^}\n]*platform: angular\b[^}\n]*?)(\s*)\}/;
  if (singleLine.test(src)) return src.replace(singleLine, `$1, design: "${qualified}"$2}`);
  return src.replace(
    /(deployable \w+ \{[^}]*?platform: angular\b)/,
    `$1\n        design: "${qualified}"`,
  );
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

describe.skipIf(!ENABLED)("generated angular project runs (ng build + Playwright smoke)", () => {
  it(`scaffold × ${PACK}`, { timeout: 900_000 }, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "loom-angular-e2e-"));
    fs.writeFileSync(path.join(work, "main.ddd"), injectDesign(SOURCE, PACK));
    run(`node ${cli} generate system ${work}/main.ddd -o ${work}/out`, repoRoot);

    // The angular deployable is `web`.
    const project = path.join(work, "out", "web");
    expect(fs.existsSync(path.join(project, "angular.json")), "angular project emitted").toBe(true);
    run("npm install --no-audit --no-fund", project);
    run("npx ng build", project);

    // `@angular/build:application` emits the browser bundle to dist/browser/.
    const bundle = path.join(project, "dist", "browser");
    expect(fs.existsSync(path.join(bundle, "index.html")), "ng build output").toBe(true);

    // Serve the static bundle from a DETACHED child process (so the blocking
    // `execSync` Playwright run below doesn't starve its event loop).
    const serverScript = path.join(work, "static-server.mjs");
    fs.writeFileSync(serverScript, STATIC_SERVER);
    const port = await freePort();
    const server = spawn("node", [serverScript, bundle, String(port)], {
      stdio: "ignore",
      detached: true,
    });
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForServer(baseUrl, 60_000);

      // The emitted Playwright suite lives under e2e/ with its own
      // package.json.  Install it + a chromium browser, then run the smoke
      // spec against the served bundle.
      const e2e = path.join(project, "e2e");
      expect(fs.existsSync(path.join(e2e, "smoke.spec.ts")), "smoke spec emitted").toBe(true);
      run("npm install --no-audit --no-fund", e2e);
      run("npx playwright install --with-deps chromium", e2e);
      run(`E2E_BASE_URL=${baseUrl} npx playwright test smoke.spec.ts`, e2e);
    } finally {
      // Kill the server process group (detached → negative pid).
      if (server.pid !== undefined) {
        try {
          process.kill(-server.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
  });
});
