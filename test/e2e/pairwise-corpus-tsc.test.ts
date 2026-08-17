import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { caseId, type PairwiseCase } from "../pairwise/axes.js";
import { pairwiseCover } from "../pairwise/cases.js";
import { runPipeline } from "../pairwise/harness.js";
import { GENERATION_WAIVERS, waiverFor } from "../pairwise/waivers.js";
import { TSC_WAIVERS } from "../pairwise/waivers-tsc.js";

// ---------------------------------------------------------------------------
// M-T9.29 slice 1 — the COMPILE oracle (Hono/node, strict tsc).
//
// The generation sweep next door proves the pipeline ANSWERS on every
// crossing.  It is blind to the answer being uncompilable target code, which
// is the entire recorded bug class: #2412 (`mask unless` × `audited`) GENERATED
// perfectly and then failed .NET CS0128 / Python F821.  Only a real compiler
// sees that.
//
// Case set: the ALL-PAIRS cover, not the cross product — every recorded
// instance of the class is a two-factor interaction, so a cover containing all
// pairs finds them at ~1/8 the cost.  Sharded one case per CI cell via
// LOOM_PAIRWISE_TSC_CASE=<case-id>.
//
// Slice 1 is node-only by design; the dotnet / java / elixir compile legs are
// a named follow-up slice (they need their toolchain containers, and this
// slice's job is to prove the harness earns them).
// ---------------------------------------------------------------------------

const ENABLED = process.env.LOOM_PAIRWISE === "1" && process.env.LOOM_TS_BUILD === "1";
const ONLY = process.env.LOOM_PAIRWISE_TSC_CASE;

const CASES = pairwiseCover("node").filter((c) => !ONLY || caseId(c) === ONLY);

/**
 * `npm install` once per DISTINCT emitted package.json, then link.
 *
 * The cover's cases differ in domain shape, not in dependency set — two cases
 * on the same persistence adapter emit a byte-identical package.json.  Paying
 * a fresh install for each would make this leg cost an hour for no additional
 * coverage; the hash key keeps it honest (a case whose deps genuinely differ
 * gets its own install).
 */
const installs = new Map<string, string>();
const scratch: string[] = [];

function nodeModulesFor(pkgJson: string): string {
  const key = crypto.createHash("sha256").update(pkgJson).digest("hex").slice(0, 16);
  const cached = installs.get(key);
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-pw-deps-${key}-`));
  scratch.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), pkgJson);
  execSync("npm install --silent --no-audit --no-fund", {
    cwd: dir,
    stdio: "inherit",
    timeout: 300_000,
  });
  installs.set(key, dir);
  return dir;
}

describe.skipIf(!ENABLED)("pairwise corpus — the emitted node project type-checks", () => {
  afterAll(() => {
    for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
  });

  it.each(CASES.map((c) => [caseId(c), c] as const))(
    "%s",
    async (_id, kase: PairwiseCase) => {
      const out = await runPipeline(kase, "node");

      if (out.verdict === "rejected") {
        // A named `loom.*` refusal is a legitimate answer; there is no project
        // to compile.  Say so rather than passing silently — a leg that
        // quietly skips is how a compile tier becomes a no-op.
        console.log(`${caseId(kase)}: rejected by ${out.codes.join(", ")} — nothing to compile`);
        return;
      }
      if (out.verdict === "crashed") {
        // Owned by the generation oracle's waiver register; asserting it again
        // here would double-count one finding as two.
        expect(
          waiverFor(GENERATION_WAIVERS, kase, "node"),
          `${caseId(kase)} crashed in codegen with no generation waiver`,
        ).toBeDefined();
        return;
      }

      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-pw-tsc-${caseId(kase)}-`));
      try {
        for (const [rel, content] of out.files!) {
          const abs = path.join(outDir, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content);
        }
        const proj = path.join(outDir, "d");
        const pkgPath = path.join(proj, "package.json");
        expect(fs.existsSync(pkgPath), `${caseId(kase)}: node project 'd' emitted`).toBe(true);

        const deps = nodeModulesFor(fs.readFileSync(pkgPath, "utf8"));
        fs.symlinkSync(path.join(deps, "node_modules"), path.join(proj, "node_modules"), "dir");

        const waiver = waiverFor(TSC_WAIVERS, kase, "node");
        let failure: string | undefined;
        try {
          execSync("npx tsc --noEmit", { cwd: proj, stdio: "pipe", timeout: 300_000 });
        } catch (e) {
          const err = e as { stdout?: Buffer; stderr?: Buffer };
          failure = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`.slice(0, 4000);
        }

        if (waiver) {
          // Ratchet: a waived case that now compiles must lose its waiver.
          expect(
            failure,
            `${caseId(kase)} now type-checks — delete its entry from ` +
              `test/pairwise/waivers-tsc.ts and close its row in the findings register`,
          ).toBeDefined();
        } else {
          expect(
            failure,
            `${caseId(kase)}: emitted node project failed strict tsc`,
          ).toBeUndefined();
        }
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    },
    900_000,
  );
});
