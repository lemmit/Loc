import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

// ---------------------------------------------------------------------------
// Generator build gate for the Vue frontend (vue-frontend-plan.md
// Slice 3): generate a system with a vue deployable, npm-install the
// emitted project, `vue-tsc --noEmit` it, and `vite build` it.
// Mirrors `generated-react-build.test.ts`'s harness shape; the
// example matrix (examples × vuetify@v3 + shadcnVue@v1) grows with
// the walker + second-pack slices — Slice 3 gates the minimal and
// scaffold-free shells.
//
// Run modes:
//   1. `LOOM_VUE_BUILD=1 npx vitest run …` (or `npm run test:vue-build`).
//   2. Single shard — `LOOM_VUE_BUILD_CASE=<name>` filters to one case.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const SHARD = process.env.LOOM_VUE_BUILD_CASE;
const ENABLED = process.env.LOOM_VUE_BUILD === "1" || SHARD !== undefined;

interface Case {
  name: string;
  source: string;
  vueDir: string;
}

/** Minimal vue system — one aggregate (create+destroy so the api
 *  module carries the full hook surface), one explicit page. */
const MINIMAL: Case = {
  name: "minimal",
  vueDir: "web",
  source: `
    system Shop {
      subdomain Sales {
        context Orders {
          aggregate Customer with crudish {
            name: string
            email: string
          }
        }
      }
      ui WebApp {
        page Home {
          route: "/"
          title: "Home"
        }
      }
      storage primary { type: postgres }
      resource ordersState { for: Orders, kind: state, use: primary }
      deployable api { platform: hono, contexts: [Orders], dataSources: [ordersState], port: 3000 }
      deployable web { platform: vue, targets: api, ui: WebApp, port: 3003 }
    }
  `,
};

/** Scaffolded ui — exercises the stub-page emitter + router across
 *  the scaffold-synthesised page set (list / new / detail / home). */
const SCAFFOLD: Case = {
  name: "scaffold",
  vueDir: "web",
  source: `
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
      deployable api { platform: hono, contexts: [Orders], dataSources: [ordersState], port: 3000 }
      deployable web { platform: vue, targets: api, ui: WebApp, port: 3003 }
    }
  `,
};

const allCases: Case[] = [MINIMAL, SCAFFOLD];

function selectCases(): Case[] {
  if (SHARD === undefined) return allCases;
  const match = allCases.find((c) => c.name === SHARD);
  if (!match) {
    throw new Error(
      `LOOM_VUE_BUILD_CASE="${SHARD}" did not match any case.  Available: ${allCases.map((c) => c.name).join(", ")}`,
    );
  }
  return [match];
}

const cases = ENABLED ? selectCases() : [];

describe.skipIf(!ENABLED)("generated Vue project compiles + bundles (vue-tsc + vite build)", () => {
  it.each(cases)("$name → vue-tsc --noEmit + vite build pass", ({ source, vueDir }) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vue-build-"));
    try {
      const dddPath = path.join(outDir, "_case.ddd");
      fs.writeFileSync(dddPath, source);
      execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
        stdio: "inherit",
        cwd: repoRoot,
      });
      const projectDir = path.join(outDir, vueDir);
      if (!fs.existsSync(projectDir)) {
        throw new Error(`Expected Vue project at ${projectDir}`);
      }
      execSync(`npm install --silent --no-audit --no-fund`, {
        cwd: projectDir,
        stdio: "inherit",
        timeout: 240_000,
      });
      // vue-tsc carries the .vue SFC type surface that plain tsc
      // can't see; --noEmit honours the project tsconfig.
      execSync(`npx vue-tsc --noEmit`, {
        cwd: projectDir,
        stdio: "inherit",
        timeout: 180_000,
      });
      execSync(`npx vite build`, {
        cwd: projectDir,
        stdio: "inherit",
        timeout: 180_000,
      });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 600_000);
});
