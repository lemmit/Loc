import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { svelteBuildExamples, sveltePacks } from "./svelte-build-cases.js";

// ---------------------------------------------------------------------------
// Generator regression test for the Svelte frontend: for each example
// .ddd × each svelte design pack, run `generate system`, npm-install
// the emitted SvelteKit project, `svelte-check` it (the .svelte type
// gate) and `vite build` it (the compiler + adapter-static gate).
// The svelte sibling of generated-react-build.test.ts.
//
// Run modes:
//   1. Full sweep — `LOOM_SVELTE_BUILD=1 npx vitest run …` (or
//      `npm run test:svelte-build`).
//   2. Single shard — `LOOM_SVELTE_BUILD_CASE=<ddd>:<pack>` filters to
//      one case (implies enabled), e.g.
//      `LOOM_SVELTE_BUILD_CASE=examples/svelte-shop.ddd:shadcnSvelte@v1`.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const SHARD = process.env.LOOM_SVELTE_BUILD_CASE;
const ENABLED = process.env.LOOM_SVELTE_BUILD === "1" || SHARD !== undefined;

/** Inject `design: "<family>@<version>"` into the `deployable web
 *  { ... }` block — mirrors the react harness's injectDesign so the
 *  canonical example sources stay pack-neutral. */
function injectDesign(src: string, qualified: string): string {
  const existing = /(\bdesign:\s*)(?:"[^"]*"|\w+)/;
  if (existing.test(src)) {
    return src.replace(existing, `$1"${qualified}"`);
  }
  // Insert `design:` right after the deployable's leading `platform:`
  // line (the grammar requires `platform` first, then accepts the
  // other axes — design included — in any order). Anchoring on the
  // platform line rather than a body-spanning `[^}]*?` keeps nested
  // braces in the block body — e.g. `ui: WebApp { Sales: api }` — from
  // cutting the match short and silently leaving the deployable on its
  // default pack.
  const platformLine = /(deployable web \{\n[ \t]*platform:[^\n]*\n)([ \t]*)/;
  if (platformLine.test(src)) {
    return src.replace(platformLine, `$1$2design: "${qualified}"\n$2`);
  }
  const singleLine = /(deployable web \{[^}\n]+?)(\s*)\}/;
  return src.replace(singleLine, `$1, design: "${qualified}"$2}`);
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 600_000 });
}

describe.skipIf(!ENABLED)("generated svelte project builds (svelte-check + vite build)", () => {
  const cases: Array<{ ddd: string; pack: string }> = [];
  for (const ddd of svelteBuildExamples) {
    for (const pack of sveltePacks) {
      cases.push({ ddd, pack });
    }
  }
  const active = SHARD ? cases.filter((c) => `${c.ddd}:${c.pack}` === SHARD) : cases;
  if (SHARD && active.length === 0) {
    throw new Error(
      `LOOM_SVELTE_BUILD_CASE="${SHARD}" matches no case. Known: ${cases.map((c) => `${c.ddd}:${c.pack}`).join(", ")}`,
    );
  }

  for (const { ddd, pack } of active) {
    it(`${ddd} × ${pack}`, { timeout: 600_000 }, () => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "loom-svelte-build-"));
      const src = fs.readFileSync(path.join(repoRoot, ddd), "utf-8");
      const dddPath = path.join(work, "main.ddd");
      fs.writeFileSync(dddPath, injectDesign(src, pack));
      run(`node ${cli} generate system ${dddPath} -o ${work}/out`, repoRoot);

      const project = path.join(work, "out", "web");
      expect(fs.existsSync(path.join(project, "svelte.config.js"))).toBe(true);
      run("npm install --no-audit --no-fund", project);
      run("npx svelte-kit sync", project);
      // The type gate — fails on any svelte-check error (warnings
      // pass; the templates are kept warning-clean separately).
      run("npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings", project);
      // The compile + adapter gate.
      run("npx vite build", project);
      expect(fs.existsSync(path.join(project, "build", "index.html"))).toBe(true);
    });
  }
});
