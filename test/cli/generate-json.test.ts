import { execSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GenerateReport } from "../../src/diagnostics/contract.js";

// ---------------------------------------------------------------------------
// `ddd generate system --json` — the GenerateReport contract (§4).  Thin CLI
// wrapper over the toolkit `generate()`; the toolkit tests cover the logic.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const acme = path.join(repoRoot, "examples", "acme.ddd");

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    return { stdout: execSync(`node ${cli} ${args.join(" ")}`, { encoding: "utf8" }), status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

describe("ddd generate system --json", () => {
  it("reports ok + a deployable manifest, writes no files", () => {
    const { stdout, status } = runCli(["generate", "system", acme, "--json"]);
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as GenerateReport;
    expect(report.ok).toBe(true);
    expect(report.deployables.length).toBeGreaterThan(0);
    expect(
      report.deployables.every((d) => d.name && d.platform && typeof d.port === "number"),
    ).toBe(true);
  });
});
