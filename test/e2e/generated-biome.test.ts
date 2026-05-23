import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems, loadExampleModel } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Quality gate for GENERATED output: emit each example's system tree,
// write the TypeScript/TSX files to a temp dir, and run Biome against
// them using biome.generated.json (the standard for emitted code).
//
// The config turns off rules that flag legitimate generated-code patterns
// (defensive fragments, non-null assertions on resolved IR, index keys on
// fixed-length skeletons) and keeps the real-quality rules (unused
// imports/vars, exhaustive-deps) visible. This test asserts ZERO Biome
// *errors*; remaining warnings are the generated-code-quality backlog and
// are reported in the assertion message.
//
// Slow-ish + needs the biome binary — opt-in via LOOM_BIOME=1.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const biomeBin = path.join(repoRoot, "node_modules", ".bin", "biome");
const genConfig = path.join(repoRoot, "biome.generated.json");

const ENABLED = process.env.LOOM_BIOME === "1";

const isLintable = (p: string): boolean => p.endsWith(".ts") || p.endsWith(".tsx");

describe.skipIf(!ENABLED)("generated TS/TSX is Biome-clean (no errors)", () => {
  it.each([
    "examples/acme.ddd",
    "web/src/examples/banking-system.ddd",
    "web/src/examples/inventory-system.ddd",
  ])("%s — generateSystems output passes biome.generated.json", async (example) => {
    const { files } = generateSystems(await loadExampleModel(example));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-biome-"));
    try {
      let wrote = 0;
      for (const [rel, content] of files) {
        if (!isLintable(rel)) continue;
        const dest = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
        wrote++;
      }
      expect(wrote, "expected some .ts/.tsx files").toBeGreaterThan(0);
      fs.copyFileSync(genConfig, path.join(outDir, "biome.json"));

      let stdout = "";
      let failed = false;
      try {
        stdout = execFileSync(biomeBin, ["lint", "--max-diagnostics=2000", "."], {
          cwd: outDir,
          encoding: "utf8",
        });
      } catch (e) {
        // Biome exits non-zero only when there are errors (warnings
        // alone exit 0). Capture its output for the assertion message.
        failed = true;
        stdout = String((e as { stdout?: string }).stdout ?? "") + String((e as Error).message);
      }

      const errorLine = /Found (\d+) errors?/.exec(stdout);
      const errorCount = errorLine ? Number(errorLine[1]) : failed ? 1 : 0;
      expect(errorCount, `Biome errors in generated ${example}:\n${stdout}`).toBe(0);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
