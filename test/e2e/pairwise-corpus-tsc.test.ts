import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeCompileLeg } from "../pairwise/compile-leg.js";

// ---------------------------------------------------------------------------
// M-T9.29 — the COMPILE oracle, node leg (Hono, strict `tsc`).
//
// The generation sweep next door proves the pipeline ANSWERS on every crossing.
// It is blind to the answer being uncompilable target code, which is the entire
// recorded bug class: #2412 (`mask unless` × `audited`) GENERATED perfectly and
// then failed .NET CS0128 / Python F821.  Only a real compiler sees that.
//
// Case set: the ALL-PAIRS cover, not the cross product — every recorded
// instance of the class is a two-factor interaction, so a cover containing all
// pairs finds them at ~1/8 the cost.  Shard one case per CI cell with
// LOOM_PAIRWISE_COMPILE_CASE=<case-id>.
//
// The case loop, the verdict handling and both directions of the waiver ratchet
// live in `test/pairwise/compile-leg.ts`, shared with the dotnet / java /
// python / elixir legs; this file supplies only node's toolchain recipe.
// ---------------------------------------------------------------------------

/**
 * `npm install` once per DISTINCT emitted package.json, then link.
 *
 * The cover's cases differ in domain shape, not in dependency set — two cases
 * on the same persistence adapter emit a byte-identical package.json.  Paying a
 * fresh install for each would make this leg cost an hour for no additional
 * coverage; the hash key keeps it honest (a case whose deps genuinely differ
 * gets its own install).
 */
const installs = new Map<string, string>();

function nodeModulesFor(pkgJson: string): string {
  const key = crypto.createHash("sha256").update(pkgJson).digest("hex").slice(0, 16);
  const cached = installs.get(key);
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-pw-deps-${key}-`));
  fs.writeFileSync(path.join(dir, "package.json"), pkgJson);
  execSync("npm install --silent --no-audit --no-fund", {
    cwd: dir,
    stdio: "inherit",
    timeout: 300_000,
  });
  installs.set(key, dir);
  return dir;
}

describeCompileLeg({
  platform: "node",
  label: "node",
  enabled: process.env.LOOM_PAIRWISE === "1" && process.env.LOOM_TS_BUILD === "1",
  projectDir: (root) => path.join(root, "d"),
  compile(proj) {
    const pkgPath = path.join(proj, "package.json");
    const deps = nodeModulesFor(fs.readFileSync(pkgPath, "utf8"));
    const link = path.join(proj, "node_modules");
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(deps, "node_modules"), link, "dir");
    try {
      execSync("npx tsc --noEmit", { cwd: proj, stdio: "pipe", timeout: 300_000 });
      return undefined;
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      return `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
    }
  },
  timeoutMs: 900_000,
});
