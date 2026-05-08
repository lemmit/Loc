import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Generator regression test for the React frontend: emit each example's
// `generate system` output, npm-install the React deployable's project,
// and run `tsc --noEmit` on it.  Catches generator drift that compiles
// the TS backend cleanly but breaks the generated TSX (missing imports,
// wrong prop types, JSX namespace issues, etc.) — the kind of thing
// that's invisible to the IR-level tests but blows up at user time.
//
// Slow (~90s with cached node_modules — Mantine + react-hook-form + tabler
// are heavy installs).  Opt-in via LOOM_REACT_BUILD=1 so `npm test`
// stays fast.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_REACT_BUILD === "1";

/** Each entry: ddd source + the snake-cased deployable subdir under
 *  the system's generation root that holds the React project.  The
 *  top-level `examples/acme.ddd` is the canonical case; the
 *  `web/src/examples/*-system.ddd` set are the playground sources
 *  the in-browser editor ships, exercising different domain shapes
 *  (banking — money, inventory — nested aggregates, sales — multi-
 *  context).  The shadcn entry is a Phase-0 spike: a derived copy of
 *  acme with `design: shadcn` on the webApp deployable, materialised
 *  at test-run time, so the new template-pack path is exercised on
 *  the same wire shape as the Mantine canonical case.  Other pages
 *  in that build still use the legacy Mantine builders (Phase 0 only
 *  ports the list page); the partial-shadcn + Mantine-rest project
 *  is expected to type-check because both paths share the runtime
 *  helpers and api modules. */
const cases: Array<{ ddd: string; reactDir: string; mutate?: (src: string) => string }> = [
  { ddd: "examples/acme.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/banking-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/inventory-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/sales-system.ddd", reactDir: "web_app" },
  {
    ddd: "examples/acme.ddd",
    reactDir: "web_app",
    mutate: (src) =>
      // Inject `design: shadcn` into the webApp deployable so the
      // shadcn pack renders the list page.  Other pages still come
      // from the legacy Mantine builders — this is the Phase 0 spike,
      // not feature-complete shadcn.
      src.replace(
        /(deployable webApp \{\s*platform: react\s*targets: api\s*port: 3001)\s*\}/,
        "$1\n        design: shadcn\n    }",
      ),
  },
];

describe.skipIf(!ENABLED)("generated React TSX compiles under strict tsc", () => {
  it.each(cases)(
    "$ddd → $reactDir compiles cleanly",
    ({ ddd, reactDir, mutate }) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-react-tsc-"));
      try {
        // When a `mutate` is supplied, read the source, transform it,
        // and write to a temp .ddd file the CLI consumes.  Used for
        // Phase 0 design-pack spike where we vary an existing source
        // without touching the canonical example file.
        let dddPath = ddd;
        if (mutate) {
          const original = fs.readFileSync(path.join(repoRoot, ddd), "utf-8");
          const mutated = mutate(original);
          dddPath = path.join(outDir, "_mutated.ddd");
          fs.writeFileSync(dddPath, mutated);
        }
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const projectDir = path.join(outDir, reactDir);
        if (!fs.existsSync(projectDir)) {
          throw new Error(
            `Expected React project at ${projectDir} after generating ${ddd}`,
          );
        }
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: projectDir,
          stdio: "inherit",
          timeout: 240_000,
        });
        // `tsc --noEmit` honours the project's tsconfig.json `include`
        // / `strict` settings.  References (tsconfig.node.json) are
        // not built — Vite's config is only checked when `tsc -b` runs
        // explicitly, which would require composite emit.
        execSync(`npx tsc --noEmit`, {
          cwd: projectDir,
          stdio: "inherit",
          timeout: 90_000,
        });
        expect(true).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
    420_000,
  );
});
