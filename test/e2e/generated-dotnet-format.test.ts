import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

// ---------------------------------------------------------------------------
// Generated .NET project is `dotnet format`-clean.  Mirrors
// `generated-dotnet-build.test.ts` (the compile gate) — emit each
// example via `ddd generate dotnet`, then run
// `dotnet format --verify-no-changes` which exits non-zero if any
// file would be modified by the SDK formatter.
//
// Catches generator drift that produces syntactically valid but
// non-canonical C# (inconsistent spacing, wrong using ordering,
// trailing whitespace, missing final newline, etc.).  The build gate
// doesn't see these because they compile; the format gate does.
//
// Opt-in via LOOM_DOTNET_FORMAT=1 so the default `npm test` stays
// fast.  CI's `.github/workflows/dotnet-build.yml` runs the same
// check as a second step after `dotnet build`.
//
// Requires the .NET SDK on PATH (10.0).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_DOTNET_FORMAT === "1";

describe.skipIf(!ENABLED)(
  "generated .NET project is `dotnet format`-clean (LOOM_DOTNET_FORMAT=1)",
  () => {
    it.each([
      "examples/sales.ddd",
      "examples/banking.ddd",
      "examples/inventory.ddd",
      "examples/roster.ddd",
      "examples/lifecycle.ddd",
      "examples/document.ddd",
      "examples/seeding.ddd",
    ])("%s — `dotnet format --verify-no-changes` exits 0", (example) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dotnet-fmt-"));
      try {
        execSync(`node ${cli} generate dotnet ${example} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        // `dotnet restore` is needed because `dotnet format` resolves
        // analyzers + project references against the restored graph.
        execSync(`dotnet restore --nologo`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 240_000,
        });
        // `--verify-no-changes` makes format a checker (exit non-zero
        // on any change needed) rather than a fixer.  `--severity info`
        // covers whitespace/style; CA-prefixed analyzer rules are a
        // separate gate (see docs/old/proposals/cross-stack-static-analysis.md).
        execSync(`dotnet format --verify-no-changes --severity info --no-restore`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 180_000,
        });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);
  },
);
