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
 *  the system's generation root that holds the React project. */
const cases: Array<{ ddd: string; reactDir: string }> = [
  { ddd: "examples/acme.ddd", reactDir: "web_app" },
];

describe.skipIf(!ENABLED)("generated React TSX compiles under strict tsc", () => {
  it.each(cases)(
    "$ddd → $reactDir compiles cleanly",
    ({ ddd, reactDir }) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-react-tsc-"));
      try {
        execSync(`node ${cli} generate system ${ddd} -o ${outDir}`, {
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
