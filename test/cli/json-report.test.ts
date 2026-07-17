import { execSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ValidateReport } from "../../src/diagnostics/contract.js";

// ---------------------------------------------------------------------------
// `ddd parse --json` — the structured-diagnostics contract
// (docs/old/proposals/ai-diagnostics-contract.md).  Asserts on stable `loom.*`
// codes (not message prose, per the contract's design goal §2), the
// always-valid envelope on a bad model, and byte-identical determinism.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const goodModel = path.join(repoRoot, "examples", "sales.ddd");
const badModel = path.join(here, "fixtures", "bad-model.ddd");

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execSync(`node ${cli} ${args.join(" ")}`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

/** Parse the JSON envelope and replace the machine-specific absolute `model`
 *  path with its basename, so assertions/snapshots are portable. */
function parseReport(stdout: string): ValidateReport {
  const report = JSON.parse(stdout) as ValidateReport;
  return { ...report, model: path.basename(report.model) };
}

describe("ddd parse --json", () => {
  it("a clean model reports ok with a populated outline", () => {
    const { stdout, status } = runCli(["parse", goodModel, "--json"]);
    expect(status).toBe(0);
    const report = parseReport(stdout);

    expect(report.ok).toBe(true);
    expect(report.summary.errors).toBe(0);
    // `sales.ddd` uses list `find`s (byCustomer / activeForCustomer), now
    // deprecated in favour of criterion reads (loom.repository-find-deprecated,
    // a warning) — the model is still valid (no errors). Tolerate those
    // deprecation warnings but assert nothing else surfaces.
    const nonDeprecation = report.diagnostics.filter(
      (d) => d.code !== "loom.repository-find-deprecated",
    );
    expect(nonDeprecation).toEqual([]);
    expect(report.loomVersion).toMatch(/^\d+\.\d+\.\d+$/);

    const sales = report.outline.contexts.find((c) => c.name === "Sales");
    expect(sales).toBeDefined();
    const aggNodes = sales?.aggregates.map((a) => a.node) ?? [];
    expect(aggNodes).toContain("aggregate Sales.Order");
    // Members are addressed in the shared address space the patch layer uses.
    const order = sales?.aggregates.find((a) => a.node === "aggregate Sales.Order");
    expect(order?.members.every((m) => m.includes("Sales.Order"))).toBe(true);
  });

  it("a bad model is non-ok, exits 1, and carries a stable coded diagnostic", () => {
    const { stdout, status } = runCli(["parse", badModel, "--json"]);
    expect(status).toBe(1); // exit gated on ok===false
    const report = parseReport(stdout);

    expect(report.ok).toBe(false);
    expect(report.summary.errors).toBeGreaterThanOrEqual(1);

    const bare = report.diagnostics.find((d) => d.code === "loom.bare-aggregate-in-type");
    expect(bare).toBeDefined();
    expect(bare?.severity).toBe("error");
    expect(bare?.phase).toBe("ast-validate");
    // CST-backed diagnostics carry a precise range (the hard contract requirement).
    expect(bare?.range).toBeDefined();
    expect(bare?.sourceText).toBe("Customer");

    // …and an applyable fix-hint (the self-suggesting loop, §3.3).
    expect(bare?.fixHint?.kind).toBe("replace-text");
    expect(bare?.fixHint?.patch).toMatchObject({
      op: "replace",
      target: "aggregate Sales.Order.customer",
      source: "customer: Customer id",
    });

    // The envelope is valid even on a failing model (contract §6).
    expect(report.outline).toBeDefined();
  });

  it("is deterministic — two runs produce byte-identical JSON", () => {
    const a = runCli(["parse", goodModel, "--json"]).stdout;
    const b = runCli(["parse", goodModel, "--json"]).stdout;
    expect(a).toBe(b);
  });

  it("golden: the bad model's diagnostics array is stable", () => {
    const report = parseReport(runCli(["parse", badModel, "--json"]).stdout);
    expect(report.diagnostics).toMatchSnapshot();
  });
});
