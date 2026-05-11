import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Generator regression test for the React frontend: emit each example's
// `generate system` output through both the Mantine and shadcn packs,
// npm-install each project, and run `tsc --noEmit`.  Catches generator
// drift that compiles the TS backend cleanly but breaks the generated
// TSX (missing imports, wrong prop types, JSX namespace issues, …) —
// the kind of thing that's invisible to the IR-level tests but blows
// up at user time.
//
// Phase 2.4: matrix expanded to 4 examples × 2 packs = 8 cases.  The
// shadcn variants are produced by injecting `design: shadcn` into the
// react deployable at test-run time, so the canonical example sources
// stay pack-neutral.
//
// Slow (~30s per case, ~4 minutes total) — opt-in via LOOM_REACT_BUILD=1
// so `npm test` stays fast.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_REACT_BUILD === "1";

const examples = [
  { ddd: "examples/acme.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/banking-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/inventory-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/sales-system.ddd", reactDir: "web_app" },
] as const;

/** Inject `design: shadcn` into the `deployable webApp { ... }` block
 *  of a `.ddd` source.  Handles both the multi-line acme syntax and
 *  the single-line playground syntax.  Idempotent and safe — if no
 *  webApp block matches, the input passes through unchanged. */
function injectDesign(src: string, design: string): string {
  // Multi-line:  deployable webApp {\n  platform: react\n  …\n}
  const multiLine = /(deployable webApp \{)([^}]*?)\n(\s*)\}/;
  if (multiLine.test(src)) {
    return src.replace(multiLine, (_, head, body, indent) => {
      return `${head}${body}\n${indent}design: ${design}\n${indent}}`;
    });
  }
  // Single-line:  deployable webApp { platform: react, targets: api, port: 3001 }
  const singleLine = /(deployable webApp \{[^}\n]+?)(\s*)\}/;
  return src.replace(singleLine, `$1, design: ${design}$2}`);
}

interface Case {
  ddd: string;
  reactDir: string;
  pack: "mantine" | "shadcn" | "mui";
}

const cases: Case[] = examples.flatMap((e) => [
  { ...e, pack: "mantine" as const },
  { ...e, pack: "shadcn" as const },
  { ...e, pack: "mui" as const },
]);

describe.skipIf(!ENABLED)("generated React TSX compiles under strict tsc", () => {
  it.each(cases)(
    "$ddd × $pack → $reactDir compiles cleanly",
    ({ ddd, reactDir, pack }) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-react-tsc-"));
      try {
        // For non-mantine cases, materialise a mutated copy of the
        // source with `design: <pack>` injected.  Mantine cases use
        // the original file directly (mantine is the default).
        let dddPath = ddd;
        if (pack !== "mantine") {
          const original = fs.readFileSync(path.join(repoRoot, ddd), "utf-8");
          const mutated = injectDesign(original, pack);
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
            `Expected React project at ${projectDir} after generating ${ddd} (pack=${pack})`,
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
