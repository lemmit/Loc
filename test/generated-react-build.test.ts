import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Generator regression test for the React frontend: for each example
// .ddd × each design pack, run `generate system`, npm-install the
// emitted project, and `tsc --noEmit` it.  Catches generator drift
// that compiles the TS backend cleanly but breaks the generated TSX
// (missing imports, wrong prop types, JSX namespace issues, …) —
// the kind of thing that's invisible to the IR-level tests but
// blows up at user time.
//
// Matrix: 7 examples × 4 packs = 28 cases.  Non-mantine variants are
// produced by injecting `design: <pack>` into the deployable at test-
// run time, so the canonical example sources stay pack-neutral.
//
// Run modes:
//   1. Full sweep — `LOOM_REACT_BUILD=1 npx vitest run …` runs every
//      case sequentially in one Node process (~5min).  Used by
//      developers locally.
//   2. Single shard — `LOOM_REACT_BUILD_CASE=<ddd>:<pack>` filters to
//      exactly one case (implies the suite is enabled even without
//      LOOM_REACT_BUILD=1).  Used by CI to parallelise across a
//      GitHub Actions job matrix — every shard runs one case in its
//      own runner, wall time drops from ~5min to ~30s per case.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const SHARD = process.env.LOOM_REACT_BUILD_CASE;
const ENABLED = process.env.LOOM_REACT_BUILD === "1" || SHARD !== undefined;

const examples = [
  { ddd: "examples/acme.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/banking-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/inventory-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/sales-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/storybook-mantine.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/storybook-shadcn.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/storybook-components.ddd", reactDir: "web_app" },
] as const;

/** Inject `design: <pack>` into the `deployable webApp { ... }` block
 *  of a `.ddd` source.  Handles both the multi-line acme syntax and
 *  the single-line playground syntax.  Idempotent and safe — if no
 *  webApp block matches, the input passes through unchanged.  When
 *  an existing `design:` slot is present (the storybook examples
 *  already declare one), the slot is rewritten in place rather than
 *  duplicated. */
function injectDesign(src: string, design: string): string {
  // Existing slot — multi-line `    design: mantine` or inline `, design: shadcn`.
  const existing = /(\bdesign:\s*)\w+/;
  if (existing.test(src)) {
    return src.replace(existing, `$1${design}`);
  }
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

type Pack = "mantine" | "shadcn" | "mui" | "chakra";
const PACKS: readonly Pack[] = ["mantine", "shadcn", "mui", "chakra"];

interface Case {
  ddd: string;
  reactDir: string;
  pack: Pack;
}

const allCases: Case[] = examples.flatMap((e) =>
  PACKS.map((pack) => ({ ...e, pack })),
);

/** Filter to the case named by `LOOM_REACT_BUILD_CASE=<ddd>:<pack>`,
 *  or return every case when no filter is set.  Throws on a malformed
 *  shard spec so the CI matrix surfaces typos loudly instead of
 *  silently skipping a case. */
function selectCases(): Case[] {
  if (SHARD === undefined) return allCases;
  const [ddd, pack] = SHARD.split(":");
  const match = allCases.find((c) => c.ddd === ddd && c.pack === pack);
  if (!match) {
    throw new Error(
      `LOOM_REACT_BUILD_CASE="${SHARD}" did not match any case.  Available: ${allCases.map((c) => `${c.ddd}:${c.pack}`).join(", ")}`,
    );
  }
  return [match];
}

const cases = ENABLED ? selectCases() : [];

describe.skipIf(!ENABLED)("generated React TSX compiles under strict tsc", () => {
  it.each(cases)(
    "$ddd × $pack → $reactDir compiles cleanly",
    ({ ddd, reactDir, pack }) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-react-tsc-"));
      try {
        // Always materialise a mutated copy with `design: <pack>` set
        // — even for mantine, since some sources (storybook-shadcn,
        // …) declare a non-mantine pack as their canonical default
        // and we need to override it.  `injectDesign` rewrites an
        // existing slot in place rather than duplicating.
        const original = fs.readFileSync(path.join(repoRoot, ddd), "utf-8");
        const mutated = injectDesign(original, pack);
        const dddPath = path.join(outDir, "_mutated.ddd");
        fs.writeFileSync(dddPath, mutated);
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
