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
  /** Inline .ddd source, or — when `fromFile` is set — the repo-
   *  relative path of a checked-in example to copy. */
  source?: string;
  fromFile?: string;
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
      deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
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
          valueobject LineItem { sku: string  qty: int }
          aggregate Order with crudish {
            total: int
            items: LineItem[]
          }
        }
      }
      ui WebApp with scaffold(subdomains: [Sales]) { }
      storage primary { type: postgres }
      resource ordersState { for: Orders, kind: state, use: primary }
      deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
      deployable web { platform: vue, targets: api, ui: WebApp, port: 3003 }
    }
  `,
};

/** Showcase-scale example (vue-frontend-plan.md Slice 5): the acme
 *  system with the frontend on `platform: vue` — three modules,
 *  views, workflows, money, enums, value objects, id-selects. */
const SHOWCASE: Case = {
  name: "showcase",
  vueDir: "web_app",
  fromFile: "examples/vue-showcase.ddd",
};

/** Store showcase (named-actions-and-stores.md §3, Stage 5): a `store Cart`
 *  shared client-side container read/written by a page AND a component — the
 *  Vue sibling of `store-showcase.ddd`.  Validates the `reactive()` singleton
 *  module + the per-member store wiring (field → `computed`, action → bound
 *  callable) compiles under each vue pack. */
const STORE: Case = {
  name: "store",
  vueDir: "web",
  fromFile: "web/src/examples/vue-store-showcase.ddd",
};

/** The vue pack matrix.  Mirrors the React harness's
 *  `{example × pack}` sweep: every case runs against each pack via a
 *  `design:` injection into the vue deployable. */
const PACKS = ["vuetify@v3", "shadcnVue@v1"] as const;

interface MatrixCase extends Case {
  pack: (typeof PACKS)[number];
  label: string;
}

const allCases: MatrixCase[] = [MINIMAL, SCAFFOLD, SHOWCASE, STORE].flatMap((c) =>
  PACKS.map((pack) => ({ ...c, pack, label: `${c.name}:${pack}` })),
);

/** Inject `design: "<pack>"` into the vue deployable.  Rewrites an
 *  existing slot in place; otherwise appends to the single-line or
 *  multi-line `platform: vue` deployable block. */
function injectDesign(src: string, qualified: string): string {
  const existing = /(\bdesign:\s*)(?:"[^"]*"|\w+)/;
  if (existing.test(src)) return src.replace(existing, `$1"${qualified}"`);
  // Single-line: `deployable web { platform: vue, targets: api, ui: WebApp, port: 3003 }`
  const singleLine = /(deployable \w+ \{[^}\n]*platform: vue\b[^}\n]*?)(\s*)\}/;
  if (singleLine.test(src)) return src.replace(singleLine, `$1, design: "${qualified}"$2}`);
  // Multi-line block containing `platform: vue`.
  return src.replace(
    /(deployable \w+ \{[^}]*?platform: vue\b)/,
    `$1\n        design: "${qualified}"`,
  );
}

function selectCases(): MatrixCase[] {
  if (SHARD === undefined) return allCases;
  const match = allCases.find((c) => c.label === SHARD || c.name === SHARD);
  if (!match) {
    throw new Error(
      `LOOM_VUE_BUILD_CASE="${SHARD}" did not match any case.  Available: ${allCases.map((c) => c.label).join(", ")}`,
    );
  }
  return [match];
}

const cases = ENABLED ? selectCases() : [];

describe.skipIf(!ENABLED)("generated Vue project compiles + bundles (vue-tsc + vite build)", () => {
  it.each(cases)("$label → vue-tsc --noEmit + vite build pass", ({
    source,
    fromFile,
    vueDir,
    pack,
  }) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vue-build-"));
    try {
      const dddPath = path.join(outDir, "_case.ddd");
      const raw = fromFile
        ? fs.readFileSync(path.join(repoRoot, fromFile), "utf-8")
        : (source ?? "");
      fs.writeFileSync(dddPath, injectDesign(raw, pack));
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
