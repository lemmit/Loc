import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// accessibility.md Phase 4 — the axe-core tripwire.
//
// The a11y emit is "correct by construction" (Phases 1–3: the primitive
// contract, derived heading levels, skip link + landmarks, the missing-alt
// gate).  This is the VERIFICATION layer the proposal calls for: generate a
// frontend for a design pack, `vite build` + `vite preview` it, then drive
// axe-core over every param-less page route and assert ZERO serious/critical
// violations.  Because the output is generated, coverage is exhaustive across
// the example × pack matrix — coverage no hand-written app achieves.
//
// axe runs REPO-side (root devDeps `@axe-core/playwright` + `playwright`)
// against the preview URL — the generated project is NOT modified (no axe dep,
// no emitted axe spec, no byte-fixture churn), so this can't turn the existing
// build/e2e gates red.  It is opt-in and label/dispatch-gated
// (generated-a11y.yml), matching k8s-e2e's "surfaces issues, not per-PR
// required" shape — the proposal expects the first runs to surface violations
// to fix (lead pack first, then backfill).
//
// Opt-in — heavy (npm installs + a chromium build).  Run with
//   LOOM_A11Y_E2E=1 [LOOM_A11Y_PACK=mantine@v9] \
//   npx vitest run test/e2e/generated-a11y-e2e.test.ts
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_A11Y_E2E === "1";
const PACK = process.env.LOOM_A11Y_PACK ?? "mantine@v9";
const EXAMPLE = process.env.LOOM_A11Y_EXAMPLE ?? "examples/showcase.ddd";

// axe impact tiers we gate on.  "minor"/"moderate" are surfaced in the log but
// don't fail the build yet (the proposal targets the AA-blocking floor first).
const GATE_IMPACTS = new Set(["serious", "critical"]);

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 900_000 });
}

/** Point the (single) React `platform: static` deployable at `qualified`. */
function injectDesign(src: string, qualified: string): string {
  const existing = /(\bdesign:\s*)(?:"[^"]*"|\w+)/;
  if (existing.test(src)) return src.replace(existing, `$1"${qualified}"`);
  const singleLine = /(deployable \w+ \{[^}\n]*platform:\s*static[^}\n]*)\}/;
  if (singleLine.test(src)) {
    return src.replace(singleLine, (_, head) => `${head}design: "${qualified}" }`);
  }
  const multiLine = /(deployable \w+ \{[^}]*?platform:\s*static[^}]*?)\n(\s*)\}/;
  return src.replace(
    multiLine,
    (_, body, indent) => `${body}\n${indent}design: "${qualified}"\n${indent}}`,
  );
}

/** The emitted smoke spec already derives the param-less page routes; reuse
 *  its `page.goto("…")` list so we cover exactly the same set. */
function routesFromSmoke(e2eDir: string): string[] {
  const spec = fs.readFileSync(path.join(e2eDir, "smoke.spec.ts"), "utf-8");
  const routes = new Set<string>();
  for (const m of spec.matchAll(/page\.goto\((["'])(.*?)\1\)/g)) routes.add(m[2]!);
  return [...routes];
}

function findProject(outDir: string): string {
  for (const entry of fs.readdirSync(outDir)) {
    const dir = path.join(outDir, entry);
    if (fs.existsSync(path.join(dir, "vite.config.ts")) && fs.existsSync(path.join(dir, "e2e"))) {
      return dir;
    }
  }
  throw new Error(`no vite frontend project under ${outDir}`);
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

describe.skipIf(!ENABLED)("generated frontend clears axe-core (preview + axe)", () => {
  it(`${EXAMPLE} × ${PACK}`, { timeout: 900_000 }, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "loom-a11y-e2e-"));
    const src = fs.readFileSync(path.join(repoRoot, EXAMPLE), "utf-8");
    fs.writeFileSync(path.join(work, "main.ddd"), injectDesign(src, PACK));
    run(`node ${cli} generate system ${work}/main.ddd -o ${work}/out`, repoRoot);

    const project = findProject(path.join(work, "out"));
    run("npm install --no-audit --no-fund", project);
    run("npx vite build", project);
    expect(fs.existsSync(path.join(project, "dist", "index.html")), "vite build output").toBe(true);

    const routes = routesFromSmoke(path.join(project, "e2e"));
    expect(routes.length, "at least one route to scan").toBeGreaterThan(0);

    const port = await freePort();
    const preview = spawn(
      "npx",
      ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      { cwd: project, stdio: "pipe", detached: true },
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch();
    const offenders: string[] = [];
    try {
      await waitForServer(baseUrl, 60_000);
      // axe-core/playwright requires a page from an explicit context.
      const context = await browser.newContext();
      const page = await context.newPage();
      for (const route of routes) {
        await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
        const { violations } = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        for (const v of violations) {
          if (!GATE_IMPACTS.has(v.impact ?? "")) continue;
          offenders.push(`${route}  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`);
        }
      }
    } finally {
      await browser.close();
      if (preview.pid !== undefined) {
        try {
          process.kill(-preview.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
    expect(offenders, `axe serious/critical violations:\n${offenders.join("\n")}`).toEqual([]);
  });
});
