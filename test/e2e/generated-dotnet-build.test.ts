import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Generator regression test: emit each example via `ddd generate dotnet`,
// run `dotnet restore`, then `dotnet build /warnaserror`.  Catches
// generator drift that breaks the generated C# (missing usings, bad
// EF Core configuration, signature mismatches against Mediator /
// FluentValidation / Swashbuckle) without running the full docker
// stack.
//
// Mirrors `generated-build.test.ts` (the TS-build regression).  Slow
// (~90s cold per fixture, dominated by `dotnet restore`; warm runs
// reuse the NuGet cache).  Opt-in via LOOM_DOTNET_BUILD=1 so the
// default `npm test` stays fast.  CI's
// `.github/workflows/dotnet-build.yml` runs the same check on every
// PR that touches the .NET generator.
//
// Requires the .NET SDK on PATH (8.0 — matches the generated
// `<TargetFramework>` in `templates/program.tpl.ts`).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_DOTNET_BUILD === "1";

describe.skipIf(!ENABLED)(
  "generated .NET project compiles under `dotnet build /warnaserror` (LOOM_DOTNET_BUILD=1)",
  () => {
    it.each([
      "examples/sales.ddd",
      "examples/banking.ddd",
      "examples/inventory.ddd",
      "examples/roster.ddd",
      // crudish lifecycle — the only example that emits a canonical
      // destroy, so this cell is what compiles the .NET [HttpDelete] +
      // Destroy<Agg>Command + repo DeleteAsync paths.
      "examples/lifecycle.ddd",
      // Document-persistence path (`normalised(false)`): exercises the
      // STJ round-trip emit — `<Agg>Document` record, snapshot DTOs,
      // `ToSnapshot()`/`FromSnapshot(...)`, jsonb column.
      "examples/document.ddd",
      // First-boot seeding (database-seeding.md): compiles
      // Infrastructure/Persistence/Seed.cs + the Program.cs RunSeeds wiring.
      "examples/seeding.ddd",
    ])("%s — `ddd generate dotnet` output restores + builds", (example) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dotnet-"));
      try {
        execSync(`node ${cli} generate dotnet ${example} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        execSync(`dotnet restore --nologo`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 240_000,
        });
        // `/warnaserror` keeps the gate honest about both real errors
        // and warnings (analyzer rules, nullable, EF Core warnings).
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 180_000,
        });
        // A `.dll` lands in `bin/Debug/net8.0/` on a successful build —
        // assert one exists so a silent no-op build can't pass.
        const binDir = path.join(outDir, "bin", "Debug", "net8.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
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
