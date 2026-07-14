import { type ChildProcess, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { type PackFormat, packFormatForBuiltin } from "../../src/util/builtin-formats.js";

// ---------------------------------------------------------------------------
// accessibility.md Phase 4/5 — the axe-core tripwire, ACROSS every frontend.
//
// The a11y emit is "correct by construction" (Phases 1–3: the primitive
// contract, derived heading levels, skip link + landmarks, the missing-alt
// gate).  This is the VERIFICATION layer the proposal calls for: generate a
// frontend for a design pack, build + preview it, then drive axe-core over
// every param-less page route and assert ZERO serious/critical violations.
// Because the output is generated, coverage is exhaustive across the
// example × pack matrix — coverage no hand-written app achieves.
//
// This gate now spans ALL FOUR JSX/markup frontends, not just React.  The pack
// name alone selects the framework — `packFormatForBuiltin` maps e.g.
// `vuetify@v3 → "vue"`, `shadcnSvelte@v1 → "svelte"`, `angularMaterial@v1 →
// "angular"`, the React packs → "tsx" — so the workflow matrix just lists
// packs and the harness picks the platform, example, build, and preview for
// each.  The React path is unchanged: it still drives the rich `showcase.ddd`
// (via `LOOM_A11Y_EXAMPLE`).  The Vue/Svelte/Angular paths drive a shared
// scaffold system (list / new / detail / home pages — headings, forms, tables,
// landmarks) so the same app is scanned on every framework.
//
// The three vite frameworks (React/Vue/Svelte) `vite build` + `vite preview`;
// Angular `ng build`s to `dist/browser/` and serves it with a tiny SPA-fallback
// static server (Angular has no `vite preview`).  Either way axe runs REPO-side
// (root devDeps `@axe-core/playwright` + `playwright`) against the preview URL —
// the generated project is NOT modified (no axe dep, no emitted axe spec, no
// byte-fixture churn), so this can't turn the existing build/e2e gates red.  It
// is opt-in and label/dispatch-gated (generated-a11y.yml), matching k8s-e2e's
// "surfaces issues, not per-PR required" shape.
//
// Opt-in — heavy (npm installs + a chromium build).  Run with
//   LOOM_A11Y_E2E=1 [LOOM_A11Y_PACK=vuetify@v3] \
//   npx vitest run test/e2e/generated-a11y-e2e.test.ts
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_A11Y_E2E === "1";
const PACK = process.env.LOOM_A11Y_PACK ?? "mantine@v9";
// The pack's format IS the framework selector.  Default to React ("tsx") for a
// pack name the format map doesn't know (a custom pack path), so an unexpected
// value still exercises the (default) React path rather than crashing.
const FORMAT: PackFormat = packFormatForBuiltin(PACK) ?? "tsx";
// React drives the rich showcase example; the other frameworks drive the shared
// scaffold system below (LOOM_A11Y_EXAMPLE only overrides the React path).
const EXAMPLE = process.env.LOOM_A11Y_EXAMPLE ?? "examples/showcase.ddd";

// axe impact tiers we gate on.  "minor"/"moderate" are surfaced in the log but
// don't fail the build yet (the proposal targets the AA-blocking floor first).
const GATE_IMPACTS = new Set(["serious", "critical"]);

// The `platform:` keyword each pack format lowers to on the deployable.
const PLATFORM_BY_FORMAT: Record<Exclude<PackFormat, "heex">, string> = {
  tsx: "static", // `platform: static` is React's UI-only deployable kind.
  vue: "vue",
  svelte: "svelte",
  angular: "angular",
};

/** Shared scaffold system for the non-React frameworks — one subdomain, two
 *  crudish aggregates, `scaffold` UI (list / new / detail / home).  The
 *  `platform:` is filled per framework; `injectDesign` adds the pack.  Same
 *  shape the vue/svelte/angular build gates exercise, so it is known to
 *  generate + build on every framework. */
function scaffoldSystem(platform: string): string {
  return `
    system A11yShowcase {
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
      deployable web { platform: ${platform}, targets: api, ui: WebApp, port: 3009 }
    }
  `;
}

// Dependency-free SPA-fallback static server (Angular has no `vite preview`).
// Written to disk + run as a detached child; serves the built `dist/browser/`
// bundle, falling back to index.html so client-side routing resolves.  Copied
// from generated-angular-e2e.test.ts.
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

/** Point the deployable on `platform` at `qualified`.  When a `design:` slot
 *  already exists (the React showcase) the first is replaced; otherwise the
 *  slot is inserted into the matching `platform: <p>` deployable block (single-
 *  or multi-line).  Generalised from the per-framework build-gate helpers. */
function injectDesign(src: string, qualified: string, platform: string): string {
  const existing = /(\bdesign:\s*)(?:"[^"]*"|\w+)/;
  if (existing.test(src)) return src.replace(existing, `$1"${qualified}"`);
  const p = platform.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const singleLine = new RegExp(
    `(deployable \\w+ \\{[^}\\n]*platform:\\s*${p}\\b[^}\\n]*?)(\\s*)\\}`,
  );
  if (singleLine.test(src)) return src.replace(singleLine, `$1, design: "${qualified}"$2}`);
  const multiLine = new RegExp(`(deployable \\w+ \\{[^}]*?platform:\\s*${p}\\b[^}]*?)\\n(\\s*)\\}`);
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

/** Locate the emitted frontend project under `outDir` — the dir carrying the
 *  build-tool marker (`vite.config.ts` for vite frameworks, `angular.json` for
 *  Angular) alongside the `e2e/` smoke suite. */
function findProject(outDir: string, marker: string): string {
  for (const entry of fs.readdirSync(outDir)) {
    const dir = path.join(outDir, entry);
    if (fs.existsSync(path.join(dir, marker)) && fs.existsSync(path.join(dir, "e2e"))) {
      return dir;
    }
  }
  throw new Error(`no ${marker} frontend project under ${outDir}`);
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

interface FrameworkProfile {
  /** Deployable `platform:` keyword. */
  platform: string;
  /** Build-tool marker file distinguishing the frontend project dir. */
  projectMarker: string;
  /** Build command run in the project dir. */
  buildCmd: string;
  /** Where the built bundle's `index.html` lands, relative to the project. */
  distSubdir: string;
  /** How the bundle is previewed — a `vite preview` server, or the tiny
   *  SPA-fallback static server for Angular's plain `dist/browser/`. */
  preview: "vite" | "static";
}

function profileFor(format: PackFormat): FrameworkProfile {
  switch (format) {
    case "vue":
    case "tsx":
      return {
        platform: PLATFORM_BY_FORMAT[format],
        projectMarker: "vite.config.ts",
        buildCmd: "npx vite build",
        distSubdir: "dist",
        preview: "vite",
      };
    case "svelte":
      // SvelteKit's adapter-static writes the client bundle to `build/`
      // (not Vite's default `dist/`); `vite preview` still serves it.
      return {
        platform: PLATFORM_BY_FORMAT[format],
        projectMarker: "vite.config.ts",
        buildCmd: "npx vite build",
        distSubdir: "build",
        preview: "vite",
      };
    case "angular":
      return {
        platform: "angular",
        projectMarker: "angular.json",
        buildCmd: "npx ng build",
        distSubdir: path.join("dist", "browser"),
        preview: "static",
      };
    case "heex":
      throw new Error("HEEx (Phoenix) is not a browser-previewable frontend for the axe gate");
  }
}

/** Start the preview server for the built bundle and return the child process
 *  + its base URL.  Vite frameworks use `vite preview`; Angular uses the static
 *  server over `dist/browser/`. */
async function startPreview(
  project: string,
  work: string,
  profile: FrameworkProfile,
  port: number,
): Promise<ChildProcess> {
  if (profile.preview === "vite") {
    return spawn(
      "npx",
      ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      { cwd: project, stdio: "pipe", detached: true },
    );
  }
  const serverScript = path.join(work, "static-server.mjs");
  fs.writeFileSync(serverScript, STATIC_SERVER);
  const bundle = path.join(project, profile.distSubdir);
  return spawn("node", [serverScript, bundle, String(port)], { stdio: "ignore", detached: true });
}

describe.skipIf(!ENABLED)("generated frontend clears axe-core (preview + axe)", () => {
  const label = FORMAT === "tsx" ? EXAMPLE : `scaffold(${PLATFORM_BY_FORMAT[FORMAT] ?? FORMAT})`;
  it(`${label} × ${PACK}`, { timeout: 900_000 }, async () => {
    const profile = profileFor(FORMAT);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "loom-a11y-e2e-"));

    // React scans the rich showcase example; the other frameworks scan the
    // shared scaffold system.  `injectDesign` points the frontend deployable at
    // the matrix pack in both cases.
    const rawSrc =
      FORMAT === "tsx"
        ? fs.readFileSync(path.join(repoRoot, EXAMPLE), "utf-8")
        : scaffoldSystem(profile.platform);
    fs.writeFileSync(path.join(work, "main.ddd"), injectDesign(rawSrc, PACK, profile.platform));
    run(`node ${cli} generate system ${work}/main.ddd -o ${work}/out`, repoRoot);

    const project = findProject(path.join(work, "out"), profile.projectMarker);
    run("npm install --no-audit --no-fund", project);
    run(profile.buildCmd, project);
    expect(
      fs.existsSync(path.join(project, profile.distSubdir, "index.html")),
      `${profile.buildCmd} output`,
    ).toBe(true);

    const routes = routesFromSmoke(path.join(project, "e2e"));
    expect(routes.length, "at least one route to scan").toBeGreaterThan(0);

    const port = await freePort();
    const preview = await startPreview(project, work, profile, port);
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
