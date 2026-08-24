// The one-origin generated-stack boot shared by the UI-tier runners.
//
// Both `run-ui.mjs` (the emitted `*.ui.spec.ts` round-trips) and
// `paged-ui.mjs` (the hand-written-page paging proof) need the SAME thing:
// locate the generated node deployable + frontend, build the frontend with
// its own build script, and serve the built bundle AND the generated Hono
// backend (on PGlite, in-process — no docker) from ONE node HTTP server so
// the browser sees one origin with no proxy and no CORS.
//
// It lives here rather than in either runner because a second copy of this
// wiring is a second place for the origin/proxy/CORS invariant to drift —
// and a drift there fails as a browser-level mystery, not a diff.

import { build } from "esbuild";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");

/** Recursively collect files under `dir` matching `pred`. */
export function walk(dir, pred, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

/** The one `platform: node` deployable dir: has both http/index.ts and db/schema.ts. */
export function findNodeDeployable(genDir) {
  const hits = walk(genDir, (p) => p.endsWith("/http/index.ts")).map((p) => resolve(p, "..", ".."));
  const dirs = [...new Set(hits)].filter((d) => existsSync(join(d, "db", "schema.ts")));
  if (dirs.length !== 1) {
    throw new Error(
      `expected exactly one node (Hono) deployable, found ${dirs.length}: ${dirs.join(", ")}`,
    );
  }
  return dirs[0];
}

/** Locate the built SPA root under a frontend dir — the dir that holds the
 *  emitted `index.html`.  Framework-agnostic: react/vue → `dist/`, SvelteKit
 *  (adapter-static) → `build/`, Angular → `dist/<app>/browser/`.  Excludes the
 *  source tree (a frontend's `index.html` also lives at its root pre-build) by
 *  only accepting a build-output dir (`dist`/`build` segment in the path). */
export function findDistRoot(frontendDir) {
  const hits = walk(frontendDir, (p) => p.endsWith("/index.html")).filter((p) => {
    const rel = p.slice(frontendDir.length);
    return /[/\\](dist|build)[/\\]/.test(rel);
  });
  if (hits.length === 0) {
    throw new Error(`no built index.html under ${frontendDir} — did the frontend build?`);
  }
  // Prefer the shallowest (e.g. dist/index.html over a nested asset copy).
  hits.sort((a, b) => a.split("/").length - b.split("/").length);
  return dirname(hits[0]);
}

/** The frontend deployable dir: has e2e/playwright.config.ts.  Framework-agnostic
 *  — the emitted `.ui.spec.ts` + page objects are testid-driven, so the same
 *  round-trip runs against any frontend; the per-framework build command
 *  (`npm run build`) and built-root (findDistRoot) are resolved above. */
export function findFrontendDeployable(genDir) {
  const hits = walk(genDir, (p) => p.endsWith("/e2e/playwright.config.ts")).map((p) =>
    resolve(p, "..", ".."),
  );
  const dirs = [...new Set(hits)];
  if (dirs.length !== 1) {
    throw new Error(
      `expected exactly one frontend with a UI e2e suite (e2e/playwright.config.ts), found ${dirs.length}: ${dirs.join(", ")}`,
    );
  }
  return dirs[0];
}

/** The bundled boot: createApp on PGlite, served (static dist + /api) over one HTTP origin. */
function serverEntrySource({ deplDir }) {
  const J = JSON.stringify;
  return `
import { synthDDL } from ${J(join(REPO, "web/src/runtime/ddl.ts"))};
import { createApp } from ${J(join(deplDir, "http/index.ts"))};
import * as schema from ${J(join(deplDir, "db/schema.ts"))};
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { is, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

// \`.wasm\` MUST be \`application/wasm\`: \`WebAssembly.instantiateStreaming\`
// REJECTS any other content-type, and CanvasKit (the Flutter web renderer)
// streams its \`.wasm\` that way — served as octet-stream the Flutter bundle
// silently never boots (no error, no <flutter-view>, an empty body).  \`.otf\`
// is here for the same reason in a milder form (Flutter's tree-shaken
// MaterialIcons face).
const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".json":"application/json", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".ico":"image/x-icon", ".woff2":"font/woff2", ".woff":"font/woff", ".ttf":"font/ttf", ".otf":"font/otf", ".wasm":"application/wasm", ".map":"application/json", ".txt":"text/plain", ".webmanifest":"application/manifest+json" };

export async function startServer({ distDir }) {
  const pglite = new PGlite();
  await pglite.exec(synthDDL(schema, { is, Table, getTableConfig }));
  const db = drizzle(pglite, { schema });
  const app = createApp(db);
  const server = createServer(async (req, res) => {
    try {
      const p = new URL(req.url, "http://localhost").pathname;
      // /api, /health, /ready → the generated Hono app, in-process.
      if (p === "/api" || p.startsWith("/api/") || p === "/health" || p === "/ready") {
        let body;
        if (req.method !== "GET" && req.method !== "HEAD") {
          const chunks = []; for await (const c of req) chunks.push(c); body = Buffer.concat(chunks);
        }
        const fres = await app.fetch(new Request("http://localhost" + req.url, { method: req.method, headers: req.headers, body, duplex: "half" }));
        const buf = Buffer.from(await fres.arrayBuffer());
        const h = {}; fres.headers.forEach((v, k) => { h[k] = v; });
        res.writeHead(fres.status, h); res.end(buf); return;
      }
      // everything else → the built SPA, with index.html fallback for routes.
      let file = join(distDir, normalize(p)); let data;
      try { const s = await stat(file); if (s.isDirectory()) file = join(file, "index.html"); data = await readFile(file); }
      catch { if (extname(p)) { res.writeHead(404); res.end("not found"); return; } file = join(distDir, "index.html"); data = await readFile(file); }
      const buf = Buffer.from(data);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "content-length": String(buf.length) }); res.end(buf);
    } catch (e) { res.writeHead(500); res.end(String(e?.message ?? e)); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(() => { try { pglite.close?.(); } catch {} r(); })),
  };
}
`;
}

/** Bundle + import the boot module; returns { startServer }. */
export async function buildServerModule(deplDir, workDir) {
  const entry = join(workDir, "server-entry.mts");
  const bundle = join(workDir, "server-bundle.mjs");
  writeFileSync(entry, serverEntrySource({ deplDir }));
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
  return import(pathToFileURL(bundle).href);
}

/** Recursively flatten a Playwright JSON report to {name,status,error} outcomes. */
export function outcomesFromPlaywrightJson(json) {
  const out = [];
  const visit = (suites) => {
    for (const s of suites ?? []) {
      for (const spec of s.specs ?? []) {
        const err = spec.tests
          ?.flatMap((t) => t.results ?? [])
          .map((r) => r.error?.message)
          .find(Boolean);
        out.push({ name: spec.title, status: spec.ok ? "pass" : "fail", error: err });
      }
      visit(s.suites);
    }
  };
  visit(json.suites);
  return out;
}
